'use strict';
/* ================= entries-jump.js =================
 * 主区跳转：把引用 / 徽章 / 灯箱"定位"请求落到具体行上。
 *
 *   jumpToRow(node, entryId)     定位到 entry
 *   jumpToBlock(node, blockId)   定位到 blockId（引用系统里的身份）
 *   jumpToStamp(node, stamp)     定位到 fmtStamp 时间戳
 *
 * 以及它们依赖的分页加载基础设施：
 *   loadEarlier / armLoadEarlier / scheduleIdleLoad / clearEarlierObs
 *
 * 依赖（全部下层，无循环）：
 *   utils / format / store / mutate / meta-row / entries-render /
 *   image / scroll-utils / ui
 *
 * 需要"重绘主区"时（展开折叠后重试）通过 wireEntriesJump 注入
 * renderEntries —— 避免 entries.js ↔ entries-jump.js 反向 import。
 */

import { $, PAGING } from './utils.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { dayKey, fmtStamp } from './format.js';
import { ensureGlobalMeta } from './meta-row.js';
import { entryBlockHTML } from './entries-render.js';
import { hydrateImages } from './image.js';
import {
  scrollIntoViewIn, scrollToBottom, flashEl,
  captureScrollAnchor, restoreScrollAnchor,
} from './scroll-utils.js';
import { toast } from './ui.js';
import { updateTopicMeta } from './io.js';
import { enqueue } from './writer.js';

/* ---------- 依赖注入 ---------- */
let D = { renderEntries: () => {} };
export function wireEntriesJump(h) { Object.assign(D, h); }

/* ---------- 常量 / 模块状态 ---------- */
const IDLE_LOAD_COOLDOWN = 500;

/* “目标前后 10 条”直接定位窗口是否开启 */
let directWindow = false;
export function setDirectWindow(v) { directWindow = !!v; }
export function isDirectWindow() { return directWindow; }

let loadingEarlier = false;
let loadingLater = false;
let lastIdleLoadAt = 0;
let earlierIO = null;
let laterIO = null;

/* ---------- 滚动位置记忆 / 持久化 ---------- */
const SCROLL_SAVE_MS = 2500;
let scrollSaveTimer = null;
const scrollDirty = new Set();

export function rememberScroll(nodeId, top) {
  if (!nodeId || !Number.isFinite(top)) return;
  Store.setScrollMemo(nodeId, top);
  const node = Store.node(nodeId);
  if (node && node.scroll && node.scroll.top === top) scrollDirty.delete(nodeId);
  else scrollDirty.add(nodeId);

  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    flushScroll(Store.ui.selectedId);
  }, SCROLL_SAVE_MS);
  if (scrollSaveTimer && typeof scrollSaveTimer.unref === 'function') scrollSaveTimer.unref();
}

export function recallScroll(nodeId, node) {
  const mem = Store.getScrollMemo(nodeId);
  if (mem != null) return mem;
  if (node && node.scroll && Number.isFinite(node.scroll.top)) {
    Store.setScrollMemo(nodeId, node.scroll.top);
    return node.scroll.top;
  }
  return null;
}

export function flushScroll(nodeId) {
  const id = nodeId || Store.ui.selectedId;
  if (!id || !scrollDirty.has(id)) return;
  const node = Store.node(id);
  if (!node || !node._dir) { scrollDirty.delete(id); return; }

  const top = Store.getScrollMemo(id);
  if (top == null) { scrollDirty.delete(id); return; }
  if (node.scroll && node.scroll.top === top) { scrollDirty.delete(id); return; }

  scrollDirty.delete(id);
  enqueue(() => updateTopicMeta(node, { scroll: { top } })).then(r => {
    if (r.ok) node.scroll = { top };
    else scrollDirty.add(id);   // 下次切换/隐藏时再试
  });
}

