'use strict';
/* ================= tree-render.js =================
 * 左栏话题树的「渲染 + 内联输入框」。
 *
 * 从 tree.js 抽出。这里只做：读 Store → 出 HTML → 写进 #treeScroll。
 * 不做：增删改话题（addNode / renameNode 在 tree.js，通过 bindTreeRender 注入）、
 *       拖拽、视图历史、选中切换、搜索（search.js）。
 *
 * 对外：
 *   renderTree()                       重绘左栏（话题树）
 *   branchHTML(n, depth, path)         只出某个节点的子树 HTML（展开折叠时用）
 *   nextTreeIndex()                    取下一个 stagger 序号
 *   bindTreeRender({ addNode, renameNode })   注入话题写操作
 *
 * 依赖：utils / icons / store / tree-utils —— 全是下层模块。
 */

import { $, esc, badgeHTML, countLabel } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { findNode } from './tree-utils.js';

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
      (n.silent
        ? '<span class="row-count row-silent" title="静默话题：启动和搜索时不加载">' + I.muted + '</span>'
        : '<span class="row-count">' + (n.entries.length ? countLabel(n.entries.length) : '') + '</span>') +
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
  const rootCreate = Store.ui.creatingParent === '__root__' ? createRowHTML(0) : '';
  treeBox.innerHTML = '<div class="tree' + (firstTree ? ' stagger' : '') + '">' + rootCreate +
    Store.root.children.map(c => branchHTML(c, 0, '')).join('') + '</div>';
  firstTree = false;
  bindInlineInputs();
}

/* 搜索已迁到 search.js，并渲染到 #searchPanel，不再替换话题树。 */

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
