// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= zip.js =================
 * 导出整个存储文件夹为 ZIP。
 *
 * 无第三方依赖 —— 手写 ZIP 结构（stored 模式，不压缩）。
 *
 * 两个关键设计：
 *   1. 流式：一边读文件一边写目标，内存只占用"一个数据块"，不再把整个
 *      归档攒在 parts[] 里。旧实现 1 GB 就会在网页端 OOM。
 *   2. ZIP64：中央目录偏移/大小/条目数超过 32 位时，自动写 EOCD64 +
 *      每条记录的 64 位 extra field。旧实现超过 4 GB 会静默截断。
 *
 *   • 文件头使用 data descriptor（flag bit 3）：不需要先扫一遍算 CRC。
 *   • 单个文件仍然限制在 4 GB（本地头里写的是 32 位长度）；
 *     一个图片附件不可能到这个量级，真要超了会明确报错而不是写坏档。
 *
 * 对外：
 *   exportZipTo(sink, rootDir, opts)   流式导出到任意 sink
 *   exportZip(rootDir)                 → Blob（兼容旧调用 / 小数据量）
 *   exportZipFlow(btn)                 工具栏"导出 ZIP"：自己挑 sink
 */

import { Store } from './store.js';
import { Storage } from './storage.js';
import { invoke, PLATFORM } from './platform.js';
import { toast } from './ui.js';
import { pickDirectory } from './picker.js';
import { enqueue } from './writer.js';

/* ---------- CRC32（可增量） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

/** 增量 CRC：传进来时 crc 从 0xFFFFFFFF 开始，最后再 ^0xFFFFFFFF。 */
export function crc32Update(crc, bytes) {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return c;
}

export function crc32Finish(crc) {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function crc32(bytes) {
  return crc32Finish(crc32Update(0xFFFFFFFF, bytes));
}

/* ---------- 小工具 ---------- */

/* ZIP 里的时间/日期用 MS-DOS 格式（固定 2+2 字节） */
function dosDateTime(d) {
  const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { dt: dt & 0xFFFF, tm: tm & 0xFFFF };
}

/* Tauri 侧传字节用 base64 */
function bufToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function writeU64(dv, offset, value) {
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x100000000) >>> 0;
  dv.setUint32(offset, lo, true);
  dv.setUint32(offset + 4, hi, true);
}

/** 逐块读取 Blob，内存只占一块。 */
async function* readBlobChunks(blob, chunkSize = 4 * 1024 * 1024) {
  if (blob && typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }
    return;
  }
  const size = blob ? blob.size : 0;
  for (let i = 0; i < size; i += chunkSize) {
    const part = blob.slice(i, Math.min(size, i + chunkSize));
    yield new Uint8Array(await part.arrayBuffer());
  }
}

/* ---------- ZIP 尾部（EOCD / ZIP64） ---------- */

const U32_MAX = 0xFFFFFFFF;
const U16_MAX = 0xFFFF;

/**
 * 生成归档结尾：需要时先写 EOCD64 + 定位器，再写兼容用的 EOCD。
 * 纯函数，便于单测（force64 用来在测试里强制走 64 位分支）。
 */
