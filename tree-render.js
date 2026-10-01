'use strict';
/* ================= tree-render.js =================
 * 左栏话题树的「渲染 + 搜索 + 内联输入框」。
 *
 * 从 tree.js 抽出。这里只做：读 Store → 出 HTML → 写进 #treeScroll。
 * 不做：增删改话题（addNode / renameNode 在 tree.js，通过 bindTreeRender 注入）、
 *       拖拽、视图历史、选中切换。
 *
 * 对外：
 *   renderTree()                       重绘左栏（话题树 / 搜索结果）
 *   renderSearch()                     只出搜索结果 HTML
 *   branchHTML(n, depth, path)         只出某个节点的子树 HTML（展开折叠时用）
 *   nextTreeIndex()                    取下一个 stagger 序号
 *   syncScopeBtn()                     同步搜索范围按钮样式
 *   bindTreeRender({ addNode, renameNode })   注入话题写操作
 *
 * 依赖：utils / icons / store / format / tree-utils —— 全是下层模块。
 */

import { $, esc, badgeHTML } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { fmtDay } from './format.js';
import { findNode, walk, pathOf } from './tree-utils.js';

/* ---------- 注入的话题写操作 ---------- */
let D = {
  addNode:    () => null,
  renameNode: () => {},
};
export function bindTreeRender(h) { Object.assign(D, h); }

/* ---------- 模块状态 ---------- */
let firstTree = true;
let treeIdx = 0;

export const treeBox = $('#treeScroll');

/** stagger 动画序号。tree.js 在折叠节点里懒渲染子节点时也要接着往下发。 */
export function nextTreeIndex() { return treeIdx++; }

/* ============================================================
 * 树渲染
 * ============================================================ */

/** 展开折叠节点时，只补渲染这一层的子节点（tree.js 用）。 */
export function branchHTML(n, depth, path) {
  const idx = nextTreeIndex();
  const kp = path ? path + '\u0001' + n.title : n.title;
  const creating = Store.ui.creatingParent === n.id;
  const hasKids = n.children.length > 0 || creating;
  const open = !Store.collapsed.has(kp) || creating;
  const sel = n.id === Store.ui.selectedId;

  /* 折叠时不递归渲染子节点 */
  const kidRows = open
    ? (creating ? createRowHTML(depth + 1) : '') +
      n.children.map(c => branchHTML(c, depth + 1, kp)).join('')
    : '';

  return '<div class="branch' + (open ? '' : ' collapsed') + '" data-branch="' + n.id + '" data-d="' + depth + '">' +
    '<div class="node-row' + (sel ? ' selected' : '') + '" data-id="' + n.id + '" style="--d:' + depth + ';--i:' + idx + '">' +
      '<span class="handle" title="拖拽移动">' + I.drag + '</span>' +
      '<button class="chev" data-act="toggle">' + (n.children.length ? I.chev : '') + '</button>' +
      badgeHTML(n) +
      (Store.ui.renaming === n.id
        ? '<input class="rename" value="' + esc(n.title) + '">'
        : '<span class="row-title">' + esc(n.title) + '</span>') +
        (n._pending ? '<span class="row-count" title="正在创建">…</span>' : '') +
      '<span class="row-count">' + (n.entries.length || '') + '</span>' +
      '<button class="rbtn" data-act="add" title="新建子话题">' + I.plus + '</button>' +
      '<button class="rbtn" data-act="more" title="更多操作">' + I.dots + '</button>' +
    '</div>' +
    (hasKids ? '<div class="kids-wrap"><div class="kids' + (depth + 1 > 0 ? ' has-line' : '') + '" style="--d:' + (depth + 1) + '">' + kidRows + '</div></div>' : '') +
  '</div>';
}

function createRowHTML(depth) {
  return '<div class="node-row creating" style="--d:' + depth + '">' +
    '<span class="handle" style="visibility:hidden">' + I.drag + '</span>' +
    '<span class="chev" style="visibility:hidden">' + I.chev + '</span>' +
    '<span class="badge" style="--bc:#B7AD97">' + I.plus + '</span>' +
    '<input class="create-input" placeholder="新话题名称，Enter 确认">' +
  '</div>';
}

export function renderTree() {
  treeIdx = 0;
  if (Store.ui.query) { treeBox.innerHTML = renderSearch(); return; }
  const rootCreate = Store.ui.creatingParent === '__root__' ? createRowHTML(0) : '';
  treeBox.innerHTML = '<div class="tree' + (firstTree ? ' stagger' : '') + '">' + rootCreate +
    Store.root.children.map(c => branchHTML(c, 0, '')).join('') + '</div>';
  firstTree = false;
  bindInlineInputs();
}

/* ============================================================
 * 搜索
 * ============================================================ */

function entryLower(e) {
  if (e._lc === undefined) e._lc = e.text.toLowerCase();
  return e._lc;
}

function hl(text, q, max = 240) {
  let t = String(text);
  if (t.length > max) {
    const idx = t.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) {
      t = t.slice(0, max) + '…';
    } else {
      const start = Math.max(0, idx - Math.floor(max / 3));
      t = (start > 0 ? '…' : '') +
          t.slice(start, start + max) +
          (start + max < text.length ? '…' : '');
    }
  }
  const te = esc(t), qe = esc(q);
  const i = te.toLowerCase().indexOf(qe.toLowerCase());
  if (i < 0) return te;
  return te.slice(0, i) + '<mark>' + te.slice(i, i + qe.length) + '</mark>' +
         te.slice(i + qe.length);
}

