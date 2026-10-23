// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE


'use strict';
/* ================= pages.js =================
 * 全屏页面：拾之 / 置顶消息页。
 *
 * 两个页面都是"从主区进入的临时全屏视图"：
 *   - pickItPage()  随机抽几条记录看看
 *   - pickItPage()     拾之（随机 / 关联一览）
 *   - openTimeArrow()  时之箭
 *
 * 置顶消息页已迁到 pins.js。
 * 与其它模块的边界：
 *   - 依赖 entries.js 的 renderEntries（跳转到记录）
 */

import { $,esc, badgeHTML,badgeColor, countLabel } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { fmtStamp, parseStamp, fmtFull } from './format.js';
import { parseRelevanceHeader } from './md.js';
import { renderEntryBody } from './entries-render.js';
import { hydrateImages, unobserveImages } from './image.js';
import { walk,stats } from './tree-utils.js';
import { select } from './tree.js';
import { renderEntries } from './entries.js';
import { toast, confirmDialog, makeEscapable, openFullPage } from './ui.js';


/* ============================================================
 * 拾之
 * ============================================================ */

/* 跳到某条记录（关页面 → 切话题 → 闪烁定位）。拾之 / 讨论串共用。 */
function jumpToEntry(api, nid, eid) {
  api.close();
  Store.ui.flashEntry = eid;
  if (nid && nid !== Store.ui.selectedId) select(nid, { noScrollRestore: true });
  else renderEntries();
}