export function buildZipTail({ count, centralSize, centralOffset, force64 }) {
  const need64 = !!force64 ||
    count > U16_MAX || centralSize > U32_MAX || centralOffset > U32_MAX;

  if (!need64) {
    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, count, true);
    dv.setUint16(10, count, true);
    dv.setUint32(12, centralSize, true);
    dv.setUint32(16, centralOffset, true);
    dv.setUint16(20, 0, true);
    return eocd;
  }

  const eocd64 = new Uint8Array(56);
  const d64 = new DataView(eocd64.buffer);
  d64.setUint32(0, 0x06064b50, true);
  writeU64(d64, 4, 44);                 /* 本记录剩余长度 */
  d64.setUint16(12, 45, true);          /* version made by */
  d64.setUint16(14, 45, true);          /* version needed  */
  d64.setUint32(16, 0, true);           /* 本磁盘号 */
  d64.setUint32(20, 0, true);           /* 中央目录所在磁盘 */
  writeU64(d64, 24, count);
  writeU64(d64, 32, count);
  writeU64(d64, 40, centralSize);
  writeU64(d64, 48, centralOffset);

  const locator = new Uint8Array(20);
  const dl = new DataView(locator.buffer);
  dl.setUint32(0, 0x07064b50, true);
  dl.setUint32(4, 0, true);
  writeU64(dl, 8, centralOffset + centralSize);   /* EOCD64 的偏移 */
  dl.setUint32(16, 1, true);

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, U16_MAX, true);
  dv.setUint16(10, U16_MAX, true);
  dv.setUint32(12, U32_MAX, true);
  dv.setUint32(16, U32_MAX, true);
  dv.setUint16(20, 0, true);

  const out = new Uint8Array(56 + 20 + 22);
  out.set(eocd64, 0);
  out.set(locator, 56);
  out.set(eocd, 76);
  return out;
}

/* ---------- 写 ZIP ---------- */

const FLAG_UTF8_AND_DESCRIPTOR = 0x0800 | 0x0008;

/** 写 ZIP 的核心：流式追加文件 + 收尾写中央目录。测试直接驱动它。 */
export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.offset = 0;
    this.central = [];
  }

  async _w(bytes) {
    await this.sink.write(bytes);
    this.offset += bytes.length;
  }

  /** 追加一个文件。blob 会被按块读取，不会整个进内存。 */
  async addFile(name, blob) {
    const nameBytes = new TextEncoder().encode(name);
    const { dt, tm } = dosDateTime(new Date((blob && blob.lastModified) || Date.now()));
    const startOffset = this.offset;

    /* 已知大小的文件在写任何字节前就拒绝，避免留下半截归档 */
    if (Number.isFinite(blob && blob.size) && blob.size > U32_MAX) {
      throw new Error('单个文件超过 4 GB，暂不支持：' + name);
    }

    /* 本地头：CRC/大小先写 0，真正的写在 data descriptor 里 */
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, FLAG_UTF8_AND_DESCRIPTOR, true);
    dv.setUint16(8, 0, true);           /* stored */
    dv.setUint16(10, tm, true);
    dv.setUint16(12, dt, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    await this._w(local);

    let crc = 0xFFFFFFFF;
    let size = 0;
    for await (const chunk of readBlobChunks(blob)) {
      crc = crc32Update(crc, chunk);
      size += chunk.length;
      if (size > U32_MAX) throw new Error('单个文件超过 4 GB，暂不支持：' + name);
      await this._w(chunk);
    }
    const finalCrc = crc32Finish(crc);

    /* data descriptor：签名 + CRC + 压缩前/后大小 */
    const dd = new Uint8Array(16);
    const ddv = new DataView(dd.buffer);
    ddv.setUint32(0, 0x08074b50, true);
    ddv.setUint32(4, finalCrc, true);
    ddv.setUint32(8, size, true);
    ddv.setUint32(12, size, true);
    await this._w(dd);

    this.central.push({ nameBytes, crc: finalCrc, size, offset: startOffset, dt, tm });
    return size;
  }

  async finish() {
    const centralOffset = this.offset;

    for (const c of this.central) {
      /* 偏移超过 4 GB（或文件本身超 4 GB，这里已不可能）→ 该记录要 ZIP64 */
      const needOffset64 = c.offset > U32_MAX || c.size > U32_MAX;
      const extraLen = needOffset64 ? 12 : 0;
      const rec = new Uint8Array(46 + c.nameBytes.length + extraLen);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, needOffset64 ? 45 : 20, true);   /* version made by */
      dv.setUint16(6, needOffset64 ? 45 : 20, true);   /* version needed  */
      dv.setUint16(8, FLAG_UTF8_AND_DESCRIPTOR, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, c.tm, true);
      dv.setUint16(14, c.dt, true);
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.size, true);
      dv.setUint32(24, c.size, true);
      dv.setUint16(28, c.nameBytes.length, true);
      dv.setUint16(30, extraLen, true);
      /* 32..41：磁盘号、内部/外部属性，全 0 */
      dv.setUint32(42, needOffset64 ? U32_MAX : c.offset, true);
      rec.set(c.nameBytes, 46);

      if (needOffset64) {
        const o = 46 + c.nameBytes.length;
        const extra = new Uint8Array(12);
        const edv = new DataView(extra.buffer);
        edv.setUint16(0, 0x0001, true);        /* ZIP64 extra field id */
        edv.setUint16(2, 8, true);             /* 只放 offset 一项 */
        writeU64(edv, 4, c.offset);
        rec.set(extra, o);
      }
      await this._w(rec);
    }

    const centralSize = this.offset - centralOffset;
    const tail = buildZipTail({
      count: this.central.length,
      centralSize,
      centralOffset,
    });
    await this._w(tail);
    return { count: this.central.length, size: this.offset };
  }
}

