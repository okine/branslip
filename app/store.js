// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE


'use strict';
/* ================= store.js =================
 * L2.5 层：应用运行时状态
 *
 * 持有：根句柄 / 索引 / UI 状态 / 折叠集合 / 缓存 / 写队列
 * 暴露：查询函数 + 少量变更函数
 * 不做：磁盘 IO / 数据规则 / 渲染
 */

import { Mutate } from './mutate.js';
import { topicRefIdFromStamp } from './format.js';

const _state = {
  dirHandle: null,

  root: {
    id: '__root__', title: '', _name: '',
    _dir: null, entries: [], children: [],
    pinned: [], folds: []
  },

  nodeIndex:   new Map(),   // id → node
  parentIndex: new Map(),   // id → parent node
  entryIndex:  new Map(),   // entry.id → { e, node }
  blockIndex:  new Map(),   // blockId → { e, node }
  topicRefIndex: new Map(), // topicRefId → node

  ui: {
    selectedId:      null,
    viewHistory:     [],    // ★ 新增：视图历史栈 [{ nodeId, entryId, scrollTop }]
    viewCursor:      -1,    // ★ 新增：当前在栈里的位置
    renaming:        null,
    creatingParent:  null,
    editingEntry:    null,
    flashEntry:      null,
    merged:          null,
    loadedStart:     0,
    loadedEnd:       0,
    multiSelect:     new Set(),
    lastMultiClick:  null,
    expandedFolds:   new Set(),
    pinCursor:       null,
    drafts:          new Map(),  /* topicId → 未发送的草稿文本 */
  },

  collapsed:  new Set(),    // pOf(node) 的集合
  scrollMemo: new Map(),    // topicId → scrollTop
  urlCache:   new Map(),    // nodeId + '\0' + path → objectURL
  mdCache:    new Map(),    // 片段文本 → 渲染后 HTML
  dataRevision: 0,
  

  fs: { ready: false, chain: Promise.resolve(), pending: 0, hasError: false },
};

/* ---- 查询 ---- */
function node(id)  { return id ? _state.nodeIndex.get(id)  || null : null; }
function parent(id){ return id ? _state.parentIndex.get(id)|| null : null; }
function entry(id) { return id ? _state.entryIndex.get(id) || null : null; }
function blockEntry(blockId) { return blockId ? _state.blockIndex.get(blockId) || null : null; }
function topicByRefId(tid) { return tid ? _state.topicRefIndex.get(tid) || null : null; }

/* 滚动记忆：内存只保留最近 10 个话题，命中即提到队尾 */
const SCROLL_MEMO_MAX = 10;
function setScrollMemo(id, top) {
  if (!id || !Number.isFinite(top)) return;
  _state.scrollMemo.delete(id);
  _state.scrollMemo.set(id, top);
  while (_state.scrollMemo.size > SCROLL_MEMO_MAX) {
    const oldest = _state.scrollMemo.keys().next().value;
    _state.scrollMemo.delete(oldest);
  }
}
function getScrollMemo(id) {
  if (!id || !_state.scrollMemo.has(id)) return null;
  const top = _state.scrollMemo.get(id);
  _state.scrollMemo.delete(id);
  _state.scrollMemo.set(id, top);
  return top;
}

/* ---- 变更 ---- */
function setDir(h) { _state.dirHandle = h; }

/* 数据版本：搜索等只读消费者用它判断缓存是否过期。
   任何会改变节点标题 / 记录正文 / 记录增删的路径都要 bump。 */
function touchData() { _state.dataRevision++; }

/**
 * 重建三个索引。唯一改动索引的地方。
 * 调用点：连接 / 重扫 / 加删话题 / 移动话题。
 */
function rebuildIndex() {
  _state.nodeIndex.clear();
  _state.parentIndex.clear();
  _state.entryIndex.clear();
  _state.blockIndex.clear();
  _state.topicRefIndex.clear();
  _state.nodeIndex.set(_state.root.id, _state.root);

  (function rec(p) {
    for (const c of p.children) {
      _state.nodeIndex.set(c.id, c);
      _state.parentIndex.set(c.id, p);
      if (c.topicId) {
        const tid = topicRefIdFromStamp(c.topicId);
        if (tid) _state.topicRefIndex.set(tid, c);
      }
      for (const e of c.entries) {
        const rec = { e, node: c };
        _state.entryIndex.set(e.id, rec);
        _state.blockIndex.set(Mutate.entryBlockId(e), rec);
      }
      rec(c);
    }
  })(_state.root);
  _state.dataRevision++;
}
/* ---- 索引维护（增量，用于避免全量 rebuild）---- */

