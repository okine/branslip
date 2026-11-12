'use strict';
/* ================= pins.js =================
 * 置顶领域：顶部置顶条 + 置顶消息页。
 *
 * 从 entries.js / pages.js 拆出，避免 entries 同时持有
 * 渲染、滚动、置顶三种职责。
 *
 * 对外：
 *   renderPins()
 *   toggleEntryPin(n, e)
 *   rebuildPinRowMap()
 *   syncPinCursorFromScroll()
 *   openPinPage()
 */

import { $, esc, countLabel, uid } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { fmtStamp } from './format.js';
import { stripImages, stripQuoteHeader } from './md.js';
import { writePins, persistMonthOf } from './io.js';
import { enqueue } from './writer.js';
import { toast, openFullPage } from './ui.js';
import { replaceMetaRow } from './meta-row.js';
import { renderEntryBody } from './entries-render.js';
import { hydrateIn } from './image.js';
import { scrollIntoViewIn, flashEl, captureViewportAnchor, restoreViewportAnchor } from './scroll-utils.js';
import { jumpToRow } from './entries-jump.js';
import { findNode, pathTitles } from './tree-utils.js';

let _lastPinSig = null;
let suppressPinSyncUntil = 0;
let pinRowMap = new Map();

/* 建表 —— 只在 DOM 结构变动后调用 */
export function rebuildPinRowMap() {
  pinRowMap = new Map();
  const box = document.getElementById('entries');
  if (!box) return;
  for (const row of box.querySelectorAll('.entry-row')) {
    if (row.dataset.eid) pinRowMap.set(row.dataset.eid, row);
  }
}

/* ---------- 置顶日志 ---------- */

export function pinLogAction(text) {
  /* 只看日志行末的动词，避免原消息预览里恰好有“取消置顶”。 */
  return /被[^\n]*取消置顶\s*$/m.test(String(text || '')) ? 'unpin' : 'pin';
}

