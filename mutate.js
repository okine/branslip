// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= mutate.js =================
 * L2 层：内存变更（纯函数）
 *
 * 职责：只修改 node / entry 数据结构本身。
 * 不做：读盘、写盘、更新索引、渲染、toast。
 *
 * 时间戳统一：置顶与折叠都直接存 entry.createdAt（毫秒）。
 * 读盘兼容旧格式由调用方（readPins / readFolds）负责。
 */

import { stampToBlockId, entryBlockId } from './format.js';
const Mutate = (() => {

  /* ---------------- 查找 ---------------- */

  function findEntryById(node, id) {
    if (!node || !node.entries) return null;
    for (const e of node.entries) if (e.id === id) return e;
    return null;
  }

  function findEntryIndexById(node, id) {
    if (!node || !node.entries) return -1;
    return node.entries.findIndex(e => e.id === id);
  }


  function findEntryIndexByBlockId(node, blockId) {
    if (!node || !node.entries) return -1;
    return node.entries.findIndex(e => entryBlockId(e) === blockId);
  }


  /* ---------------- 条目 ---------------- */

  /**
   * 追加一条新记录到末尾。
   * 返回新建的 entry 对象。
   */
  function addEntry(node, { id, text, createdAt }) {
    const e = { id, text, createdAt, edited: false, editedAt: null };
    node.entries.push(e);
    return e;
  }

  /**
   * 按 createdAt 升序插入（恢复用）。
   * 同毫秒冲突时顺延 1ms 直到无冲突。
   * 返回 { entry, index }。
   */
  function insertSorted(node, { id, text, createdAt, edited, editedAt }) {
    const used = new Set(node.entries.map(e => e.createdAt));
    let ts = createdAt;
    while (used.has(ts)) ts++;

    let i = node.entries.length;
    while (i > 0 && node.entries[i - 1].createdAt > ts) i--;

    const e = {
      id, text, createdAt: ts,
      edited: !!edited, editedAt: editedAt || null
    };
    node.entries.splice(i, 0, e);
    return { entry: e, index: i };
  }

  /**
   * 编辑一条记录。
   * 返回 { entry, changed }。text trim 后相同 → changed=false。
   */
  function editEntry(node, entryId, newText) {
    const e = findEntryById(node, entryId);
    if (!e) return { entry: null, changed: false };
    const v = String(newText == null ? '' : newText).trim();
    if (v === e.text) return { entry: e, changed: false };
    e.text = v;
    e.edited = true;
    e.editedAt = Date.now();
    delete e._lc;
    return { entry: e, changed: true };
  }

  /**
   * 删除一条记录（并清掉它的置顶）。
   * 返回 { entry, index, wasPinned } 或 null。
   */
  function removeEntry(node, entryId) {
    const i = findEntryIndexById(node, entryId);
    if (i < 0) return null;
    const e = node.entries[i];
    node.entries.splice(i, 1);
    const wasPinned = removePin(node, e);
    return { entry: e, index: i, wasPinned };
  }

  /* ---------------- 置顶（毫秒） ---------------- */

  function isPinned(node, entry) {
    if (!node || !Array.isArray(node.pinned) || !entry) return false;
    return node.pinned.includes(entry.createdAt);
  }

  function addPin(node, entry) {
    if (!Array.isArray(node.pinned)) node.pinned = [];
    if (node.pinned.includes(entry.createdAt)) return false;
    node.pinned.push(entry.createdAt);
    return true;
  }

  function removePin(node, entry) {
    if (!node || !Array.isArray(node.pinned) || !entry) return false;
    const i = node.pinned.indexOf(entry.createdAt);
    if (i < 0) return false;
    node.pinned.splice(i, 1);
    return true;
  }

  /** 切换置顶，返回切换后是否处于置顶状态。 */
  function togglePin(node, entry) {
    if (isPinned(node, entry)) { removePin(node, entry); return false; }
    addPin(node, entry);
    return true;
  }

  /**
   * 按 pinned 数组顺序返回存在的 entry。
   * 找不到的（被删/被移走）自动跳过。
   */
  function pinnedEntries(node) {
    if (!node || !Array.isArray(node.pinned) || !node.pinned.length) return [];
    const byMs = new Map(node.entries.map(e => [e.createdAt, e]));
    const out = [];
    for (const ms of node.pinned) {
      const e = byMs.get(ms);
      if (e) out.push(e);
    }
    return out;
  }

  /* ---------------- 折叠（毫秒） ---------------- */

  function foldKey(from, to) {
    return from + '|' + to;
  }

  /**
   * 加一段折叠（毫秒）。
   * 自动丢弃所有与之重叠的旧折叠。
   * 返回新建的 fold，或 null（区间无效）。
   */
  function addFold(node, from, to) {
    if (typeof from !== 'number' || typeof to !== 'number' || from > to) return null;
    if (!Array.isArray(node.folds)) node.folds = [];
    node.folds = node.folds.filter(f =>
      !(f && typeof f.from === 'number' && typeof f.to === 'number'
        && f.to >= from && f.from <= to));
    const fold = { from, to };
    node.folds.push(fold);
    return fold;
  }

  function removeFold(node, from, to) {
    if (!node || !Array.isArray(node.folds)) return false;
    const before = node.folds.length;
    node.folds = node.folds.filter(f => !(f.from === from && f.to === to));
    return node.folds.length !== before;
  }

  /**
   * 计算 entries[start..] 的折叠覆盖。
   * 返回 Map<index, {fold, a, b}>。
   * - index 在折叠区间内 → 有值
   * - a/b 是区间起止下标
   *
   * 渲染循环用：
   *   cov = cover.get(i)
   *   cov.fold  → 折叠对象（from/to 是毫秒）
   *   cov.a/b   → 用来判断"我是折叠头还是折叠尾"
   */
  function buildFoldCover(node, start) {
    const cover = new Map();
    const folds = Array.isArray(node.folds) ? node.folds : [];
    if (!folds.length) return cover;

    const total = node.entries.length;
    const msIdx = new Map();
    for (let i = 0; i < total; i++) msIdx.set(node.entries[i].createdAt, i);

    for (const f of folds) {
      if (!f || typeof f.from !== 'number' || typeof f.to !== 'number') continue;
      const a = msIdx.has(f.from) ? msIdx.get(f.from) : -1;
      const b = msIdx.has(f.to) ? msIdx.get(f.to) : -1;
      if (a < 0 || b < a) continue;
      for (let j = Math.max(a, start == null ? 0 : start); j <= b; j++) {
        cover.set(j, { fold: f, a, b });
      }
    }
    return cover;
  }

  return {
    // 查找
    findEntryById, findEntryIndexById, findEntryIndexByBlockId,
    entryBlockId,      // ← 现在指向 format 的实现
    // 条目
    addEntry, insertSorted, editEntry, removeEntry,
    // 置顶
    isPinned, addPin, removePin, togglePin, pinnedEntries,
    // 折叠
    foldKey, addFold, removeFold, buildFoldCover,
  };
})();

export { Mutate };