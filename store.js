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

  ui: {
    selectedId:      null,
    viewHistory:     [],    // ★ 新增：视图历史栈 [{ nodeId, entryId, scrollTop }]
    viewCursor:      -1,    // ★ 新增：当前在栈里的位置
    query:           '',
    renaming:        null,
    creatingParent:  null,
    editingEntry:    null,
    flashEntry:      null,
    merged:          null,
    loadedStart:     0,
    multiSelect:     new Set(),
    lastMultiClick:  null,
    expandedFolds:   new Set(),
    searchScope:     'topic',
    searchShown:     100,
    pinCursor:       null,
    drafts:          new Map(),  /* topicId → 未发送的草稿文本 */
  },

  collapsed:  new Set(),    // pOf(node) 的集合
  scrollMemo: new Map(),    // topicId → scrollTop
  urlCache:   new Map(),    // nodeId + '\0' + path → objectURL
  mdCache:    new Map(),    // 片段文本 → 渲染后 HTML
  replyCounts: new Map(),  //回复计数
  relevanceCounts: new Map(), //关联计数
  mirrorCounts: new Map(),  //镜像计数
  metaBuilt: false, 
  

  fs: { ready: false, chain: Promise.resolve(), pending: 0, hasError: false },
};

/* ---- 查询 ---- */
function node(id)  { return id ? _state.nodeIndex.get(id)  || null : null; }
function parent(id){ return id ? _state.parentIndex.get(id)|| null : null; }
function entry(id) { return id ? _state.entryIndex.get(id) || null : null; }

/* ---- 变更 ---- */
function setDir(h) { _state.dirHandle = h; }

/**
 * 重建三个索引。唯一改动索引的地方。
 * 调用点：连接 / 重扫 / 加删话题 / 移动话题。
 */
function rebuildIndex() {
  _state.nodeIndex.clear();
  _state.parentIndex.clear();
  _state.entryIndex.clear();
  _state.nodeIndex.set(_state.root.id, _state.root);

  (function rec(p) {
    for (const c of p.children) {
      _state.nodeIndex.set(c.id, c);
      _state.parentIndex.set(c.id, p);
      for (const e of c.entries) {
        _state.entryIndex.set(e.id, { e, node: c });
      }
      rec(c);
    }
  })(_state.root);
}
function setMetaCounts(reply, mirror, relevance) {
  _state.replyCounts = reply;
  _state.mirrorCounts = mirror;
  _state.relevanceCounts = relevance;
  _state.metaBuilt = true;
}
function isMetaBuilt() { return _state.metaBuilt; }
function resetMetaBuilt() {
  _state.metaBuilt = false;
  _state.replyCounts.clear();
  _state.mirrorCounts.clear();
  _state.relevanceCounts.clear();
}

/* ---- 索引维护（增量，用于避免全量 rebuild）---- */

function indexNode(n, p) {
  _state.nodeIndex.set(n.id, n);
  _state.parentIndex.set(n.id, p);
  for (const e of n.entries) _state.entryIndex.set(e.id, { e, node: n });
}

function unindexNode(n) {
  _state.nodeIndex.delete(n.id);
  _state.parentIndex.delete(n.id);
  for (const e of n.entries) _state.entryIndex.delete(e.id);
}

function indexEntry(e, n)  { _state.entryIndex.set(e.id, { e, node: n }); }
/* ---- 原子变更：内存 + 索引一起做 ----
 *
 * 所有对 entries 的增删都走这三个入口。
 * 直接调 Mutate.addEntry / removeEntry 会漏掉索引同步 —— 之后
 * Store.entry(id) 找回来的就是"已删对象"，所有跳转/引用全错。
 */

function addEntry(node, init) {
  const e = Mutate.addEntry(node, init);
  _state.entryIndex.set(e.id, { e, node });
  return e;
}

function insertSorted(node, init) {
  const r = Mutate.insertSorted(node, init);
  _state.entryIndex.set(r.entry.id, { e: r.entry, node });
  return r;
}

function removeEntry(node, id) {
  const r = Mutate.removeEntry(node, id);
  if (r) _state.entryIndex.delete(r.entry.id);
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
  get fs()        { return _state.fs; },
  get replyCounts(){ return _state.replyCounts; },
  get mirrorCounts(){ return _state.mirrorCounts; },
  get relevanceCounts(){ return _state.relevanceCounts; },
  setMetaCounts,isMetaBuilt, resetMetaBuilt,

  // 查询
  node, parent, entry,


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

