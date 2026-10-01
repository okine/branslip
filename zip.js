'use strict';
/* ================= zip.js =================
 * 导出整个存储文件夹为 ZIP。
 *
 * 无第三方依赖 —— 手写 ZIP 结构（stored 模式，不压缩）。
 * 注意：ZIP 只支持 4GB 和 65535 文件，超出会静默截断。
 *
 *   exportZip(rootHandle)   → Blob
 *   initZipButton()         挂载侧栏底部的导出按钮
 */

import { Store } from './store.js';
import { I }     from './icons.js';
import { toast } from './ui.js';

/* CRC32 查表 —— ZIP 规范强制要求 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ZIP 里的时间/日期用 MS-DOS 格式（固定 2+2 字节，不用 ISO） */
function dosDateTime(d) {
  const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { dt: dt & 0xFFFF, tm: tm & 0xFFFF };
}

export async function exportZip(rootHandle) {
  const parts = [];        /* Blob 片段 —— 只存头，不存数据（用 File 引用） */
  const central = [];      /* 中央目录记录 */
  let offset = 0;          /* 当前写入位置的字节偏移 */
  let fileCount = 0;

  async function walk(dir, path) {
    for await (const [name, h] of dir.entries()) {
      const fullPath = path ? path + '/' + name : name;
      if (h.kind === 'file') {
        const file = await h.getFile();
        /* 只为了算 CRC32 读一次字节 —— 读完立刻丢，不进 parts */
        const buf = new Uint8Array(await file.arrayBuffer());
        const crc = crc32(buf);
        const size = buf.length;

        const nameBytes = new TextEncoder().encode(fullPath);
        const { dt, tm } = dosDateTime(new Date(file.lastModified || Date.now()));

        /* --- 本地文件头（30 字节 + 文件名） --- */
        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);          /* 所需版本 2.0 */
        dv.setUint16(6, 0x0800, true);      /* 标志：文件名 UTF-8 */
        dv.setUint16(8, 0, true);           /* 压缩方法：0=stored */
        dv.setUint16(10, tm, true);
        dv.setUint16(12, dt, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, size, true);       /* 压缩后大小 = 原大小 */
        dv.setUint32(22, size, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);          /* extra field 长度 */
        local.set(nameBytes, 30);

        parts.push(local);
        parts.push(file);                    /* ← 关键：直接引用 File，不复制 */
        offset += local.length + size;

        /* --- 中央目录记录（46 字节 + 文件名） --- */
        const cen = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(cen.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);         /* 创建版本 */
        cdv.setUint16(6, 20, true);         /* 所需版本 */
        cdv.setUint16(8, 0x0800, true);
        cdv.setUint16(10, 0, true);
        cdv.setUint16(12, tm, true);
        cdv.setUint16(14, dt, true);
        cdv.setUint32(16, crc, true);
        cdv.setUint32(20, size, true);
        cdv.setUint32(24, size, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint16(30, 0, true);
        cdv.setUint16(32, 0, true);
        cdv.setUint16(34, 0, true);
        cdv.setUint16(36, 0, true);
        cdv.setUint32(38, 0, true);
        cdv.setUint32(42, offset - local.length - size, true);  /* 本地头偏移 */
        cen.set(nameBytes, 46);
        central.push(cen);
        fileCount++;
      } else if (h.kind === 'directory') {
        await walk(h, fullPath);
      }
    }
  }

  await walk(rootHandle, '');

  /* 中央目录区 */
  let centralSize = 0;
  for (const c of central) { parts.push(c); centralSize += c.length; }

  /* 结尾记录（22 字节） */
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, fileCount, true);
  edv.setUint16(10, fileCount, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

/* 挂到侧栏底部 .foot-row */
export function initZipButton() {
  if (document.getElementById('zipBtn')) return;
  const row = document.querySelector('.foot-row');
  if (!row) return;
  const btn = document.createElement('button');
  btn.className = 'export-btn';
  btn.id = 'zipBtn';
  btn.title = '导出为 ZIP 压缩包';
  btn.innerHTML = I.folder + '<span>导出</span>';
  row.appendChild(btn);

  btn.addEventListener('click', async () => {
    if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }
    toast('正在打包…');
    btn.disabled = true;
    try {
      const blob = await exportZip(Store.dir);
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const fname = '时枝笺-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        '-' + p(d.getHours()) + p(d.getMinutes()) + '.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('已导出 ' + fname + '（' + (blob.size / 1048576).toFixed(1) + ' MB）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  });
}