export function flushCurrentScroll() {
  const id = Store.ui.selectedId;
  const s = $('#entriesScroll');
  if (!id || !s) return;
  Store.setScrollMemo(id, s.scrollTop);
  scrollDirty.add(id);
  flushScroll(id);
}

/**
 * 把"当前视图的实时位置 + 所有攒着没写的滚动位置"一次性写盘。
 * 清缓存 / 换目录 / 关闭前调用：滚动位置属于磁盘状态，不能跟内存缓存一起丢。
 */
export function flushAllScroll() {
  const id = Store.ui.selectedId;
  const s = $('#entriesScroll');
  if (id && s) {
    Store.setScrollMemo(id, s.scrollTop);
    scrollDirty.add(id);
  }
  for (const nid of [...scrollDirty]) flushScroll(nid);
}

export function clearScrollState() {
  if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null; }
  scrollDirty.clear();
  Store.scrollMemo.clear();
}

/* ---------- 列表顶部 / 底部对齐 ---------- */

/**
 * 找当前"跨过视口顶部"的第一个可见块。
 * 返回 { el, cut } —— cut=true 表示它被切了（顶部在视口之上）。
 */
export function topCutItem() {
  const sc = $('#entriesScroll'), box = $('#entries');
  if (!sc || !box) return null;
  const viewTop = sc.getBoundingClientRect().top;
  for (const el of box.children) {
    if (!el.classList.contains('entry-row') &&
        !el.classList.contains('day-chip')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > viewTop + 2) {
      return { el, cut: r.top < viewTop - 2 };
    }
  }
  return null;
}

export function scrollToCurrentTop() {
  const sc = $('#entriesScroll'), box = $('#entries');
  const t = topCutItem();
  if (!sc || !box || !t) return;
  const padTop = parseFloat(getComputedStyle(box).paddingTop) || 0;
  scrollIntoViewIn(sc, t.el, { align: 'top', offset: padTop });
}

export function scrollToLatest() {
  if (directWindow) {
    /* 直接定位窗口里点向下箭头：回最新一页，不逐批加载中间所有记录 */
    D.renderEntries();
    scrollToBottom($('#entriesScroll'), true);
    return;
  }
  scrollToBottom($('#entriesScroll'), true);
}

export function updateScrollBtn() {
  const s = $('#entriesScroll');
  if (!s) return;

  const dist = s.scrollHeight - s.scrollTop - s.clientHeight;

  /* 到底按钮：离底部 > 200px 显示；定位窗口里即使内容不够高，
     也要留下"向下箭头 → 回最新"的入口 */
  const bottomBtn = $('#scrollBottomBtn');
  const hasLater = !!document.getElementById('loadLater');
  if (bottomBtn) bottomBtn.classList.toggle('on', dist > 200 || hasLater);

  /* 到顶按钮：顶部那条被切断才显示 */
  const topBtn = $('#scrollTopBtn');
  if (topBtn) {
    if (s.scrollTop < 100) { topBtn.classList.remove('on'); return; }
    const t = topCutItem();
    topBtn.classList.toggle('on', !!(t && t.cut));
  }
}

if (typeof document !== 'undefined') {
  $('#scrollBottomBtn').addEventListener('click', scrollToLatest);
  $('#scrollTopBtn').addEventListener('click', scrollToCurrentTop);
}


if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushCurrentScroll);
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushCurrentScroll();
  });
}

const entryStamp = e => fmtStamp(e.createdAt);

/* ---------- 视图身份 ---------- */

/**
 * 当前 #entries 里渲染的是哪个话题。
 * 单话题走 selectedId；合并视图 / 空状态没有落点，返回 null。
 */
function currentViewNodeId() {
  return Store.ui.merged ? null : Store.ui.selectedId;
}

/* ---------- 分页加载 ---------- */

