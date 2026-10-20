// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE


'use strict';
/* ================= ui.js =================
 * 通用 UI 原语：toast / 菜单 / 模态 / 侧栏 / 灯箱
 *
 * 只依赖 DOM；话题树相关的选择器在 ui-topicPicker.js。
 * 不含业务逻辑 —— 谁调用谁负责业务。
 *  *   sidebar    {() => string}            可选，返回 .pp-side 内容 HTML
 */

import { $, esc } from './utils.js';
import { Store } from './store.js';
import { I } from './icons.js'; 
let _pendingResolve = null;
/* ---------- Toast ---------- */

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toastRoot').appendChild(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2600);
}



const _escStack = [];

/**
 * 把一个"可被 Escape 关闭"的 handler 压栈。
 * 返回一个 unpush 函数，必须在关闭时调用，否则栈里会留僵尸。
 */
export function pushEsc(handler) {
  const entry = { handler };
  _escStack.push(entry);
  return () => {
    const i = _escStack.indexOf(entry);
    if (i >= 0) _escStack.splice(i, 1);
  };
}

/** 栈顶有没有东西 —— 供 app.js 判断要不要 preventDefault */
export function hasEscapable() { return _escStack.length > 0; }

// ui.js —— 不注册全局监听器，只导出 runTopEsc
export function runTopEsc() {
  if (!_escStack.length) return false;
  const top = _escStack[_escStack.length - 1];

  /* ★ 栈的所有权在 ui.js：调用完自己把它摘掉，不要指望 handler 内部
     会去调 pushEsc 给的那个 unpush。
     历史 bug：makeEscapable 的 close() 只在第一次 active 时 off()，
     一旦 closeFn 被别的路径先跑过，active 已是 false，close() 直接
     return，那条就永远留在栈里 —— hasEscapable() 从此恒为 true，
     app.js 的 Escape 分发和 tree.js 的 hasModal() 判断全部被带偏。 */
  const i = _escStack.indexOf(top);
  if (i >= 0) _escStack.splice(i, 1);

  top.handler();
  return true;
}

export function makeEscapable(closeFn) {
  let active = true;
  let off = null;

  /* 两种用法要分清楚：
     ① 主动关：close() → 跑 closeFn()（幂等）
     ② 被 Escape 命中：runTopEsc() 会先把条目摘掉，再调 close()。
        这时条目已经不在栈上了，close() 必须**什么都不做** ——
        既不能再跑一遍 closeFn（会重复关闭），也不能再 off() 一次
        （off 按下标 splice，二次调用会把栈里下面那条也误摘掉）。 */
  const close = () => {
    if (!active) return;
    if (off) {
      active = false;
      const offNow = off;
      off = null;
      offNow();
      closeFn();
    }
    /* off === null ⇒ 已经被 runTopEsc 摘过，直接 no-op */
  };

  off = pushEsc(close);
  return close;
}
/* ---------- 菜单 ---------- */

const menuRoot  = $('#menuRoot');
const modalRoot = $('#modalRoot');

let menuAC = null;
let _menuEscOff = null; 

export function closeMenu() {
  menuRoot.innerHTML = '';
  if (menuAC) { menuAC.abort(); menuAC = null; }   /* ★ 同步清监听器 */
  if (_menuEscOff) { _menuEscOff(); _menuEscOff = null; }
}

export function hasMenu()   { return menuRoot.childElementCount > 0; }

/* align: 'right' → x 是锚点右边缘；
          'center' → x 是锚点中心；
          省略     → x 是锚点左边缘。 */
