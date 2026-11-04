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
import { renderMDCached, renderTextParts, parseRelevanceHeader, parseAltHeader, stripQuoteHeader, isReplyMessage, isRelatedMessage, parseSenderPrefix } from './md.js';

import { renderMetaRow } from './meta-row.js';
import { dayKey, fmtDay, dayKeyOfEntry } from './format.js';
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
 export function entryInnerHTML(e, srcNode, opts) {
  opts = opts || {};
  const editing = Store.ui.editingEntry === e.id;

  /* ── 编辑态 ── */
  if (editing) {
    /* 编辑时仍显示完整正文（含 **发送者** 前缀），保存不会丢发送者 */
    return '<div class="entry editing" data-editing="' + e.id +
      '"><textarea rows="3">' + esc(e.text) + '</textarea></div>';
  }

  /* 主视角“我”的消息：显示时隐藏 `**名字**` 前缀 */
  const sp = opts.stripSender ? parseSenderPrefix(e.text) : null;
  const text = sp ? sp.body : e.text;


  /* ── 来源标签（时间流视图里用） ── */
  const tag = Store.ui.merged && srcNode
    ? '<button class="src-tag" data-src="' + srcNode.id + '">' +
      badgeHTML(srcNode) + '<span>' + esc(srcNode.title) + '</span></button>'
    : '';

  /* ── 关联消息：头徽章 + 剥离后的正文 ── */
  const rel = parseRelevanceHeader(text);
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

  /* 变体头 ↻ 也是隐藏行，正文要剥掉 */
  const textForBody = (rel || parseAltHeader(text)) ? stripQuoteHeader(text) : text;
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
  const isSys = /^:::system\b/.test(e.text);

  /* 主视角：话题 owner 的消息右对齐（像“我”），其他人左对齐 */
  const owner = (srcNode && srcNode.owner)
    || (nid && Store.node(nid) && Store.node(nid).owner)
    || null;
  const sp = owner ? parseSenderPrefix(e.text) : null;
  const isMe = !!(sp && sp.name === owner);
  const isOther = !!(sp && sp.name !== owner);

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
  (isMe ? ' pov-me' : '') +
  (isOther ? ' pov-other' : '') +
  (isReply ? ' reply-entry' : '') +
  (isRelev ? ' relevance-entry' : '') +
  (isSys ? ' sys-row' : '') +
  (lastAdded === e.id ? ' new' : '') +
  '" data-eid="' + e.id + '" data-node="' + nid +
  '" data-day="' + dayKeyOfEntry(e) +
  '" style="--i:' + idx + '">' +
  '<div class="tools">' +
    '<button class="tool" data-eact="edit" aria-label="编辑" title="编辑">' + I.pen + '</button>' +
    /* 置顶 / 移动 / 删除 都收进右键菜单（手机上长按同效），行内只保留编辑 */
  '</div>' +
  entryInnerHTML(e, srcNode, { stripSender: isMe }) +
  foldCtrl +
'</div>';
    
    
    
}

/* day-chip —— 日分组标题。entryBlockHTML / 合并视图 / 分页加载都用它。 */
export function dayChipHTML(ts, idx, entry) {
  /* 有条目就按条目自己的时区算日期，和它头上的 ## 行保持一致 */
  return '<div class="day-chip" data-day="' + (entry ? dayKeyOfEntry(entry) : dayKey(ts)) +
         '" style="--i:' + idx + '">' + fmtDay(ts) + '</div>';
}

/* day-chip + 完整一行 */
export function entryBlockHTML(e, idx, node, showDay, foldInfo) {
  const head = showDay ? dayChipHTML(e.createdAt, idx, e) : '';
  return head + entryHTML(e, idx, node, foldInfo);
}

/* entry → 下标。挂在 node 上并随 dataRevision 失效，避免每次分页/渲染都重建 O(n) 的 Map。 */
function entryIndexMap(node) {
  const rev = Store.dataRevision;
  const c = node._idxOf;
  if (c && c.rev === rev && c.n === node.entries.length) return c.map;
  const map = new Map(node.entries.map((e, i) => [e, i]));
  node._idxOf = { rev, n: node.entries.length, map };
  return map;
}

/* 这条 entry 是不是"变体"，是的话返回它锚定的那条 entry（否则 null）。 */
export function altAnchorOf(entry, node, resolve) {
  const a = parseAltHeader(entry && entry.text);
  if (!a) return null;
  const get = resolve || (bid => Store.blockEntry(bid));
  const hit = get(a.blockId);
  if (!hit || !hit.e) return null;
  if (node && hit.node !== node) return null;
  return hit.e;
}