export function pickItPage() {
  const pool = [];
  walk(Store.root, n => { for (const e of n.entries) pool.push({ e, n }); });
  if (!pool.length) { toast('还没有任何记录'); return; }

  let mode = 'random';          // 'random' | 'relations'
  let relActive = null;
  let relGroups = [];

  function pickThree() {
    const count = Math.min(3, pool.length);
    const picked = [], used = new Set();
    while (picked.length < count) {
      const i = Math.floor(Math.random() * pool.length);
      if (used.has(i)) continue;
      used.add(i);
      picked.push(pool[i]);
    }
    picked.sort((a, b) => a.e.createdAt - b.e.createdAt);
    return picked;
  }

  /* 关联标题 → 记录列表。标题就是 ∝ 头里的标签。（改回原来的"按标题分组"） */
  function buildRelGroups() {
    const groups = new Map();
    for (const { e, n } of pool) {
      const rel = parseRelevanceHeader(e.text);
      if (!rel) continue;
      const label = rel.label || '未命名';
      let g = groups.get(label);
      if (!g) { g = { label, items: [] }; groups.set(label, g); }
      g.items.push({ e, n, preview: rel.preview });
    }
    const arr = [...groups.values()];
    for (const g of arr) g.items.sort((a, b) => b.e.createdAt - a.e.createdAt);
    arr.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label, 'zh'));
    return arr;
  }

  function renderRandom() {
    let cards = '';
    for (const { e, n } of picked) {
      const { html: body } = renderEntryBody(e);
      const tag = '<button class="src-tag" data-src="' + n.id + '">' +
        badgeHTML(n) + '<span>' + esc(n.title) + '</span></button>';
      cards += '<div class="pp-card" data-eid="' + e.id + '" data-node="' + n.id + '">' +
        tag + body +
        '<span class="meta">' + fmtStamp(e.createdAt) +
          (e.edited ? ' · 已编辑' : '') + '</span>' +
        '<div class="pp-acts"><button data-pickit-goto="' + e.id + '">去看这条</button></div>' +
      '</div>';
    }
    return cards;
  }

  /* 左侧：常驻模式按钮（随机 / 关联一览）；关联一览里再列"关联标题"（原来的样子） */
  function renderRelSidebar() {
    const modeBtn = (key, label, icon) =>
      '<button type="button" class="pp-side-item' + (mode === key ? ' on' : '') +
        '" data-pickit-mode="' + key + '">' +
        '<span class="pp-side-icon">' + icon + '</span><span>' + label + '</span>' +
      '</button>';

    let h = modeBtn('random', '随机', I.sparkles) +
            modeBtn('relations', '关联一览', I.relevance);

    if (mode !== 'relations') return h;

    h += '<div class="rel-side-head">关联标题</div>';
    if (!relGroups.length) {
      h += '<div class="rel-side-empty">还没有关联</div>';
      return h;
    }
    h += relGroups.map((g, i) =>
      '<button type="button" class="pp-side-item rel-side-item' +
        (g.label === relActive ? ' on' : '') + '" data-rel-side="' + i + '">' +
        '<span class="rel-side-title"># ' + esc(g.label) + '</span>' +
        '<span class="pp-side-count">' + countLabel(g.items.length) + '</span>' +
      '</button>'
    ).join('');
    return h;
  }

  function renderRelContent() {
    if (!relGroups.length) {
      return '<div class="rel-page"><div class="pp-empty">还没有关联记录。<br>' +
        '右键一条记录 →「建立关联…」，起个标题即可。</div></div>';
    }
    let g = relGroups.find(x => x.label === relActive) || relGroups[0];
    relActive = g.label;

    const items = g.items.map(it =>
      '<button type="button" class="rel-item" data-rel-goto="' + it.e.id +
        '" data-rel-node="' + it.n.id + '">' +
        '<span class="rel-preview">' + esc(it.preview.slice(0, 80) || '（无引用预览）') + '</span>' +
        '<span class="rel-src">' + esc(it.n.title) + '</span>' +
      '</button>'
    ).join('');

    return '<div class="rel-page">' +
      '<div class="rel-group">' +
        '<div class="rel-group-head">' +
          '<span class="rel-tag"># ' + esc(g.label) + '</span>' +
          '<span class="rel-count">' + countLabel(g.items.length) + ' 条</span>' +
        '</div>' +
        '<div class="rel-items">' + items + '</div>' +
      '</div>' +
    '</div>';
  }

  let picked = pickThree();
  let pageEl = null;

  openFullPage({
    title: () => mode === 'relations' ? '关联一览' : '拾之',
    sideClass: 'rel-side',
    /* 侧栏常驻：模式切换本身就是侧栏按钮，不再占顶部 */
    sidebar: () => renderRelSidebar(),

    actions: () => mode === 'relations'
      ? ''
      : '<button class="pickit-refresh">' + I.refresh + '<span>换一批</span></button>',

    render: () => mode === 'relations' ? renderRelContent() : renderRandom(),

    afterDraw: (api) => {
      pageEl = api.el;
      /* 不重置全局 observer：主列表里还没水合的图片不应该因为打开拾之而丢观察 */
      hydrateImages(api.el);
    },

    onClose: () => {
      if (pageEl) unobserveImages(pageEl);
    },

    onEvent: (ev, api) => {
      const modeBtn = ev.target.closest('[data-pickit-mode]');
      if (modeBtn) {
        if (pageEl) unobserveImages(pageEl);
        mode = modeBtn.dataset.pickitMode;
        if (mode === 'relations') {
          relGroups = buildRelGroups();
          relActive = relGroups[0] ? relGroups[0].label : null;
        } else {
          picked = pickThree();
        }
        api.redraw();
        return;
      }

      if (ev.target.closest('.pickit-refresh')) {
        if (pageEl) unobserveImages(pageEl);
        picked = pickThree();
        api.redraw();
        return;
      }

      const sideBtn = ev.target.closest('[data-rel-side]');
      if (sideBtn) {
        const g = relGroups[+sideBtn.dataset.relSide];
        if (g) relActive = g.label;
        api.redraw();
        return;
      }

      const relGo = ev.target.closest('[data-rel-goto]');
      if (relGo) {
        jumpToEntry(api, relGo.dataset.relNode, relGo.dataset.relGoto);
        return;
      }

      const tag = ev.target.closest('.src-tag');
      if (tag) { api.close(); select(tag.dataset.src); return; }

      const go = ev.target.closest('[data-pickit-goto]');
      if (go) {
        const card = go.closest('[data-node]');
        const nid  = card ? card.dataset.node : null;
        const eid  = go.dataset.pickitGoto;
        jumpToEntry(api, nid, eid);
        return;
      }
    },
  });
}

