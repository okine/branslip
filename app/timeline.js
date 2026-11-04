// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE


'use strict';
/* ================= timeline.js =================
 * 时之间面板 —— 区间 + 时间点。
 *
 * 区间：创建 / 调整起点 / 终止 / 调整终点 / 删除
 * 时间点：记下 / 编辑（时间 + 名字） / 删除
 *
 * 对外：
 *   openTimelinePanel()
 *
 * 快捷键：Alt + T
 */

import { esc } from './utils.js';
import {
  openFullPage, toast, confirmDialog, openModal, closeModal,
} from './ui.js';
import {
  readTimeline,
  addTimelineRange, updateTimelineRange, removeTimelineRange,
  addTimelinePoint, updateTimelinePoint, removeTimelinePoint,
} from './io.js';
import { enqueue } from './writer.js';

/* _时之间.json 的每一次写都必须走 writer 队列（review 不变量 2）。
   这些动作都是 read-modify-write：不串行时两次快速操作会互相覆盖（丢区间 /
   丢时间点），并发 atomicWriteText 还会争用同一个 .tmp，读回校验失败，
   而 ui.js 里 onEvent 不 await，异常只会变成 unhandled rejection —— 用户零提示。 */
async function saveTimeline(fn) {
  const r = await enqueue(fn);
  if (r && r.ok) return true;
  toast('时之间保存失败：' + ((r && r.err && r.err.message) || (r && r.err) || '未知错误'));
  return false;
}

/* ---------- 格式化 ---------- */

function fmtDateTime(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtDuration(fromMs, toMs) {
  const ms = Math.max(0, toMs - fromMs);
  const sec  = Math.floor(ms / 1000);
  const min  = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  const day  = Math.floor(hour / 24);

  if (day >= 1) {
    const restH = hour - day * 24;
    return restH ? day + ' 天 ' + restH + ' 小时' : day + ' 天';
  }
  if (hour >= 1) {
    const restM = min - hour * 60;
    return restM ? hour + ' 小时 ' + restM + ' 分钟' : hour + ' 小时';
  }
  if (min >= 1) return min + ' 分钟';
  return sec + ' 秒';
}

/* 'YYYY-MM-DD HH:mm' → 毫秒；失败 null */
function parseLocalDateTime(s) {
  const m = String(s).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{1,2}))?$/
  );
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0, 0).getTime();
}

/* ---------- 对话框 ---------- */

/* 单行输入。返回 string | null（取消 / Escape） */
function inputDialog(title, defaultValue, hint) {
  let done = false;
  return new Promise(resolve => {
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const md = openModal(
      '<h3>' + esc(title) + '</h3>' +
      (hint ? '<p class="sub">' + esc(hint) + '</p>' : '') +
      '<input class="m-input" type="text" value="' + esc(defaultValue || '') + '">' +
      '<div class="modal-btns">' +
        '<button class="m-btn ghost" data-close>取消</button>' +
        '<button class="m-btn" data-ok ' +
          'style="background:var(--accent);color:#F5F1E4">确定</button>' +
      '</div>',
      () => finish(null)
    );
    const input = md.querySelector('.m-input');
    input.focus(); input.select();
    md.querySelector('[data-close]').addEventListener('click', closeModal);
    md.querySelector('[data-ok]').addEventListener('click', () => {
      finish(input.value); closeModal();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { finish(input.value); closeModal(); }
    });
  });
}

/* 时间 + 名字 双字段。返回 { at, label } | null */
function pointDialog(title, defaultMs, defaultLabel) {
  let done = false;
  return new Promise(resolve => {
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const md = openModal(
      '<h3>' + esc(title) + '</h3>' +
      '<p class="sub">时间格式：2026-09-30 14:30</p>' +
      '<input class="m-input" id="ptAt" type="text" ' +
        'value="' + esc(fmtDateTime(defaultMs)) + '">' +
      '<input class="m-input" id="ptLabel" type="text" ' +
        'placeholder="名字（可选）" value="' + esc(defaultLabel || '') + '">' +
      '<div class="modal-btns">' +
        '<button class="m-btn ghost" data-close>取消</button>' +
        '<button class="m-btn" data-ok ' +
          'style="background:var(--accent);color:#F5F1E4">确定</button>' +
      '</div>',
      () => finish(null)
    );
    const atIn = md.querySelector('#ptAt');
    const lbIn = md.querySelector('#ptLabel');
    atIn.focus(); atIn.select();

    const ok = () => {
      const ms = parseLocalDateTime(atIn.value);
      if (ms == null) { toast('时间格式不对'); atIn.focus(); return; }
      finish({ at: ms, label: String(lbIn.value).trim() });
      closeModal();
    };
    md.querySelector('[data-close]').addEventListener('click', closeModal);
    md.querySelector('[data-ok]').addEventListener('click', ok);
    [atIn, lbIn].forEach(el => el.addEventListener('keydown', e => {
      if (e.key === 'Enter') ok();
    }));
  });
}

/* ---------- 主面板 ---------- */