export function loadEarlier(n) {
  if (!n) return;
  if (loadingEarlier) return;

  /* ★ 必须保证"正在看的"就是 n。
     Store.ui.loadedStart 是渲染期写下的单例下标，不带话题身份；
     若拿 A 的下标区间去索引 B 的 entries，会把 B 的一段记录
     插进当前话题的 DOM 里。 */
  if (currentViewNodeId() !== n.id) return;

  loadingEarlier = true;
  try {
    const box = $('#entries');
    const sc = $('#entriesScroll');
    const sentinel = $('#loadEarlier');
    if (!sentinel) return;
    const end = Store.ui.loadedStart;
    const start = Math.max(0, end - PAGING.chunk);
    if (end === start) return;

    const oldH = sc.scrollHeight;
    const oldTop = sc.scrollTop;
    const anchor = captureScrollAnchor(sc, box);
    ensureGlobalMeta();

    let h = '';
    let lastDay = end < n.entries.length ? dayKey(n.entries[end].createdAt) : '';
    let idx = 0;
    for (let i = start; i < end; i++) {
      const e = n.entries[i];
      const dk = dayKey(e.createdAt);
      const showDay = dk !== lastDay;
      if (showDay) lastDay = dk;
      h += entryBlockHTML(e, idx, n, showDay);
      idx++;
    }

    sentinel.insertAdjacentHTML('beforebegin', h);
    Store.ui.loadedStart = start;
    if (start === 0) sentinel.remove();
    else sentinel.textContent = '向上滚动加载更早的记录 · 还有 ' + start + ' 条';

    if (!restoreScrollAnchor(sc, anchor)) {
      const newH = sc.scrollHeight;
      sc.scrollTo({ top: oldTop + (newH - oldH), behavior: 'auto' });
    }
    hydrateImages(box);
  } finally {
    loadingEarlier = false;
  }
}

export function clearEarlierObs() {
  if (earlierIO) { earlierIO.disconnect(); earlierIO = null; }
}

/* ---------- 向下加载（直接定位窗口用） ---------- */

export function loadLater(n) {
  if (!n || loadingLater) return;
  if (currentViewNodeId() !== n.id) return;

  loadingLater = true;
  try {
    const box = $('#entries');
    const sc = $('#entriesScroll');
    const sentinel = $('#loadLater');
    if (!sentinel) return;

    const start = Store.ui.loadedEnd;
    const total = n.entries.length;
    if (start >= total) { sentinel.remove(); return; }

    const end = Math.min(total, start + PAGING.chunk);
    const anchor = captureScrollAnchor(sc, box);
    ensureGlobalMeta();

    let h = '';
    let lastDay = start > 0 ? dayKey(n.entries[start - 1].createdAt) : '';
    let idx = 0;
    for (let i = start; i < end; i++) {
      const e = n.entries[i];
      const dk = dayKey(e.createdAt);
      const showDay = dk !== lastDay;
      if (showDay) lastDay = dk;
      h += entryBlockHTML(e, idx, n, showDay);
      idx++;
    }

    sentinel.insertAdjacentHTML('beforebegin', h);
    Store.ui.loadedEnd = end;
    if (end === total) sentinel.remove();
    else sentinel.textContent = '向下滚动加载更新的记录 · 还有 ' + (total - end) + ' 条';
    restoreScrollAnchor(sc, anchor);
    hydrateImages(box);
  } finally {
    loadingLater = false;
  }
}

export function clearLaterObs() {
  if (laterIO) { laterIO.disconnect(); laterIO = null; }
}

/* 哨兵观察器 —— 每次加载后都要重新挂 */
export function armLoadEarlier(node) {
  clearEarlierObs();
  const sentinel = document.getElementById('loadEarlier');
  if (!sentinel || !node) return;
  earlierIO = new IntersectionObserver(ents => {
    if (!ents[0].isIntersecting) return;
    clearEarlierObs();
    loadEarlier(node);
    if (document.getElementById('loadEarlier')) armLoadEarlier(node);
  }, { root: document.getElementById('entriesScroll'), rootMargin: '200px 0px' });
  earlierIO.observe(sentinel);
}

