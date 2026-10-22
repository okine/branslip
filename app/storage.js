// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= storage.js =================
 * 双端存储原语。
 *   Web   → File System Access API（目录句柄）
 *   Tauri → invoke（路径字符串）
 *
 * 对外接口完全一致。上层拿到的 dir 是"目录标识"：
 *   Web 下是 FileSystemDirectoryHandle
 *   Tauri 下是路径字符串
 */

import { PLATFORM, invoke } from './platform.js';

/* 平台判断统一在 platform.js，这里只做转发（老代码还在读 Storage.isTauri）。 */
const isTauri = PLATFORM.isTauri;
const isAndroid = PLATFORM.isAndroid;
const tauriInvoke = isTauri ? invoke : null;

function joinPath(a, b) {
  if (!b) return a || '';
  if (!a) return b;
  if (a.endsWith('/') || a.endsWith('\\')) return a + b;
  return a + '/' + b;
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const Storage = (() => {

  /* ==================== Web ==================== */

  async function webGetDir(dir, name, opts) {
    return dir.getDirectoryHandle(name, opts || {});
  }
  async function webGetFile(dir, name) {
    const fh = await dir.getFileHandle(name);
    return fh.getFile();
  }
  async function webListEntries(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) out.push({ name, kind: h.kind });
    return out;
  }
  async function webReadText(dir, name) {
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
  }
  async function webWriteText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function webRemoveEntry(dir, name, opts) {
    return dir.removeEntry(name, opts || {});
  }
  async function webExists(dir, name) {
    try { await dir.getFileHandle(name); return 'file'; }
    catch (e) {
      try { await dir.getDirectoryHandle(name); return 'dir'; }
      catch (e2) { return false; }
    }
  }
  async function webAppendText(dir, name, text) {
    let fh;
    try { fh = await dir.getFileHandle(name); }
    catch (e) { return webWriteText(dir, name, text); }
    const w = await fh.createWritable({ keepExistingData: true });
    const size = (await fh.getFile()).size;
    await w.seek(size);
    await w.write(text);
    await w.close();
  }
  async function webWriteBlob(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  /* ==================== Tauri ==================== */

  async function tauriGetDir(dir, name, opts) {
    const p = joinPath(dir, name);
    if (opts && opts.create) await tauriInvoke('mkdir', { dir, name });
    return p;
  }
  async function tauriGetFile(dir, name) {
    const b64 = await tauriInvoke('read_bytes_b64', { dir, rel: name });
    return new Blob([b64ToBuf(b64)]);
  }
  async function tauriListEntries(dir) {
    const raw = await tauriInvoke('list_dir', { dir });
    /* 归一化：Tauri 的 "dir" → Web 的 "directory" */
    return raw.map(it => ({
      name: it.name,
      kind: it.kind === 'dir' ? 'directory' : it.kind,
    }));
  }
  async function tauriReadText(dir, name) {
    return await tauriInvoke('read_text', { dir, name });
  }
  async function tauriWriteText(dir, name, text) {
    return await tauriInvoke('write_text', { dir, name, text });
  }
  async function tauriRemoveEntry(dir, name, opts) {
    return await tauriInvoke('remove_entry', {
      dir, name, recursive: !!(opts && opts.recursive),
    });
  }
  async function tauriExists(dir, name) {
    const r = await tauriInvoke('exists', { dir, name });
    if (r === 'dir') return 'dir';
    return r || false;
  }
  async function tauriAppendText(dir, name, text) {
    let old = '';
    try { old = await tauriReadText(dir, name); } catch (e) {}
    return tauriWriteText(dir, name, old + text);
  }
  async function tauriWriteBlob(dir, name, blob) {
    const buf = await blob.arrayBuffer();
    return tauriInvoke('write_bytes', { dir, name, b64: bufToB64(buf) });
  }

  /* Tauri 专用：整目录一步 rename（不分平台暴露给上层判断） */
  async function tauriMoveDirTo(srcPath, dstParentPath, newName) {
    const to = joinPath(dstParentPath, newName);
    await tauriInvoke('rename_path', { from: srcPath, to });
    return to;
  }

  return {
    isTauri,
    isAndroid,

    /* Android：由 Rust 侧给出固定的存储目录（并确保已创建） */
    defaultDir: isTauri ? () => tauriInvoke('default_storage_dir') : null,

    /* ── Android 自选文件夹（MANAGE_EXTERNAL_STORAGE）──────────────
       权限判断不调 Android API：往目标目录写个探针文件，能写就是有权限。 */
    canWriteDir: isTauri ? (dir) => tauriInvoke('can_write_dir', { dir }) : async () => true,
    copyDirTree: isTauri ? (from, to) => tauriInvoke('copy_dir_tree', { from, to }) : null,

    /* 跳系统「所有文件访问」设置页（MainActivity 注入的桥） */
    requestAllFilesAccess() {
      const b = typeof window !== 'undefined' ? window.ShizhijianAndroid : null;
      if (!b || typeof b.requestAllFilesAccess !== 'function') return false;
      b.requestAllFilesAccess();
      return true;
    },
    /* Android API level；拿不到返回 0（非 Android） */
    androidSdk() {
      const b = typeof window !== 'undefined' ? window.ShizhijianAndroid : null;
      return b && typeof b.sdkInt === 'function' ? b.sdkInt() : 0;
    },

    getDir:      isTauri ? tauriGetDir      : webGetDir,
    getFile:     isTauri ? tauriGetFile     : webGetFile,
    listEntries: isTauri ? tauriListEntries : webListEntries,
    readText:    isTauri ? tauriReadText    : webReadText,
    writeText:   isTauri ? tauriWriteText   : webWriteText,
    removeEntry: isTauri ? tauriRemoveEntry : webRemoveEntry,
    exists:      isTauri ? tauriExists      : webExists,
    appendText:  isTauri ? tauriAppendText  : webAppendText,
    writeBlob:   isTauri ? tauriWriteBlob   : webWriteBlob,

    /* moveDirTo 只有 Tauri 实现。调用方用 PLATFORM.isTauri 判断 */
    moveDirTo:   isTauri ? tauriMoveDirTo   : null,

    /* moveEntry：把 srcDir/srcName 整体移到 dstDir/dstName */
    async moveEntry(srcDir, srcName, dstDir, dstName) {
      if (!isTauri) throw new Error('moveEntry 只在 Tauri 下可用');
      await tauriInvoke('rename_path', {
        from: joinPath(srcDir, srcName),
        to:   joinPath(dstDir, dstName),
      });
    },
  };
})();

export { Storage };