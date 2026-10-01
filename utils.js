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