/*-----------------------时之箭----------------------*/
export async function openTimeArrow() {
  /* ── 0. 数据量提示 ── */
  const total = stats().e;
  if (total > 3000) {
    const ok = await confirmDialog(
      '打开时之箭',
      '当前有 ' + total + ' 条记录，首次打开可能卡顿。要继续吗？',
      { okText: '继续', cancelText: '取消' }
    );
    if (!ok) return;
  }

  /*const dataStart = Math.min(...topics.map(t => t.startMs));
  const rangeStart = /* 从区间数据里读 ;
  const globalStart = Math.min(dataStart, rangeStart); */   //等待未来的区间功能
  /* ── 1. 收集根话题 ── */
  const topics = [];
  for (const n of Store.root.children) {
    if (!n.entries.length) continue;
    const startMs = n.topicId
      ? (parseStamp(n.topicId) || n.entries[0].createdAt)
      : n.entries[0].createdAt;
    const endMs = n.entries[n.entries.length - 1].createdAt;
    topics.push({ node: n, startMs, endMs });
  }
  if (!topics.length) { toast('还没有任何记录'); return; }

  /* ── 2. 时间范围 ── */
  const globalStart = Math.min(...topics.map(t => t.startMs));
  const globalEnd = Date.now();
  const spanMs = Math.max(1, globalEnd - globalStart);

  /* ── 3. 轨道分配 ── */
  const sorted = [...topics].sort((a, b) => a.startMs - b.startMs);
  const trackEnds = [];
  const trackOf = new Map();
  for (const t of sorted) {
    let idx = trackEnds.findIndex(end => end <= t.startMs);
    if (idx < 0) idx = trackEnds.length;
    trackEnds[idx] = t.endMs;
    trackOf.set(t, idx);
  }

  /* ── 4. 布局参数 ── */
  const trackGap  = 50;
  const padTop    = 40;
  const padBottom = 40;

  let ZOOM=1
  const LOGICAL_W = window.innerWidth;    // 逻辑宽（画布坐标系）
  const axisX = LOGICAL_W / 2;
  const H = Math.max(window.innerHeight - 120, spanPx(spanMs));

  const yOf = ms => padTop + (ms - globalStart) / spanMs * (H - padTop - padBottom);
  const xOf = track => {
    const side  = track % 2;
    const depth = Math.floor(track / 2);
    const dist  = (depth + 1) * trackGap;
    return axisX + (side ? dist : -dist);
  };

  /* ── 5. 拼 SVG ── */
  let svg = '<svg width="' + LOGICAL_W + '" height="' + H + '" ' +
          'viewBox="0 0 ' + LOGICAL_W + ' ' + H + '" ' +
          'preserveAspectRatio="none" class="ti-svg">';

  /* 全局起点 */ //用第一条记录的时间或未来的最早区间起点
  svg += '<circle class="ti-start ti-dot" ' +
  'cx="' + axisX + '" cy="' + padTop + '" r="5" ' +
  'data-title="时枝笺的第一条记录" ' +
  'data-time="' + esc(fmtFull(globalStart)) + '" />';

  /* 主轴 */
  svg += '<line class="ti-axis" x1="' + axisX + '" y1="' + padTop + '" ' +
         'x2="' + axisX + '" y2="' + (H - padTop + 20) + '" />';

  /* 箭头 */
  const arrowW = 10;
  const arrowH = 22;
  svg += '<polygon class="ti-arrow" points="' +
         (axisX - arrowW) + ',' + (H - padTop + 20) + ' ' +
         (axisX + arrowW) + ',' + (H - padTop + 20) + ' ' +
         axisX + ',' + (H - padTop + 20 + arrowH) + '" />';

  /* 每条话题 */
for (const t of topics) {
  const track = trackOf.get(t);
  const x = xOf(track);
  const y1 = yOf(t.startMs);
  const y2 = yOf(t.endMs);
  const color = badgeColor(t.node.id);
  const isRight = track % 2 === 1;

  /* ① 竖线（主线） */
  svg += '<line x1="' + x + '" y1="' + y1 + '" ' +
         'x2="' + x + '" y2="' + y2 + '" ' +
         'stroke="' + color + '" stroke-width="3" stroke-linecap="round" />';

  /* ② 起点横线（虚线，主轴 → 话题） */
  svg += '<line x1="' + axisX + '" y1="' + y1 + '" ' +
         'x2="' + x + '" y2="' + y1 + '" ' +
         'stroke="' + color + '" stroke-dasharray="4 3" ' +
         'stroke-width="2.5" stroke-linecap="round" />';

  /* ③ 终点横线（虚线，话题 → 主轴） */
  svg += '<line x1="' + x + '" y1="' + y2 + '" ' +
         'x2="' + axisX + '" y2="' + y2 + '" ' +
         'stroke="' + color + '" stroke-dasharray="4 3" ' +
         'stroke-width="2.5" stroke-linecap="round" />';

  /* ④ 中点伸枝 + 标题（竖排） */
const yMid     = (y1 + y2) / 2;
const stemLen  = 10;
const stemEndX = isRight ? x + stemLen : x - stemLen;

/* 竖排文字：font-size 12 → 半字宽 6，再加 6px 空隙 */
const textX = isRight ? stemEndX + 12 : stemEndX - 12;

svg += '<line x1="' + x + '" y1="' + yMid + '" ' +
       'x2="' + stemEndX + '" y2="' + yMid + '" ' +
       'stroke="' + color + '" stroke-width="1.5" ' +
       'stroke-linecap="round" />';

svg += '<text x="' + textX + '" y="' + yMid + '" ' +
       'text-anchor="middle" ' +
       'dominant-baseline="central" ' +   /* ★ 见下 */
       'font-size="12" fill="' + color + '">' +
       esc(t.node.title) + '</text>';

  /* ⑤ 起点圆点（实心） */
  svg += '<circle cx="' + x + '" cy="' + y1 + '" r="4" ' +
         'class="ti-dot" ' +
         'data-title="' + esc(t.node.title) + '" ' +
         'data-time="' + esc(fmtFull(t.startMs)) + '" ' +
         'fill="' + color + '" />';

  /* ⑥ 终点圆点（空心） */
  svg += '<circle cx="' + x + '" cy="' + y2 + '" r="3" ' +
         'class="ti-dot" ' +
         'data-title="' + esc(t.node.title) + '（当前最末记录）" ' +
         'data-time="' + esc(fmtFull(t.endMs)) + '" ' +
         'fill="none" stroke="' + color + '" stroke-width="2" />';
}
  

  svg += '</svg>';

  /* ── 6. 页面壳（★ 先 innerHTML，再挂 body）── */
  const d = document.createElement('div');
  d.className = 'pin-page';
  d.style.position = 'fixed'; 
  d.innerHTML =
  '<div class="pp-head">' +
    '<button class="pp-back">' + I.x + '<span>关闭</span></button>' +
    '<h3>时之箭</h3>' +
    '<div class="pp-actions">' +
      '<span class="ti-hint">' + topics.length + ' 条话题 · ' +
        new Date(globalStart).getFullYear() + '—' +
        new Date(globalEnd).getFullYear() + '</span>' +
    '</div>' +
  '</div>' +
  '<div class="ti-scroll">' + svg + '</div>';

  document.body.appendChild(d);

  /* ── 7. tooltip 元素（此时再建）── */
  const tip = document.createElement('div');
  tip.className = 'ti-tip';
  tip.id = 'tiTip';
  document.body.appendChild(tip);

  /* ── 8. 绑事件（★ 现在 d 里已经有 .ti-dot 了）── */
  const dots = d.querySelectorAll('.ti-dot');
  for (const dot of dots) {
    dot.addEventListener('mouseenter', () => {
      tip.textContent = dot.dataset.title + ' · ' + dot.dataset.time;
      tip.classList.add('on');
    });
    dot.addEventListener('mousemove', ev => {
      const tipW = tip.offsetWidth;
      const x = Math.min(ev.clientX + 14, window.innerWidth - tipW - 10);
      tip.style.left = x + 'px';
      tip.style.top  = (ev.clientY + 14) + 'px';
    });
    dot.addEventListener('mouseleave', () => {
      tip.classList.remove('on');
    });
  }

 

  requestAnimationFrame(() => {
    const sc = d.querySelector('.ti-scroll');
    sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
  });
  const sc = d.querySelector('.ti-scroll');
let drag = null;

  sc.addEventListener('pointerdown', e => {
    /* 圆点不触发拖动 —— 圆点要留给 tooltip */
    if (e.target.closest('.ti-dot')) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      left: sc.scrollLeft,
      top:  sc.scrollTop,
    };
    sc.classList.add('dragging');
    sc.setPointerCapture(e.pointerId);
  });

  sc.addEventListener('pointermove', e => {
    if (!drag) return;
    sc.scrollLeft = drag.left - (e.clientX - drag.x);
    sc.scrollTop  = drag.top  - (e.clientY - drag.y);
  });

  sc.addEventListener('pointerup', e => {
    if (!drag) return;
    drag = null;
    sc.classList.remove('dragging');
    try { sc.releasePointerCapture(e.pointerId); } catch {}
  });

  sc.addEventListener('pointercancel', () => {
    drag = null;
    sc.classList.remove('dragging');
  });
  let zoom = 1;   // 当前缩放系数，和 SVG 元素尺寸同步

