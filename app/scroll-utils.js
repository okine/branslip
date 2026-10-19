'use strict';
/* ================= scroll-utils.js =================
 * 精确滚动。所有"跳转/定位/对齐"的唯一入口。
 *
 * 核心：滚动完成后自动校正 —— 对抗 content-visibility 造成的
 *       高度漂移，让对齐结果精确到 ±1px。
 *
 * 依赖：无。
 */

/* ---------- 内部 ---------- */

/* 临时关掉 CSS scroll-behavior，直接赋 scrollTop */
function setScrollTopInstant(sc, y) {
  const prev = sc.style.scrollBehavior;
  sc.style.scrollBehavior = 'auto';
  sc.scrollTop = y;
  sc.style.scrollBehavior = prev;
}

/* 计算当前元素相对理想位置还差多少像素（0 表示已对齐）*/
function alignmentDelta(sc, el, align, offset) {
  const scRect = sc.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  if (align === 'top')    return elRect.top    - (scRect.top + offset);
  if (align === 'bottom') return elRect.bottom - (scRect.bottom - offset);
  /* center */
  return (elRect.top + elRect.bottom) / 2 - (scRect.top + scRect.bottom) / 2;
}



/* 平滑滚动结束后，二次校正到精确对齐,跟踪布局变化直到稳定 */
function settle(sc, el, opts) {
    let stable = 0;
    let lastH = -1;
    let frames = 0;
    const MAX = 40;
  
    function tick() {
      if (!sc.isConnected || !el.isConnected) return;
      if (frames++ > MAX) return;
  
      const h = sc.scrollHeight;
      const d = alignmentDelta(sc, el, opts.align, opts.offset);
  
      if (Math.abs(d) < 1.5 && h === lastH) {
        if (++stable >= 2) return;          // 连续两帧位置 + 文档高度都不变
      } else {
        stable = 0;
        if (Math.abs(d) >= 1.5) setScrollTopInstant(sc, sc.scrollTop + d);
      }
      lastH = h;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

/* ---------- 对外 API ---------- */

/**
 * 把 sc 内的 el 对齐到指定位置。
 *
 * @param {Element} sc         滚动容器
 * @param {Element} el         目标元素
 * @param {object} [opts]
 *   align  {'top'|'center'|'bottom'}  默认 'top'
 *   offset {number}           对齐留白（正数 = 往内缩），默认 0
 *   smooth {boolean}          是否平滑，默认 true
 *   settle {boolean}          平滑结束后是否二次校正，默认 true
 *                             （普通场景保持 true，连续滚动场景可关）
 *   max    {number}           最大滚动位置（默认 sc.scrollHeight - clientHeight）
 */
export function scrollIntoViewIn(sc, el, opts) {
  if (!sc || !el) return;
  opts = opts || {};
  const align  = opts.align  || 'top';
  const offset = opts.offset || 0;
  const smooth = opts.smooth !== false;

  /* ★ 新增：需要时先实物化目标上方窗口，让 elTop 是真的 */
  const restore = opts.materialize
    ? materializeAbove(sc, el, opts.materializeWindow)
    : null;
    let restoreTimer = null;
    if (restore) {
      if (smooth) {
        // 平滑滚动大致结束时间；宁可晚一点，也不要过早还原
        restoreTimer = setTimeout(restore, 600);
      } else {
        restoreTimer = requestAnimationFrame(restore);
      }
    }

  /* 目标元素的绝对 Y 坐标（相对 sc 内容顶部）*/
  const scRect = sc.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const elTop  = sc.scrollTop + (elRect.top - scRect.top);

  let target;
  if (align === 'top')         target = elTop - offset;
  else if (align === 'bottom') target = elTop - (sc.clientHeight - elRect.height) + offset;
  else /* center */            target = elTop - (sc.clientHeight - elRect.height) / 2;

  const max = (opts.max != null) ? opts.max : (sc.scrollHeight - sc.clientHeight);
  target = Math.max(0, Math.min(target, max));

  if (smooth) {
    sc.scrollTo({ top: target, behavior: 'smooth' });
    if (opts.settle !== false) settle(sc, el, { align, offset });
  } else {
    setScrollTopInstant(sc, target);
  }
}

/**
 * 滚到绝对位置。
 *   smooth = false 时同步完成，可安全连续调用。
 */
export function scrollToY(sc, y, smooth) {
  if (!sc) return;
  const max = sc.scrollHeight - sc.clientHeight;
  y = Math.max(0, Math.min(y, max));
  if (smooth === false) setScrollTopInstant(sc, y);
  else sc.scrollTo({ top: y, behavior: 'smooth' });
}

export function scrollToBottom(sc, smooth) {
  scrollToY(sc, sc.scrollHeight, smooth);
}

/* ---------- 分页插入锚点 ----------
 * 在插入新内容前记下“当前视口顶部第一条记录”的位置，
 * 插入后按它校正 scrollTop。比 scrollHeight 差值稳：
 * content-visibility / 图片高度变化会让差值漂移。
 */
export function captureScrollAnchor(sc, box) {
  if (!sc || !box) return null;
  const scTop = sc.getBoundingClientRect().top;
  for (const el of box.children) {
    if (!el.classList.contains('entry-row') &&
        !el.classList.contains('day-chip')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > scTop + 2) {
      return { el, top: r.top - scTop };
    }
  }
  return null;
}

export function restoreScrollAnchor(sc, anchor) {
  if (!sc || !anchor || !anchor.el.isConnected) return false;
  const scTop = sc.getBoundingClientRect().top;
  const now = anchor.el.getBoundingClientRect().top - scTop;
  if (Math.abs(now - anchor.top) > 1) {
    setScrollTopInstant(sc, sc.scrollTop + now - anchor.top);
  }
  return true;
}

/* 目标元素上方若处于 content-visibility 塌陷态，会导致 elTop 严重偏小。
   跳转前把上方一段窗口临时实物化，跳完（或下一帧）恢复。 */
   function materializeAbove(sc, el, windowSize) {
    const rows = [...sc.querySelectorAll('.entry-row')];
    const target = el.closest ? el.closest('.entry-row') : null;
    const idx = rows.indexOf(target || el);
    if (idx < 0) return () => {};
  
    const from = Math.max(0, idx - (windowSize || 40));
    const undo = [];
    for (let i = from; i < idx; i++) {
      const r = rows[i];
      undo.push([r, r.style.contentVisibility]);
      r.style.contentVisibility = 'visible';
    }
    return () => {
      for (const [r, v] of undo) r.style.contentVisibility = v;
    };
  }

  /* 给元素加一次闪烁高亮。
   与 CSS 里的 .flash + @keyframes rowFlash 配套，
   默认 1700ms 与动画时长一致。 */
export function flashEl(el, ms) {
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), ms || 1700);
}