/**
 * 把窗口 [start, end) 里的变体按锚点分组。
 * ★ 锚点必须也在窗口里，否则该变体不当作变体（按普通记录单独渲染）——
 *   不然"锚点在窗口外、变体在窗口内"时两条都不渲染，数据会凭空消失。
 * @returns {{ altOf: Map<string, object[]>, isAlt: Set<string> }}
 */
export function buildAltGroups(node, start, end, resolve) {
  const altOf = new Map();
  const isAlt = new Set();
  if (!node || !node.entries) return { altOf, isAlt };
  const idxOf = entryIndexMap(node);
  for (let i = start; i < end; i++) {
    const e = node.entries[i];
    const anchor = altAnchorOf(e, node, resolve);
    if (!anchor) continue;
    const ai = idxOf.get(anchor);
    if (ai == null || ai < start || ai >= end) continue;   /* 锚点不在窗口 → 当普通行 */
    isAlt.add(e.id);
    const list = altOf.get(anchor.id) || [];
    list.push(e);
    altOf.set(anchor.id, list);
  }
  return { altOf, isAlt };
}

/**
 * 切换变体行显示第几版（唯一实现，entries.js / entries-ops.js 都调它）。
 * 负责：hidden 切换、data-eid、页码、时间、altIndex 记忆。
 * @returns {number} 实际生效的版本下标
 */
export function setAltVersion(row, idx) {
  if (!row) return -1;
  const bodies = [...row.querySelectorAll('[data-alt-body]')];
  if (!bodies.length) return -1;
  const i = Math.max(0, Math.min(idx | 0, bodies.length - 1));
  row.dataset.altI = String(i);
  row.dataset.eid = bodies[i].dataset.altEid || row.dataset.eid;
  bodies.forEach((b, k) => { b.hidden = (k !== i); });
  const pos = row.querySelector('.alt-pos b');
  if (pos) pos.textContent = String(i + 1);
  const t = row.querySelector('.alt-time');
  if (t) t.textContent = bodies[i].dataset.altTime || '';
  const anchor = row.dataset.altAnchor;
  if (anchor) Store.ui.altIndex.set(anchor, i);
  return i;
}

/* 变体行：同一条消息的 N 个版本共用一行，只显示一个，其余藏在翻页里。
   每个版本用 entryInnerHTML 渲染（带各自的 `.entry` 气泡和 meta 行），
   翻页条放在消息下方，右侧显示当前版本时间。 */
/* HH:mm:ss —— 翻页条上的版本时间要能区分同一分钟内的两个版本 */
function hms(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function altRowHTML(anchor, variants, idx, node, active) {
  const versions = [anchor, ...variants];
  const act = Math.max(0, Math.min(active || 0, versions.length - 1));
  const nid = node ? node.id : Store.ui.selectedId;

  const toolHTML = '<div class="tools">' +
    '<button class="tool" data-eact="edit" aria-label="编辑" title="编辑">' + I.pen + '</button>' +
  '</div>';
  /* 工具按钮放进每一版自己的横向行里 —— 这样它永远贴着当前气泡，
     和普通消息的编辑图标位置一致（不会漂到整行最右边）。 */
  const bodies = versions.map((v, i) =>
    '<div class="alt-body" data-alt-body="' + i + '"' +
      ' data-alt-eid="' + esc(v.id) + '"' +
      ' data-alt-time="' + esc(hms(v.createdAt)) + '"' +
      (i === act ? '' : ' hidden') + '>' +
      '<div class="alt-line">' + toolHTML + entryInnerHTML(v, node) + '</div>' +
    '</div>'
  ).join('');

  const bar = '<div class="alt-bar">' +
    '<button type="button" class="alt-nav" data-alt-nav="-1" title="上一版">‹</button>' +
    '<span class="alt-pos"><b>' + (act + 1) + '</b> / ' + versions.length + '</span>' +
    '<button type="button" class="alt-nav" data-alt-nav="1" title="下一版">›</button>' +
    '<span class="alt-time">' + esc(hms(versions[act].createdAt)) + '</span>' +
  '</div>';

  const replyCls = (dialogueEnabled && isReplyMessage(anchor.text)) ? ' reply-entry' : '';
  return '<div class="entry-row alt-row' + replyCls + '" data-eid="' + esc(versions[act].id) + '"' +
    ' data-node="' + esc(nid) + '"' +
    ' data-day="' + esc(dayKeyOfEntry(versions[act])) + '"' +
    ' data-alt-anchor="' + esc(anchor.id) + '"' +
    ' data-alt-i="' + act + '"' +
    ' style="--i:' + idx + '">' +
    '<div class="alt-col">' + bodies + bar + '</div>' +
  '</div>';
}