export function pinLogTarget(text) {
  const m = String(text || '').match(/^:::pin\b[\s\S]*?#\^([^\]|]+)/);
  return m ? m[1] : null;
}

export function makePinLogText({ topicRef, blockId, preview, at, actor, action }) {
  const cleanRef = String(topicRef || '').replace(/[\r\n]/g, '').trim();
  const cleanBlock = String(blockId || '').replace(/[\r\n]/g, '').trim();
  let pv = stripQuoteHeader(stripImages(String(preview || '')))
    .replace(/\s+/g, ' ')
    .replace(/[\[\]|]/g, ' ')
    .trim()
    .slice(0, 80);
  if (!pv) pv = '一条消息';
  const who = String(actor || '我').replace(/[\r\n]/g, ' ').trim() || '我';
  const verb = action === 'unpin' ? '取消置顶' : '置顶';
  return ':::pin\n📌 [[' + cleanRef + '#^' + cleanBlock + '|' + pv + ']] 在 ' +
    fmtStamp(at) + ' 被 ' + who + ' ' + verb + '\n:::';
}

/** 从 pin 事件里保留第一次/最后一次（按 action 分开）。 */
export function firstLastByTarget(events, blockOf) {
  const groups = new Map();
  for (const ev of events || []) {
    if (!ev || !ev.target || !ev.action) continue;
    const bid = blockOf(ev.target);
    if (!bid) continue;
    const key = ev.action + '\u0000' + bid;
    let g = groups.get(key);
    if (!g) { g = { action: ev.action, blockId: bid, events: [] }; groups.set(key, g); }
    g.events.push(ev);
  }
  const out = [];
  for (const g of groups.values()) {
    g.events.sort((a, b) => (a.at || 0) - (b.at || 0));
    const first = g.events[0];
    const last = g.events[g.events.length - 1];
    out.push(first);
    if (last !== first) out.push(last);
  }
  return out;
}

let D = { renderEntries: () => {}, renderAll: () => {} };
export function wirePins(h) { Object.assign(D, h); }

/* 写入/维护 :::pin 服务日志。每个 (目标, action) 最多保留首尾两条。 */
function appendPinLog(n, e, action) {
  const blockId = Mutate.entryBlockId(e);
  const topicRef = n.topicId ? ('~' + n.topicId) : pathTitles(n);
  const at = Date.now();
  const text = makePinLogText({
    topicRef, blockId, preview: e.text, at, actor: '我', action,
  });
  const r = Store.insertSorted(n, {
    id: uid(), text, createdAt: at,
    edited: false, editedAt: null,
  });
  r.entry._tzOffset = -new Date().getTimezoneOffset();
  enqueue(() => persistMonthOf(n, r.entry.createdAt));

  const logs = n.entries
    .filter(x => String(x.text).startsWith(':::pin') &&
      pinLogTarget(x.text) === blockId &&
      pinLogAction(x.text) === action)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (logs.length > 2) {
    for (const old of logs.slice(1, -1)) {
      Store.removeEntry(n, old.id);
      enqueue(() => persistMonthOf(n, old.createdAt));
    }
  }
  D.renderAll();
}

export function renderPins() {
  const bar = $('#pinBar');
  if (!bar) return;
  if (Store.ui.merged) { bar.innerHTML = ''; bar.style.display = 'none'; return; }

  const n = findNode(Store.ui.selectedId);
  const list = n ? Mutate.pinnedEntries(n) : [];

  if (!list.length) {
    _lastPinSig = null;
    bar.innerHTML = ''; bar.style.display = 'none';
    return;
  }

  /* 列表签名变了 → 用户视角下的置顶集合变了，pinCursor 作废 */
  const sig = list.map(e => e.id).join('\u0000');
  if (sig !== _lastPinSig) {
    _lastPinSig = sig;
    Store.ui.pinCursor = null;
  }
  const idx = (Store.ui.pinCursor != null && Store.ui.pinCursor >= 0 && Store.ui.pinCursor < list.length)
    ? Store.ui.pinCursor : list.length - 1;
  const e = list[idx];
  const prev = stripImages(e.text).replace(/\s+/g, ' ').trim() || '[图片]';

  bar.innerHTML =
    '<button class="pin-chip" data-loc="' + e.id + '" data-pin-idx="' + idx + '" title="点击定位">' +
      '<span class="p-ic">' + I.pin + '</span>' +
      '<span class="t">' + esc(prev.slice(0, 60)) + '</span>' +
    '</button>' +
    
    '<button class="pin-more" title="查看全部置顶">' + I.menu + '</button>';
  bar.style.display = 'flex';
}

export function toggleEntryPin(n, e) {
  if (!n || !e) return;

  /* 置顶条从 0 → 显示 / 显示 → 0 会改变 #entriesScroll 的高度，
     浏览器保持 scrollTop 不变，视觉上就是内容轻轻跳一下。
     先记住当前可见行，改完置顶条后把它放回原位置。 */
  const sc = $('#entriesScroll');
  const box = $('#entries');
  const anchor = captureViewportAnchor(box);

  const nowPinned = Mutate.togglePin(n, e);
  toast(nowPinned ? '已置顶，右栏顶部可查看' : '已取消置顶');
  enqueue(() => writePins(n));
  appendPinLog(n, e, nowPinned ? 'pin' : 'unpin');

  const row = document.querySelector('#entries .entry-row[data-eid="' + e.id + '"]');
  if (row) replaceMetaRow(row, e, n);
  renderPins();
  restoreViewportAnchor(sc, anchor);
}

export function syncPinCursorFromScroll() {
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

  let best = -1, bestTop = -Infinity;
  let firstVisible = -1;

  for (let i = 0; i < list.length; i++) {
    const row = pinRowMap.get(list[i].id);
    if (!row || !row.isConnected) continue;
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
    renderPins();
  }
}

$('#pinBar').addEventListener('click', e => {
  const loc = e.target.closest('[data-loc]');
  if (loc) {
    const idx = +loc.dataset.pinIdx;
    if (!isNaN(idx) && Store.ui.pinCursor !== idx) {
      Store.ui.pinCursor = idx;
      renderPins();
    }

    suppressPinSyncUntil = Date.now() + 900;

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
  if (e.target.closest('.pin-more')) openPinPage();
  if (e.target.closest('.pin-cnt'))  openPinPage();
});

/* ============================================================
 * 置顶消息页
 * ============================================================ */

export function openPinPage() {
  const n = Store.node(Store.ui.selectedId);
  if (!n) return;
  let list = Mutate.pinnedEntries(n);
  let firstDraw = true;

  openFullPage({
    title: () => '置顶消息 · ' + list.length,

    render: () => {
      if (!list.length)
        return '<div class="pp-empty">这个话题还没有置顶的记录</div>';
      return list.map((e, i) => {
        const { html: body } = renderEntryBody(e);
        return '<div class="pp-card" data-eid="' + e.id + '">' + body +
          '<span class="meta">' + fmtStamp(e.createdAt) +
            (e.edited ? ' · 已编辑' : '') + '</span>' +
          '<div class="pp-foot">' +
            '<span class="pp-num">#' + (i + 1) + '</span>' +
            '<div class="pp-acts">' +
              '<button data-goto="' + e.id + '">定位到消息</button>' +
              '<button data-unpin="' + e.id + '">取消置顶</button>' +
            '</div>' +
          '</div></div>';
      }).join('');
    },

    afterDraw: (api) => {
      /* 首次打开时把“当前置顶”对到底部，而不是永远从 #1 开始。
         之后取消置顶触发 redraw 时保留列表滚动位置。 */
      if (firstDraw) {
        firstDraw = false;
        const listEl = api.el.querySelector('.pp-list');
        if (listEl) {
          const cur = Number.isInteger(Store.ui.pinCursor) ? Store.ui.pinCursor : list.length - 1;
          const idx = Math.max(0, Math.min(cur, list.length - 1));
          const card = listEl.querySelectorAll('.pp-card')[idx];
          if (card) {
            const cr = card.getBoundingClientRect();
            const lr = listEl.getBoundingClientRect();
            listEl.scrollTop = Math.max(0, listEl.scrollTop + cr.bottom - lr.bottom);
          } else {
            listEl.scrollTop = listEl.scrollHeight;
          }
        }
      }
      /* hydrateIn 是一次性水合，不需要也不应该重置主列表的全局观察器 */
      hydrateIn(api.el, n);
    },

    onEvent: (ev, api) => {
      /* 取消置顶 */
      const un = ev.target.closest('[data-unpin]');
      if (un) {
        const ent = n.entries.find(x => x.id === un.dataset.unpin);
        if (!ent) return;
        toggleEntryPin(n, ent);
        list = Mutate.pinnedEntries(n);
        api.redraw();
        if (!list.length) setTimeout(api.close, 900);
        return;
      }
      /* 定位到消息 */
      const go = ev.target.closest('[data-goto]');
      if (go) {
        api.close();
        const el = document.querySelector(
          '#entries .entry-row[data-eid="' + go.dataset.goto + '"]'
        );
        if (el) {
          scrollIntoViewIn($('#entriesScroll'), el, { align: 'center' });
          flashEl(el);
        } else {
          const cur = findNode(Store.ui.selectedId);
          if (cur) jumpToRow(cur, go.dataset.goto);
        }
      }
    },
  });
}
