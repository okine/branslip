// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= entries.js =================
 * 记录列表领域。
 *
 * 覆盖：
 *   - 主区渲染（单话题 / 合并视图 / 折叠 / 分页加载）
 *   - 单条记录交互（编辑 / 删除 / 移动 / 置顶 / 复制引用）
 *   - 多选折叠
 *   - 日期跳转 / 滚动到底部
 *   - 置顶条 + 置顶页
 *   - 合并视图（选择话题合并）
 *
 * 与其它模块的边界：
 *   - 需要 setReply（在 composer）→ 通过 wireEntries 注入
 *   - 需要 renderAll（在 app）    → 通过 wireEntries 注入
 *   - 其它一切依赖都从模块直接 import
 */

import { $, esc } from './utils.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { dayKey } from './format.js';
import { hydrateImages, resetImgObserver } from './image.js';
import { toast, openMenuAt } from './ui.js';
import {
   entryInnerHTML, entryBlockHTML, 
   setLastAdded, clearLastAdded,
} from './entries-render.js';
import { scrollIntoViewIn, scrollToBottom, flashEl } from './scroll-utils.js';
import {
  clearMultiSelect, doFold,
  buildEntryMenuItems, handleEntriesClick,
  wireOps,
} from './entries-ops.js';
import {
  renderPins, toggleEntryPin, rebuildPinRowMap, syncPinCursorFromScroll,
} from './pins.js';
import { updateDateJump } from './entries-date.js';
import './ref-preview.js';
import {
  addGlobalMetaFor,
  ensureGlobalMeta,
  refreshMetaForRefs,
} from './meta-row.js';
import {
  armLoadEarlier,
  armLoadLater,
  clearEarlierObs,
  clearLaterObs,
  rememberScroll,
  setDirectWindow,
  isDirectWindow,
  updateScrollBtn,
  jumpToRow, 
  wireEntriesJump,
} from './entries-jump.js';
// entries.js
const findNode = Store.node;
/* ---------- 依赖注入 ---------- */
let D = {
  setReply: () => {},
  setRelevance:  () => {},   // ★
  
  renderAll: () => {},
  renderMerged: () => {},
  select: () => {},
};
export function wireEntries(h) { Object.assign(D, h); }

/* ---------- 模块状态 ---------- */
const PAGE_SIZE = 80;       // 初始渲染条数（保留原语义）

let firstMain = true;
let dateJumpRaf = null;

const findEntry = Store.entry;

/* 只重绘指定 entry 那一行的 meta-row */
/* ---------- 单条记录的 HTML ---------- */


/* 完整一行 —— 初次渲染和 appendEntry 用。 */
/* ============================================================
 * 主区渲染
 * ============================================================ */