export function openMenuAt(x, y, items, align) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="menu-sep"></div>';
    if (it.split) {
      return '<div class="menu-item menu-split">' +
        '<button class="menu-half" data-mi="' + i + '">' + (it.icon || '') + '<span>' + esc(it.label) + '</span></button>' +
        '<span class="menu-split-sep">丨</span>' +
        '<button class="menu-half" data-mis="' + i + '"><span>' + esc(it.split) + '</span></button>' +
      '</div>';
    }
    return '<button class="menu-item' + (it.danger ? ' danger' : '') +
      '" data-mi="' + i + '">' + (it.icon || '') + '<span>' + esc(it.label) + '</span></button>';
  }).join('');
  menuRoot.appendChild(m);
  _menuEscOff = pushEsc(closeMenu);

  /* setTimeout 避免当前这次点击立即触发关闭 */
  const ac = new AbortController();
  menuAC = ac;
  setTimeout(() => {
    document.addEventListener('pointerdown', ev => {
      if (!m.contains(ev.target)) closeMenu();
    }, { signal: ac.signal });
  }, 0);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left;
  if (align === 'right') left = x - mw;       // x 传锚点右边缘
  else if (align === 'center') left = x - mw / 2;
  else left = x;                               // 默认左对齐
  m.style.left = Math.max(8, Math.min(left, innerWidth - mw - 8)) + 'px';
  m.style.top  = Math.max(8, Math.min(y, innerHeight - mh - 8)) + 'px';
  m.addEventListener('click', ev => {
    const bs = ev.target.closest('[data-mis]');
    if (bs) { const it = items[+bs.dataset.mis]; closeMenu(); it.splitFn(); return; }
    const b = ev.target.closest('[data-mi]'); if (!b) return;
    closeMenu(); items[+b.dataset.mi].fn();
  });
  
}

export function openMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  openMenuAt(r.right, r.bottom + 6, items, 'right');   // ← 传真实右边缘
}

/* ---------- 模态 ---------- */

export function hasModal()   { return modalRoot.childElementCount > 0; }

/* 当前 modal 的关闭函数（makeEscapable 返回，幂等）。
   所有关闭路径（mask / 取消 / 确认 / Escape）都走它。 */
let _modalClose = null;

export function closeModal() {
  if (_modalClose) {
    _modalClose();          // 幂等 —— 触发 closeFn：清 DOM + resolve(false) + pop esc 栈 + onClose
  } else {
    // 防御：_modalClose 丢了（理论上不该发生）
    modalRoot.innerHTML = '';
    if (_pendingResolve) { const r = _pendingResolve; _pendingResolve = null; r(false); }
  }
}

export function openModal(html, onClose) {
  // ★ 打开新的先关旧的 —— 走 closeModal，旧的 pending 会被 resolve(false)
  if (_modalClose) closeModal();

  modalRoot.innerHTML = '<div class="mask"><div class="modal">' + html + '</div></div>';
  const mask = modalRoot.querySelector('.mask');
  mask.addEventListener('pointerdown', e => { if (e.target === mask) closeModal(); });

  _modalClose = makeEscapable(() => {
    modalRoot.innerHTML = '';
    _modalClose = null;
    if (_pendingResolve) {
      const r = _pendingResolve;
      _pendingResolve = null;
      r(false);
    }
    if (typeof onClose === 'function') onClose();
  });

  return modalRoot.querySelector('.modal');
}

export function confirmDialog(title, message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const md = openModal(
      '<h3>' + esc(title) + '</h3>' +
      '<p class="sub">' + esc(message) + '</p>' +
      '<div class="modal-btns">' +
      '<button class="m-btn ghost" data-close>' + (opts.cancelText || '取消') + '</button>' +
      '<button class="m-btn ' + (opts.danger ? 'danger' : '') + '" data-ok>' +
        (opts.okText || '确认') + '</button>' +
      '</div>');
    _pendingResolve = resolve;   // openModal 已经清理完旧的
    md.querySelector('[data-close]').addEventListener('click', () => { closeModal(); });
    md.querySelector('[data-ok]').addEventListener('click', () => {
      const r = _pendingResolve;
      _pendingResolve = null;
      closeModal();
      if (r) r(true);
    });
  });
}

