// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= writer.js =================
 * 串行写入队列 + 保存状态指示。
 *
 *   enqueue(fn)        把一个写操作排进队列。所有磁盘写都应该走这里。
 *   setStatus(s, st)   更新左下角状态点 / 文字
 *   markFsReady()      文件夹就绪 —— 放行排在队列里的"未连接期"写任务
 *
 * enqueue 保证：
 *   - 所有 fn 串行执行，不会交叉
 *   - 任何 fn 抛错不中断队列
 *   - 未连接文件夹时不丢弃任务：排队等 markFsReady() 后按原顺序执行，
 *     这样调用方才有机会知道"这笔写没落盘"，不会出现
 *     "内存说已保存、磁盘上没有"的静默丢数据
 *   - 权限类错误 → 主动请求权限，提示用户重试
 *   - 其它错误 → toast + 红灯 + title 记最近一次错误
 *   - 队列空闲且无错误时自动切回"已保存"
 *
 * 返回值：本任务的 Promise（不是 Store.fs.chain）——
 *   resolve `{ ok: true }` 或 `{ ok: false, err }`。
 *   **它永远不 reject**：失败不再被静默吞掉（调用方拿得到 err），
 *   也不会让那十几个 fire-and-forget 的 `enqueue(...)` 变成
 *   unhandled rejection。需要回滚的调用方查 `ok` 即可。
 *   注意：句柄在 .finally 之前就 settle，所以"pending 是否归零"这类
 *   断言要等 Store.fs.chain，不能等句柄。
 *   Store.fs.chain 本身同样永远不 reject —— 一个任务失败不阻断队列。
 *
 * 与 io.js 的分工：
 *   io.js 回答"这个文件怎么写"
 *   writer.js 回答"这些写什么时候执行、按什么顺序、失败了怎么办"
 */

import { $,esc  }     from './utils.js';
import { Store, draftTopicIds } from './store.js';
import { currentWindow, invoke } from './platform.js';
import { toast, promptPermissionRecovery, openModal, closeModal, confirmDialog } from './ui.js';
import { stats } from './tree-utils.js';
let lastStats = null;

/* ★ 新增：saving 状态的最小显示时长 + 首次显示时刻 */
let pendingShownAt = 0;
const MIN_SAVING_MS = 500;

/* 当前正在执行的任务的进度。null = 无进度可报 */
let _progress = null;
let _activeToken = null;   /* 谁在跑 —— 用来防止过期任务覆盖进度 */
let _lastError = null;   // 最近一次失败原因，供红灯弹框展示

/* 判断 File System Access API 的"权限/只读"类错误 */
function isPermissionError(err) {
  if (!err) return false;
  if (err.name === 'NoModificationAllowedError') return true;
  if (err.name === 'NotAllowedError') return true;
  const msg = String(err.message || '');
  return /modifications are not allowed|not allowed|read-?only|permission denied/i.test(msg);
}

/* ---------- 未连接期的写任务闸门 ----------
 *
 * boot.js 的 connect() 走完才置 Store.fs.ready = true。在那之前发起的
 * 写任务不能直接丢（旧实现 return Promise.resolve() → 调用方以为写成功，
 * 回滚分支永不触发），而应该原地等文件夹就绪。
 *
 * 约定：
 *   - 等待者按 FIFO 唤起，配合 Store.fs.chain 保证整体仍是串行
 *   - 用户换了文件夹（connect 再次被调）时，旧等待者就地放行；
 *     任务本身会按那时候的 Store.dir 去写 —— 与"连接期间到达的新任务"
 *     行为一致，不额外制造语义分歧
 *      *   - ★ 只要 markFsReady() 被调过一次，闸门就永久打开：
 *     后续 waitForFs() 立即放行，不会再挂起。
 *     这样即使 connect() 失败（权限拒绝 / 路径不存在 / picker 取消后
 *     用户再也没连上），队列也不会无限堆积。
 */
let _fsWaiters  = [];
let _fsGateOpen = false;

/** 文件夹就绪：放行所有还在等 ready 的写任务。boot.js 的 connect() 调用。 */
export function markFsReady() {
  _fsGateOpen = true;
  if (!_fsWaiters.length) return;
  const waiters = _fsWaiters;
  _fsWaiters = [];
  for (const w of waiters) w();
}

function waitForFs() {
  if (Store.fs.ready || _fsGateOpen) return Promise.resolve();
  return new Promise(resolve => { _fsWaiters.push(resolve); });
}

/* 一个任务失败后的统一处置：红灯 / toast / 权限恢复提示。
   调用方已经通过句柄知道失败了，这里只负责"告诉用户"。
   刻意不 re-throw —— Store.fs.chain 必须保持可用，一个失败不阻断队列。 */
