'use strict';
/* ================= entries-date.js =================
 * 日期跳转：
 *   - 滚动时同步右下角"当前日期"chip
 *   - 点击 chip 弹出日期菜单（含"选择日期…"按钮 + 有记录的日期列表）
 *   - 菜单顶部按钮 → 系统日期选择器
 *
 * 对外：
 *   updateDateJump()   由 #entriesScroll scroll 调用
 *   openDatePicker()   由 #dateJump click 调用
 *
 * 模块加载时自动绑定 #dateJump 的 click。
 */

import { $, esc } from './utils.js';
import { scrollIntoViewIn } from './scroll-utils.js';
import { toast, makeEscapable } from './ui.js';
import { openCalendarPicker } from './calendar.js';
import { openTimelinePanel } from './timeline.js';
import { readTimeline } from './io.js';                                       // ★

let dateJumpTimer = null;

/* ---------- 滚动时同步 chip ---------- */

function currentMidDay() {
  const sc = $('#entriesScroll');
  const chips = [...sc.querySelectorAll('.day-chip[data-day]')];
  if (!chips.length) return null;
  const scRect = sc.getBoundingClientRect();
  const midY = scRect.top + scRect.height / 2;
  let cur = chips[0];
  for (const c of chips) {
    if (c.getBoundingClientRect().top <= midY) cur = c;
    else break;
  }
  return cur;
}

export function updateDateJump() {
  const jump = $('#dateJump'); if (!jump) return;
  const cur = currentMidDay();
  if (!cur) { jump.classList.remove('on'); return; }
  jump.textContent = cur.textContent;
  jump.dataset.day = cur.dataset.day;
  jump.classList.add('on');
  clearTimeout(dateJumpTimer);
  dateJumpTimer = setTimeout(() => jump.classList.remove('on'), 1200);
}

/* ---------- 打开日期菜单 ---------- */

export function openDatePicker() {
  const sc = $('#entriesScroll');
  const chips = [...sc.querySelectorAll('.day-chip[data-day]')];
  if (!chips.length) return;

  const uniq = [...new Map(chips.map(c => [c.dataset.day, c.textContent])).entries()];
  const curChip = currentMidDay();
  const curDay = (curChip && curChip.dataset.day)
              || $('#dateJump').dataset.day
              || uniq[uniq.length - 1][0];

  const menu = document.createElement('div');
  menu.className = 'date-menu';
  menu.innerHTML =
    '<div class="date-menu-head">' +
      '<button type="button" data-open-calendar>📅 选择日期</button>' +
      
    '</div>' +
    '<div class="date-menu-body">' +
      uniq.map(([d, t]) =>
        '<button type="button" data-day="' + d + '"' +
          (d === curDay ? ' class="cur"' : '') + '>' + esc(t) + '</button>'
      ).join('') +
    '</div>';
  document.body.appendChild(menu);

  // ★ 一个 close，一个 AbortController，一个 esc 栈登记
  const ac = new AbortController();
  const close = makeEscapable(() => {
    if (menu.isConnected) menu.remove();
    ac.abort();
  });

  /* 滚动区定位到当前日期 */
  const body = menu.querySelector('.date-menu-body');
  const curBtn = body.querySelector('.cur');
  if (curBtn) {
    body.scrollTop = Math.max(0,
      curBtn.offsetTop - body.clientHeight / 2 + curBtn.offsetHeight / 2);
  }

  /* 列表点击 → 跳转 */
  body.addEventListener('click', ev => {
    const b = ev.target.closest('[data-day]'); if (!b) return;
    close();
    jumpToDay(sc, b.dataset.day);
  });

  /* "选择日期"按钮 → 系统日期选择器 */
  menu.querySelector('[data-open-calendar]').addEventListener('click', ev => {
    ev.stopPropagation();
    close();
    openCustomCalendar(sc, curDay);
  });

  

  /* 点击外部关闭 —— 用 signal 绑定，close 时一起摘掉 */
  setTimeout(() => {
    document.addEventListener('pointerdown', ev => {
      if (!menu.contains(ev.target) && ev.target.id !== 'dateJump') {
        close();
      }
    }, { signal: ac.signal });
  }, 0);
}


/* ---------- 跳到某天 ---------- */

function jumpToDay(sc, dayKey) {
  const chip = sc.querySelector('.day-chip[data-day="' + dayKey + '"]');
  if (chip) {
    scrollIntoViewIn(sc, chip, { align: 'top', smooth: true });
  } else {
    toast('那天没有记录');
  }
}

async function openCustomCalendar(sc, currentDayKey) {
  /* 收集有记录的日期 */
  const chips = sc.querySelectorAll('.day-chip[data-day]');
  const entryDays = new Set();
  for (const c of chips) entryDays.add(c.dataset.day);

  /* 读已有区间（只用于显示） */
  let ranges = [];
  try {
    ranges = (await readTimeline()).ranges;
  } catch (e) {}

  const rect = sc.getBoundingClientRect();

  openCalendarPicker({
    current: currentDayKey,
    entryDays,
    ranges,
    anchorX: rect.right - 320,
    anchorY: rect.top + 40,

    onPick: (k) => pickDayAndJump(sc, k),
    onOpenTimeLine: () => openTimelinePanel(),
  });
}

/* dayKey 格式是 'YYYY-M-D'（M 从 0 起）。
   转成可比较数值 —— 不要直接字符串比较，'2026-9-x' > '2026-10-x' 会错。 */
   function dayKeyNum(k) {
    const [y, m, d] = String(k).split('-').map(Number);
    return y * 10000 + m * 100 + d;
  }
  
  function pickDayAndJump(sc, dayKey) {
    const firstChip = sc.querySelector('.day-chip[data-day]');
    if (!firstChip) { toast('还没有任何记录'); return; }
  
    /* 早于第一条记录 → 跳到第一条 */
    if (dayKeyNum(dayKey) < dayKeyNum(firstChip.dataset.day)) {
      scrollIntoViewIn(sc, firstChip, { align: 'top', smooth: true });
      toast('已跳到最早记录');
      return;
    }
  
    const chip = sc.querySelector('.day-chip[data-day="' + dayKey + '"]');
    if (chip) {
      scrollIntoViewIn(sc, chip, { align: 'top', smooth: true });
    } else {
      toast('那天没有记录');
    }
  }
/* ---------- 事件绑定（模块加载时执行一次） ---------- */

$('#dateJump').addEventListener('click', openDatePicker);