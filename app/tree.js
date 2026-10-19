// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE


'use strict';
/* ================= tree.js =================
 * 话题树领域：增删改 + 拖拽 + 选中 + 侧栏/面包屑/搜索框交互 + 视图历史。
 *
 * 渲染在 tree-render.js（本模块 re-export，调用方 import 路径不变）。
 *
 * 导出：
 *   renderTree()          重绘左栏树          → tree-render.js
 *   syncScopeBtn()        同步搜索范围按钮样式 → tree-render.js
 *   select(id)            切换当前话题
 *   startCreate(parentId) 在指定父话题下开启"新建"输入框
 *   pushViewState / viewBack / goToView        视图历史栈
 *   wireTree({...})       注入外部依赖（renderAll / savePrefs / refreshPreview）
 *
 * 与其它模块的边界：
 *   - 需要 renderAll（在 app.js）       → 通过 wireTree 注入
 *   - 需要 savePrefs（在 app.js）       → 通过 wireTree 注入
 *   - 需要 refreshPreview（在 app.js）  → 通过 wireTree 注入
 *   - renderEntries 从 entries.js 直接 import
 *   - updateScrollBtn 从 entries-jump.js 直接 import
 *   - addNode / renameNode 通过 bindTreeRender 注入给 tree-render.js
 */

import { $, esc, badgeHTML } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import {
 deleteOrphanAttachments
} from './io.js';
import { clearPendingForNode } from './image.js';
import { enqueue } from './writer.js';
import {
  toast, openMenu, openMenuAt, openMovePicker,
  closeSide, hasModal, confirmDialog
} from './ui.js';
import {
  findNode, findParent,  pOf, isDesc, subtreeIds,
} from './tree-utils.js';
import { renderEntries } from './entries.js';
import { updateScrollBtn } from './entries-jump.js';
import { setReply, setRelevance, restoreDraft } from './composer.js';
import { recallScroll, flushScroll, rememberScroll } from './entries-jump.js';

import * as treeRender from './tree-render.js';
import {
  renderTree, syncScopeBtn, bindTreeRender,
} from './tree-render.js';
import {
  addNode, renameNode, moveNode,  confirmDeleteTopic,
  wireTreeOps,
} from './tree-ops.js';


/* ---------- 依赖注入 ---------- */
let D = {
  renderAll: () => {},
  savePrefs: () => {},
  refreshPreview: () => {},
};
export function wireTree(h) {
  Object.assign(D, h);
  /* 转发给 tree-ops —— 它也需要 renderAll / savePrefs，
     但不想让 app.js 直接 wire 两个模块 */
  wireTreeOps({
    renderAll: h.renderAll,
    savePrefs: h.savePrefs,
    select,
    setReply,
    setRelevance,
  });
}

/* ---------- 模块状态 ---------- */
let searchTimer = null;

/* ── 渲染 / 搜索 / 内联输入框 全部在 tree-render.js ──
   treeBox 也从那边导出：拖拽（hitTest / autoScroll）要用它。
   写操作（addNode / renameNode / …）在 tree-ops.js。
   addNode / renameNode 通过 bindTreeRender 注入给 tree-render.js。 */
const treeBox = treeRender.treeBox;




/* ============================================================
 * 选中
 * ============================================================ */

