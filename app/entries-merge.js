'use strict';
/* ================= entry-merge.js =================
 * 时间流视图：把多个话题的记录按时间合并显示。
 * 对谈模式开关也在这里 —— 它只影响渲染样式。
 */

import { $, esc, badgeHTML, PAGING } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { dayKey, fmtDay } from './format.js';
import { hydrateImages } from './image.js';
import { enqueue } from './writer.js';
import { theme, writeTheme } from './theme.js';
import {
  toast, openMenu, closeSide, pushEsc
} from './ui.js';
import { openTopicPicker } from './ui-topicPicker.js';
import { walk } from './tree-utils.js';
import { renderEntries } from './entries.js';
import { renderPins } from './pins.js';
import { clearEarlierObs } from './entries-jump.js';
import {
  entryHTML, setDialogueEnabled,dayChipHTML, 
} from './entries-render.js';
import { ensureGlobalMeta } from './meta-row.js';
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-utils.js';
/* ---------- 依赖注入 ---------- */
let D = { renderAll: () => {} };
export function wireMerge(h) { Object.assign(D, h); }


let _mergeEscOff = null;             // ★ 模块级
/* 时间流分页参数 */
const MERGED_INITIAL = PAGING.mergedInitial;   // 开屏渲染条数
const MERGED_CHUNK   = PAGING.mergedChunk;    // 每次向上加载
/* 时间流分页状态 */
let mergedList = [];
let mergedStart = 0;
let mergedLoading = false;
let mergedIO = null;
let lastMergedIdleAt = 0;
const MERGED_IDLE_COOLDOWN = 500;

function clearMergedObs() {
  if (mergedIO) { mergedIO.disconnect(); mergedIO = null; }
}
/* ---------- 收集 ---------- */

export function collectMerged() {
  const out = [];
  const push = n => { for (const e of n.entries) out.push({ e, n }); };
  if (Store.ui.merged === 'all') walk(Store.root, push);
  else for (const id of Store.ui.merged || []) {
    const n = Store.node(id); if (n) push(n);
  }
  out.sort((a, b) => a.e.createdAt - b.e.createdAt);
  return out;
}

/* ---------- 渲染 ---------- */

export function renderMerged() {
  /* 切视图时清理单话题的 observer（同一时刻只有一个视图活跃） */
  clearEarlierObs();
  clearMergedObs();

  const box = $('#entries');
  const list = collectMerged();
  mergedList = list;

  if (!list.length) {
    box.className = '';
    box.innerHTML = '<div class="empty"><div class="q">“</div><h3>时间流里还没有记录</h3>' +
      '<p>先在被合并的话题下写点什么，<br>或在合并菜单里换个范围。</p></div>';
    mergedStart = 0;
    return;
  }

  ensureGlobalMeta();
  mergedStart = Math.max(0, list.length - MERGED_INITIAL);
  renderMergedRange();
}
function renderMergedRange() {
  const box = $('#entries');
  const list = mergedList;
  const start = mergedStart;
  const end = list.length;

  let h = '';
  if (start > 0) {
    h = '<div class="load-earlier" id="loadEarlier">向上滚动加载更早的记录 · 还有 ' +
        start + ' 条</div>';
  }

  let lastDay = start > 0 ? dayKey(list[start - 1].e.createdAt) : '';
  let idx = 0;
  for (let i = start; i < end; i++) {
    const { e, n } = list[i];
    const dk = dayKey(e.createdAt);
    if (dk !== lastDay) {
      h += dayChipHTML(e.createdAt, idx);
      lastDay = dk; idx++;
    }
    h += entryHTML(e, idx, n); idx++;
  }

  box.className = '';
  box.innerHTML = h;
  hydrateImages();
  setTimeout(() => {
    if (Store.ui.merged && document.getElementById('loadEarlier')) armMergedLoadEarlier();
  }, 0);
}
function loadEarlierMerged() {
  if (mergedLoading) return;
  const box = $('#entries');
  const sc = $('#entriesScroll');
  const sentinel = document.getElementById('loadEarlier');
  if (!sentinel) return;

  const end = mergedStart;
  const start = Math.max(0, end - MERGED_CHUNK);
  if (end === start) return;

  mergedLoading = true;
  try {
    const oldH = sc.scrollHeight;
    const oldTop = sc.scrollTop;
    const anchor = captureScrollAnchor(sc, box);
    const list = mergedList;

    let h = '';
    let lastDay = start > 0 ? dayKey(list[start - 1].e.createdAt) : '';
    let idx = 0;
    for (let i = start; i < end; i++) {
      const { e, n } = list[i];
      const dk = dayKey(e.createdAt);
      if (dk !== lastDay) {
        h += dayChipHTML(e.createdAt, idx);
        lastDay = dk; idx++;            
      }
      h += entryHTML(e, idx, n); idx++;
    }

    sentinel.insertAdjacentHTML('beforebegin', h);
    mergedStart = start;
    if (start === 0) sentinel.remove();
    else sentinel.textContent = '向上滚动加载更早的记录 · 还有 ' + start + ' 条';

    if (!restoreScrollAnchor(sc, anchor)) {
      const newH = sc.scrollHeight;
      sc.scrollTo({ top: oldTop + (newH - oldH), behavior: 'auto' });
    }
    hydrateImages(box);
  } finally {
    mergedLoading = false;
  }
}
function armMergedLoadEarlier() {
  clearMergedObs();
  const sentinel = document.getElementById('loadEarlier');
  if (!sentinel) return;
  mergedIO = new IntersectionObserver(ents => {
    if (!ents[0].isIntersecting) return;
    clearMergedObs();
    loadEarlierMerged();
    if (document.getElementById('loadEarlier')) armMergedLoadEarlier();
  }, { root: document.getElementById('entriesScroll'), rootMargin: '200px 0px' });
  mergedIO.observe(sentinel);
}