async function reportFailure(err) {
  console.error(err);
  Store.fs.hasError = true;
  _lastError = err; 

  const dot = $('#saveDot');

  if (isPermissionError(err) && Store.dir) {
    if (dot) dot.title = '需要文件夹读写权限，点击左下角红灯或重新授权';
    setStatus('error');
    promptPermissionRecovery();
    return;
  }
  if (dot) {
    dot.title = (err && err.name ? err.name + '：' : '') +
      ((err && err.message) || String(err));
  }
  toast('操作中断：' + ((err && err.message) || err) + '（点击左下角红灯可回看）');
  setStatus('error');
}

export function enqueue(fn) {
  Store.fs.pending++;
  const myToken = Symbol('task');

  /* 本任务的句柄。为什么不直接 return Store.fs.chain：
     .finally() 会把链的值换成新的 Promise，调用方接到的就不是
     自己那个任务了，await 的永远是"下一个空 promise" —— 失败传不出去。
     句柄只服务"这一个任务"的结果，chain 仍然负责串行。 */
  let settle;
  const handle = new Promise(res => { settle = res; });

  setStatus('saving');

  Store.fs.chain = Store.fs.chain
    .then(() => {
      /* 现在轮到我了 —— 认领"当前任务" */
      _activeToken = myToken;
      _progress = null;

      /* 只给当前任务一个 report。老调用方忽略这个参数即可 */
      const report = (done, total) => {
        if (_activeToken !== myToken) return;   /* 已经被后续任务顶掉了 */
        if (!total || total <= 1) return;       /* 没有"进度"可言 */
        _progress = { done, total };
        setStatus('saving');
      };

      /* 已连接（绝大多数情况）→ 同步直通，不引入额外 microtask；
         未连接 → 先等文件夹就绪，再执行 */
      if (Store.fs.ready) return fn(report);
      return waitForFs().then(() => fn(report));
    })
    .then(
      () => { settle({ ok: true }); },
      async err => {
        await reportFailure(err);
        settle({ ok: false, err });   /* 结果走值，不走 rejection */
      })
    .finally(() => {
      /* 只有"我仍是当前任务"时才清 —— 否则会把后继任务的进度也清掉 */
      if (_activeToken === myToken) {
        _activeToken = null;
        _progress = null;
      }
      Store.fs.pending--;
      if (Store.fs.pending === 0) {
        if (!Store.fs.hasError) setStatus('saved', stats());
        Store.fs.chain = Promise.resolve();
      } else {
        setStatus('saving');
      }
    });

  return handle;
}

export function setStatus(s, st) {
  const dot = $('#saveDot'), txt = $('#saveText');
  if (!dot) return;

  if (s === 'saved') {
    /* ★ 保证 saving 至少显示 MIN_SAVING_MS，避免一闪而过 */
    const elapsed = pendingShownAt ? Date.now() - pendingShownAt : Infinity;
    if (elapsed < MIN_SAVING_MS) {
      setTimeout(() => {
        if (Store.fs.pending === 0 && !Store.fs.hasError) {
          setStatus('saved', st);
        }
      }, MIN_SAVING_MS - elapsed);
      return;
    }
    pendingShownAt = 0;
    if (st) lastStats = st;
    const use = st || lastStats;
    dot.style.background = '#5FA268';
    dot.style.animation = '';
    dot.title = '';
    txt.textContent = use
      ? ('已保存 · ' + use.t + ' 个话题 · ' + use.e + ' 条记录')
      : '已保存';
    return;
  }

  if (s === 'saving') {
    if (!pendingShownAt) pendingShownAt = Date.now();
    const n = Store.fs.pending;

    /* 主文案：有进度就显示"X / Y"，否则退回"写入中" */
    let text;
    if (_progress) {
      text = '操作进行中… ' + _progress.done + ' / ' + _progress.total;
      if (n > 1) text += '（+' + (n - 1) + ' 排队）';
    } else {
      text = '操作进行中…' + (n > 1 ? '（' + n + '）' : '');
    }

    dot.style.background = '#C9A227';
    dot.style.animation = 'savePulse 1.1s ease-in-out infinite';
    dot.title = text;
    txt.textContent = text;
    return;
  }

  if (s === 'error') {
    pendingShownAt = 0;
    dot.style.background = '#B2402C';
    dot.style.animation = '';
    txt.textContent = '操作中断：点击查看';
    return;
  }

  pendingShownAt = 0;
  dot.style.background = '#B9B09B';
  dot.style.animation = '';
  dot.title = '';
  txt.textContent = '未连接';
}
/* ---------- 错误详情 / 复位 ---------- */

function describeError(err) {
  if (!err) return '';
  const name = err.name ? err.name + '：' : '';
  const msg  = err.message || String(err);
  return name + msg;
}

