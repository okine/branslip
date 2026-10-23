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
import { Store } from './store.js';
import { toast, makeEscapable, wireOutsideClose } from './ui.js';
import { openCalendarPicker } from './calendar.js';
import { openTimelinePanel } from './timeline.js';
import { readTimeline } from './io.js';
import { jumpToRow } from './entries-jump.js';
import { dayKey, dayKeyNum, fmtDay, dayKeyOfEntry } from './format.js';

let dateJumpTimer = null;
let dateMenuClose = null;

/* ---------- 滚动时同步 chip ---------- */

function currentMidDay() {
  const sc = $('#entriesScroll');
  if (!sc) return null;
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
  const n = Store.node(Store.ui.selectedId);
  if (!sc || !n || !n.entries.length) return;

  if (dateMenuClose) dateMenuClose();

  /* 日期列表必须来自整个话题，而不是当前已渲染的 80 条 */
  const dayMap = new Map();
  for (const e of n.entries) {
    const k = dayKeyOfEntry(e);
    if (!dayMap.has(k)) dayMap.set(k, fmtDay(e.createdAt));
  }
  const uniq = [...dayMap.entries()]
    .sort((a, b) => dayKeyNum(a[0]) - dayKeyNum(b[0]));
  if (!uniq.length) return;

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

  const ac = new AbortController();
  const close = makeEscapable(() => {
    if (menu.isConnected) menu.remove();
    ac.abort();
    if (dateMenuClose === close) dateMenuClose = null;
  });
  dateMenuClose = close;

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
  wireOutsideClose(menu, close, ac.signal, t => t.id === 'dateJump');
}


/* ---------- 跳到某天 ---------- */

function jumpToDay(sc, key) {
  const n = Store.node(Store.ui.selectedId);
  if (!n) return;
  const target = n.entries.find(e => dayKeyOfEntry(e) === key);
  if (target) jumpToRow(n, target.id);
  else toast('那天没有记录');
}

async function openCustomCalendar(sc, currentDayKey) {
  const n = Store.node(Store.ui.selectedId);
  const entryDays = new Set();
  if (n) for (const e of n.entries) entryDays.add(dayKeyOfEntry(e));

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

function pickDayAndJump(sc, key) {
  const n = Store.node(Store.ui.selectedId);
  if (!n || !n.entries.length) { toast('还没有任何记录'); return; }

  const first = n.entries[0];
  /* 早于第一条记录 → 跳到第一条 */
  if (dayKeyNum(key) < dayKeyNum(dayKeyOfEntry(first))) {
    jumpToRow(n, first.id);
    toast('已跳到最早记录');
    return;
  }

  const target = n.entries.find(e => dayKeyOfEntry(e) === key);
  if (target) jumpToRow(n, target.id);
  else toast('那天没有记录');
}
/* ---------- 事件绑定（模块加载时执行一次） ---------- */

$('#dateJump').addEventListener('click', openDatePicker);