/* ---------- sink：把字节送到目标 ---------- */

/** 内存 sink：小数据量 / Web 没有 File System Access 时的兜底。 */
export function memorySink() {
  const parts = [];
  let size = 0;
  return {
    get size() { return size; },
    async write(bytes) { parts.push(bytes); size += bytes.length; },
    async close() {
      return { blob: new Blob(parts, { type: 'application/zip' }), size };
    },
  };
}

/** Web：File System Access 的可写流，边写边落盘，支持 > 4 GB。 */
export function webFileSink(fileHandle) {
  let writable = null;
  let size = 0;
  return {
    get size() { return size; },
    async write(bytes) {
      if (!writable) writable = await fileHandle.createWritable();
      await writable.write(bytes);
      size += bytes.length;
    },
    async close() {
      if (writable) { await writable.close(); writable = null; }
    },
    /* 失败时别 close：Chrome 会在 close 时把半截 swap 文件提交成正式文件，
       结果用户拿到一个打不开的 zip。abort 是丢弃。 */
    async abort() {
      if (writable) {
        try { await writable.abort(); } catch (e) {}
        writable = null;
      }
    },
  };
}

/** Tauri：Rust 侧开个 BufWriter，按块追加（见 lib.rs 的 zip_writer_*）。 */
export function tauriFileSink(path) {
  let id = null;
  let size = 0;
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = cut >= 0 ? path.slice(0, cut) : '.';
  const name = cut >= 0 ? path.slice(cut + 1) : path;
  return {
    get size() { return size; },
    async write(bytes) {
      if (id == null) id = await invoke('zip_writer_open', { path });
      await invoke('zip_writer_append', { id, b64: bufToB64(bytes) });
      size += bytes.length;
    },
    async close() {
      if (id != null) {
        await invoke('zip_writer_close', { id });
        id = null;
      }
    },
    /* 失败时关句柄并把半截文件删掉，别留一个打不开的 zip */
    async abort() {
      if (id != null) {
        try { await invoke('zip_writer_close', { id }); } catch (e) {}
        id = null;
      }
      try { await invoke('remove_entry', { dir, name, recursive: false }); } catch (e) {}
    },
  };
}

/* ---------- 导出 ---------- */

/* 读源文件时目录句柄的缓存可能已经过期（典型场景：目标 .zip 就存在笔记目录里，
   Chrome 的 .crswap 临时文件一出现，目录就在变）。
   InvalidStateError / NotFoundError 都是可重试的：重新 getFileHandle 再读。 */
async function readFileWithRetry(dir, name, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await Storage.getFile(dir, name);
    } catch (e) {
      lastErr = e;
      const transient = e && (e.name === 'InvalidStateError' || e.name === 'NotFoundError');
      if (!transient) break;
      await new Promise(r => setTimeout(r, 60 * (i + 1)));
    }
  }
  throw lastErr;
}

