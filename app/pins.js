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

import { $, esc, countLabel } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { fmtStamp } from './format.js';
import { writePins } from './io.js';
import { enqueue } from './writer.js';
import { toast, openFullPage } from './ui.js';
import { replaceMetaRow } from './meta-row.js';
import { renderEntryBody } from './entries-render.js';
import { hydrateIn } from './image.js';
import { scrollIntoViewIn, flashEl } from './scroll-utils.js';
import { jumpToRow } from './entries-jump.js';
import { findNode } from './tree-utils.js';

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
  const prev = e.text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || '[图片]';

  bar.innerHTML =
    '<button class="pin-chip" data-loc="' + e.id + '" data-pin-idx="' + idx + '" title="点击定位">' +
      '<span class="p-ic">' + I.pin + '</span>' +
      '<span class="t">' + esc(prev.slice(0, 60)) + '</span>' +
    '</button>' +
    (list.length > 1
      ? '<span class="pin-sep">丨</span><button class="pin-cnt">共 ' + countLabel(list.length) + ' 条</button>'
      : '') +
    '<button class="pin-more" title="查看全部置顶">' + I.menu + '<span>全部置顶</span></button>';
  bar.style.display = 'flex';
}

export function toggleEntryPin(n, e) {
  if (!n || !e) return;
  const nowPinned = Mutate.togglePin(n, e);
  toast(nowPinned ? '已置顶，右栏顶部可查看' : '已取消置顶');
  enqueue(() => writePins(n));

  const row = document.querySelector('#entries .entry-row[data-eid="' + e.id + '"]');
  if (row) replaceMetaRow(row, e, n);
  renderPins();
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

  openFullPage({
    title: () => '置顶消息 · ' + list.length,

    render: () => {
      if (!list.length)
        return '<div class="pp-empty">这个话题还没有置顶的记录</div>';
      return list.map(e => {
        const { html: body } = renderEntryBody(e);
        return '<div class="pp-card" data-eid="' + e.id + '">' + body +
          '<span class="meta">' + fmtStamp(e.createdAt) +
            (e.edited ? ' · 已编辑' : '') + '</span>' +
          '<div class="pp-acts">' +
            '<button data-goto="' + e.id + '">定位到消息</button>' +
            '<button data-unpin="' + e.id + '">取消置顶</button>' +
          '</div></div>';
      }).join('');
    },

    afterDraw: (api) => {
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