export function armLoadLater(node) {
  clearLaterObs();
  const sentinel = document.getElementById('loadLater');
  if (!sentinel || !node) return;
  laterIO = new IntersectionObserver(ents => {
    if (!ents[0].isIntersecting) return;
    clearLaterObs();
    loadLater(node);
    if (document.getElementById('loadLater')) armLoadLater(node);
  }, { root: document.getElementById('entriesScroll'), rootMargin: '200px 0px' });
  laterIO.observe(sentinel);
}

/**
 * 空闲预加载：开屏渲染完成后，趁浏览器空闲自动再加载一批。
 */
export function scheduleIdleLoad(n) {
  if (!n) return;
  if (Store.ui.merged) return;
  if (!document.getElementById('loadEarlier')) return;

  const run = () => {
    if (Store.ui.selectedId !== n.id) return;
    if (Store.ui.merged) return;
    if (!document.getElementById('loadEarlier')) return;

    const now = Date.now();
    if (now - lastIdleLoadAt < IDLE_LOAD_COOLDOWN) return;
    lastIdleLoadAt = now;

    loadEarlier(n);
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 700);
  }
}

/* ---------- 跳转 ---------- */

export function jumpToRow(node, targetId) {
  if (!node) { toast('找不到那条记录'); return; }

  const tries = () => {
    /* 1. 已渲染 → 直接定位 + 闪烁 */
    const row = document.querySelector(
      '#entries .entry-row[data-eid="' + targetId + '"]'
    );
    if (row) {
      scrollIntoViewIn($('#entriesScroll'), row, { align: 'top', offset: 20 });
      flashEl(row);
      return;
    }

    /* 2. 目标在内存里但没渲染 → 直接切到"目标前后各 10 条"窗口，
       不再一截一截 loadEarlier（老记录会触发无限向上加载）。 */
    const hit = Store.entry(targetId);
    const inNode = !!(hit && hit.node === node);
    if (!Store.ui.merged
        && inNode
        && currentViewNodeId() === node.id
        && typeof D.showAround === 'function') {
      D.showAround(node, targetId);
      return;
    }

    /* 3. 目标在折叠区间里 → 展开后重试 */
    if (hit && hit.node === node) {
      const idx = node.entries.indexOf(hit.e);
      for (const f of (node.folds || [])) {
        if (!f || typeof f.from !== 'number') continue;
        const a = node.entries.findIndex(e => e.createdAt === f.from);
        const b = node.entries.findIndex(e => e.createdAt === f.to);
        if (a >= 0 && b >= a && idx >= a && idx <= b) {
          const key = Mutate.foldKey(f.from, f.to);
          if (!Store.ui.expandedFolds.has(key)) {
            Store.ui.expandedFolds.add(key);
            D.renderEntries();
            requestAnimationFrame(tries);
            return;
          }
        }
      }
    }

    /* 4. 都试过了，确实找不到 */
    toast('找不到那条记录');
  };

  requestAnimationFrame(tries);
}

export function jumpToBlock(node, blockId) {
  const tries = () => {
    const hit = Store.blockEntry(blockId);
    if (hit && hit.node === node) { jumpToRow(node, hit.e.id); return; }
    /* 兼容旧数据/未建 block 索引的调用 */
    const i = Mutate.findEntryIndexByBlockId(node, blockId);
    if (i >= 0) { jumpToRow(node, node.entries[i].id); return; }
    toast('找不到那条记录');
  };
  requestAnimationFrame(tries);
}

export function jumpToStamp(node, stamp) {
  const tries = () => {
    const t = node.entries.find(e => entryStamp(e) === stamp);
    if (t) { jumpToRow(node, t.id); return; }
    /* 同上：内存里找不到，加载 DOM 分页也不会变出这条记录 */
    toast('找不到那条记录（可能已被删除）');
  };
  requestAnimationFrame(tries);
}