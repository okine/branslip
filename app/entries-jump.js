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

import { $ } from './utils.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { dayKey, fmtStamp } from './format.js';
import { ensureGlobalMeta } from './meta-row.js';
import { entryBlockHTML } from './entries-render.js';
import { hydrateImages } from './image.js';
import { scrollIntoViewIn, flashEl } from './scroll-utils.js';
import { toast } from './ui.js';

/* ---------- 依赖注入 ---------- */
let D = { renderEntries: () => {} };
export function wireEntriesJump(h) { Object.assign(D, h); }

/* ---------- 常量 / 模块状态 ---------- */
const CHUNK_SIZE = 40;
const IDLE_LOAD_COOLDOWN = 500;

let loadingEarlier = false;
let lastIdleLoadAt = 0;
let earlierIO = null;

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
    const start = Math.max(0, end - CHUNK_SIZE);
    if (end === start) return;

    const oldH = sc.scrollHeight;
    const oldTop = sc.scrollTop;
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

    const newH = sc.scrollHeight;
    sc.scrollTo({ top: oldTop + (newH - oldH), behavior: 'auto' });
    hydrateImages(box);
  } finally {
    loadingEarlier = false;
  }
}

export function clearEarlierObs() {
  if (earlierIO) { earlierIO.disconnect(); earlierIO = null; }
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

    /* 2. 单话题视图 + 有更早分页 → 加载后重试。
       ★ 必须 !merged：合并视图下 currentViewNodeId() 返回 null，
          loadEarlier 会因身份不符直接 return，
          tries 下一帧再进同一分支 → 无限 rAF。 */
    if (!Store.ui.merged
        && document.getElementById('loadEarlier')
        && currentViewNodeId() === node.id) {
      loadEarlier(node);
      requestAnimationFrame(tries);
      return;
    }

    /* 3. 目标在折叠区间里 → 展开后重试 */
    const hit = Store.entry(targetId);
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
    toast(Store.ui.merged
      ? '找不到那条记录（可能在更早的时间流里，滚到顶部加载后再试）'
      : '找不到那条记录（可能在更早的月份，未被加载或已折叠）');
  };

  requestAnimationFrame(tries);
}

export function jumpToBlock(node, blockId) {
  const tries = () => {
    const i = Mutate.findEntryIndexByBlockId(node, blockId);
    if (i >= 0) { jumpToRow(node, node.entries[i].id); return; }

    if (!Store.ui.merged
        && document.getElementById('loadEarlier')
        && currentViewNodeId() === node.id) {
      loadEarlier(node);
      requestAnimationFrame(tries);
      return;
    }
    toast(Store.ui.merged
      ? '找不到那条记录（可能在更早的时间流里，滚到顶部加载后再试）'
      : '找不到那条记录');
  };
  requestAnimationFrame(tries);
}

export function jumpToStamp(node, stamp) {
  const tries = () => {
    const t = node.entries.find(e => entryStamp(e) === stamp);
    if (t) { jumpToRow(node, t.id); return; }

    /* 合并视图补上身份检查。 */
    if (!Store.ui.merged
        && document.getElementById('loadEarlier')
        && currentViewNodeId() === node.id) {
      loadEarlier(node);
      requestAnimationFrame(tries);
      return;
    }
    toast(Store.ui.merged
      ? '找不到那条记录（可能在更早的时间流里，滚到顶部加载后再试）'
      : '找不到那条记录（可能已被删除）');
  };
  requestAnimationFrame(tries);
}