'use strict';
/* ================= tree-utils.js =================
 * 话题树的纯工具函数。
 *
 * 只依赖 Store，不认识磁盘、不认识渲染、不认识事件。
 * 所有需要"遍历 / 查找 / 从节点推路径"的地方都用这里的函数。
 */

import { Store } from './store.js';
import { topicRefIdFromStamp } from './format.js';
export const findNode   = Store.node;
export const findParent = Store.parent;
export const findEntry  = Store.entry;

export function topicRefId(node) {
  return node && node.topicId ? topicRefIdFromStamp(node.topicId) : null;
}

export function findTopicByRefId(tid) {
  if (!tid) return null;
  const hit = Store.topicByRefId(tid);
  if (hit) return hit;
  /* 索引尚未建立 / 旧数据 topicId 格式异常时兜底 */
  for (const node of Store.nodes()) {
    if (node.id === '__root__') continue;
    if (topicRefId(node) === tid) return node;
  }
  return null;
}

export function walk(node, fn, seen = new Set()) {
  if (!node || seen.has(node.id)) return;
  seen.add(node.id);
  for (const c of node.children || []) { fn(c); walk(c, fn, seen); }
}

export function isDesc(a, b) {
  for (const c of a.children) {
    if (c.id === b.id || isDesc(c, b)) return true;
  }
  return false;
}

export function subtreeIds(n) {
  const s = [n.id];
  n.children.forEach(c => s.push(...subtreeIds(c)));
  return s;
}

export function stats() {
  let t = 0, e = 0;
  walk(Store.root, n => { t++; e += n.entries.length; });
  return { t, e };
}

/* 从根到 n 的路径（含 n），用于面包屑 */
export function pathOf(n) {
  const p = [n];
  const seen = new Set([n.id]);
  let t = findParent(n.id);
  while (t && t.id !== '__root__' && !seen.has(t.id)) {
    seen.add(t.id);
    p.unshift(t);
    t = findParent(t.id);
  }
  return p;
}

/* 路径的规范化字符串 —— 用作 Map/Set 的 key */
export function pOf(n) {
  return pathOf(n).map(x => x.title).join('\u0001');
}

/* 反向：'\u0001' 分隔的标题路径 → node */
export function findByPath(str) {
  if (!str) return null;
  let list = Store.root.children, node = null;
  for (const t of str.split('\u0001')) {
    node = list.find(c => c.title === t);
    if (!node) return null;
    list = node.children;
  }
  return node;
}

export function pathExists(p) { return !!findByPath(p); }