/**
 * 用户看过错误详情后调用：
 * 复位 hasError；队列空闲时立即切回"已保存"绿灯，
 * 还在写入中就显示"操作进行中"（下一步成功会自然转绿）。
 */
export function clearFsError() {
  _lastError = null;
  Store.fs.hasError = false;
  const dot = $('#saveDot');
  if (dot) dot.title = '';
  if (Store.fs.pending === 0) setStatus('saved', stats());
  else                        setStatus('saving');
}

export function getLastError() { return _lastError; }

function openErrorDetail() {
  if (!Store.fs.hasError) return;
  const detail = describeError(_lastError) || '（无详情）';

  const md = openModal(
    '<h3>磁盘写入中断</h3>' +
    '<p class="sub">最近一次写入没有完成。常见原因：' +
      '文件夹读写权限被浏览器收回、存储空间不足、文件被其他程序占用。</p>' +
    '<pre style="margin:10px 0 0;padding:10px 12px;' +
      'background:var(--paper);border:1px solid var(--line-soft);border-radius:8px;' +
      'font-size:12px;line-height:1.6;max-height:180px;overflow:auto;' +
      'white-space:pre-wrap;word-break:break-word;color:var(--ink2)">' +
      esc(detail) + '</pre>' +
    '<div class="modal-btns">' +
      '<button class="m-btn" data-ok style="background:var(--accent);color:#F5F1E4">知道了</button>' +
    '</div>',
    /* onClose：按钮 / Escape / 点遮罩 —— 任何关闭路径都走到这里，
       看过详情才算数，此刻才复位。 */
    () => { clearFsError(); }
  );

  md.querySelector('[data-ok]').addEventListener('click', closeModal);
}

/* 红灯点击 → 看详情 → 看过才绿。
   用委托，避免模块顶层执行时 #saveDot 尚未就绪（虽然目前能拿到）。 */
document.addEventListener('click', e => {
  const t = e.target;
  if (!t || t.id !== 'saveDot') return;
  if (!Store.fs.hasError) return;
  openErrorDetail();
});

/*
 * 等待写入队列空闲。
 *   onProgress(pending)  每次 tick 时回调，方便显示进度
 * 返回 Promise，队列空闲时 resolve。*/
 
export function waitForIdle(onProgress) {
  return new Promise(resolve => {
    if (Store.fs.pending === 0) return resolve();
    const tick = () => {
      if (onProgress) onProgress(Store.fs.pending);
      if (Store.fs.pending === 0) return resolve();
      setTimeout(tick, 80);
    };
    tick();
  });
}
/* ---------- 退出保护（有草稿 / 有写盘排队时别静默丢） ----------
 * 1) 浏览器 & WebView：beforeunload（只能弹系统默认确认框）
 * 2) Tauri 桌面：拦窗口关闭事件，弹自己的确认框，确认了才 destroy
 * 由 app.js 在 wire 完成后调用一次。
 */
let _exitGuardInstalled = false;
/* 用户已经确认"仍然关闭" → 放行 beforeunload，否则 destroy 会再被拦一次 */
let _exiting = false;

function hasUnsavedWork() {
  return draftTopicIds().length > 0 || Store.fs.pending > 0;
}

function unsavedSummary() {
  const d = draftTopicIds().length;
  const p = Store.fs.pending;
  const bits = [];
  if (d) bits.push(d + ' 个话题里有草稿');
  if (p) bits.push(p + ' 个写入还在排队');
  return bits.join('，');
}

export function installExitGuard() {
  if (_exitGuardInstalled) return;
  _exitGuardInstalled = true;

  window.addEventListener('beforeunload', e => {
    if (_exiting) return;
    if (!hasUnsavedWork()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  try {
    const win = currentWindow();
    if (!win || typeof win.onCloseRequested !== 'function') return;
    win.onCloseRequested(async ev => {
      if (!hasUnsavedWork()) return;
      ev.preventDefault();
      const ok = await confirmDialog(
        '还有没保存的内容',
        unsavedSummary() + '。\n现在关闭会丢掉这些内容。',
        { danger: true, okText: '仍然关闭', cancelText: '继续写' }
      );
      if (!ok) return;
      _exiting = true;
      /* 正常路径：destroy 关窗。ACL 没给 allow-destroy 时它会 reject，
         这时退到 Rust 的 quit_app，别让用户"点了关闭却关不掉"。 */
      try {
        await win.destroy();
      } catch (e) {
        console.warn('[exit] destroy 失败，改用 quit_app', e);
        try { await invoke('quit_app'); } catch (e2) { console.error('[exit] quit_app 也失败', e2); }
      }
    });
  } catch (e) { /* 非 Tauri 环境忽略 */ }
}
