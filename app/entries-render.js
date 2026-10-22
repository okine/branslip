'use strict';
/* ================= entry-render.js =================
 * 单条记录的 HTML 生成。纯渲染层 —— 不碰磁盘、不写 DOM、不改业务状态。
 *
 * 从 entries.js 抽出。唯一对外契约：
 *   entryHTML(e, idx, srcNode, foldInfo)           完整一行
 *   entryInnerHTML(e, srcNode)                     只渲染 .entry 内部
 *   entryBlockHTML(e, idx, node, showDay, foldInfo)  含 day-chip
 *   renderEntryBody(e)                             { html, hasImg } 正文（pages.js 也用）
 *
 * 脚标计数（meta-row）由 meta-row.js 自己从 Store 的三条 Map 里取，
 * 本模块不再提供任何计数聚合函数。
 *
 * 模块级状态（由 entries.js 通过 setter 转发）：
 *   dialogueEnabled   对谈模式（app.js 读盘后设置）
 *   lastAdded         最新一条的 id，用来给它加 .new 动画
 *
 * 依赖：utils / icons / store / mutate / format / md
 *       —— 全部是下层模块，无循环风险。
 */

import { esc, badgeHTML } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';

import { dayKey, fmtDay } from './format.js';
import { renderMDCached, renderTextParts, parseRelevanceHeader, stripQuoteHeader, isReplyMessage, isRelatedMessage } from './md.js';

import { renderMetaRow } from './meta-row.js';
/* ---------- 模块级状态 ---------- */

let dialogueEnabled = true;
let lastAdded = null;

export function setDialogueEnabled(v) { dialogueEnabled = !!v; }
export function setLastAdded(id) { lastAdded = id; }
export function clearLastAdded() { lastAdded = null; }

/* ============================================================
 * 单条记录
 * ============================================================ */


/* 渲染 entry 正文（图 + 文本）。3 处调用点共用。
   返回 { html, hasImg } —— hasImg 用于给 .entry 加 .has-img 类。 */
export function renderEntryBody(e) {
  return renderTextParts(
    e.text,
    p => '<img class="eimg" data-src="' + esc(p.img) +
         '" alt="' + esc(p.alt || '') + '">',
    t => '<span class="etext">' + renderMDCached(t) + '</span>'
  );
}
/* 只渲染 .entry 内部 —— 工具条、折叠控制、外层属性都不包含。
 * replaceRow / commitEdit 用它做局部更新。 */
 export function entryInnerHTML(e, srcNode) {
  const editing = Store.ui.editingEntry === e.id;

  /* ── 编辑态 ── */
  if (editing) {
    return '<div class="entry editing" data-editing="' + e.id +
      '"><textarea rows="3">' + esc(e.text) + '</textarea></div>';
  }


  /* ── 来源标签（时间流视图里用） ── */
  const tag = Store.ui.merged && srcNode
    ? '<button class="src-tag" data-src="' + srcNode.id + '">' +
      badgeHTML(srcNode) + '<span>' + esc(srcNode.title) + '</span></button>'
    : '';

  /* ── 关联消息：头徽章 + 剥离后的正文 ── */
  const rel = parseRelevanceHeader(e.text);
  let head = '';
  if (rel) {
    head =
      '<div class="md-quote relevance-quote">' + esc(rel.preview) + '</div>' +
      '<button type="button" class="relevance-head"' +
        ' data-relev-block="' + esc(rel.blockId) + '"' +
        (rel.topicRef ? ' data-relev-topic="' + esc(rel.topicRef) + '"' : '') +
        ' title="跳到关联的目标">' +
        I.relevance +
        '<span class="relevance-label">' + esc(rel.label) + '</span>' +
      '</button>';
  }

  const textForBody = rel ? stripQuoteHeader(e.text) : e.text;
  const { html: body, hasImg } = renderEntryBody({ text: textForBody });

  return '<div class="entry' + (hasImg ? ' has-img' : '') + '">' +
  tag + head + body +
  renderMetaRow(e, srcNode) +                   
  '</div>';

}


/* 完整一行 —— 初次渲染和 appendEntry 用。 */
export function entryHTML(e, idx, srcNode, foldInfo) {
  const nid = srcNode ? srcNode.id : Store.ui.selectedId;
  const isReply = dialogueEnabled && isReplyMessage(e.text);
  const isRelev = dialogueEnabled && isRelatedMessage(e.text);

  let foldCtrl = '';
  if (foldInfo) {
    const tip = foldInfo.expanded
      ? ('收起 ' + foldInfo.count + ' 条')
      : ('展开 ' + foldInfo.count + ' 条');
    const arrow = foldInfo.expanded ? '▲' : '▼';
    foldCtrl = '<div class="fold-ctrl">' +
      '<button class="fold-toggle" data-fold="' + esc(foldInfo.key) +
        '" title="' + tip + '">' + arrow + '</button>' +
      (foldInfo.isLast
        ? '<button class="fold-cancel" data-fold="' + esc(foldInfo.key) +
          '" title="取消折叠">✕</button>' : '') +
    '</div>';
  }
  

  return '<div class="entry-row' +
  (isReply ? ' reply-entry' : '') +
  (isRelev ? ' relevance-entry' : '') +
  (lastAdded === e.id ? ' new' : '') +
  '" data-eid="' + e.id + '" data-node="' + nid +
  '" data-day="' + dayKey(e.createdAt) +
  '" style="--i:' + idx + '">' +
  '<div class="tools">' +
    '<button class="tool" data-eact="edit" aria-label="编辑" title="编辑">' + I.pen + '</button>' +
    /* 置顶 / 移动 / 删除 都收进右键菜单（手机上长按同效），行内只保留编辑 */
  '</div>' +
  entryInnerHTML(e, srcNode) +
  foldCtrl +
'</div>';
    
    
    
}

/* day-chip —— 日分组标题。entryBlockHTML / 合并视图 / 分页加载都用它。 */
export function dayChipHTML(ts, idx) {
  return '<div class="day-chip" data-day="' + dayKey(ts) +
         '" style="--i:' + idx + '">' + fmtDay(ts) + '</div>';
}

/* day-chip + 完整一行 */
export function entryBlockHTML(e, idx, node, showDay, foldInfo) {
  const head = showDay ? dayChipHTML(e.createdAt, idx) : '';
  return head + entryHTML(e, idx, node, foldInfo);
}