function scheduleMergedIdleLoad() {
  if (!Store.ui.merged) return;
  if (!document.getElementById('loadEarlier')) return;

  const run = () => {
    if (!Store.ui.merged) return;
    if (!document.getElementById('loadEarlier')) return;

    const now = Date.now();
    if (now - lastMergedIdleAt < MERGED_IDLE_COOLDOWN) return;
    lastMergedIdleAt = now;

    loadEarlierMerged();
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 700);
  }
}
/* ---------- 进入 / 退出 ---------- */

export function enterMerge(sel) {
  Store.ui.merged = sel;
  Store.ui.editingEntry = null;
  closeSide();
  D.renderAll();
  renderPins();
  requestAnimationFrame(() => {
    const s = $('#entriesScroll'); if (s) s.scrollTop = s.scrollHeight;
  });
  if (!_mergeEscOff) _mergeEscOff = pushEsc(exitMerge);          // ★ 入栈
}

export function exitMerge() {
  Store.ui.merged = null;
  mergedList = [];
  mergedStart = 0;
  clearMergedObs();
  
  Store.ui.multiSelect.clear();
  Store.ui.lastMultiClick = null;
  const bar = $('#multiBar'); if (bar) bar.classList.remove('on');
  D.renderAll();
  if (_mergeEscOff) { _mergeEscOff(); _mergeEscOff = null; }      // ★ 出栈
}

/* ---------- 菜单 ---------- */

export function openMergeMenu(anchor) {
  const items = [];
  items.push({ icon: I.layers, label: '全部时间流', fn: () => enterMerge('all') });
  items.push({ icon: I.plus, label: '选择话题合并…', fn: openMergePicker });
  items.push({
    icon: I.reply,
    label: theme.dialogue ? '关闭对谈模式' : '开启对谈模式',
    fn: toggleDialogue,
  });
  if (Store.ui.merged) {
    items.push({ sep: true });
    items.push({ icon: I.x, label: '退出时间流', fn: exitMerge });
  }
  openMenu(anchor, items);
}

function openMergePicker() {
  openTopicPicker({
    title: '选择要合并的话题',
    hint: '勾选的话题下，所有记录会按时间合并显示；\n置顶消息也不再单独置顶，一并按时间排入。',
    mode: 'multi',
    preselect: Array.isArray(Store.ui.merged) ? Store.ui.merged : [],
    okText: '合并显示',
    emptyText: '还没有任何话题',
    onPickMulti: ids => enterMerge(ids),
  });
}

/* ---------- 对谈模式 ---------- */

function toggleDialogue() {
  const sc = document.getElementById('entriesScroll');
  const oldTop = sc ? sc.scrollTop : 0;

  theme.dialogue = !theme.dialogue;
  setDialogueEnabled(theme.dialogue);
  enqueue(() => writeTheme());
  renderEntries();

  requestAnimationFrame(() => {
    if (sc) sc.scrollTop = oldTop;
  });
  toast(theme.dialogue ? '已开启对谈模式' : '已关闭对谈模式');
}

/* ---------- 事件 ---------- */
/* 合并入口按钮现在由 fixed-buttons.js 统一排版，这里只保留可复用的 openMergeMenu。 */