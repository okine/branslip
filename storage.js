// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE


'use strict';
/* ================= 存储原语 =================
 * 所有和 File System Access API 直接打交道的地方都在这里。
 * 换平台（Node / Tauri / 其它浏览器 API）只需要重写这 7 个函数。
 * 参数用句柄（handle），不是路径 —— 上层保留 node._dir 不变。
 */

const Storage = (() => {

  async function getDir(dir, name, opts) {
    return dir.getDirectoryHandle(name, opts || {});
  }
  async function getFile(dir, name) {
    const fh = await dir.getFileHandle(name);
    return fh.getFile();
  }
  async function listEntries(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      out.push({ name, kind: h.kind });
    }
    return out;
  }
  async function readText(dir, name) {
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
  }
  async function writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function removeEntry(dir, name, opts) {
    return dir.removeEntry(name, opts || {});
  }
  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return 'file' }
    catch (e) {
      try { await dir.getDirectoryHandle(name); return 'dir' }
      catch (e2) { return false }
    }
  }
  async function appendText(dir, name, text) {
    /* 打开已有文件、定位到末尾、追加。文件不存在时等价于新建。 */
    let fh;
    try { fh = await dir.getFileHandle(name); }
    catch (e) { return writeText(dir, name, text); }  // 不存在 → 直接写
    const w = await fh.createWritable({ keepExistingData: true });
    const size = (await fh.getFile()).size;
    await w.seek(size);
    await w.write(text);
    await w.close();
  }

  async function writeBlob(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }
  return { getDir, getFile, listEntries, readText, writeText, removeEntry, exists,appendText,writeBlob };
})();

export { Storage };