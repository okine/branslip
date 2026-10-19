'use strict';
/* ================= writeSecurity.js =================
 * 写入安全协议：任何一次写入要么完整落盘，要么完全不动。
 *
 * 覆盖：
 *   TMP_TRAILER        .tmp 完整性凭证
 *   atomicWriteText    原子写入
 *   recoverTempFiles   启动时扫描残留 .tmp
 *
 * 双端差异集中在这里：
 *   Web   → 手动 .tmp + 写后读校验 + 删 .tmp
 *   Tauri → Rust 侧 write_text 本身就是原子的，直接透传
 *
 * 依赖：storage.js
 */

import { Storage } from './storage.js';

/* .tmp 的完整性凭证。
   只有以此结尾，才说明写入过程完整走完了。
   目标文件永远不含它。 */
export const TMP_TRAILER = '\n<<<SZJ-EOF>>>\n';


/* ★ 新增：清洗不完整的 UTF-16 代理项，避免转 UTF-8 时被浏览器替换成 U+FFFD 导致校验失败 */
function sanitizeUTF8(str) {
  return String(str).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * 原子写文本。
 *
 * Web：写 .tmp（带凭证）→ 写正式 → 写后读校验 → 删 .tmp
 * 任何一步抛错，正式文件保持原样。
 *
 * Tauri：直接交给 Storage.writeText —— Rust 侧已经是
 *        "写 .tmp → 删旧 → rename" 三步原子操作。
 */
export async function atomicWriteText(dir, name, text) {

   // ★ 在写入前清洗
   const cleanText = sanitizeUTF8(text);
  /* Tauri 分支 */
  if (Storage.isTauri) {
    await Storage.writeText(dir, name, text);
    return;
  }

  /* Web 分支 */
  const tmpName = name + '.tmp';

  const tmpFh = await dir.getFileHandle(tmpName, { create: true });
  const w = await tmpFh.createWritable();
  await w.write(text + TMP_TRAILER);
  await w.close();

  const final = await dir.getFileHandle(name, { create: true });
  const w2 = await final.createWritable();
  await w2.write(text);
  await w2.close();

  /* 写后读校验 —— 磁盘真写坏了能立刻发现 */
  const check = await Storage.readText(dir, name);
  // ★ 用 cleanText 比对
  if (check !== cleanText) {
    throw new Error('写入校验失败：' + name);
  }

  try { await dir.removeEntry(tmpName); } catch (e) {}
}

/**
 * 启动时恢复残留 .tmp。
 *
 * 完整的 .tmp（以 TMP_TRAILER 结尾）→ 恢复为正式文件，
 * 恢复前把现有正式文件备份成 .bak。
 * 残缺的 .tmp（写入过程中崩溃）→ 直接丢弃。
 *
 * Tauri 下不存在崩溃残留，返回 0。
 */
export async function recoverTempFiles(dir) {
  if (!dir) return 0;
  if (Storage.isTauri) return 0;

  let recovered = 0;
  const items = await Storage.listEntries(dir);

  for (const { name, kind } of items) {
    if (kind !== 'file' || !name.endsWith('.tmp')) continue;
    const finalName = name.slice(0, -4);

    try {
      const tmpText = await Storage.readText(dir, name);
      if (!tmpText || !tmpText.endsWith(TMP_TRAILER)) {
        await Storage.removeEntry(dir, name);
        console.log('[recover] 丢弃残缺的 .tmp:', name);
        continue;
      }

      const clean = tmpText.slice(0, -TMP_TRAILER.length);
      /* .json 先 parse 一遍，坏 JSON 不覆盖好文件 */
      if (finalName.endsWith('.json')) JSON.parse(clean);

      /* 备份现有正式文件 */
      try {
        const f = await Storage.getFile(dir, finalName);
        await Storage.writeBlob(dir, finalName + '.bak', f);
        console.log('[recover] 现有文件已备份:', finalName + '.bak');
      } catch (e) {}

      await Storage.writeText(dir, finalName, clean);
      await Storage.removeEntry(dir, name);
      recovered++;
      console.log('[recover] 已恢复', finalName);
    } catch (e) {
      console.warn('[recover] 跳过损坏的', name, e);
    }
  }
  return recovered;
}