/* 导出时自己产生/正在变化的文件，别塞进归档 */
function isNoise(name) {
  return /\.crswap$/i.test(name) || /^\.~/.test(name) || /\.tmp$/i.test(name) || /^~\$/.test(name);
}

/* 只数文件个数（不读内容），用于报告 X / Y 进度 */
async function countFiles(dir, skip, path, acc) {
  acc = acc || { n: 0 };
  path = path || '';
  let items = [];
  try { items = await Storage.listEntries(dir); } catch (e) { return acc.n; }
  for (const it of items) {
    const fullPath = path ? path + '/' + it.name : it.name;
    if (isNoise(it.name) || (skip && (skip.has(fullPath) || skip.has(it.name)))) continue;
    if (it.kind === 'file') { acc.n++; continue; }
    if (it.kind === 'directory') {
      let sub = null;
      try { sub = await Storage.getDir(dir, it.name); } catch (e) { continue; }
      await countFiles(sub, skip, fullPath, acc);
    }
  }
  return acc.n;
}

/**
 * 流式把 dir 整棵树写进 sink。
 * @param {object} opts
 *   skipNames  Set<string>  这些文件名（全路径或裸名）跳过
 *   onProgress ({files, bytes, current}) => void
 * @returns {{files:number, bytes:number, failed:string[]}}
 */
export async function exportZipTo(sink, rootDir, opts) {
  opts = opts || {};
  const skip = opts.skipNames || new Set();
  const zw = new ZipWriter(sink);
  let files = 0;
  let bytes = 0;
  const failed = [];          // 读不了的文件：跳过并上报，不让整档失败

  async function walk(dir, path) {
    let items = [];
    try {
      items = await Storage.listEntries(dir);
    } catch (e) {
      failed.push((path || '.') + '（目录读取失败：' + ((e && e.name) || e) + '）');
      return;
    }

    for (const it of items) {
      const fullPath = path ? path + '/' + it.name : it.name;
      if (isNoise(it.name) || skip.has(fullPath) || skip.has(it.name)) continue;

      if (it.kind === 'file') {
        let blob = null;
        try {
          blob = await readFileWithRetry(dir, it.name);
        } catch (e) {
          failed.push(fullPath + '（' + ((e && e.message) || e) + '）');
          continue;
        }
        const n = await zw.addFile(fullPath, blob);
        files++;
        bytes += n;
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress({ files, bytes, current: fullPath }); } catch (e) {}
        }
        /* 每 25 个文件让出一次宏任务：microtask 不会让浏览器重绘 */
        if (files % 25 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } else if (it.kind === 'directory') {
        let sub = null;
        try {
          sub = await Storage.getDir(dir, it.name);
        } catch (e) {
          failed.push((fullPath || '.') + '（目录打不开：' + ((e && e.name) || e) + '）');
          continue;
        }
        await walk(sub, fullPath);
      }
    }
  }

  await walk(rootDir, '');
  const r = await zw.finish();
  return { files, bytes: r.size, failed };
}

/** 兼容旧调用：整档进内存返回 Blob。小数据量或 Web 无 FS Access 时用。 */
export async function exportZip(rootDir) {
  const sink = memorySink();
  await exportZipTo(sink, rootDir);
  const { blob } = await sink.close();
  return blob;
}

/* ---------- UI 流程 ---------- */

function zipFileName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return '时枝笺-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + '.zip';
}

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

function showExportError(e) {
  let msg = '导出失败：' + ((e && e.message) || e || '未知错误');
  if (e && e.name === 'InvalidStateError') {
    msg += '\n提示：目标文件被其他程序改动，或保存位置就在笔记文件夹里。' +
      '\n换一个保存位置（比如桌面）再试一次。';
  }
  toast(msg);
}

