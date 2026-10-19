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

import { $, esc, countLabel } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { fmtStamp, dayKey } from './format.js';
import { writePins, writeFolds } from './io.js';
import { hydrateImages, openTopicLightbox,resetImgObserver } from './image.js';
import { enqueue } from './writer.js';
import { toast, openMenuAt } from './ui.js';
import {
   entryInnerHTML, entryBlockHTML, 
   setLastAdded, clearLastAdded,
} from './entries-render.js';
import { scrollIntoViewIn, scrollToBottom, flashEl } from './scroll-utils.js';
import {
  startEdit, 
  enterDelConfirm, 
  moveEntryTo,
  handleMultiClick, clearMultiSelect, doFold,
  buildEntryMenuItems,
  wireOps,
} from './entries-ops.js';
import { updateDateJump } from './entries-date.js';
import { select } from './tree.js';
import './ref-preview.js';
import {
  renderMetaRow,
  replaceMetaRow,
  addGlobalMetaFor,
  ensureGlobalMeta,
  refreshMetaForRefs,
} from './meta-row.js';
import {
  armLoadEarlier,
  scheduleIdleLoad,
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
  openPinPage: () => {},
  renderMerged: () => {},
};
export function wireEntries(h) { Object.assign(D, h); }

/* ---------- 模块状态 ---------- */
const PAGE_SIZE = 80;       // 初始渲染条数（保留原语义）

let firstMain = true;
let _lastPinSig = null;
let dateJumpRaf = null;
let suppressPinSyncUntil = 0;
let pinRowMap = new Map();

const findEntry = Store.entry;







/* 只重绘指定 entry 那一行的 meta-row */
function refreshRowMetaFor(e, n) {
  const row = document.querySelector('#entries .entry-row[data-eid="' + e.id + '"]');
  replaceMetaRow(row, e, n);
}



/* 建表 —— 只在 DOM 结构变动后调用 */
function rebuildPinRowMap() {
  pinRowMap = new Map();
  const box = document.getElementById('entries');
  if (!box) return;
  for (const row of box.querySelectorAll('.entry-row')) {
    if (row.dataset.eid) pinRowMap.set(row.dataset.eid, row);
  }
}
/* ---------- 单条记录的 HTML ---------- */


/* 完整一行 —— 初次渲染和 appendEntry 用。 */
/* ============================================================
 * 主区渲染
 * ============================================================ */



