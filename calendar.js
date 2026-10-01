// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= calendar.js =================
 * 自定义日期选择器。
 *
 * 替代原生 <input type=date>：位置可控、样式统一、
 * 可高亮有记录的日期、可显示已创建的区间。
 *
  * 对外：
 *   openCalendarPicker(opts)
 *     current          'YYYY-M-D'   初始选中
 *     entryDays        Set<string>  有记录的日期
 *     ranges           [{from,to,label}]  只用于显示，不在本控件里创建
 *     anchorX/anchorY  number       可选，默认居中
 *     onPick           (dayKey) => void
 *     onOpenTimeArrow  () => void      "⏱ 时之间"按钮（timeline.js 面板）
 */

import { esc } from './utils.js';
import { makeEscapable } from './ui.js';

const DOW = ['日','一','二','三','四','五','六'];
const MON = ['1 月','2 月','3 月','4 月','5 月','6 月',
             '7 月','8 月','9 月','10 月','11 月','12 月'];


const dayKeyNum = k => {
  const [y, m, d] = String(k).split('-').map(Number);
  return y * 10000 + m * 100 + d;
};
function parseDayKey(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return { y, m, d };
}

function msToDayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function monthGrid(y, m) {
  const firstDow = new Date(y, m, 1).getDay();
  const start = new Date(y, m, 1 - firstDow);
  const out = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    out.push({
      key: d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(),
      d: d.getDate(),
      otherMonth: d.getMonth() !== m,
    });
  }
  return out;
}

export function openCalendarPicker(opts) {
  opts = opts || {};
  const entryDays = opts.entryDays || new Set();
  const ranges = opts.ranges || [];

  let selectedKey = opts.current || msToDayKey(Date.now());
  let { y: viewY, m: viewM } = parseDayKey(selectedKey);
  const todayKey = msToDayKey(Date.now());

  

  const pop = document.createElement('div');
  pop.className = 'cal-pop';

  const ac = new AbortController();
  const close = makeEscapable(() => {
    if (pop.isConnected) pop.remove();
    ac.abort();
  });

  /* ---------- 渲染 ---------- */

  function draw() {
    /* 头部 */
    const head =
      '<div class="cal-head">' +
        '<button class="cal-nav" data-nav="-1">‹</button>' +
        '<div class="cal-title">' + viewY + ' 年 ' + MON[viewM] + '</div>' +
        '<button class="cal-nav" data-nav="1">›</button>' +
        '<button class="cal-today" data-today>今天</button>' +
      '</div>';

    /* 星期行 */
    const dow = '<div class="cal-dow-row">' +
      DOW.map(d => '<span>' + d + '</span>').join('') + '</div>';

    /* 网格 */
    let days = '';
    for (const c of monthGrid(viewY, viewM)) {
      const cls = ['cal-day'];
      if (c.otherMonth)         cls.push('other-month');
      if (c.key === todayKey)   cls.push('today');
      if (entryDays.has(c.key)) cls.push('has-entry');
      if (c.key === selectedKey) cls.push('selected');
      /* 落在已有区间里的日期给个浅底 */
      for (const r of ranges) {
        if (r.to == null) continue;
        const fromK = msToDayKey(r.from);
        const toK = msToDayKey(r.to);
        if (dayKeyNum(c.key) >= dayKeyNum(fromK) &&
            dayKeyNum(c.key) <= dayKeyNum(toK) &&
            !cls.includes('selected')) {
          cls.push('has-range');
          break;
        }
      }
      days += '<button class="' + cls.join(' ') +
        '" data-day="' + c.key + '">' + c.d + '</button>';
    }

    /* 已有区间列表 */
    let marks = '';
    if (ranges.length) {
      marks = '<div class="cal-marks">';
      for (const r of ranges) {
        const fromK = msToDayKey(r.from);
        const ongoing = r.to == null;
        const toText = ongoing ? '进行中' : (
          (parseDayKey(msToDayKey(r.to)).m + 1) + '月' +
          parseDayKey(msToDayKey(r.to)).d + '日'
        );
        const fromText = (parseDayKey(fromK).m + 1) + '月' +
                        parseDayKey(fromK).d + '日';
        marks += '<div class="cal-mark-row" data-goto-day="' + fromK + '">' +
          '<span class="cal-mark-dot' + (ongoing ? ' ongoing' : '') + '"></span>' +
          '<span class="cal-mark-label">' + esc(r.label || '未命名区间') + '</span>' +
          '<span class="cal-mark-range">' + fromText + ' – ' + toText + '</span>' +
        '</div>';
      }
      marks += '</div>';
    }

    const foot = '<div class="cal-foot">' +
    '<button class="primary" data-open-timeline>⏱ 时之间</button>' +
    '</div>';

    pop.innerHTML =
        head + dow +
        '<div class="cal-grid">' + days + '</div>' +
        marks + foot;
  }

  function position() {
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = (opts.anchorX != null) ? opts.anchorX : (innerWidth - w) / 2;
    let y = (opts.anchorY != null) ? opts.anchorY : (innerHeight - h) / 2;
    x = Math.max(8, Math.min(x, innerWidth  - w - 8));
    y = Math.max(8, Math.min(y, innerHeight - h - 8));
    pop.style.left = x + 'px';
    pop.style.top  = y + 'px';
  }

  /* ---------- 事件 ---------- */

  pop.addEventListener('click', ev => {
    const nav = ev.target.closest('[data-nav]');
    if (nav) {
      viewM += +nav.dataset.nav;
      if (viewM < 0)  { viewM = 11; viewY--; }
      if (viewM > 11) { viewM = 0;  viewY++; }
      draw(); position();
      return;
    }
    if (ev.target.closest('[data-today]')) {
      const t = parseDayKey(todayKey);
      viewY = t.y; viewM = t.m; selectedKey = todayKey;
      draw(); position();
      return;
    }
    const dayBtn = ev.target.closest('[data-day]');
    if (dayBtn) {
    const k = dayBtn.dataset.day;
    selectedKey = k;
    const p = parseDayKey(k);
    viewY = p.y; viewM = p.m;
    draw(); position();

    if (opts.onPick) opts.onPick(k);
    close();
    return;
    }
    const mark = ev.target.closest('[data-goto-day]');
    if (mark) {
      const k = mark.dataset.gotoDay;
      selectedKey = k;
      const p = parseDayKey(k);
      viewY = p.y; viewM = p.m;
      draw(); position();
      return;
    }
    
    if (ev.target.closest('[data-open-timeline]')) {
      if (opts.onOpenTimeLine) opts.onOpenTimeLine();
      close();
      return;
    }
  });

  /* 点外部关闭 */
  setTimeout(() => {
    document.addEventListener('pointerdown', ev => {
      if (!pop.contains(ev.target)) close();
    }, { signal: ac.signal });
  }, 0);

  document.body.appendChild(pop);
  draw();
  position();
}