function indexNode(n, p) {
  _state.nodeIndex.set(n.id, n);
  _state.parentIndex.set(n.id, p);
  if (n.topicId) {
    const tid = topicRefIdFromStamp(n.topicId);
    if (tid) _state.topicRefIndex.set(tid, n);
  }
  for (const e of n.entries) {
    const rec = { e, node: n };
    _state.entryIndex.set(e.id, rec);
    _state.blockIndex.set(Mutate.entryBlockId(e), rec);
  }
  _state.dataRevision++;
}

function unindexNode(n) {
  _state.nodeIndex.delete(n.id);
  _state.parentIndex.delete(n.id);
  if (n.topicId) {
    const tid = topicRefIdFromStamp(n.topicId);
    if (tid) _state.topicRefIndex.delete(tid);
  }
  for (const e of n.entries) {
    _state.entryIndex.delete(e.id);
    _state.blockIndex.delete(Mutate.entryBlockId(e));
  }
  _state.dataRevision++;
}

function indexEntry(e, n)  {
  const rec = { e, node: n };
  _state.entryIndex.set(e.id, rec);
  _state.blockIndex.set(Mutate.entryBlockId(e), rec);
  _state.dataRevision++;
}

/* 时序：composer 先 addEntry，再冻结 _writeStamp；blockId 可能因此变化。
   把旧的 blockId 映射删掉，写新的。 */
function reindexEntry(e, n, oldBlockId) {
  const rec = { e, node: n };
  _state.entryIndex.set(e.id, rec);
  const olds = Array.isArray(oldBlockId) ? oldBlockId : [oldBlockId];
  for (const id of olds) if (id) _state.blockIndex.delete(id);
  _state.blockIndex.set(Mutate.entryBlockId(e), rec);
  _state.dataRevision++;
}
/* ---- 原子变更：内存 + 索引一起做 ----
 *
 * 所有对 entries 的增删都走这三个入口。
 * 直接调 Mutate.addEntry / removeEntry 会漏掉索引同步 —— 之后
 * Store.entry(id) 找回来的就是"已删对象"，所有跳转/引用全错。
 */

function addEntry(node, init) {
  const e = Mutate.addEntry(node, init);
  const rec = { e, node };
  _state.entryIndex.set(e.id, rec);
  _state.blockIndex.set(Mutate.entryBlockId(e), rec);
  _state.dataRevision++;
  return e;
}

function insertSorted(node, init) {
  const r = Mutate.insertSorted(node, init);
  const rec = { e: r.entry, node };
  _state.entryIndex.set(r.entry.id, rec);
  _state.blockIndex.set(Mutate.entryBlockId(r.entry), rec);
  _state.dataRevision++;
  return r;
}

function removeEntry(node, id) {
  const r = Mutate.removeEntry(node, id);
  if (r) {
    _state.entryIndex.delete(r.entry.id);
    _state.blockIndex.delete(Mutate.entryBlockId(r.entry));
    _state.dataRevision++;
  }
  return r;
}

/* ---- 导出 ---- */
export const Store = {
  // 只读状态
  get dir()       { return _state.dirHandle; },
  get root()      { return _state.root; },
  get ui()        { return _state.ui; },
  get collapsed() { return _state.collapsed; },
  get scrollMemo(){ return _state.scrollMemo; },
  get urlCache()  { return _state.urlCache; },
  get mdCache()   { return _state.mdCache; },
  get dataRevision(){ return _state.dataRevision; },
  touchData,
  get fs()        { return _state.fs; },

  // 查询
  node, parent, entry, blockEntry,
  topicByRefId,
  setScrollMemo, getScrollMemo,
  reindexEntry,


  nodes() {
    return _state.nodeIndex.values();
  },
  // 变更
  setDir,
  rebuildIndex,
  indexNode, unindexNode, indexEntry,
  /* ★ 原子变更 —— 新代码只用这三个，别再手写 indexEntry/Entry 配对 */
  addEntry, insertSorted, removeEntry,
};

