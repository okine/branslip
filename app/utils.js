'use strict';
/* ================= utils.js =================
 * 无依赖的小工具。任何模块都可以 import。
 */

/* DOM 查询 */
export const $ = s => document.querySelector(s);

/* HTML 转义 */
export const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* 短 ID：时间戳 + 随机后缀 */
export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* 话题徽章配色 */
export const PALETTE = [
  '#C0714E', '#7C9A55', '#4E8EA0', '#A56E8F',
  '#BC9A3F', '#5F7DB0', '#8D6FB0', '#4FA287',
];

export function badgeColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function badgeHTML(n, cls = '') {
  const ch = [...n.title.trim()][0] || '·';
  return '<span class="badge ' + cls + '" style="--bc:' +
    badgeColor(n.id) + '">' + esc(ch) + '</span>';
}

/* 紧凑计数：超过 999 只显示 999+，避免侧栏/顶栏被大数字撑开 */
export function countLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return v > 999 ? '999+' : String(Math.floor(v));
}

/* 列表分页的统一基准值。需要调整时只改这里；
   各模块按用途读取，不再各自写 40 / 80 / 120。 */

/**
 * 重复点同一个「会弹面板」的按钮 = 把那个面板关掉。
 *
 *   togglePop(anchor, '.theme-pop') → 面板开着就关掉并返回 true
 *                                    （调用方据此直接 return，不再重开）
 *
 * anchor 给了就只认它自己开的那一个（面板上挂了 `_anchor` 时不一致就放过）。
 */
export function togglePop(anchor, panelSel, close) {
  if (typeof document === 'undefined') return false;
  const pop = document.querySelector(panelSel);
  if (!pop) return false;
  if (anchor && pop._anchor && pop._anchor !== anchor) return false;
  if (typeof close === 'function') close(pop); else pop.remove();
  return true;
}

export const PAGING = {
  initial: 80,        // 单话题首屏
  chunk: 40,          // 单话题向上/向下每次加载
  mergedInitial: 120, // 时间流首屏
  mergedChunk: 40,    // 时间流每次加载
  around: 10,         // 直接定位目标前后各几条
};