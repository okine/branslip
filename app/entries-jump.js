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
import { ensureGlobalMeta } from './meta-row.js';
import { entryBlockHTML, altRowHTML, dayChipHTML, buildAltGroups, altAnchorOf } from './entries-render.js';
import { hydrateImages } from './image.js';
import {
  scrollIntoViewIn, scrollToBottom, flashEl,
  captureScrollAnchor, restoreScrollAnchor,
} from './scroll-utils.js';
import { toast } from './ui.js';
import { updateTopicMeta } from './io.js';
import { enqueue } from './writer.js';
import { dayKey, fmtStamp, dayKeyOfEntry } from './format.js';

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

/* 调试探针：控制台里 window.__earlierAlive 看观察器是否挂着 */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__earlierAlive', { get: () => !!earlierIO });
}
let laterIO = null;

/* ---------- 滚动位置记忆 / 持久化 ---------- */
const SCROLL_SAVE_MS = 2500;
let scrollSaveTimer = null;
const scrollDirty = new Set();
/* 每个话题的顶部锚点（内存里，flush 时一起落盘） */
const anchorMemo = new Map();

/* ---------- 手动排查工具 ----------
 * 自动加载只靠 armLoadEarlier 里的 IntersectionObserver（root=viewport）。
 * 这里保留一个手动入口，控制台可调：window.__SZJ.maybeLoadEarlier(true) */

/**
 * 还有更早的记录、并且"哨兵已经在可视区里" → 加载一批。
 *
 * 不再靠 scrollTop 阈值：不同宿主里真正滚动的是不同元素（网页/桌面/手机
 * 都可能不同），scrollTop 会给出误导性的数字。直接问 DOM：
 * 哨兵 #loadEarlier 现在是否落在 #entriesScroll 的可视矩形里。
 *
 * 返回状态字符串，方便控制台直接看卡在哪：
 *   'no-dom' / 'merged' / 'no-topic' / 'all-loaded' /
 *   'not-visible' / 'cooldown' / 'no-node' / 'busy' / 'loaded(<新 loadedStart>)'
 */
let lastAutoLoadAt = 0;
let prevSentinelTop = null;      /* 上次加载时哨兵的屏幕位置，用来判断"用户又往上滑了" */
const AUTO_LOAD_COOLDOWN_MS = 350;

/**
 * @param {boolean} [force] 由滚动事件判定"已经到顶"时传 true —— 跳过几何判断。
 */
export function maybeLoadEarlier(force) {
  if (typeof document === 'undefined') return 'no-dom';
  if (Store.ui.merged) return 'merged';
  const id = Store.ui.selectedId;
  if (!id) return 'no-topic';
  if (Store.ui.loadedStart <= 0) return 'all-loaded';

  const n = Store.node(id);
  if (!n) return 'no-node';

  const scEl = document.getElementById('entriesScroll');
  const sentinel = document.getElementById('loadEarlier');

  /* 可视矩形：窗口 ∩ 列表容器。任一层裁掉都算"看不见" */
  const scRect = scEl ? scEl.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const clipTop = Math.max(0, scRect.top);
  const clipBottom = Math.min(window.innerHeight, scRect.bottom || window.innerHeight);

  let visible;
  const sRect = sentinel ? sentinel.getBoundingClientRect() : null;
  if (force) {
    visible = true;                       /* 滚动事件已经证明到顶了，几何不可信 */
  } else if (sRect) {
    visible = sRect.top < clipBottom - 8 && sRect.bottom > clipTop;
  } else {
    /* 哨兵丢了（DOM 被重绘）：看第一条记录是否已经顶到可视区上沿 */
    const first = document.querySelector('#entries .entry-row');
    if (!first) return 'no-sentinel';
    visible = first.getBoundingClientRect().top >= clipTop - 4;
  }
  if (!visible) return 'not-visible';

  /* 只在"用户又往上滑了一点"时才继续加载：
     加载完我们会补偿滚动，哨兵在屏幕上位置不变；
     若不加这道判断，会每 350ms 自动吃 40 条，几万条直接喂爆 DOM。 */
  if (!force && sRect && prevSentinelTop != null && sRect.top <= prevSentinelTop + 1) {
    return 'need-scroll-up';
  }

  /* 冷却：一次滚动手势只加载一批 */
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastAutoLoadAt < AUTO_LOAD_COOLDOWN_MS) return 'cooldown';
  lastAutoLoadAt = now;
  if (sRect) prevSentinelTop = sRect.top;

  const before = Store.ui.loadedStart;
  loadEarlier(n);
  return Store.ui.loadedStart < before
    ? 'loaded(' + Store.ui.loadedStart + ')'
    : 'busy';
}