export async function openTimelinePanel() {
  let data = await readTimeline();

  const api = openFullPage({
    title: () => '时之间 · ' + (data.ranges.length + data.points.length),
    actions: () =>
      '<button class="tl-add" data-add-range>+ 现在开始</button>' +
      '<button class="tl-add" data-add-point>+ 记下此刻</button>',
    render: () => renderBody(data),

    onEvent: async ev => {
      const t = ev.target;
      if (t.closest('[data-add-range]')) return onCreateRange();
      if (t.closest('[data-add-point]')) return onCreatePoint();

      /* data-* 一律带 createdAt（只读身份）。
         起止 / 时刻是另一回事，只用于显示，不在 data-* 里当 key。 */
      const s = t.closest('[data-edit-from]');
      if (s) return onAdjustStart(+s.dataset.editFrom);
      const e = t.closest('[data-end-now]');
      if (e) return onEndNow(+e.dataset.endNow);
      const to = t.closest('[data-edit-to]');
      if (to) return onAdjustEnd(+to.dataset.editTo);
      const d = t.closest('[data-del-range]');
      if (d) return onDeleteRange(+d.dataset.delRange);
      const l = t.closest('[data-edit-label]');
      if (l) return onEditLabel(+l.dataset.editLabel);

      const ep = t.closest('[data-edit-point]');
      if (ep) return onEditPoint(+ep.dataset.editPoint);
      const dp = t.closest('[data-del-point]');
      if (dp) return onDeletePoint(+dp.dataset.delPoint);
    },
  });

  async function refresh() {
    data = await readTimeline();
    api.redraw();
  }

  /* 按 createdAt 找记录。找不到说明面板数据过期了（在别处删过 / 改过），
     以前这里是静默 return —— 现在身份稳定了，"找不到"才真的是异常。 */
  const rangeOf = key => data.ranges.find(x => x.createdAt === key);
  const pointOf = key => data.points.find(x => x.createdAt === key);
  function stale() { toast('这条已经变了，关掉重开一次时之间'); }

  /* ── 区间动作 ── */

  async function onCreateRange() {
    const label = await inputDialog('给这段区间起个名字', '');
    if (label == null) return;
    if (!await saveTimeline(() => addTimelineRange(Date.now(), null, String(label).trim()))) return;
    toast('已开始');
    await refresh();
  }

  async function onAdjustStart(key) {
    const r = rangeOf(key);
    if (!r) return stale();
    const v = await inputDialog('调整起点', fmtDateTime(r.from), '格式：2026-09-30 14:30');
    if (v == null) return;
    const ms = parseLocalDateTime(v);
    if (ms == null) { toast('时间格式不对'); return; }
    if (r.to != null && ms > r.to) { toast('起点不能晚于终点'); return; }
    if (!await saveTimeline(() => updateTimelineRange(key, { from: ms }))) return;
    toast('已调整');
    await refresh();
  }

  async function onEndNow(key) {
    const r = rangeOf(key);
    if (!r) return stale();
    const ok = await confirmDialog(
      '终止这段区间？',
      '「' + (r.label || '未命名') + '」将在现在结束。',
      { okText: '终止' }
    );
    if (!ok) return;
    if (!await saveTimeline(() => updateTimelineRange(key, { to: Date.now() }))) return;
    toast('已终止');
    await refresh();
  }

  async function onAdjustEnd(key) {
    const r = rangeOf(key);
    if (!r) return stale();
    const v = await inputDialog('调整终点', fmtDateTime(r.to), '格式：2026-09-30 14:30');
    if (v == null) return;
    const ms = parseLocalDateTime(v);
    if (ms == null) { toast('时间格式不对'); return; }
    if (ms < r.from) { toast('终点不能早于起点'); return; }
    if (!await saveTimeline(() => updateTimelineRange(key, { to: ms }))) return;
    toast('已调整');
    await refresh();
  }

  async function onDeleteRange(key) {
    const r = rangeOf(key);
    if (!r) return stale();
    const ok = await confirmDialog('删除这段区间？', '此操作无法撤销。',
      { danger: true, okText: '删除' });
    if (!ok) return;
    if (!await saveTimeline(() => removeTimelineRange(key))) return;
    toast('已删除');
    await refresh();
  }

  async function onEditLabel(key) {
    const r = rangeOf(key);
    if (!r) return stale();
    const v = await inputDialog('名字', r.label || '');
    if (v == null) return;
    if (!await saveTimeline(() => updateTimelineRange(key, { label: String(v).trim() }))) return;
    await refresh();
  }

  /* ── 时间点动作 ── */

  async function onCreatePoint() {
    const r = await pointDialog('记下一个时刻', Date.now(), '');
    if (!r) return;
    if (!await saveTimeline(() => addTimelinePoint(r.at, r.label))) return;
    toast('已记下');
    await refresh();
  }

  async function onEditPoint(key) {
    const p = pointOf(key);
    if (!p) return stale();
    const r = await pointDialog('编辑时间点', p.at, p.label || '');
    if (!r) return;
    if (!await saveTimeline(() => updateTimelinePoint(key, { at: r.at, label: r.label }))) return;
    toast('已更新');
    await refresh();
  }

  async function onDeletePoint(key) {
    const ok = await confirmDialog('删除这个时间点？', '此操作无法撤销。',
      { danger: true, okText: '删除' });
    if (!ok) return;
    if (!await saveTimeline(() => removeTimelinePoint(key))) return;
    toast('已删除');
    await refresh();
  }
}