export async function exportZipFlow(btn) {
  if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }

  const fname = zipFileName();
  /* 目标自己不能进归档：在笔记目录里导出时，Chrome 的 .crswap
     会让目录不断变化，读文件直接抛 InvalidStateError。 */
  const skipNames = new Set();

  /* ── 第一步：先把目标定下来 ──────────────────────────────
     文件选择器必须放在 enqueue 之前：对话框是人在操作，可能停留几十秒，
     放进写队列会把所有保存/编辑一起堵住。 */
  let makeSink = null;      // () => sink；null = 退回归档进内存
  let describe = '';

  if (PLATFORM.isTauri) {
    if (PLATFORM.isAndroid) {
      const dir = await pickDirectory({
        start: '/storage/emulated/0/Download',
        title: '导出到哪个文件夹',
      });
      if (!dir) { toast('已取消'); return; }

      let name = fname;
      /* 重名就加序号，别覆盖上一次的备份 */
      try {
        let i = 1, cand = fname;
        while ((await Storage.exists(dir, cand)) && i <= 50) {
          cand = fname.replace(/\.zip$/i, '') + '(' + i + ').zip';
          i++;
        }
        name = cand;
      } catch (e) {}
      skipNames.add(name);
      const full = dir + '/' + name;
      makeSink = () => tauriFileSink(full);
      describe = full;
    } else {
      const savePath = await invoke('plugin:dialog|save', {
        options: {
          defaultPath: fname,
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        },
      });
      if (!savePath) { toast('已取消'); return; }
      skipNames.add(savePath.split(/[\\/]/).pop());
      makeSink = () => tauriFileSink(savePath);
      describe = savePath;
    }
  } else if (typeof window.showSaveFilePicker === 'function') {
    /* 浏览器支持 File System Access：直接流式写盘，不受内存/4 GB 限制 */
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: fname,
        types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('已取消'); return; }
      handle = null;
    }
    if (handle) {
      skipNames.add(handle.name || fname);
      makeSink = () => webFileSink(handle);
      describe = handle.name || fname;
    }
  }

  if (btn) btn.disabled = true;
  try {
    const res = await enqueue(async report => {
      /* 进度沿用 writer 的 report(done,total)：左下角状态栏显示"操作进行中… X / Y"。
         先只数一遍文件（不读内容）拿到总数，再边写边报。 */
      let totalFiles = 0;
      try { totalFiles = await countFiles(Store.dir, skipNames); } catch (e) {}
      const onProgress = totalFiles ? info => report(info.files, totalFiles) : undefined;

      /* 没有流式目标（Safari / 旧浏览器）→ 退回归档进内存再下载 */
      if (!makeSink) {
        const mem = memorySink();
        const r = await exportZipTo(mem, Store.dir, { skipNames, onProgress });
        const { blob } = await mem.close();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        let msg = '已导出 ' + fname + '（' + mb(blob.size) + '，' + r.files + ' 个文件）';
        if (r.failed && r.failed.length) {
          msg += '\n跳过 ' + r.failed.length + ' 个读不了的文件，例如：' + r.failed[0];
        }
        toast(msg);
        return;
      }

      const sink = makeSink();
      let r;
      try {
        r = await exportZipTo(sink, Store.dir, { skipNames, onProgress });
        await sink.close();
      } catch (e) {
        /* ★ 失败要 abort 而不是 close：close 会把半截内容提交成正式文件 */
        try { await sink.abort(); } catch (e2) {}
        throw e;
      }

      let msg = '已导出到 ' + describe + '（' + mb(r.bytes) + '，' + r.files + ' 个文件）';
      if (r.failed && r.failed.length) {
        msg += '\n跳过 ' + r.failed.length + ' 个读不了的文件，例如：' + r.failed[0];
      }
      toast(msg);
    });
    if (!res.ok) {
      showExportError(res.err);
      return;
    }
  } catch (e) {
    showExportError(e);
  } finally {
    if (btn) btn.disabled = false;
  }
}