export function renderEntries() {
  /* ★ flashEntry 是"下一帧要闪的那一条"，必须在本帧被消费掉 ——
     所以在这里就快照 + 清空，而不是等到函数末尾。
     老实现只在成功路径末尾清，下面三个早退分支（未选中 / 空话题 / 合并视图）
     会把它留在 Store 里，等下一次别的话题渲染成功时拿着一个过期的 id
     去跳转（还会白 toast 一次"找不到那条记录"）。
     代价：清早了 + 这次渲染失败，闪一下的效果丢掉 —— 这是有意的取舍。 */
  const flashId = Store.ui.flashEntry;
  Store.ui.flashEntry = null;

  if (Store.ui.merged) {
    pinRowMap = new Map();      // ★ 清空
    return D.renderMerged();
  }
  const box = $('#entries'), n = findNode(Store.ui.selectedId);
  if (!n) {
    pinRowMap = new Map();
    box.className = '';
    box.innerHTML =
      '<div class="empty"><div class="q">“</div><h3>从左侧开始第一层话题</h3>' +
      '<p>在左下角点击「新建根话题」，每个话题里都能继续<br></p></div>';
    renderPins(); 
    return;
  }
  if (!n.entries.length ) {
    pinRowMap = new Map();
    box.className = '';
    box.innerHTML = '<div class="empty"><div class="q">“</div><h3>「' + esc(n.title) + '」还是空白的</h3>' +
      '<p>在下方输入框写下第一条记录，按下 <kbd>Enter</kbd> 即可。<br>也可以直接粘贴或拖入图片，或在左侧继续细分子话题。</p></div>';
    renderPins(); 
    return;
  }
  

  const total = n.entries.length;
  const start = Math.max(0, total - PAGE_SIZE);
  Store.ui.loadedStart = start;
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
  armLoadEarlier(n);

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
  scheduleIdleLoad(n);    // ★ 新增 —— 初始 80 条渲染完成后，空闲预加载 40 条
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
  const box = $('#entries');
  if (Store.ui.merged || !box.querySelector('.entry-row')) {
    renderEntries();
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

  const s = $('#entriesScroll');
  scrollToBottom(s, false);
  clearLastAdded();
  [60, 180, 400].forEach(t => setTimeout(() => scrollToBottom(s, false), t));
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




/* ============================================================
 * 置顶条 + 置顶页
 * ============================================================ */

export function renderPins() {
  const bar = $('#pinBar');
  if (Store.ui.merged) { bar.innerHTML = ''; bar.style.display = 'none'; return; }

  const n = findNode(Store.ui.selectedId);
  const list = n ? Mutate.pinnedEntries(n) : [];

  if (!list.length) {
    _lastPinSig = null;
    bar.innerHTML = ''; bar.style.display = 'none';
    return;
  }

  // ★ 列表签名变了 → 用户视角下的"置顶集合"变了，pinCursor 作废
  const sig = list.map(e => e.id).join('\u0000');
  if (sig !== _lastPinSig) {
    _lastPinSig = sig;
    Store.ui.pinCursor = null;
  }
  let idx = (Store.ui.pinCursor != null && Store.ui.pinCursor >= 0 && Store.ui.pinCursor < list.length)
    ? Store.ui.pinCursor : list.length - 1;
  const e = list[idx];
  const prev = e.text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || '[图片]';

  bar.innerHTML =
    '<button class="pin-chip" data-loc="' + e.id + '" data-pin-idx="' + idx + '" title="点击定位">' +
      '<span class="p-ic">' + I.pin + '</span>' +
      '<span class="t">' + esc(prev.slice(0, 60)) + '</span>' +
    '</button>' +
    (list.length > 1 ? '<span class="pin-sep">丨</span><button class="pin-cnt">共 ' + countLabel(list.length) + ' 条</button>' : '') +
    '<button class="pin-more" title="查看全部置顶">' + I.menu + '<span>全部置顶</span></button>';
  bar.style.display = 'flex';
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
  

export function toggleEntryPin(n, e) {
  if (!n || !e) return;
  const nowPinned = Mutate.togglePin(n, e);
  toast(nowPinned ? '已置顶，右栏顶部可查看' : '已取消置顶');
  enqueue(() => writePins(n));
  renderPins();
  refreshRowMetaFor(e, n);
}

function syncPinCursorFromScroll() {
  if (Store.ui.merged) return;
  if (Date.now() < suppressPinSyncUntil) return;
  const n = findNode(Store.ui.selectedId);
  if (!n) return;
  const list = Mutate.pinnedEntries(n);
  if (!list.length) return;

  const sc = $('#entriesScroll');
  if (!sc) return;
  const scRect = sc.getBoundingClientRect();
  const refY = scRect.bottom - 4;   // 底部基准线：稍微往上一点

  let best = -1, bestTop = -Infinity;   // 最近滚过基准线的置顶
  let firstVisible = -1;                // 全都还在下方时，取最上面那条

  for (let i = 0; i < list.length; i++) {
    const row = pinRowMap.get(list[i].id);
    if (!row || !row.isConnected) continue;          // ★ 直接查表，带 isConnected 兜底       // 那条被分页截断了，跳过
    const top = row.getBoundingClientRect().top;
    if (top <= refY) {
      if (top > bestTop) { bestTop = top; best = i; }
    } else if (firstVisible < 0) {
      firstVisible = i;
    }
  }

  const next = best >= 0
    ? best
    : (firstVisible >= 0 ? firstVisible : list.length - 1);

  if (Store.ui.pinCursor !== next) {
    Store.ui.pinCursor = next;
    renderPins();                       // 只在真正变化时重绘
  }
}


/* ============================================================
 * 滚动按钮：底部回底 / 顶部对齐
 * ============================================================ */

/**
 * 找当前"跨过视口顶部"的第一个可见块。
 * 返回 { el, cut } —— cut=true 表示它被切了（顶部在视口之上）。
 * day-chip 也算（它是内容的一部分，被切一半也该对齐）。
 */
function topCutItem() {
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

/**
 * 把当前顶部那条滚到完全贴齐顶部。
 * 已经贴齐 → 什么都不做。
 */
function scrollToCurrentTop() {
  const sc = $('#entriesScroll'), box = $('#entries');
  const t = topCutItem();
  if (!sc || !box || !t) return;
  const padTop = parseFloat(getComputedStyle(box).paddingTop) || 0;
  scrollIntoViewIn(sc, t.el, { align: 'top', offset: padTop });
}

export function updateScrollBtn() {
  const s = $('#entriesScroll');
  if (!s) return;

  const dist = s.scrollHeight - s.scrollTop - s.clientHeight;

  /* 到底按钮：离底部 > 200px 显示 */
  const bottomBtn = $('#scrollBottomBtn');
  if (bottomBtn) bottomBtn.classList.toggle('on', dist > 200);

  /* 到顶按钮：顶部那条被切断才显示 */
  const topBtn = $('#scrollTopBtn');
  if (topBtn) {
    if (s.scrollTop < 100) { topBtn.classList.remove('on'); return; }
    const t = topCutItem();
    topBtn.classList.toggle('on', !!(t && t.cut));
  }
}
/* ============================================================
 * 事件绑定
 * ============================================================ */

/* #entries 上的所有交互：折叠、多选、图片灯箱、工具按钮 */
$('#entries').addEventListener('click', e => {
  /* 已有多选、但这次点击不是"多选点击" → 先清掉选中 */
  if (Store.ui.multiSelect.size) {
    const mrow = e.target.closest('.entry-row');
    const isMultiClick = mrow
      && (e.ctrlKey || e.metaKey || e.shiftKey)
      && !e.target.closest('[data-eact]')     // 工具按钮（编辑/置顶/移动/删除）
      && !e.target.closest('.md-ref')         // 内部引用
      && !e.target.closest('.md-tag')         // #标签
      && !e.target.closest('img.eimg');       // 图片（走灯箱）
    if (!isMultiClick) clearMultiSelect();
  }
  const badge = e.target.closest('.reply-badge');
  if (badge) {
    const sc = $('#entriesScroll');
    const target = document.querySelector('#entries .entry-row[data-eid="' + badge.dataset.replyTo + '"]');
    if (target) {
      scrollIntoViewIn(sc, target, { align: 'center' });
      flashEl(target);
    } else {
      const cur = findNode(Store.ui.selectedId);
      if (cur) jumpToRow(cur, badge.dataset.replyTo);
    }
    return;
  }
  /* 关联徽章 → 跳到第一条关联消息 */
  const relBadge = e.target.closest('.relevance-badge');
  if (relBadge) {
    const sc = $('#entriesScroll');
    const target = document.querySelector('#entries .entry-row[data-eid="' + relBadge.dataset.relevTo + '"]');
    if (target) {
      scrollIntoViewIn(sc, target, { align: 'center' });
      flashEl(target);
    } else {
      const cur = findNode(Store.ui.selectedId);
      if (cur) jumpToRow(cur, relBadge.dataset.relevTo);
    }
    return;
  }


  /* 镜像徽章 → 跳到第一处镜像（可能跨话题） */
const mirrorBadge = e.target.closest('.mirror-badge');
if (mirrorBadge) {
  const targetId = mirrorBadge.dataset.mirrorOf;
  const sc = $('#entriesScroll');

  /* 1. 目标已在当前 DOM 里 → 直接定位 */
  const target = document.querySelector(
    '#entries .entry-row[data-eid="' + targetId + '"]'
  );
  if (target) {
    scrollIntoViewIn(sc, target, { align: 'center' });
    flashEl(target);
    return;
  }

  /* 2. 不在 DOM 里 → 从全局索引判断目标属于哪个 node */
  const hit = findEntry(targetId);           // Store.entry(id) → { e, node }
  if (!hit) { toast('找不到那条记录'); return; }

  if (hit.node.id !== Store.ui.selectedId) {
    /* 跨话题：设好 flashEntry 再切 */
    Store.ui.flashEntry = targetId;
    select(hit.node.id, { noScrollRestore: true });
  } else {
    /* 同话题但被分页 / 折叠截断 —— 交给 jumpToRow 处理 */
    jumpToRow(hit.node, targetId);
  }
  return;
}

  const tog = e.target.closest('.fold-toggle');
  if (tog) {
    const key = tog.dataset.fold;
    if (Store.ui.expandedFolds.has(key)) Store.ui.expandedFolds.delete(key);
    else Store.ui.expandedFolds.add(key);
    renderEntries();
    return;
  }
  const cxl = e.target.closest('.fold-cancel');
  if (cxl) {
    const key = cxl.dataset.fold;
    const [from, to] = key.split('|').map(Number);
    const n0 = findNode(Store.ui.selectedId);
    if (n0) {
      Mutate.removeFold(n0, from, to);
      enqueue(() => writeFolds(n0));
      Store.ui.expandedFolds.delete(key);
      renderEntries();
      toast('已取消折叠');
    }
    return;
  }
  const row0 = e.target.closest('.entry-row');
  if (row0 && (e.ctrlKey || e.metaKey || e.shiftKey)
      && !e.target.closest('[data-eact]')
      && !e.target.closest('.md-ref') && !e.target.closest('.md-tag')
      && !e.target.closest('img.eimg')) {
    e.preventDefault(); e.stopPropagation();
    handleMultiClick(row0.dataset.eid, e.shiftKey);
    return;
  }
  const im = e.target.closest('img.eimg.ok');
  if (im) {
    const row = im.closest('.entry-row');
    const hit = row ? findEntry(row.dataset.eid) : null;
    if (hit) openTopicLightbox(hit.node, hit.e, im.dataset.path);
    return;
  }

  const btn = e.target.closest('[data-eact]'); if (!btn) return;
  const row = e.target.closest('[data-eid]'); const eid = row.dataset.eid;
  const hit = findEntry(eid); if (!hit) return;
  const n = hit.node, ent = hit.e;
  const act = btn.dataset.eact;

  if (act === 'edit') {
    startEdit(eid, n);
  } else if (act === 'del') {
    enterDelConfirm(eid, n);
  } else if (act === 'moveEntry') {
    moveEntryTo(ent, n);
  } else if (act === 'pin') {
    toggleEntryPin(n, ent);
  }
});

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
    Store.scrollMemo.set(Store.ui.selectedId, $('#entriesScroll').scrollTop);
  }
  if (dateJumpRaf) return;
  dateJumpRaf = requestAnimationFrame(() => {
    dateJumpRaf = null;
    updateDateJump();
    updateScrollBtn();
    syncPinCursorFromScroll();
  });
}, { passive: true });

$('#scrollBottomBtn').addEventListener('click', () => {
  scrollToBottom($('#entriesScroll'), true);
});
/* ★ 新增 */
$('#scrollTopBtn').addEventListener('click', scrollToCurrentTop);


$('#multiBar').addEventListener('click', e => {
  if (e.target.closest('.mb-fold')) { doFold(); return; }
  if (e.target.closest('.mb-cancel')) { clearMultiSelect(); return; }
});

$('#pinBar').addEventListener('click', e => {
  const loc = e.target.closest('[data-loc]');
  if (loc) {
    /* 1. 先把 cursor 钉到被点击的这条，并重绘 chip */
    const idx = +loc.dataset.pinIdx;
    if (!isNaN(idx) && Store.ui.pinCursor !== idx) {
      Store.ui.pinCursor = idx;
      renderPins();
    }

    /* 2. 平滑滚动期间屏蔽联动，避免“滚到中央 → 联动改成上一条” */
    suppressPinSyncUntil = Date.now() + 900;

    /* 3. 定位 + 闪烁 */
    const el = document.querySelector('#entries .entry-row[data-eid="' + loc.dataset.loc + '"]');
    if (el) {
      scrollIntoViewIn($('#entriesScroll'), el, { align: 'center' });
      flashEl(el);
    } else {
      const n = findNode(Store.ui.selectedId);
      if (n) jumpToRow(n, loc.dataset.loc);
    }
    return;
  }
  if (e.target.closest('.pin-more')) D.openPinPage();
  if (e.target.closest('.pin-cnt'))  D.openPinPage();
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
});
wireEntriesJump({ renderEntries });