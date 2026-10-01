'use strict';
/* ================= ref-preview.js =================
 * 内部引用（.md-ref）的悬停预览卡片。
 *
 * 悬停在 .md-ref 上 200ms → 弹出卡片，显示目标记录 / 话题的预览。
 *
 * 对外：
 *   hideRefPreview()   主动隐藏（滚动 / 失焦 / 切窗口等场景）
 *
 * 依赖：utils / format / mutate / md / tree-utils
 */

import { esc } from './utils.js';
import { fmtStamp } from './format.js';
import { Mutate } from './mutate.js';
import { findTopicByRefId } from './md.js';
import { findByPath } from './tree-utils.js';

let previewTimer = null;
let previewCard = null;
let previewAnchor = null;

/* ---------- 主逻辑 ---------- */

function showRefPreview(ref) {
  hideRefPreview();

  const tid   = ref.dataset.topicId;
  const path  = ref.dataset.path;
  const bid   = ref.dataset.block;

  let node = null, entry = null;
  if (tid)       node = findTopicByRefId(tid);
  else if (path) node = findByPath(path.split(/[\/\u001f]/).join('\u0001'));

  if (!node) {
    showCard(ref, '<div class="ref-preview-empty">引用的内容已不存在</div>');
    return;
  }

  if (bid) entry = node.entries.find(e => Mutate.entryBlockId(e) === bid);

  let html;
  if (entry) {
    const preview = entry.text.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]').slice(0, 240);
    html = '<div class="ref-preview-head">' + esc(node.title) + '</div>' +
           '<div class="ref-preview-time">' + fmtStamp(entry.createdAt) + '</div>' +
           '<div class="ref-preview-body">' + esc(preview) + '</div>';
  } else {
    const recent = node.entries.slice(-3);
    html = '<div class="ref-preview-head">' + esc(node.title) + '</div>' +
           '<div class="ref-preview-time">' + node.entries.length + ' 条记录</div>' +
           '<div class="ref-preview-body">' +
             recent.map(e => '· ' + esc(e.text.slice(0, 60))).join('<br>') +
           '</div>';
  }

  showCard(ref, html);
}

function showCard(anchor, html) {
  previewCard = document.createElement('div');
  previewCard.className = 'ref-preview';
  previewCard.innerHTML = html;
  document.body.appendChild(previewCard);

  /* 内容真的溢出时，才给 body 加 .overflow */
  const body = previewCard.querySelector('.ref-preview-body');
  if (body && body.scrollHeight > body.clientHeight + 2) {
    body.classList.add('overflow');
  }

  const r = anchor.getBoundingClientRect();
  const cardW = previewCard.offsetWidth;
  const cardH = previewCard.offsetHeight;

  let left = Math.min(r.left, innerWidth - cardW - 12);
  left = Math.max(12, left);

  let top = r.bottom + 6;
  if (top + cardH > innerHeight - 12) top = r.top - cardH - 6;

  previewCard.style.left = left + 'px';
  previewCard.style.top  = top  + 'px';
}

export function hideRefPreview() {
  clearTimeout(previewTimer);
  previewTimer = null;
  if (previewCard) { previewCard.remove(); previewCard = null; }
  previewAnchor = null;
}

/* ---------- 事件 ---------- */

document.addEventListener('pointerover', e => {
  /* 鼠标移到卡片上 → 取消隐藏（虽然卡片 pointer-events:none，一般不会触发） */
  if (e.target.closest('.ref-preview')) {
    clearTimeout(previewTimer);
    return;
  }
  const ref = e.target.closest('.md-ref');
  if (!ref || ref === previewAnchor) return;
  previewAnchor = ref;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => showRefPreview(ref), 200);
});

document.addEventListener('pointerout', e => {
  const ref = e.target.closest('.md-ref');
  if (!ref) return;
  if (e.relatedTarget && e.relatedTarget.closest('.ref-preview')) return;
  hideRefPreview();
});

/* ★ 以下三条是"卡片不消失"的兜底 —— pointerout 在这些场景下不触发 */

/* 滚动：元素从鼠标下方移走。capture 收所有滚动（scroll 不冒泡） */
document.addEventListener('scroll', hideRefPreview, { capture: true, passive: true });

/* 鼠标离开浏览器窗口 */
document.addEventListener('mouseleave', hideRefPreview);

/* 切换标签页 / 窗口失焦 */
window.addEventListener('blur', hideRefPreview);