export function select(id, opts) {
  opts = opts || {};
  if (!id) return;  

  if (id === Store.ui.selectedId && !Store.ui.merged) {
    if (Store.ui.editingEntry) {
      Store.ui.editingEntry = null; renderEntries();
    }
    closeSide();
    D.refreshPreview();
    return;
  }

  

  const wasMerged = !!Store.ui.merged;
  const prevId = Store.ui.selectedId;
  if (Store.ui.merged) { 
    Store.ui.merged = null;
    Store.ui.multiSelect.clear();
    Store.ui.lastMultiClick = null;
    const bar = $('#multiBar');
    if (bar) bar.classList.remove('on'); }
  if (!wasMerged && prevId && prevId !== id) {
     const s = $('#entriesScroll');
     if (s) rememberScroll(prevId, s.scrollTop);
     flushScroll(prevId);
  }
  if (Store.ui.selectedId !== id) { 
    Store.ui.multiSelect.clear();
    Store.ui.lastMultiClick = null;
    const bar = $('#multiBar');
    if (bar) bar.classList.remove('on'); }

  Store.ui.selectedId = id;
   /* ★ 切走前：把当前话题的草稿存起来 */
  Store.ui.editingEntry = null;
  Store.ui.pinCursor = null;
  setReply(null);
  setRelevance(null);
  syncScopeBtn();

  /* ★ 丢掉上一个话题里没发送的图片 blob。
     草稿只存文本，图片引用不会跟着走；切回来也不是同一份输入框内容了，
     这些 Blob 再没人能给它们建立引用。不清的话它们会一直占着内存，
     直到重连 / 重扫 / 删话题才被 clearPendingForNode 收走。 */
  if (prevId && prevId !== id) clearPendingForNode(prevId);

  let p = findParent(id);
  while (p && p.id !== '__root__') { Store.collapsed.delete(pOf(p)); p = findParent(p.id); }

   /* ★ 切来后：把新话题的草稿还原到 textarea */
  restoreDraft(id);
  /* 两个话题的输入框内容恰好相同（例如都是空）时不会触发 input，
     这里补一次，保证图片预览条不会残留上一个话题的附件。 */
  D.refreshPreview();
  D.savePrefs();
  D.renderAll();
  closeSide();
  /* ★ 记录刚进入的视图。
     返回时 popstate 恢复到上一条 viewHistory，即"上一个话题"。 */
  if (!opts.skipHistory) {
    const sc = $('#entriesScroll');
    const saved = recallScroll(id, Store.node(id));
    pushViewState({
      nodeId: id,
      scrollTop: (saved != null) ? saved : (sc ? sc.scrollHeight : 0),
    });
  }
  if (opts.noScrollRestore) return;
  requestAnimationFrame(() => {
    const s = $('#entriesScroll'); if (!s) return;
    const saved = wasMerged ? null : recallScroll(id, Store.node(id));
    const target = saved != null ? saved : s.scrollHeight;
    s.scrollTo({ top: target, behavior: 'instant' });
    requestAnimationFrame(() => {
      const t2 = saved != null ? saved : s.scrollHeight;
      s.scrollTo({ top: t2, behavior: 'instant' });
      updateScrollBtn();
    });
  });
}

/* ============================================================
 * 菜单 / 确认
 * ============================================================ */


function buildTopicMenuItems(n) {
  return [
    { icon: I.plus, label: '新建子话题', fn: () => startCreate(n.id) },
    { icon: I.pen, label: '重命名', fn: () => { Store.ui.renaming = n.id; renderTree(); } },
    {
      icon: I.move, label: '移动到…',
      fn: () => openMovePicker(
        '把「' + n.title + '」移到哪个话题下？',
        subtreeIds(n),
        tid => {
          moveNode(n.id, tid, 'inside');
          D.renderAll();
          toast('已移动到「' + findNode(tid).title + '」');
        }
      ),
    },
    { sep: true },
    {
      icon: I.trash, label: '清理未引用的图片',
      fn: async () => {
        const ok = await confirmDialog(
          '清理未引用的图片',
          '会删除「' + n.title + '」话题文件夹内、没有被任何记录引用到的图片文件。此操作无法撤销。',
          { danger: true, okText: '清理' }
        );
        if (!ok) return;
        enqueue(async () => {
          const cnt = await deleteOrphanAttachments(n);
          toast(cnt ? ('已清理 ' + cnt + ' 个文件') : '没有需要清理的文件');
        });
      },
    },
    { icon: I.trash, label: '删除话题', danger: true, fn: () => confirmDeleteTopic(n) },
  ];
}
function topicMenu(anchor, n) {
  openMenu(anchor, buildTopicMenuItems(n));
}
export function startCreate(parentId) {
  const pn = findNode(parentId);
  if (pn && pn.id !== '__root__') Store.collapsed.delete(pOf(pn));
  Store.ui.query = ''; $('#searchInput').value = '';
  Store.ui.creatingParent = parentId;
  renderTree();
  const el = $('#treeScroll .create-input');
  if (el) el.scrollIntoView({ block: 'center' });
}

/* ============================================================
 * 拖拽移动话题
 * ============================================================ */

let dragCtx = null, ghost = null, dropLine = null, armExpand = null;
let autoScrollRaf = null, autoScrollDir = 0;

function startAutoScroll(dir) {
  if (autoScrollDir === dir) return;
  autoScrollDir = dir;
  if (autoScrollRaf) return;
  const step = () => {
    if (!autoScrollDir || !dragCtx) { autoScrollRaf = null; autoScrollDir = 0; return; }
    treeBox.scrollTop += autoScrollDir * 8;
    if (dragCtx.lastX != null) hitTest(dragCtx.lastX, dragCtx.lastY);
    autoScrollRaf = requestAnimationFrame(step);
  };
  autoScrollRaf = requestAnimationFrame(step);
}

