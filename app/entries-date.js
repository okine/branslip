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
import { dayKey, dayKeyNum, fmtDay, fmtDayOfEntry, fmtTimeOfEntry, dayKeyOfEntry } from './format.js';
import { isReplyMessage, stripQuoteHeader, stripImages } from './md.js';

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

/* 视口里"最新"的一条记录（按记录顺序取最靠下的可见行）。
   日期 chip 以前依赖 day-chip，只有日期变化处才有，所以同一天内滚动
   常常看不到；这里直接读可见行，任何滚动都能给出当前日期。 */
function latestVisibleEntry() {
  const sc = $('#entriesScroll');
  if (!sc) return null;
  const rows = sc.querySelectorAll('.entry-row[data-eid]');
  if (!rows.length) return null;
  const scRect = sc.getBoundingClientRect();
  let latest = null;
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (r.bottom <= scRect.top + 1) continue;   /* 完全在视口上方 */
    if (r.top >= scRect.bottom) break;          /* 下面的行不用看了 */
    const hit = Store.entry(row.dataset.eid);
    if (hit && hit.e) latest = hit.e;
  }
  return latest;
}

function currentDateInfo() {
  const e = latestVisibleEntry();
  if (e) {
    return { day: dayKeyOfEntry(e), text: fmtDay(e.createdAt) };
  }
  /* 兜底：没有可见行时（空列表/加载中）仍按日期分隔条定位 */
  const chip = currentMidDay();
  if (chip) return { day: chip.dataset.day, text: chip.textContent };
  return null;
}

export function updateDateJump() {
  const jump = $('#dateJump'); if (!jump) return;
  const info = currentDateInfo();
  if (!info) { jump.classList.remove('on'); return; }
  jump.textContent = info.text;
  jump.dataset.day = info.day;
  jump.classList.add('on');
  clearTimeout(dateJumpTimer);
  dateJumpTimer = setTimeout(() => jump.classList.remove('on'), 1200);
}

/* ---------- 打开日期菜单 / 对话导航 ---------- */

const AI_SOURCES = new Set(['deepseek', 'claude', 'qwen', 'gemini', 'chatgpt', 'openai']);
let navTab = 'date';

function isAiTopic(n) {
  return AI_SOURCES.has(String((n && n.source) || ''));
}

/* LLM 对话的“对话列表”= 用户提问节点；assistant 回复带引用头，直接跳过。 */
function conversationItems(n) {
  const out = [];
  if (!n) return out;
  for (const e of n.entries) {
    const text = String(e.text || '');
    if (!text.trim() || text.startsWith(':::system')) continue;
    if (isReplyMessage(text)) continue;
    const preview = stripQuoteHeader(stripImages(text)).replace(/\s+/g, ' ').trim();
    if (!preview) continue;
    const chars = Array.from(preview);
    const cut = chars.length > 10 ? chars.slice(0, 10).join('') + '…' : preview;
    out.push({ e, preview: cut });
  }
  return out;
}

function currentChatEntry(items) {
  const visible = latestVisibleEntry();
  if (!visible) return null;
  let best = null;
  for (const it of items) {
    if (it.e.createdAt <= visible.createdAt) best = it;
    else break;
  }
  return best;
}

function dateBodyHTML(uniq, curDay) {
  return uniq.map(([d, t]) =>
    '<button type="button" data-day="' + d + '"' +
      (d === curDay ? ' class="cur"' : '') + '>' + esc(t) + '</button>'
  ).join('');
}

function chatBodyHTML(items, activeId) {
  if (!items.length) return '<div class="hint">这个话题还没有可列出的对话</div>';
  const shown = items.slice(0, 500);
  let h = shown.map(it =>
    '<button type="button" class="date-chat-item' +
      (it.e.id === activeId ? ' cur' : '') +
      '" data-eid="' + esc(it.e.id) + '">' +
      '<span class="date-chat-preview">' + esc(it.preview) + '</span>' +
      '<span class="date-chat-time">' +
        esc(fmtDayOfEntry(it.e)) + ' ' + esc(fmtTimeOfEntry(it.e)) +
      '</span></button>'
  ).join('');
  if (items.length > shown.length) {
    h += '<div class="hint">只显示前 ' + shown.length + ' 条，共 ' + items.length + ' 条</div>';
  }
  return h;
}