sc.addEventListener('wheel', e => {
  /* 只有按住 Ctrl / Cmd 才缩放 —— 否则保留默认滚动行为 */
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();

  const oldZoom = zoom;
  zoom *= e.deltaY < 0 ? 1.1 : 0.9;
  zoom = Math.max(0.3, Math.min(5, zoom));
  if (zoom === oldZoom) return;

  /* 鼠标在滚动容器内的坐标 */
  const rect = sc.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  /* 鼠标下的点在内容中的逻辑位置（缩放前） */
  const contentX = (sc.scrollLeft + mx) / oldZoom;
  const contentY = (sc.scrollTop + my) / oldZoom;

  /* 应用新尺寸 */
  const svgEl = sc.querySelector('.ti-svg');
  svgEl.setAttribute('width',  LOGICAL_W * zoom);
  svgEl.setAttribute('height', H * zoom);

  /* 滚动到新位置，让鼠标下的点不动 */
  sc.scrollLeft = contentX * zoom - mx;
  sc.scrollTop  = contentY * zoom - my;
}, { passive: false });
    /* ── 9. 关闭 ── */
  const close = makeEscapable(() => { d.remove(); tip.remove(); });
  d.querySelector('.pp-back').addEventListener('click', close);
}


/* 模块作用域，不用每次调用都重建 */
function spanPx(ms) {
  const days = ms / 864e5;
  return Math.max(400, days * 1.5);
}

/* 置顶消息页已迁到 pins.js */