/**
 * 单行文本输入弹窗。返回 string | null（取消 / Escape）。
 * opts: value / placeholder / hint / okText / cancelText
 */
export function promptInput(title, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };

    const md = openModal(
      '<h3>' + esc(title) + '</h3>' +
      (opts.hint ? '<p class="sub">' + esc(opts.hint) + '</p>' : '') +
      '<input class="m-input" type="text" value="' + esc(opts.value || '') + '"' +
        ' placeholder="' + esc(opts.placeholder || '') + '"' +
        (Array.isArray(opts.suggestions) && opts.suggestions.length
          ? ' list="prompt-suggestions" autocomplete="off"' : '') + '>' +
      (Array.isArray(opts.suggestions) && opts.suggestions.length
        ? '<datalist id="prompt-suggestions">' +
            opts.suggestions.map(s => '<option value="' + esc(s) + '"></option>').join('') +
          '</datalist>'
        : '') +
      '<div class="modal-btns">' +
      '<button class="m-btn ghost" data-close>' + (opts.cancelText || '取消') + '</button>' +
      '<button class="m-btn" data-ok style="background:var(--accent);color:#F5F1E4">' +
        (opts.okText || '确定') + '</button>' +
      '</div>',
      () => finish(null)
    );

    const input = md.querySelector('.m-input');
    input.focus();
    input.select();

    md.querySelector('[data-close]').addEventListener('click', closeModal);
    const ok = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      finish(v);
      closeModal();
    };
    md.querySelector('[data-ok]').addEventListener('click', ok);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
    });
  });
}
/* ---------- 权限恢复提示 ---------- */
let _permPromptOpen = false;

export function promptPermissionRecovery() {
  if (_permPromptOpen) return;
  _permPromptOpen = true;

  // ★ onClose 在所有关闭路径（含 Escape）都被调用
  const md = openModal(
    '<h3>需要文件夹权限</h3>' +
    '<p class="sub">浏览器在一段时间后收回了读写权限。<br>' +
    '点击下方按钮重新授权，之前失败的写入会保留在内存里，授权后重试即可。</p>' +
    '<div class="modal-btns">' +
      '<button class="m-btn ghost" data-close>稍后</button>' +
      '<button class="m-btn" data-req style="background:var(--accent);color:#F5F1E4">重新授权</button>' +
    '</div>',
    () => { _permPromptOpen = false; }       // ← 唯一复位点，Escape 也会走到
  );

  md.querySelector('[data-close]').addEventListener('click', closeModal);
  md.querySelector('[data-req]').addEventListener('click', async () => {
    try {
      const perm = await Store.dir.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        closeModal();
        toast('权限已恢复，请重试刚才的操作');
      } else {
        toast('未获得权限，请重新连接文件夹');
      }
    } catch (e) {
      toast('授权失败：' + (e.message || e));
    }
  });
}
/* ---------- 通用话题选择器已迁到 ui-topicPicker.js ---------- */


// 侧栏
let _sideEscOff = null;
export function openSide() {
  document.body.classList.add('side-open');
  if (!_sideEscOff) _sideEscOff = pushEsc(closeSide);
}
export function closeSide() {
  document.body.classList.remove('side-open');
  if (_sideEscOff) { _sideEscOff(); _sideEscOff = null; }
}

/* ---------- 全屏页面 ---------- */