export function openDatePicker() {
  const sc = $('#entriesScroll');
  const n = Store.node(Store.ui.selectedId);
  if (!sc || !n || !n.entries.length) return;

  if (dateMenuClose) dateMenuClose();

  /* 日期列表必须来自整个话题，而不是当前已渲染的 80 条 */
  const dayMap = new Map();
  for (const e of n.entries) {
    const k = dayKeyOfEntry(e);
    if (!dayMap.has(k)) dayMap.set(k, fmtDayOfEntry(e));
  }
  const uniq = [...dayMap.entries()]
    .sort((a, b) => dayKeyNum(a[0]) - dayKeyNum(b[0]));
  if (!uniq.length) return;

  const curInfo = currentDateInfo();
  const curDay = (curInfo && curInfo.day) || uniq[uniq.length - 1][0];
  const showChat = isAiTopic(n);
  const chat = showChat ? conversationItems(n) : [];
  if (showChat && navTab === 'chat') {
    const active = currentChatEntry(chat);
    if (active) navTab = 'chat';
  }

  const menu = document.createElement('div');
  menu.className = 'date-menu';
  menu.innerHTML =
    '<div class="date-menu-head">' +
      '<button type="button" data-open-calendar>📅 选择日期</button>' +
    '</div>' +
    (showChat
      ? '<div class="date-menu-tabs">' +
          '<button type="button" data-nav-tab="date"' +
            (navTab === 'date' ? ' class="on"' : '') + '>日期</button>' +
          '<button type="button" data-nav-tab="chat"' +
            (navTab === 'chat' ? ' class="on"' : '') + '>对话</button>' +
        '</div>'
      : '') +
    '<div class="date-menu-body"></div>';
  document.body.appendChild(menu);

  const ac = new AbortController();
  const close = makeEscapable(() => {
    if (menu.isConnected) menu.remove();
    ac.abort();
    if (dateMenuClose === close) dateMenuClose = null;
  });
  dateMenuClose = close;

  const body = menu.querySelector('.date-menu-body');
  const renderBody = () => {
    if (showChat && navTab === 'chat') {
      const active = currentChatEntry(chat);
      body.innerHTML = chatBodyHTML(chat, active && active.e.id);
      const cur = body.querySelector('.cur');
      if (cur) body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2 + cur.offsetHeight / 2);
    } else {
      body.innerHTML = dateBodyHTML(uniq, curDay);
      const cur = body.querySelector('.cur');
      if (cur) body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2 + cur.offsetHeight / 2);
    }
  };

  /* 先按日期列表量一次宽度并锁死：切到“对话”时面板不再变宽。 */
  body.innerHTML = dateBodyHTML(uniq, curDay);
  const dateWidth = Math.ceil(menu.getBoundingClientRect().width);
  if (dateWidth) menu.style.width = dateWidth + 'px';
  renderBody();

  /* tab 切换 */
  menu.querySelectorAll('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.navTab;
      if (t !== 'date' && t !== 'chat') return;
      navTab = t;
      menu.querySelectorAll('[data-nav-tab]').forEach(b =>
        b.classList.toggle('on', b.dataset.navTab === t));
      renderBody();
    });
  });

  /* 列表点击 → 跳转 */
  body.addEventListener('click', ev => {
    const day = ev.target.closest('[data-day]');
    if (day) { close(); jumpToDay(sc, day.dataset.day); return; }
    const chatItem = ev.target.closest('[data-eid]');
    if (chatItem) {
      const eid = chatItem.dataset.eid;
      close();
      jumpToRow(n, eid);
    }
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