/* 自动触发只用 IntersectionObserver（见 armLoadEarlier）。
   之前那套"滚动事件 + 几何测量"已经移除：滚动里 getBoundingClientRect
   会强制同步布局（[Violation] Forced reflow），而且和真实滚动容器容易对不上。
   maybeLoadEarlier 保留为控制台手动排查用。 */

export function rememberScroll(nodeId, top) {
  if (!nodeId || !Number.isFinite(top)) return;
  Store.setScrollMemo(nodeId, top);
  const node = Store.node(nodeId);
  if (node && node.scroll && node.scroll.top === top) scrollDirty.delete(nodeId);
  else scrollDirty.add(nodeId);

  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    /* ★ 落盘前先把锚点抓下来：只更新像素 top 会让锚点停留在旧位置，
       下次恢复时"锚点优先"反而会跳回更早的地方。 */
    const cur = Store.ui.selectedId;
    if (cur) {
      const a = captureTopAnchor();
      if (a && a.id) anchorMemo.set(cur, a);
    }
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

/* ---------- 顶部锚点：比"像素位置"更稳 ----------
 * 清缓存 / 重新分页后，同一条记录可能落在不同的 scrollTop 上，
 * 所以额外记「窗口最上面那条记录的 id + 它离视口上沿的像素偏移」。
 */
export function captureTopAnchor() {
  const sc = $('#entriesScroll'), box = $('#entries');
  if (!sc || !box) return null;
  const scTop = sc.getBoundingClientRect().top;
  for (const el of box.children) {
    if (!el.classList.contains('entry-row')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > scTop + 2) {
      return { id: el.dataset.eid || '', off: Math.round(r.top - scTop) };
    }
  }
  return null;
}

export function restoreTopAnchor(anchor) {
  if (!anchor || !anchor.id) return false;
  const sc = $('#entriesScroll'), box = $('#entries');
  if (!sc || !box) return false;
  let el = null;
  try {
    el = box.querySelector('.entry-row[data-eid="' + anchor.id + '"]');
  } catch (e) { return false; }
  if (!el) return false;
  const scTop = sc.getBoundingClientRect().top;
  const now = el.getBoundingClientRect().top - scTop;
  const delta = now - (anchor.off || 0);
  if (Math.abs(delta) > 1) sc.scrollTop += delta;
  return true;
}

/**
 * 连续几帧把锚点对齐。
 * 一次对齐不够：图片/字体/懒渲染会陆续改变行高，恢复后前几帧位置还会漂。
 * 用户一动手（pointerdown / wheel）立刻停手，不抢滚动。
 */
export function settleTopAnchor(anchor, frames) {
  if (!anchor || !anchor.id) return;
  const max = frames || 4;
  let n = 0, cancelled = false;
  const cancel = () => { cancelled = true; };
  window.addEventListener('pointerdown', cancel, { once: true, passive: true });
  window.addEventListener('wheel', cancel, { once: true, passive: true });
  const tick = () => {
    if (cancelled) return;
    restoreTopAnchor(anchor);
    if (++n >= max) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 离开某个话题之前把它的顶部锚点记下来 —— 只有 DOM 还是它的时候才抓得到。 */
export function captureAnchorFor(nodeId) {
  if (!nodeId) return;
  const a = captureTopAnchor();
  if (a && a.id) anchorMemo.set(nodeId, a);
}

export function flushScroll(nodeId) {
  const id = nodeId || Store.ui.selectedId;
  if (!id || !scrollDirty.has(id)) return;
  const node = Store.node(id);
  if (!node || !node._dir) { scrollDirty.delete(id); return; }

  const top = Store.getScrollMemo(id);
  if (top == null) { scrollDirty.delete(id); return; }
  const a = anchorMemo.get(id) || null;
  const sameTop = node.scroll && node.scroll.top === top;
  const sameAnchor = !a || (node.scroll && node.scroll.id === a.id && node.scroll.off === a.off);
  if (sameTop && sameAnchor) { scrollDirty.delete(id); return; }

  scrollDirty.delete(id);
  const patch = { top };
  if (a && a.id) { patch.id = a.id; patch.off = a.off; }
  enqueue(() => updateTopicMeta(node, { scroll: patch })).then(r => {
    if (r.ok) node.scroll = patch;
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
    const a = captureTopAnchor();
    if (a && a.id) anchorMemo.set(id, a);
    scrollDirty.add(id);
  }
  for (const nid of [...scrollDirty]) flushScroll(nid);
}

export function clearScrollState() {
  if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null; }
  scrollDirty.clear();
  anchorMemo.clear();
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

/* 图片、content-visibility、字体都会在滚动后继续改变内容高度。
   回到底部不能只滚一次，否则 smooth 的目标高度早就过期了。 */
let bottomSettleRO = null;
let bottomSettleTimer = 0;
let bottomSettleAC = null;

function stopBottomSettle() {
  if (bottomSettleRO) { bottomSettleRO.disconnect(); bottomSettleRO = null; }
  if (bottomSettleTimer) { clearTimeout(bottomSettleTimer); bottomSettleTimer = 0; }
  if (bottomSettleAC) { bottomSettleAC.abort(); bottomSettleAC = null; }
}

function settleBottom(s) {
  if (!s) return;
  stopBottomSettle();
  const box = $('#entries');
  if (!box) return;
  const sid = Store.ui.selectedId;

  /* 布局变化时继续贴底；用户主动滚轮/触摸/切换话题则立刻释放。 */
  if (typeof ResizeObserver === 'function') {
    bottomSettleRO = new ResizeObserver(() => {
      if (Store.ui.selectedId !== sid) { stopBottomSettle(); return; }
      scrollToBottom(s, false);
    });
    bottomSettleRO.observe(box);
  }
  bottomSettleAC = new AbortController();
  const stop = () => stopBottomSettle();
  s.addEventListener('wheel', stop, { passive: true, signal: bottomSettleAC.signal });
  s.addEventListener('pointerdown', stop, { signal: bottomSettleAC.signal });
  s.addEventListener('touchstart', stop, { passive: true, signal: bottomSettleAC.signal });
  bottomSettleTimer = setTimeout(stop, 3000);
}

export function scrollToLatest() {
  const s = $('#entriesScroll');
  const sid = Store.ui.selectedId;
  if (directWindow) {
    /* 直接定位窗口里点向下箭头：回最新一页，不逐批加载中间所有记录 */
    D.renderEntries();
    scrollToBottom(s, true);
    settleBottom(s);
    return;
  }
  scrollToBottom(s, true);
  /* 兜底：没有 ResizeObserver 时也在前几帧继续贴底。 */
  if (typeof ResizeObserver !== 'function') {
    [0, 60, 180, 400, 900].forEach(t => setTimeout(() => {
      if (Store.ui.selectedId === sid) scrollToBottom(s, false);
    }, t));
  }
  settleBottom(s);
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

/**
 * 单向切片加载 —— "向上加载更早" 和 "向下加载更新" 共用这一套。
 * 两者只有三处不同：区间方向、哨兵是谁、新记录插在哨兵的哪一侧。
 * @param {'earlier'|'later'} dir
 * @returns {boolean} 是否真的加载了一批
 */
function loadSlice(n, dir) {
  const earlier = dir === 'earlier';
  const box = $('#entries');
  const sc = $('#entriesScroll');
  if (!box || !sc) return false;

  const total = n.entries.length;
  let start, end;
  let sentinel = null;

  if (earlier) {
    sentinel = $('#loadEarlier');
    end = Store.ui.loadedStart;
    start = Math.max(0, end - PAGING.chunk);
    if (end === start) return false;
  } else {
    sentinel = $('#loadLater');
    start = Store.ui.loadedEnd;
    if (start >= total) { if (sentinel) sentinel.remove(); return false; }
    end = Math.min(total, start + PAGING.chunk);
  }

  const oldH = sc.scrollHeight;
  const oldTop = sc.scrollTop;
  const anchor = captureScrollAnchor(sc, box);
  ensureGlobalMeta();

  /* 跨切片第一条要不要显示"日期分隔"：拿切片外那一秒的日期做基准 */
  let h = '';
  let lastDay = earlier
    ? (end < total ? dayKeyOfEntry(n.entries[end]) : '')
    : (start > 0 ? dayKeyOfEntry(n.entries[start - 1]) : '');
  let idx = 0;

  /* 切片里也要认变体：锚点在切片内 → 合并成翻页行；
     锚点在切片外（已经渲染过）→ 若它的翻页行已在 DOM，这一版已经收在翻页里，
     不再单独成行（否则同一内容会出现两次）。 */
  const { altOf, isAlt } = buildAltGroups(n, start, end);
  for (let i = start; i < end; i++) {
    const e = n.entries[i];
    if (isAlt.has(e.id)) continue;
    const anchor = altAnchorOf(e, n);
    if (anchor && box.querySelector('.alt-row[data-alt-anchor="' + anchor.id + '"]')) continue;
    const dk = dayKeyOfEntry(e);
    const showDay = dk !== lastDay;
    if (showDay) lastDay = dk;
    const variants = altOf.get(e.id);
    if (variants) {
      if (showDay) h += dayChipHTML(e.createdAt, idx, e);
      h += altRowHTML(e, variants, idx, n, Store.ui.altIndex.get(e.id) || 0);
      idx++;
    } else {
      h += entryBlockHTML(e, idx, n, showDay);
      idx++;
    }
  }

  if (earlier) {
    if (sentinel) {
      /* ★ 哨兵必须永远待在列表最上面。
         以前把新记录插在哨兵"前面"（beforebegin），每加载 40 条哨兵就下沉
         40 行 —— 几十批后哨兵跑到内容底部，滚到顶永远碰不到它，
         于是"加载一定条数后就再也加载不动"。
         正确做法：先把哨兵扶回第一位，再把新记录插到它后面。 */
      if (box.firstElementChild !== sentinel) box.insertBefore(sentinel, box.firstChild);
      sentinel.insertAdjacentHTML('afterend', h);
    } else {
      box.insertAdjacentHTML('afterbegin', h);
    }
    Store.ui.loadedStart = start;
    if (sentinel) {
      if (start === 0) sentinel.remove();
      else sentinel.textContent = '向上滚动加载更早的记录 · 还有 ' + start + ' 条';
    }
  } else {
    if (sentinel) sentinel.insertAdjacentHTML('beforebegin', h);
    else box.insertAdjacentHTML('beforeend', h);
    Store.ui.loadedEnd = end;
    if (sentinel) {
      if (end === total) sentinel.remove();
      else sentinel.textContent = '向下滚动加载更新的记录 · 还有 ' + (total - end) + ' 条';
    }
  }

  /* 新内容插在视口上方会让位置跳，按"顶部那条记录"补偿回来 */
  if (!restoreScrollAnchor(sc, anchor)) {
    const newH = sc.scrollHeight;
    sc.scrollTo({ top: oldTop + (newH - oldH), behavior: 'auto' });
  }
  hydrateImages(box);
  return true;
}

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
    loadSlice(n, 'earlier');
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
    loadSlice(n, 'later');
  } finally {
    loadingLater = false;
  }
}

export function clearLaterObs() {
  if (laterIO) { laterIO.disconnect(); laterIO = null; }
}

/* 哨兵观察器 —— 每次加载后都要重新挂。
   注意：回调里必须重新取"当前话题"，不能闭包着 arm 时的 node。
   否则切换话题后旧的观察器会把新话题的哨兵绑到旧话题上，loadEarlier 永远
   提前 return，"还有记录却加载不出来"。 */
export function armLoadEarlier(node) {
  clearEarlierObs();
  prevSentinelTop = null;       /* 换了视图，重新开始判断"有没有再往上滑" */
  const sentinel = document.getElementById('loadEarlier');
  if (!sentinel || !node) return;
  const armedId = node.id;
  earlierIO = new IntersectionObserver(ents => {
    if (!ents.some(e => e.isIntersecting)) return;
    clearEarlierObs();
    try {
      const cur = Store.node(Store.ui.selectedId);
      if (!cur || cur.id !== armedId) return;      /* 视图已经换了，不自绑 */
      loadEarlier(cur);
    } catch (err) {
      console.error('[loadEarlier] 出错', err);
    } finally {
      /* ★ 不管这次成没成，只要还有更早的记录就重新挂上观察器。
         否则抛一次错/提前 return 就永久失去加载能力。 */
      if (document.getElementById('loadEarlier')) {
        const again = Store.node(Store.ui.selectedId);
        if (again) armLoadEarlier(again);
      }
    }
  }, {
    /* root = viewport（null）：不管真正滚动的是窗口还是某个容器，
       IntersectionObserver 都会把祖先的裁剪算进去，比盯某个元素稳。
       rootMargin 提前 600px 预加载，滑到顶之前就开始取。 */
    root: null,
    rootMargin: '600px 0px',
    threshold: 0,
  });
  earlierIO.observe(sentinel);
}

export function armLoadLater(node) {
  clearLaterObs();
  const sentinel = document.getElementById('loadLater');
  if (!sentinel || !node) return;
  const armedId = node.id;
  laterIO = new IntersectionObserver(ents => {
    if (!ents.some(e => e.isIntersecting)) return;
    clearLaterObs();
    const cur = Store.node(Store.ui.selectedId);
    if (!cur || cur.id !== armedId) return;        /* 视图已经换了，不自绑 */
    loadLater(cur);
    if (document.getElementById('loadLater')) armLoadLater(cur);
  }, { root: null, rootMargin: '600px 0px', threshold: 0 });
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

/** 只把分页窗口换成"包含这条记录"的样子，不闪烁、不强制对齐（清缓存恢复用）。 */
export function renderAroundEntry(node, eid) {
  if (!node || !eid) return false;
  const row = document.querySelector('#entries .entry-row[data-eid="' + eid + '"]');
  if (row) return true;                       // 已经在当前窗口里
  if (typeof D.showAround !== 'function') return false;
  D.showAround(node, eid);
  return true;
}

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
      /* 目标是"变体"时，窗口里它是被收起的，激活那一版 */
      setTimeout(() => { try { D.activateAlt?.(targetId); } catch (e) {} }, 0);
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