export function renderEntries() {
  setDirectWindow(false);
  clearEarlierObs();
  clearLaterObs();
  /* ★ flashEntry 是"下一帧要闪的那一条"，必须在本帧被消费掉 ——
     所以在这里就快照 + 清空，而不是等到函数末尾。
     老实现只在成功路径末尾清，下面三个早退分支（未选中 / 空话题 / 合并视图）
     会把它留在 Store 里，等下一次别的话题渲染成功时拿着一个过期的 id
     去跳转（还会白 toast 一次"找不到那条记录"）。
     代价：清早了 + 这次渲染失败，闪一下的效果丢掉 —— 这是有意的取舍。 */
  const flashId = Store.ui.flashEntry;
  Store.ui.flashEntry = null;

  if (Store.ui.merged) {
    rebuildPinRowMap();
    return D.renderMerged();
  }
  const box = $('#entries'), n = findNode(Store.ui.selectedId);
  if (!n) {
    rebuildPinRowMap();
    box.className = '';
    box.innerHTML =
      '<div class="empty"><div class="q">“</div><h3>从左侧开始第一层话题</h3>' +
      '<p>在左下角点击「新建根话题」，每个话题里都能继续<br></p></div>';
    renderPins(); 
    return;
  }
  if (!n.entries.length ) {
    rebuildPinRowMap();
    box.className = '';
    box.innerHTML = '<div class="empty"><div class="q">“</div><h3>「' + esc(n.title) + '」还是空白的</h3>' +
      '<p>在下方输入框写下第一条记录，按下 <kbd>Enter</kbd> 即可。<br>也可以直接粘贴或拖入图片，或在左侧继续细分子话题。</p></div>';
    renderPins(); 
    return;
  }
  

  const total = n.entries.length;
  const start = Math.max(0, total - PAGE_SIZE);
  Store.ui.loadedStart = start;
  Store.ui.loadedEnd = total;
  ensureGlobalMeta()

  const foldCover = Mutate.buildFoldCover(n, start);
  let h = '', lastDay = start > 0 ? dayKey(n.entries[start - 1].createdAt) : '', idx = 0;

  for (let i = start; i < total; i++) {
    let foldInfo = null;
    const cov = foldCover.get(i);
    if (cov && cov.fold) {
      const f = cov.fold;
      const key = Mutate.foldKey(f.from, f.to);
      const expanded = Store.ui.expandedFolds.has(key);
      const count = cov.b - cov.a + 1;
      if (!expanded) { if (i !== cov.b) continue; }
      foldInfo = { key, expanded, count, isLast: (i === cov.b) };
    }
    const e = n.entries[i];
    const dk = dayKey(e.createdAt);
    const showDay = dk !== lastDay;
    if (showDay) lastDay = dk;
    h += entryBlockHTML(e, idx, n, showDay, foldInfo);
    idx++;
  }

  if (start > 0) {
    h = '<div class="load-earlier" id="loadEarlier">向上滚动加载更早的记录 · 还有 ' + start + ' 条</div>' + h;
  }

  box.className = firstMain ? 'stagger' : '';
  firstMain = false;
  box.innerHTML = h;

  resetImgObserver();

  if (flashId) {
    requestAnimationFrame(() => {              // ← 等布局稳定
      const el = box.querySelector('[data-eid="' + flashId + '"]');
      if (el) {
        scrollIntoViewIn($('#entriesScroll'), el, {
          align: 'top', offset: 20,
          smooth: false,                        // ★ 硬跳
        });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1700);
      } else if (n) {
        jumpToRow(n, flashId);
      }
    });
  }

  hydrateImages();
  renderPins();
  rebuildPinRowMap();

  /* 等切话题的 scrollTop 恢复先落下去，再挂“向上加载”哨兵；
     否则哨兵在旧位置先触发 loadEarlier，会把用户往回带。 */
  setTimeout(() => {
    if (Store.ui.selectedId !== n.id) return;
    if (document.getElementById('loadEarlier')) armLoadEarlier(n);
  }, 0);
}

/**
 * 定位用的快速下标查找：entries 按 createdAt 升序，
 * 先用 Store.entry 拿到目标的时间，再二分；O(log N) 而不是 O(N)。
 */
function findEntryIndexFast(n, targetId) {
  const hit = Store.entry(targetId);
  if (!hit || hit.node !== n || !n.entries.length) return -1;
  const list = n.entries;
  const ms = hit.e.createdAt;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].createdAt < ms) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] && list[lo].id === targetId) return lo;
  /* 同毫秒/异常排序时做一次邻域校正，再退回线性兜底 */
  for (let i = Math.max(0, lo - 2); i < Math.min(list.length, lo + 3); i++) {
    if (list[i].id === targetId) return i;
  }
  return list.findIndex(e => e.id === targetId);
}

/**
 * 直接定位：只渲染 target 前后各 10 条。
 * 不挂"回到最新"横幅；上下各挂一个普通加载哨兵，
 * 向上继续 loadEarlier，向下继续 loadLater，保持正常滚动。
 */