/* ---------- 渲染 ---------- */

function renderBody(data) {
  const ranges = data.ranges || [];
  const points = data.points || [];

  if (!ranges.length && !points.length) {
    return '<div class="tl-empty">还没有任何区间或时间点。<br><br>' +
      '「+ 现在开始」把此刻作为一段区间的起点——比如一段工作、一次旅行。<br>' +
      '「+ 记下此刻」标记一个瞬间——开始学画画、搬家的那天。<br><br>' +
      '区间回答「持续了多久」，时间点回答「那天」。</div>';
  }

  const ongoing = ranges.filter(r => r.to == null).sort((a, b) => b.from - a.from);
  const ended    = ranges.filter(r => r.to != null).sort((a, b) => b.to - a.to);
  const sortedPts = points.slice().sort((a, b) => b.at - a.at);

  let h = '';
  if (ongoing.length) {
    h += '<div class="tl-section">' +
      '<h4 class="tl-section-title">进行中 · ' + ongoing.length + '</h4>' +
      ongoing.map(renderOngoing).join('') +
    '</div>';
  }
  if (sortedPts.length) {
    h += '<div class="tl-section">' +
      '<h4 class="tl-section-title">时间点 · ' + sortedPts.length + '</h4>' +
      sortedPts.map(renderPoint).join('') +
    '</div>';
  }
  if (ended.length) {
    h += '<div class="tl-section">' +
      '<h4 class="tl-section-title">已结束 · ' + ended.length + '</h4>' +
      ended.map(renderEnded).join('') +
    '</div>';
  }
  return h;
}

/* data-* 里放的是 createdAt（只读身份）；显示用 from / to / at。
   老实现把 from 同时当身份和显示值，改一次起点就再也定位不到自己了。 */
function renderOngoing(r) {
  return '<div class="tl-item tl-item-ongoing">' +
    '<div class="tl-item-head">' +
      '<span class="tl-dot ongoing"></span>' +
      '<span class="tl-item-label" data-edit-label="' + r.createdAt + '" title="点击改名">' +
        esc(r.label || '未命名') + '</span>' +
      '<span class="tl-item-span ongoing">已持续 ' +
        fmtDuration(r.from, Date.now()) + '</span>' +
    '</div>' +
    '<div class="tl-item-time">' + fmtDateTime(r.from) + ' 开始</div>' +
    '<div class="tl-item-acts">' +
      '<button data-edit-from="' + r.createdAt + '">调整起点</button>' +
      '<button data-end-now="' + r.createdAt + '">终止</button>' +
      '<button data-del-range="' + r.createdAt + '" class="danger">删除</button>' +
    '</div>' +
  '</div>';
}

function renderEnded(r) {
  return '<div class="tl-item">' +
    '<div class="tl-item-head">' +
      '<span class="tl-dot"></span>' +
      '<span class="tl-item-label" data-edit-label="' + r.createdAt + '" title="点击改名">' +
        esc(r.label || '未命名') + '</span>' +
      '<span class="tl-item-span">' + fmtDuration(r.from, r.to) + '</span>' +
    '</div>' +
    '<div class="tl-item-time">' + fmtDateTime(r.from) +
      ' – ' + fmtDateTime(r.to) + '</div>' +
    '<div class="tl-item-acts">' +
      '<button data-edit-from="' + r.createdAt + '">调整起点</button>' +
      '<button data-edit-to="' + r.createdAt + '">调整终点</button>' +
      '<button data-del-range="' + r.createdAt + '" class="danger">删除</button>' +
    '</div>' +
  '</div>';
}

function renderPoint(p) {
  return '<div class="tl-item tl-item-point">' +
    '<div class="tl-item-head">' +
      '<span class="tl-dot point"></span>' +
      '<span class="tl-item-label">' + esc(p.label || '未命名') + '</span>' +
      '<span class="tl-item-span">已经过 ' + fmtDuration(p.at, Date.now()) + '</span>' +
    '</div>' +
    '<div class="tl-item-time">' + fmtDateTime(p.at) + '</div>' +
    '<div class="tl-item-acts">' +
      '<button data-edit-point="' + p.createdAt + '">编辑</button>' +
      '<button data-del-point="' + p.createdAt + '" class="danger">删除</button>' +
    '</div>' +
  '</div>';
}

/* ---------- 快捷键：Alt + T ---------- */

document.addEventListener('keydown', e => {
  if (e.key !== 't' && e.key !== 'T') return;
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.matches && e.target.matches('input,textarea')) return;
  e.preventDefault();
  openTimelinePanel();
});