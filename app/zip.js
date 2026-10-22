// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= zip.js =================
 * 导出整个存储文件夹为 ZIP。
 *
 * 无第三方依赖 —— 手写 ZIP 结构（stored 模式，不压缩）。
 * 注意：ZIP 只支持 4GB 和 65535 文件，超出会静默截断。
 *
 *   exportZip(rootDir)   → Blob
 *   exportZipFlow(btn)   toolbar.js 的“导出”按钮调用（含保存/下载流程）
 *
 * 双端：
 *   Web   → Blob 通过 <a download> 触发浏览器下载
 *   Tauri → 弹 save 对话框选路径，写盘
 */

import { Store } from './store.js';
import { Storage } from './storage.js';
import { invoke, PLATFORM } from './platform.js';
import { toast } from './ui.js';
import { pickDirectory } from './picker.js';
import { enqueue } from './writer.js';

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

/* Tauri 侧 write_bytes 接口收 base64 */
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export async function exportZip(rootDir) {
  const parts = [];
  const central = [];
  let offset = 0;
  let fileCount = 0;

  async function walk(dir, path) {
    const items = await Storage.listEntries(dir);
    for (const it of items) {
      const fullPath = path ? path + '/' + it.name : it.name;
      if (it.kind === 'file') {
        const blob = await Storage.getFile(dir, it.name);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const crc = crc32(buf);
        const size = buf.length;

        const nameBytes = new TextEncoder().encode(fullPath);
        const { dt, tm } = dosDateTime(new Date(blob.lastModified || Date.now()));

        /* --- 本地文件头（30 字节 + 文件名） --- */
        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true);
        dv.setUint16(8, 0, true);
        dv.setUint16(10, tm, true);
        dv.setUint16(12, dt, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, size, true);
        dv.setUint32(22, size, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        parts.push(local);
        parts.push(blob);                       // ← 直接引用 Blob，Blob 构造惰性读
        offset += local.length + size;

        /* --- 中央目录记录（46 字节 + 文件名） --- */
        const cen = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(cen.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);
        cdv.setUint16(6, 20, true);
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
        cdv.setUint32(42, offset - local.length - size, true);
        cen.set(nameBytes, 46);
        central.push(cen);
        fileCount++;
      } else if (it.kind === 'directory') {
        const sub = await Storage.getDir(dir, it.name);
        await walk(sub, fullPath);
      }
    }
  }

  await walk(rootDir, '');

  let centralSize = 0;
  for (const c of central) { parts.push(c); centralSize += c.length; }

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

/* 由 toolbar.js 的按钮数组调用 */
export async function exportZipFlow(btn) {
  if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }

  /* Android 先选目标目录：这是纯 UI 交互，不能放在写队列里干等 */
  let androidDir = null;
  if (PLATFORM.isAndroid) {
    androidDir = await pickDirectory({
      start: '/storage/emulated/0/Download',
      title: '导出到哪个文件夹',
    });
    if (!androidDir) { toast('已取消'); return; }
  }

  if (btn) btn.disabled = true;
  try {
    await enqueue(async () => {
      const blob = await exportZip(Store.dir);
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const fname = '时枝笺-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        '-' + p(d.getHours()) + p(d.getMinutes()) + '.zip';

      if (PLATFORM.isTauri) {
        let dir = null, name = fname;

        if (PLATFORM.isAndroid) {
          /* Android 的系统「保存」对话框只会返回 content:// URI，
             write_bytes 要的是绝对路径 —— 用上面选好的目录。 */
          dir = androidDir;
          /* 重名就加序号，别把上一次的备份覆盖掉 */
          try {
            let i = 1, cand = fname;
            while ((await Storage.exists(dir, cand)) && i <= 50) {
              cand = fname.replace(/\.zip$/i, '') + '(' + i + ').zip';
              i++;
            }
            name = cand;
          } catch (e) {}
        } else {
          const savePath = await invoke('plugin:dialog|save', {
            options: {
              defaultPath: fname,
              filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
            },
          });
          if (!savePath) { toast('已取消'); return; }

          const idx = Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\'));
          dir  = idx >= 0 ? savePath.slice(0, idx) : '.';
          name = idx >= 0 ? savePath.slice(idx + 1) : savePath;
        }

        const buf = await blob.arrayBuffer();
        await invoke('write_bytes', {
          dir, name, b64: bufToB64(buf),
        });

        toast('已导出到 ' + dir + '/' + name +
          '（' + (blob.size / 1048576).toFixed(1) + ' MB）');
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('已导出 ' + fname + '（' + (blob.size / 1048576).toFixed(1) + ' MB）');
      }
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}