function renderEntriesAround(n, targetId) {
  const box = $('#entries');
  if (!n || !box) { renderEntries(); return; }

  const total = n.entries.length;
  const target = findEntryIndexFast(n, targetId);
  if (target < 0) {
    toast('找不到那条记录');
    renderEntries();
    return;
  }

  const B = 10;
  const start = Math.max(0, target - B);
  const end = Math.min(total, target + B + 1);

  setDirectWindow(true);
  Store.ui.loadedStart = start;
  Store.ui.loadedEnd = end;
  ensureGlobalMeta();
  clearEarlierObs();
  clearLaterObs();

  let h = '';
  let lastDay = start > 0 ? dayKey(n.entries[start - 1].createdAt) : '', idx = 0;
  for (let i = start; i < end; i++) {
    const e = n.entries[i];
    const dk = dayKey(e.createdAt);
    const showDay = dk !== lastDay;
    if (showDay) lastDay = dk;
    h += entryBlockHTML(e, idx, n, showDay, null);
    idx++;
  }

  let head = '';
  if (start > 0) {
    head = '<div class="load-earlier" id="loadEarlier">向上滚动加载更早的记录 · 还有 ' +
      start + ' 条</div>';
  }
  let tail = '';
  if (end < total) {
    tail = '<div class="load-earlier" id="loadLater">向下滚动加载更新的记录 · 还有 ' +
      (total - end) + ' 条</div>';
  }

  box.className = '';
  box.innerHTML = head + h + tail;
  resetImgObserver();
  hydrateImages(box);
  renderPins();
  rebuildPinRowMap();
  updateScrollBtn();

  requestAnimationFrame(() => {
    const el = box.querySelector('[data-eid="' + targetId + '"]');
    if (!el) return;
    scrollIntoViewIn($('#entriesScroll'), el, {
      align: 'top',
      offset: 20,
      smooth: false,
    });
    flashEl(el);

    /* ★ 先定位，再挂分页哨兵。
       否则目标窗口的顶部哨兵一开始就在视口里，IntersectionObserver
       会立刻 loadEarlier，插入旧记录后再纠正滚动 —— 看起来就是
       “定位后突然往下跳”。 */
    if (document.getElementById('loadEarlier')) armLoadEarlier(n);
    if (document.getElementById('loadLater')) armLoadLater(n);
  });
}

export function updateTopCount() {
  const n = findNode(Store.ui.selectedId);
  if (n) $('#topCount').textContent = n.entries.length + ' 条记录';
}

export function appendEntry(n, e) {
  setLastAdded(e.id);
   /* ★ 改成：确保 map 存在 → 增量 bump。
     不要再清 null —— 清了就丢增量更新的入口。 */
  ensureGlobalMeta();
  addGlobalMetaFor(e);
  const wasWindow = isDirectWindow();
  const box = $('#entries');
  if (Store.ui.merged || wasWindow || !box.querySelector('.entry-row')) {
    renderEntries();
    if (wasWindow) {
      const s = $('#entriesScroll');
      const sid = n.id;
      [0, 60, 180, 400].forEach(t => setTimeout(() => {
        if (Store.ui.selectedId === sid) scrollToBottom(s, false);
      }, t));
    }
    clearLastAdded();
    return;
  }
  const prev = n.entries[n.entries.length - 2];
  const showDay = !prev || dayKey(prev.createdAt) !== dayKey(e.createdAt);
  const idx = n.entries.length - 1;
  box.insertAdjacentHTML('beforeend', entryBlockHTML(e, idx, n, showDay));
  const newRow = box.lastElementChild;
  hydrateImages(newRow);
  refreshMetaForRefs(e);
  Store.ui.loadedEnd = n.entries.length;

  const s = $('#entriesScroll');
  scrollToBottom(s, false);
  clearLastAdded();
  const sid = n.id;
  [60, 180, 400].forEach(t => setTimeout(() => {
    if (Store.ui.selectedId === sid) scrollToBottom(s, false);
  }, t));
  updateScrollBtn();
  rebuildPinRowMap();
}


export function removeEntryRow(eid, n) {
  const box = $('#entries');
  const row = box.querySelector('.entry-row[data-eid="' + eid + '"]');
  if (!row) { renderEntries(); return; }
  const dk = row.dataset.day;
  row.remove();
  if (!box.querySelector('.entry-row[data-day="' + dk + '"]')) {
    const chip = box.querySelector('.day-chip[data-day="' + dk + '"]');
    if (chip) chip.remove();
  }
  if (!box.querySelector('.entry-row')) renderEntries();
  else rebuildPinRowMap(); 
}