function stopAutoScroll() {
  autoScrollDir = 0;
  if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }
}

function clearDropFx() {
  document.querySelectorAll('.drop-inside').forEach(r => r.classList.remove('drop-inside'));
  if (dropLine) dropLine.style.display = 'none';
  if (ghost) ghost.classList.remove('nodrop');
  if (armExpand) { clearTimeout(armExpand.t); armExpand = null; }
}

function hitTest(cx, cy) {
  clearDropFx();
  let hit = null;
  for (const r of treeBox.querySelectorAll('.node-row')) {
    if (r.classList.contains('creating')) continue;
    const b = r.getBoundingClientRect();
    if (cy >= b.top && cy < b.bottom) { hit = { r, b }; break; }
  }
  if (!hit) {
    const tb = treeBox.getBoundingClientRect();
    if (cx >= tb.left && cx < tb.right && cy >= tb.top && cy < tb.bottom) {
      const rows = treeBox.querySelectorAll('.node-row');
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const lb = lastRow.getBoundingClientRect();
        if (cy >= lb.bottom - 2) {
          dragCtx.drop = { targetId: '__root__', pos: 'inside' };
          dropLine.style.display = 'block';
          dropLine.style.left = (tb.left + 16) + 'px';
          dropLine.style.width = (tb.width - 32) + 'px';
          dropLine.style.top = (lb.bottom + 2) + 'px';
          return;
        }
      } else {
        dragCtx.drop = { targetId: '__root__', pos: 'inside' };
        dropLine.style.display = 'block';
        dropLine.style.left = (tb.left + 16) + 'px';
        dropLine.style.width = (tb.width - 32) + 'px';
        dropLine.style.top = (tb.top + 6) + 'px';
        return;
      }
    }
    dragCtx.drop = null; ghost.classList.add('nodrop'); return;
  }
  const targetId = hit.r.dataset.id;
  const self = findNode(dragCtx.id), target = findNode(targetId);
  const bad = (targetId === dragCtx.id) || isDesc(self, target);
  if (bad) { dragCtx.drop = null; ghost.classList.add('nodrop'); return; }
  const rel = (cy - hit.b.top) / hit.b.height;
  const pos = rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'inside';
  if (pos === 'inside') {
    hit.r.classList.add('drop-inside');
    if (Store.collapsed.has(pOf(target)) && (!armExpand || armExpand.id !== targetId)) {
      armExpand = {
        id: targetId,
        t: setTimeout(() => { Store.collapsed.delete(pOf(target)); D.savePrefs(); renderTree(); }, 650),
      };
    }
  } else {
    dropLine.style.display = 'block';
    dropLine.style.left = (hit.b.left + 22) + 'px';
    dropLine.style.width = (hit.b.width - 32) + 'px';
    dropLine.style.top = (pos === 'before' ? hit.b.top - 2 : hit.b.bottom - 2) + 'px';
  }
  dragCtx.drop = { targetId, pos };
}

treeBox.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const h = e.target.closest('.handle'); if (!h) return;
  const row = e.target.closest('.node-row');
  if (!row || row.classList.contains('creating')) return;

  /* 触屏下不调 preventDefault：
     .handle 已经有 touch-action:none，滚动已经被 CSS 拦住；
     手动 preventDefault 反而会打断 pointer 序列，让后续 pointermove 收不到。
     非触屏仍然 preventDefault，防止文本选择。 */
  if (e.pointerType !== 'touch') e.preventDefault();

  dragCtx = {
    id: row.dataset.id, row, sx: e.clientX, sy: e.clientY,
    pointerType: e.pointerType,          // ★ 记下来，给阈值判断用
    started: false, drop: null,
    offX: e.clientX - row.getBoundingClientRect().left,
    offY: e.clientY - row.getBoundingClientRect().top,
  };
  try { row.setPointerCapture(e.pointerId); } catch (err) {}
});