/**
 * 打开一个全屏浮层页面（回收站 / 拾之 / 置顶 等）。
 *
 * 预置行为（不用再写）：
 *   - 页头结构（.pp-head / .pp-back / h3 / .pp-actions）
 *   - 点遮罩关闭 / 点 .pp-back 关闭 / Escape 关闭
 *   - redraw 时保留 .pp-list 滚动位置
 *
 * @param {object} opts
 *   title      {string | () => string}   标题（函数则每次重绘时调用）
 *   render     {() => string}            必填，返回 .pp-list 内容 HTML
 *   actions    {() => string}            可选，返回 .pp-actions 内容 HTML
 *   onEvent    {(ev, api) => void}       可选，业务点击处理（关闭逻辑已预置）
 *   afterDraw  {(api) => void}           可选，每次重绘后调用（图片水合等）
 *   onClose    {() => void}              可选，关闭时调用
 *   keepScroll {boolean}                 默认 true
 *
 * @returns {{ el: HTMLElement, redraw: () => void, close: () => void,
*             setTitle: (t: string) => void }}
*/
export function openFullPage(opts) {
 opts = opts || {};
 const d = document.createElement('div');
 d.className = 'pin-page';

 const close = makeEscapable(() => {
   if (d.parentNode) d.remove();
   if (typeof opts.onClose === 'function') opts.onClose();
 });

 function setTitle(t) {
   const h = d.querySelector('.pp-head h3');
   if (h) h.textContent = t;
 }

 function redraw() {
  const oldList = d.querySelector('.pp-list');
  const prevTop = (opts.keepScroll !== false && oldList) ? oldList.scrollTop : 0;
  const oldSide = d.querySelector('.pp-side');
  const prevSideTop = oldSide ? oldSide.scrollTop : 0;

  const rawTitle = (typeof opts.title === 'function') ? opts.title() : opts.title;
  const title   = rawTitle == null ? '' : String(rawTitle);
  const actions = opts.actions ? opts.actions() : '';
  const body    = opts.render  ? opts.render()  : '';
  const side    = opts.sidebar ? opts.sidebar() : '';
  const sideCls = opts.sideClass ? ' ' + opts.sideClass : '';

  const listHtml = '<div class="pp-list">' + body + '</div>';
  const bodyHtml = '<div class="pp-body">' +
    (side ? '<div class="pp-side' + sideCls + '">' + side + '</div>' : '') +
    listHtml +
  '</div>';

  d.innerHTML =
    '<div class="pp-head">' +
      '<button class="pp-back">' + I.x + '<span>关闭</span></button>' +
      '<h3>' + esc(title) + '</h3>' +
      (actions ? '<div class="pp-actions">' + actions + '</div>' : '') +
    '</div>' +
    bodyHtml;

  const nextList = d.querySelector('.pp-list');
  if (nextList && prevTop) nextList.scrollTop = prevTop;
  const nextSide = d.querySelector('.pp-side');
  if (nextSide && prevSideTop) nextSide.scrollTop = prevSideTop;

  if (typeof opts.afterDraw === 'function') opts.afterDraw(api);
}

 d.addEventListener('click', ev => {
   if (ev.target === d) { close(); return; }                 // 点遮罩
   if (ev.target.closest('.pp-back')) { close(); return; }   // 点返回
   if (typeof opts.onEvent === 'function') opts.onEvent(ev, api);
 });

 const api = { el: d, redraw, close, setTitle };

 document.body.appendChild(d);
 redraw();
 return api;
}

/* ---------- 灯箱 ---------- */