function replaceRow(eid, n) {
  const row = document.querySelector('#entries .entry-row[data-eid="' + eid + '"]');
  if (!row) return false;
  const hit = findEntry(eid);
  if (!hit || hit.node !== n) return false;
  const ent = hit.e;

  const oldEntry = row.querySelector(':scope > .entry');
  if (!oldEntry) return false;

  const tmp = document.createElement('div');
  tmp.innerHTML = entryInnerHTML(ent, n);
  const newEntry = tmp.firstElementChild;

  /* 就地替换，外层 .entry-row / .tools / .fold-ctrl / data-* 全部保留 */
  oldEntry.replaceWith(newEntry);
  hydrateImages(newEntry);
  return true;
}




/* 全屏界面里 .pp-card 的右键 —— 只读菜单（复制类操作） */
document.addEventListener('contextmenu',e=>{
    if(e.defaultPrevented)return;                    /* 主区 / 树已经处理过 */
    const sel=window.getSelection();
    if(sel&&sel.type==='Range'&&sel.toString().trim().length)return;
    const card=e.target.closest('.pp-card[data-eid]');
    if(!card)return;
    e.preventDefault();
    const hit=findEntry(card.dataset.eid);if(!hit)return;
    openMenuAt(e.clientX,e.clientY,buildEntryMenuItems(hit,{readonly:true}));
  });
  

/* ============================================================
 * 事件绑定
 * ============================================================ */

/* #entries 上的所有交互统一转给 entries-ops 的路由 */
$('#entries').addEventListener('click', e => handleEntriesClick(e));


$('#entries').addEventListener('contextmenu', e => {
  if (Store.ui.editingEntry) return;
  const sel = window.getSelection();
  if (sel && sel.type === 'Range' && sel.toString().trim().length) return;
  const row = e.target.closest('.entry-row[data-eid]'); if (!row) return;
  e.preventDefault();
  const hit = findEntry(row.dataset.eid); if (!hit) return;
  openMenuAt(e.clientX, e.clientY, buildEntryMenuItems(hit, { readonly: false }));
});

$('#entries').addEventListener('dblclick', e => {
  if (e.target.closest('img.eimg')) return;
  if (e.target.closest('a')) return;
  if (e.target.closest('.md-pre-copy')) return;
  if (Store.ui.editingEntry) return;
  if (e.target.closest('.tools')) return;
  if (e.target.closest('.reply-badge')) return; 
  if (e.target.closest('.relevance-badge')) return;   // ★ 新增
  if (e.target.closest('.mirror-badge'))    return;   // ★ 新增
  const row = e.target.closest('.entry-row'); if (!row) return;
  const hit = findEntry(row.dataset.eid); if (!hit) return;
  D.setReply(hit.e);
});

$('#entriesScroll').addEventListener('scroll', () => {
  if (Store.ui.selectedId && !Store.ui.merged) {
    rememberScroll(Store.ui.selectedId, $('#entriesScroll').scrollTop);
  }
  if (dateJumpRaf) return;
  dateJumpRaf = requestAnimationFrame(() => {
    dateJumpRaf = null;
    updateDateJump();
    updateScrollBtn();
    syncPinCursorFromScroll();
  });
}, { passive: true });

$('#multiBar').addEventListener('click', e => {
  if (e.target.closest('.mb-fold')) { doFold(); return; }
  if (e.target.closest('.mb-cancel')) { clearMultiSelect(); return; }
});



// entries.js 末尾


wireOps({
  replaceRow,
  renderEntries,
  removeEntryRow,
  updateTopCount,

  renderPins,
  toggleEntryPin,
  setReply:  (...a) => D.setReply(...a),   // 转发 composer 注入
  setRelevance: (...a) => D.setRelevance(...a),   // ★
  renderAll: (...a) => D.renderAll(...a),  // 转发 app 注入
  select: (...a) => D.select(...a),
});
wireEntriesJump({ renderEntries, showAround: renderEntriesAround });