window.addEventListener('pointermove', e => {
  if (!dragCtx) return;
  if (!dragCtx.started) {
    /* 手指比鼠标抖，阈值放宽。 */
    const th = dragCtx.pointerType === 'touch' ? 10 : 5;
    if (Math.hypot(e.clientX - dragCtx.sx, e.clientY - dragCtx.sy) < th ) return;
    dragCtx.started = true;
    document.body.classList.add('dragging');
    dragCtx.row.classList.add('drag-src');
    const n = findNode(dragCtx.id);
    ghost = document.createElement('div'); ghost.className = 'drag-ghost';
    ghost.innerHTML = badgeHTML(n) + '<span>' + esc(n.title) + '</span>';
    document.body.appendChild(ghost);
    dropLine = document.createElement('div'); dropLine.id = 'dropLine';
    document.body.appendChild(dropLine);
  }
  ghost.style.left = (e.clientX - dragCtx.offX) + 'px';
  ghost.style.top = (e.clientY - dragCtx.offY - 6) + 'px';

  dragCtx.lastX = e.clientX; dragCtx.lastY = e.clientY;
  const tb = treeBox.getBoundingClientRect();
  const EDGE = 40;
  if (e.clientX < tb.left || e.clientX > tb.right) stopAutoScroll();
  else if (e.clientY < tb.top + EDGE) startAutoScroll(-1);
  else if (e.clientY > tb.bottom - EDGE) startAutoScroll(1);
  else stopAutoScroll();

  hitTest(e.clientX, e.clientY);
});

function endDrag(e) {
  if (!dragCtx) return;
  const d = dragCtx;
  clearDropFx();
  stopAutoScroll();
  document.body.classList.remove('dragging');
  d.row.classList.remove('drag-src');
  if (ghost) { ghost.remove(); ghost = null; }
  if (dropLine) { dropLine.remove(); dropLine = null; }
  try { d.row.releasePointerCapture(e.pointerId); } catch {}
  dragCtx = null;
}

window.addEventListener('pointerup', e => {
  if (!dragCtx) return;
  const moved = dragCtx.started && dragCtx.drop;
  const id = dragCtx.id, drop = dragCtx.drop;
  endDrag(e);
  if (moved) { moveNode(id, drop.targetId, drop.pos); D.renderAll(); }
});

window.addEventListener('pointercancel', e => endDrag(e));

/* ============================================================
 * 树事件
 * ============================================================ */

treeBox.addEventListener('click', e => {
  const more = e.target.closest('[data-scope-more]');
  if (more) { Store.ui.searchShown += 100; renderTree(); return; }
  const toAll = e.target.closest('[data-scope-all]');
  if (toAll) { Store.ui.searchScope = 'all'; Store.ui.searchShown = 100; syncScopeBtn(); renderTree(); return; }
  const btn = e.target.closest('button');
  if (btn && btn.dataset.act) {
    const row = btn.closest('.node-row'); const id = row.dataset.id;
    if (btn.dataset.act === 'toggle') {
      const node = Store.node(id); const kp = pOf(node);
      const br = treeBox.querySelector('[data-branch="' + id + '"]');
      if (Store.collapsed.has(kp)) {
        Store.collapsed.delete(kp);
        if (br) {
          const kidsEl = br.querySelector(':scope > .kids-wrap > .kids');
          if (kidsEl && !kidsEl.children.length && node.children.length) {
            const depth = +(br.dataset.d || 0);
            kidsEl.innerHTML = node.children
              .map(c => treeRender.branchHTML(c, depth + 1, kp)).join('');
          }
          br.classList.remove('collapsed');
        }
      } else {
        Store.collapsed.add(kp);
        if (br) br.classList.add('collapsed');
      }
      D.savePrefs();
      return;
    }
    if (btn.dataset.act === 'more') { topicMenu(btn, Store.node(id)); return; }
  }
  const goBtn = e.target.closest('[data-goto]');
  if (goBtn) {
    const targetId = goBtn.dataset.goto;
    const entryId = goBtn.getAttribute('data-goto-entry');
    select(targetId);
    if (entryId) { Store.ui.flashEntry = entryId; renderEntries(); }
    return;
  }
  const row = e.target.closest('.node-row');
  if (row && !row.classList.contains('creating') && !btn
     && !e.target.closest('input')) select(row.dataset.id);
});

treeBox.addEventListener('contextmenu', e => {
  const row = e.target.closest('.node-row');
  if (!row || row.classList.contains('creating')) return;
  if (e.target.closest('input')) return;
  e.preventDefault();
  const n = findNode(row.dataset.id);
  openMenuAt(e.clientX, e.clientY, buildTopicMenuItems(n));
});

treeBox.addEventListener('dblclick', e => {
  const title = e.target.closest('.row-title'); if (!title) return;
  Store.ui.renaming = title.closest('.node-row').dataset.id; renderTree();
});