function searchScopeRoot() {
  if (Store.ui.searchScope === 'all' || !Store.ui.selectedId) return Store.root;
  return findNode(Store.ui.selectedId) || Store.root;
}

function collectScopeNodes() {
  const root = searchScopeRoot();
  const list = [];
  if (root === Store.root) walk(Store.root, n => list.push(n));
  else { list.push(root); walk(root, n => list.push(n)); }
  return list;
}

export function syncScopeBtn() {
  const b = $('#scopeBtn'); if (!b) return;
  if (!Store.ui.selectedId) Store.ui.searchScope = 'all';
  const isAll = Store.ui.searchScope === 'all';
  b.textContent = isAll ? '全局' : '本话题';
  b.classList.toggle('global', isAll);
}

export function renderSearch() {
  const q = Store.ui.query.trim().toLowerCase();
  if (!q) return '<div class="hint">输入关键词，搜索话题标题与记录正文</div>';

  const scopeNodes = collectScopeNodes();
  const scopeIsAll = (searchScopeRoot() === Store.root);

  const topics = [], entries = [];
  for (const n of scopeNodes) {
    if (n.title.toLowerCase().includes(q)) topics.push(n);
    n.entries.forEach(e => { if (entryLower(e).includes(q)) entries.push({ e, node: n }); });
  }
  entries.sort((a, b) => b.e.createdAt - a.e.createdAt);

  /* 话题范围空、全局有 → 提示切过去 */
  if (!scopeIsAll && !topics.length && !entries.length) {
    let gCount = 0;
    walk(Store.root, n => {
      if (n.title.toLowerCase().includes(q)) gCount++;
      n.entries.forEach(e => { if (entryLower(e).includes(q)) gCount++; });
    });
    if (gCount > 0) {
      return '<div class="hint">本话题下没有匹配，<br>但全局有 <b>' + gCount + '</b> 条。<br><br>' +
        '<button class="link-btn" data-scope-all>切换到全局搜索</button></div>';
    }
    return '<div class="hint">没有找到与「' + esc(Store.ui.query) + '」相关的内容</div>';
  }

  let h = '';
  if (topics.length) {
    const shownTopics = topics.slice(0, Store.ui.searchShown);
    h += '<div class="res-head">话题 · ' + topics.length + '</div>' +
       shownTopics.map(n => {
         const p = pathOf(n).slice(0, -1).map(x => esc(x.title)).join(' / ');
         return '<button class="res-row" data-goto="' + n.id + '">' + badgeHTML(n) +
           '<span class="main"><span>' + hl(n.title, q) + '</span>' +
           (p ? '<span class="path">' + p + '</span>' : '') + '</span></button>';
       }).join('') +
       (topics.length > shownTopics.length
         ? '<button class="res-more" data-scope-more>显示更多 · 还有 ' +
           (topics.length - shownTopics.length) + ' 个话题</button>'
         : '');
  }
  if (entries.length) {
    const total = entries.length;
    const shown = Math.min(total, Store.ui.searchShown);
    h += '<div class="res-head">记录 · ' + total +
       (scopeIsAll ? ' · 全局' : ' · 本话题') + '</div>' +
       entries.slice(0, shown).map(r => {
         const p = pathOf(r.node).map(x => esc(x.title)).join(' / ');
         return '<button class="res-row" data-goto-entry="' + r.e.id + '" data-goto="' + r.node.id + '">' +
           '<span style="color:var(--ink3);flex:none">' + I.pen + '</span>' +
           '<span class="main"><span class="txt">' + hl(r.e.text, q) + '</span>' +
           '<span class="path">' + p + ' · ' + fmtDay(r.e.createdAt) + '</span></span></button>';
       }).join('') +
       (total > shown
         ? '<button class="res-more" data-scope-more>显示更多 · 还有 ' + (total - shown) + ' 条</button>'
         : '');
  }
  return h || '<div class="hint">没有找到与「' + esc(Store.ui.query) + '」相关的内容</div>';
}

/* ============================================================
 * 内联输入框（新建 / 重命名）
 * ============================================================ */

function bindInlineInputs() {
  const box = treeBox;
  const ci = box.querySelector('.create-input');
if (ci) {
  const myParent = Store.ui.creatingParent;   // ← 快照
  ci.focus();

  ci.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      const v = ci.value.trim();
      if (v) { D.addNode(myParent, v); Store.ui.creatingParent = null; renderTree(); }
      else { Store.ui.creatingParent = null; renderTree(); }
    }
    if (e.key === 'Escape') { 
      e.stopPropagation();
      Store.ui.creatingParent = null; 
      renderTree(); }
  });

  ci.addEventListener('blur', () => {
    /* 只处理"仍然是我"的情况 —— creatingParent 已被别的 startCreate 抢走就放弃 */
    if (Store.ui.creatingParent !== myParent) return;
    const v = ci.value.trim();
    if (v) D.addNode(myParent, v);
    Store.ui.creatingParent = null;
    renderTree();
  });
}
  const rn = box.querySelector('.rename');
  if (rn) {
    rn.focus(); rn.select();
    let finished = false;
    const commit = () => {
      if (finished || !rn.isConnected) return;
      finished = true;
      const node = findNode(Store.ui.renaming);
      const v = rn.value.trim();
      if (node && v && v !== node.title) D.renameNode(node, v);
      Store.ui.renaming = null;
      renderTree();
    };
    rn.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) commit();
      if (e.key === 'Escape') { 
        e.stopPropagation();
        finished = true; 
        Store.ui.renaming = null; 
        renderTree(); }
    });
    rn.addEventListener('blur', () => { if (!finished) commit(); });
  }
}