export function openLightbox(items, startIndex, opts) {
  opts = opts || {};
  if (!items || !items.length) return;
  let idx = Math.max(0, Math.min(startIndex || 0, items.length - 1));

  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML =
    '<button class="lb-close" aria-label="关闭">✕</button>' +
    '<button class="lb-prev" aria-label="上一张">‹</button>' +
    '<img class="lb-img" alt="">' +
    '<button class="lb-next" aria-label="下一张">›</button>' +
    '<div class="lb-bar">' +
      '<button class="lb-locate" title="跳到这条记录">定位</button>' +
      '<span class="lb-caption"></span>' +
      '<span class="lb-count"></span>' +
    '</div>';

  const img     = d.querySelector('.lb-img');
  const caption = d.querySelector('.lb-caption');
  const count   = d.querySelector('.lb-count');
  const locate  = d.querySelector('.lb-locate');
  const prev    = d.querySelector('.lb-prev');
  const next    = d.querySelector('.lb-next');

  /* 快速翻页时，旧的 await 可能晚于新的 show 返回 —— 用序号丢弃过期结果 */
  let showSeq = 0;

  function prefetch(i) {
    if (!opts.resolve) return;
    const it = items[(i + items.length) % items.length];
    if (!it) return;
    try { Promise.resolve(opts.resolve(it)).catch(() => {}); } catch (e) {}
  }

  async function show(i) {
    idx = (i + items.length) % items.length;
    const it = items[idx];
    const my = ++showSeq;

    img.alt = it.alt || '';
    img.classList.add('loading');
    img.classList.remove('missing');

    /* 说明文字：由调用方决定格式；没提供就隐藏 */
    const cap = opts.captionOf ? opts.captionOf(it) : '';
    caption.textContent = cap || '';
    caption.style.display = cap ? '' : 'none';

    /* 定位按钮：没提供 onLocate 就隐藏 */
    locate.style.display = opts.onLocate ? '' : 'none';

    if (items.length > 1) {
      count.textContent = (idx + 1) + ' / ' + items.length;
      prev.style.display = '';
      next.style.display = '';
    } else {
      count.textContent = '';
      prev.style.display = 'none';
      next.style.display = 'none';
    }

    let src = it.src;
    if (opts.resolve) {
      try { src = await opts.resolve(it); }
      catch (e) { src = null; }
    }
    if (my !== showSeq || !d.isConnected) return;

    if (!src) {
      img.removeAttribute('src');
      img.classList.remove('loading');
      img.classList.add('missing');
      caption.textContent = (cap ? cap + ' · ' : '') + '图片无法加载';
      caption.style.display = '';
      return;
    }

    img.src = src;
    img.classList.remove('loading');

    /* 预取相邻两张：点下一张时通常已经在本地 loader 里 */
    if (items.length > 1) {
      prefetch(idx + 1);
      prefetch(idx - 1);
    }
  }
  /* 注意：等 append 之后再 show，否则没有 opts.resolve 的同步路径
     会在 `!d.isConnected` 处提前 return。 */

  const onNav = e => {
    if (!d.isConnected) { document.removeEventListener('keydown', onNav); return; }
    if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
    // Escape 交给栈
  };
  document.addEventListener('keydown', onNav);
  
  const close = makeEscapable(() => {
    document.removeEventListener('keydown', onNav);
    d.remove();
    if (typeof opts.onClose === 'function') opts.onClose();
  });

  d.addEventListener('click', e => { if (e.target === d) close(); });
  prev.addEventListener('click', e => { e.stopPropagation(); show(idx - 1); });
  next.addEventListener('click', e => { e.stopPropagation(); show(idx + 1); });

  locate.addEventListener('click', e => {
    e.stopPropagation();
    if (!opts.onLocate) return;
    const it = items[idx];
    close();                                
    opts.onLocate(it);
  });

  d.querySelector('.lb-close').addEventListener('click', e => {
    e.stopPropagation();
    close();                                
  });
  document.body.appendChild(d);
  show(idx);
}


/**
 * 挂一个"点外部关闭"监听。
 *
 * @param {Element}   el       目标元素
 * @param {Function}  close    关闭动作
 * @param {AbortSignal} signal 用来在 close 时一并摘掉监听
 * @param {(t: EventTarget) => boolean} [ignore]
 *        额外忽略条件 —— 命中则不算"点外部"。锚点按钮、兄弟面板用它。
 *
 * 用 setTimeout(…, 0) 挂载，避免触发这次 pointerdown 的
 * 就是打开动作本身（同一个事件冒泡到 document 立刻关掉自己）。
 */
export function wireOutsideClose(el, close, signal, ignore) {
  setTimeout(() => {
    document.addEventListener('pointerdown', ev => {
      if (el.contains(ev.target)) return;
      if (ignore && ignore(ev.target)) return;
      close();
    }, { signal });
  }, 0);
}