/* F2 / Delete 快捷键（作用于当前选中话题） */
document.addEventListener('keydown', e => {
  if (e.target.matches && e.target.matches('input,textarea')) return;
  if (hasModal()) return;
  const n = findNode(Store.ui.selectedId); if (!n) return;
  if (e.key === 'F2') {
    e.preventDefault();
    Store.ui.renaming = n.id; renderTree();
    requestAnimationFrame(() => {
      const el = $('#treeScroll .rename'); if (el) el.scrollIntoView({ block: 'nearest' });
    });
  }
  if (e.key === 'Delete') { e.preventDefault(); confirmDeleteTopic(n); }
});

/* ============================================================
 * 侧栏 / 搜索框 / 面包屑
 * ============================================================ */

$('#crumbs').addEventListener('click', e => {
  const c = e.target.closest('[data-crumb]'); if (c) select(c.dataset.crumb);
});

$('#searchInput').addEventListener('input', e => {
  const v = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { Store.ui.query = v; Store.ui.searchShown = 100; renderTree(); }, 120);
});
$('#searchInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    clearTimeout(searchTimer);
    e.target.value = ''; Store.ui.query = ''; renderTree();
  }
});
$('#scopeBtn').addEventListener('click', () => {
  Store.ui.searchScope = Store.ui.searchScope === 'all' ? 'topic' : 'all';
  Store.ui.searchShown = 100;
  syncScopeBtn();
  renderTree();
});

$('#newRootBtn').addEventListener('click', () => startCreate('__root__'));

$('#hamburger').addEventListener('click', () => document.body.classList.toggle('side-open'));
$('#scrim').addEventListener('click', closeSide);

/* ─── 视图历史栈（返回功能） ─────────────────── */

export function pushViewState(snap) {
  const VIEW_HISTORY_MAX = 200;
  if (Store.ui.viewHistory.length > VIEW_HISTORY_MAX) {
    /* 只裁掉最旧的一条，游标跟着 -1；裁完必须 >= 0，
       否则下面的截断分支会把整条历史清空 */
    Store.ui.viewHistory.shift();
    Store.ui.viewCursor = Math.max(0, Store.ui.viewCursor - 1);
  }
  if (Store.ui.viewCursor < Store.ui.viewHistory.length - 1) {
    Store.ui.viewHistory.length = Store.ui.viewCursor + 1;
  }
  const sc = document.querySelector('#entriesScroll');
  const state = snap || {
    nodeId: Store.ui.selectedId,
    scrollTop: sc ? sc.scrollTop : 0,
  };
  Store.ui.viewHistory.push(state);
  Store.ui.viewCursor = Store.ui.viewHistory.length - 1;
  history.pushState({ viewIdx: Store.ui.viewCursor }, '');
  updateBackBtn();
  
}

export function viewBack() {
  if (Store.ui.viewCursor <= 0) return false;
  history.back();
  return true;
}

export function goToView(idx) {
  if (idx < 0 || idx >= Store.ui.viewHistory.length) return;
  if (idx === Store.ui.viewCursor) return;
  Store.ui.viewCursor = idx;
  const s = Store.ui.viewHistory[idx];

  // ★ 目标节点没了 → 退到第一个子话题，而不是把主区清空
  let nid = s.nodeId;
  if (!nid || !Store.node(nid)) {
    nid = Store.root.children[0] ? Store.root.children[0].id : null;
  }
  if (!nid) return;
  
  select(nid, { skipHistory: true, noScrollRestore: true });
  requestAnimationFrame(() => {
    const sc = document.querySelector('#entriesScroll');
    if (!sc) return;
    const memo = recallScroll(nid, Store.node(nid));
    sc.scrollTop = (memo != null) ? memo : (s.scrollTop || 0);
  });
  updateBackBtn();
}

function updateBackBtn() {
  const btn = document.querySelector('#navBackFloat');
  if (!btn) return;
  btn.classList.toggle('on', Store.ui.viewCursor > 0);
}

window.addEventListener('popstate', (e) => {
  if (e.state && e.state.root)
   return;   // 到根了，让浏览器自己处理
  const idx = (e.state && typeof e.state.viewIdx === 'number')
    ? e.state.viewIdx
    : 0;
  goToView(idx);
});

document.querySelector('#navBackFloat')?.addEventListener('click', viewBack);  // ← 改

/* ============================================================
 * 把话题写操作交给 tree-render.js
 * （内联输入框里 Enter / 失焦 → 真的创建 / 重命名话题）
 * ============================================================ */

bindTreeRender({ addNode, renameNode });
