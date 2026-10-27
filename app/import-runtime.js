'use strict';
/* ================= import-runtime.js =================
 * 所有聊天导出导入器的共享运行时。
 *
 * 生命周期：
 *   adapter 拿到源数据
 *     → 转成 IR 消息数组
 *     → buildMessageTree(ir)              ← 树构建 + 深度 + 时间修正
 *     → extractFromTree(tree, { ... })    ← 走树生成 topic 结构
 *     → importAsTopics(dir, [conv], src)  ← 写盘
 *
 * 每个 adapter 只需要三样东西：
 *   1. 源 → IR（每条消息 → { id, parentId, childrenIds, at, message }）
 *   2. extractContent(原始消息) → { role, text, thinking, rawStamp?, tzOffset? }
 *      —— 或者返回数组（一个 node 产多条 entry，DeepSeek 需要）
 *   3. 顶层解析（源文本 → 一组 conversation）
 *
 * HTML 源（Gemini / Telegram）和 JSON 源走的是完全一样的路径。
 *
 * 时间戳的三层：
 *   _rawStamp   —— 源里的原始字符串（含时区），或由 bump 修正后重生
 *   _writeStamp —— 写盘前冻结，等于 _rawStamp 或 _tzOffset 推导值
 *   entryBlockId —— 从 _writeStamp 截取，作为引用系统的稳定 ID
 * 因此 rawStamp 一旦错丢，blockId 就会漂 → 引用断链。
 */

import { Storage } from './storage.js';
import { uid } from './utils.js';
import {
  fmtStamp, fmtStampAtTz, monthKey,
  stampForWrite, entryBlockId, localIdFromMs,
  monthKeyOfEntry, dayKeyOfEntry,
} from './format.js';
import { sanitizeName, uniqueName, resolveFile, dirOf, writeOrder, writeMonthFile } from './io.js';
import { atomicWriteText } from './writeSecurity.js';
import { Store } from './store.js';
import { invoke, PLATFORM } from './platform.js';
import { findNode, pathTitles } from './tree-utils.js';
import { resetMeta } from './meta-row.js';

/* ============================================================
 * 中间表示（IR）—— adapter 与 runtime 的契约
 * ============================================================ */

/**
 * 构造一条 IR 消息。
 *
 * @param {string} id          唯一 ID（源里的消息 ID）
 * @param {number} at          毫秒时间戳；0 表示缺失，由 assignTimes 修正
 * @param {object} [opts]
 * @param {string|null}   [opts.parentId]     父消息 ID；null/undefined = 根
 * @param {string[]|null} [opts.childrenIds]  显式子消息列表；null = 靠 parentId 反推
 * @param {any}           [opts.raw]          原始消息对象，extractContent 会读它
 */
export function makeMessage(id, at, opts) {
  opts = opts || {};
  return {
    id: String(id),
    parentId: opts.parentId != null ? String(opts.parentId) : null,
    childrenIds: Array.isArray(opts.childrenIds) ? opts.childrenIds.map(String) : null,
    at: Number.isFinite(at) ? at : 0,
    message: opts.raw != null ? opts.raw : null,
  };
}

/* ============================================================
 * 消息树构建
 * ============================================================ */

/**
 * 从 IR 数组构建消息树。
 * 返回根节点；多个根时返回虚拟根 { id: '__virtual_root__' }。
 *
 * 副作用（都在返回前完成）：
 *   - 每个节点的 children 按 at 升序
 *   - _depth 已计算（后序）
 *   - 时间戳已修正（bump：父 + 1ms；infer：Date.now()）
 *   - _atAdjusted 标记修正类型（'bump' | 'infer'）
 */
export function buildMessageTree(messages) {
  const byId = new Map();
  const list = [];

  for (const ir of messages) {
    if (!ir || !ir.id) continue;
    const node = {
      id: ir.id,
      message: ir.message,
      children: [],
      at: ir.at,
      _depth: 1,
    };
    byId.set(ir.id, node);
    list.push({ ir, node });
  }

  /* 连边 —— childrenIds 优先（源给了显式列表）；parentId 兜底补齐。 */
  for (const { ir, node } of list) {
    if (!ir.childrenIds) continue;
    for (const cid of ir.childrenIds) {
      const c = byId.get(cid);
      if (c && !node.children.includes(c)) node.children.push(c);
    }
  }
  for (const { ir, node } of list) {
    if (!ir.parentId) continue;
    const p = byId.get(ir.parentId);
    if (!p) continue;
    if (!p.children.includes(node)) p.children.push(node);
  }

  /* 排序 */
  for (const { node } of list) {
    node.children.sort((a, b) => a.at - b.at);
  }

  /* 找根 —— 排除被 childrenIds 引用过的节点，
     这样「只给 childrenIds 不给 parentId」的源也能正确定根。 */
  const childSet = new Set();
  for (const { node } of list) {
    for (const c of node.children) childSet.add(c.id);
  }
  const roots = [];
  for (const { node } of list) {
    if (childSet.has(node.id)) continue;
    roots.push(node);
  }

  const root = roots.length === 1
    ? roots[0]
    : {
        id: '__virtual_root__',
        message: null,
        children: roots.slice().sort((a, b) => a.at - b.at),
        at: 0,
        _depth: 1,
      };

  /* 检测不可达节点（成环 / 孤岛），挂到虚拟根兜底。
     正常数据不会触发；异常数据也能走完全流程而不是挂死。 */
  const reachable = new Set();
  (function mark(n) {
    if (reachable.has(n.id)) return;
    reachable.add(n.id);
    for (const c of n.children) mark(c);
  })(root);

  const orphans = list.filter(({ node }) => !reachable.has(node.id));
  if (orphans.length) {
    console.warn('[import-runtime] ' + orphans.length +
      ' 个节点无法从根到达（可能成环），已附加到虚拟根兜底');
    for (const { node } of orphans) {
      if (!root.children.includes(node)) root.children.push(node);
    }
    root.children.sort((a, b) => a.at - b.at);
  }

  computeDepths(root);
  assignTimes(root, 0);
  return root;
}

function computeDepths(node) {
  if (!node.children.length) { node._depth = 1; return 1; }
  let max = 0;
  for (const c of node.children) max = Math.max(max, computeDepths(c));
  node._depth = 1 + max;
  return node._depth;
}

function assignTimes(node, parentAt, fallbackAt) {
    /* 只有带 message 的节点代表真实消息，参与时间修正。
     message: null 的节点（虚拟根、DeepSeek 的占位 root）是纯容器，
     跳过修正、也不推进 cur —— 否则它们的 at=0 会被误判为「缺时间」
     而被补成 Date.now()，把整棵子树的时间戳都拉到当下。

     修正分两种：
       'bump'  —— 为了让时间严格递增（父时间 + 1ms）。
                  原始 rawStamp 依然可信，只差 1ms，可重新生成。
       'infer' —— 整条父链都没有时间。用 fallbackAt（对话的 inserted_at /
                  树里最早的时间）兜底，**绝不使用 Date.now()**：
                  用"现在"会让导入的记录排在所有真实记录之后，
                  blockId 也随之改变，引用和回复计数都会错位。
                  只有在整份文件一点时间信息都没有时才落到 1。 */
  let cur = parentAt;
  if (node.message) {
    if (!node.at || node.at <= parentAt) {
      if (parentAt > 0) {
        node.at = parentAt + 1;
        node._atAdjusted = 'bump';
      } else {
        node.at = (fallbackAt && fallbackAt > 0) ? fallbackAt : 1;
        node._atAdjusted = 'infer';
      }
    }
    cur = node.at;
  }
  for (const c of node.children) assignTimes(c, cur, fallbackAt);
}

/* ============================================================
 * rawStamp 再生：时间被修正但时区仍可信时用
 * ============================================================ */

/**
 * 用给定时间 + 原始时区重新生成一个 rawStamp。
 *
 * 动机：bump 修正只把时间挪了 N 毫秒，原始时区（+08:00 / -05:00 / Z）依然
 * 可信。保留时区让 entryBlockId 派生出跨时区稳定的引用 ID。
 *
 * 对比：如果直接丢 rawStamp，fallback 会走 localIdFromMs(createdAt)，
 * 用「本地时区字段」拼 blockId —— 同一份导出在不同时区的机器上会得到
 * 不同的 blockId，引用系统崩。
 */
function regenRawStamp(createdAt, tzOffset) {
  const tz = (tzOffset != null) ? tzOffset : -new Date().getTimezoneOffset();
  return fmtStampAtTz(createdAt, tz);
}

/* ============================================================
 * 走树：消息树 → 内部 topic 结构
 * ============================================================ */

/**
 * 从消息树生成内部 conversation 结构。
 *
 * @param {object} tree  buildMessageTree 的返回值
 * @param {object} opts
 *   title           {string}    话题标题
 *   sourceCreatedAt {number}    源 created_at（毫秒）；NaN/0 回落到第一条
 *   extractContent  {Function}  (message) => EntryData | EntryData[] | { role: 'skip' }
 *                               EntryData = {
 *                                 role: 'user' | 'assistant'
 *                                 text: string
 *                                 thinking?: string
 *                                 rawStamp?: string | null
 *                                 tzOffset?: number | null
 *                               }
 *   tzOffset        {number}    兜底时区偏移（分钟）；默认本地
 */
export function extractFromTree(tree, opts) {
  const {
    title,
    sourceCreatedAt,
    extractContent,
    tzOffset = -new Date().getTimezoneOffset(),
  } = opts;

  /* 兜底时间：源 created_at → 树里最早的时间 → 1（1970，明确表示"不知道"）。
     ★ 绝不使用 Date.now()：导入要保留原始时间，用"现在"会让记录排到最后，
       blockId 也变，引用和回复计数全部错位。 */
  const baseMs = Number.isFinite(sourceCreatedAt) && sourceCreatedAt > 0
    ? sourceCreatedAt
    : (findFirstAt(tree) || 1);

  const root = {
    scopeId: nextScopeId(),
    title,
    createdAtMs: baseMs,
    entries: [],
    branches: [],
  };

  rescueInferredTimes(tree, baseMs);
  walkSubtree(tree, null, root, extractContent, tzOffset);
  normalizeAll(root);
  syncTopicTimes(root, Number.isFinite(sourceCreatedAt) && sourceCreatedAt > 0 ? sourceCreatedAt : 0);
  freezeWriteStamps(root);
  return root;
}

/* 话题时间：
   - 有原始创建时间（对话的 created_at）且确实早于首条记录 → 用原时间；
   - 没有原始时间，或原时间不早于首条（比如和首条同一毫秒）→ 首条 - 1ms。
   后一种情况必须让开 1ms：话题和记录的时间戳都参与 ID/排序，撞毫秒会互相顶。 */
function syncTopicTimes(t, sourceMs) {
  if (!t) return;
  if (t.entries.length) {
    const first = t.entries[0].createdAt;
    t.createdAtMs = (sourceMs > 0 && sourceMs < first)
      ? sourceMs
      : Math.max(1, first - 1);
  }
  /* 分支子话题没有独立的"创建时间"信息 → 一律首条 - 1ms */
  for (const br of t.branches) syncTopicTimes(br, 0);
}

/**
 * 把"完全没有时间"的消息从占位值（1）挪到 baseMs 起的连续毫秒。
 * 这样导入的记录仍然落在**源对话的年份**里，而不是 1970 / 或今天。
 */
function rescueInferredTimes(node, startMs) {
  let t = startMs;
  const visit = n => {
    if (n.message && n._atAdjusted === 'infer') {
      n.at = t;
      t += 1;
    }
    for (const c of n.children) visit(c);
  };
  visit(node);
}

function findFirstAt(node) {
  if (node.at) return node.at;
  for (const c of node.children) {
    const r = findFirstAt(c);
    if (r) return r;
  }
  return 0;
}

/* 树里最早的消息时间 —— 比"第一条"更稳（源里可能乱序） */
function findMinAt(node) {
  let best = 0;
  const visit = n => {
    if (n.at && (!best || n.at < best)) best = n.at;
    for (const c of n.children) visit(c);
  };
  visit(node);
  return best;
}

let scopeCounter = 0;
function nextScopeId() { return ++scopeCounter; }

/* extractContent 的结果按节点缓存：排序（peekTransientChild）和 walkSubtree 都要用，
   以前同一个节点会被解析两次。WeakMap 不阻止节点被回收。 */
const _contentCache = new WeakMap();
function contentItemsOf(node, extractContent) {
  if (!node || !node.message) return [];
  const cached = _contentCache.get(node);
  if (cached) return cached;
  let c = null;
  try { c = extractContent(node.message); } catch (e) { c = null; }
  const items = Array.isArray(c) ? c : (c ? [c] : []);
  _contentCache.set(node, items);
  return items;
}

function walkSubtree(node, parentUser, ctx, extractContent, defaultTz) {
  let myUser = parentUser;

  if (node.message && node.at) {
    const items = contentItemsOf(node, extractContent);

    for (const item of items) {
      if (!item || item.role === 'skip') continue;
      if (!item.text && !item.thinking) continue;

      const tz = item.tzOffset != null ? item.tzOffset : defaultTz;

      /* rawStamp 处理：
         - 'bump'  → 时间 +N ms，用原始时区重新生成（保留 blockId 稳定）
         - 'infer' → 时间完全推断，rawStamp 不可信，丢弃
         - 无修正  → 原样保留 */
      let rawStamp = item.rawStamp;
      if (rawStamp) {
        const adj = node._atAdjusted;
        if (adj === 'infer') rawStamp = null;
        else if (adj === 'bump') rawStamp = regenRawStamp(node.at, tz);
      }

      if (item.role === 'user') {
        const entry = {
          id: uid(),
          text: item.text || '',
          createdAt: node.at,
          edited: false, editedAt: null,
          _tzOffset: tz,
          _scope: ctx.scopeId,
        };
        if (rawStamp) entry._rawStamp = rawStamp;
        ctx.entries.push(entry);
        myUser = entry;

      } else if (item.role === 'assistant') {
        let body = '';
        if (item.thinking) {
          const safe = String(item.thinking).replace(/(^|\n):::/g, '$1\\:::');
          body = ':::think\n' + safe + '\n:::';
        }
        if (item.text) body = body ? body + '\n\n' + item.text : item.text;

        const entry = {
          id: uid(),
          text: body,
          createdAt: node.at,
          edited: false, editedAt: null,
          _replyTo: myUser,             /* 父链上最近的 user（含同 node 内先出现的） */
          _tzOffset: tz,
          _scope: ctx.scopeId,
        };
        if (rawStamp) entry._rawStamp = rawStamp;
        ctx.entries.push(entry);
      }
    }
  }

  if (!node.children.length) return;

  /* 主分支 = 有真实内容的优先，其次最深子树，其次时间最新。
     失败重试（"服务器繁忙"）不能当主回答 —— 否则打开先看到失败，
     真正的答案藏在翻页里。 */
  const transientOf = new Map(
    node.children.map(c => [c, peekTransientChild(c, extractContent) ? 1 : 0])
  );
  const children = [...node.children].sort((a, b) => {
    const ta = transientOf.get(a) || 0;
    const tb = transientOf.get(b) || 0;
    if (ta !== tb) return ta - tb;
    if (a._depth !== b._depth) return b._depth - a._depth;
    return b.at - a.at;
  });

  const beforeMain = ctx.entries.length;
  walkSubtree(children[0], myUser, ctx, extractContent, defaultTz);

  /* 主路径走完后先记住"主回答"这条 —— 后面用它当变体的锚点 */
  const anchorReply = findAnchorReply(ctx, myUser, beforeMain);
  let altInserted = 0;

  for (let i = 1; i < children.length; i++) {
    const subCtx = {
      scopeId: nextScopeId(),
      title: '',
      createdAtMs: 0,
      entries: [],
      branches: [],
      _fromUser: myUser,
    };
    walkSubtree(children[i], myUser, subCtx, extractContent, defaultTz);
    if (!subCtx.entries.length) continue;
    subCtx.createdAtMs = subCtx.entries[0].createdAt;
    subCtx.title = branchTitle(subCtx);
    /* ★ 叶子再生成（只有一条 assistant、没有后续）→ 收进主回答的"变体"，
         不再建子话题。有后续的分支仍然保留为子话题。 */
    if (isLeafRegeneration(subCtx) && anchorReply) {
      const v = subCtx.entries[0];
      v._scope = ctx.scopeId;      /* 和主回答同一个话题 */
      v._altOf = anchorReply;
      const at = ctx.entries.indexOf(anchorReply);
      ctx.entries.splice(at + 1 + altInserted, 0, v);
      altInserted++;
      continue;
    }

    ctx.branches.push(subCtx);
  }
}

/* 主回答：主路径上"回复当前用户消息"的那条 assistant entry */
function findAnchorReply(ctx, myUser, fromIdx) {
  for (let i = fromIdx; i < ctx.entries.length; i++) {
    const e = ctx.entries[i];
    if (e && e._replyTo && e._replyTo === myUser) return e;
  }
  return null;
}

/* 叶子再生成：只有一条 entry（assistant）、没有子分支 */
function isLeafRegeneration(subCtx) {
  if (!subCtx) return false;
  if (subCtx.branches && subCtx.branches.length) return false;
  if (!subCtx.entries || subCtx.entries.length !== 1) return false;
  return !!subCtx.entries[0]._replyTo;
}

/* ============================================================
 * 时间戳规范化
 * ============================================================ */

function normalizeAll(topic) {
  normalizeTimestamps(topic);
  for (const br of topic.branches) normalizeAll(br);
}

function normalizeTimestamps(topic) {
  const usedStamps = new Set();
  let lastAt = 0;
  for (const e of topic.entries) {
    if (!Number.isFinite(e.createdAt) || e.createdAt <= lastAt) {
      e.createdAt = lastAt + 1;
      /* 时间被 +1ms → 用原始时区重新生成 rawStamp（不是丢弃）。
         这样 entryBlockId 仍然派生自稳定的时区字符串。 */
      if (e._rawStamp) e._rawStamp = regenRawStamp(e.createdAt, e._tzOffset);
    }
    /* rawStamp 撞车（同秒 + 同时区）：重生一次；仍撞就丢弃防污染 */
    if (e._rawStamp && usedStamps.has(e._rawStamp)) {
      const regen = regenRawStamp(e.createdAt, e._tzOffset);
      e._rawStamp = usedStamps.has(regen) ? null : regen;
    }
    if (e._rawStamp) usedStamps.add(e._rawStamp);
    lastAt = e.createdAt;
  }
}

/* ============================================================
 * 写盘前：冻结 _writeStamp
 * ============================================================ */

export function freezeWriteStamps(topic) {
  for (const e of topic.entries) {
    if (!e._writeStamp) e._writeStamp = stampForWrite(e);
  }
  for (const br of topic.branches) freezeWriteStamps(br);
}

/* ============================================================
 * 分支预览 / 标题
 * ============================================================ */

export function previewText(text, maxLen) {
  const s = String(text || '')
    .replace(/:::think[\s\S]*?:::/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('📎') && !l.startsWith('>') && !l.startsWith('\\#'))
    .join(' ');
  return s.slice(0, maxLen || 60);
}

export function branchTitle(branch) {
  const first = branch.entries[0];
  if (!first) return '[分支]';
  const head = previewText(first.text, 20) || '分支';
  return '[分支] ' + head;
}

/* ============================================================
 * 临时性失败消息（重试产生的噪音分支）
 * ============================================================ */

/* 这些是「服务端临时故障 / 拒答」的固定话术。DeepSeek 导出的 mapping 里，
   每次重试都会留下一个只含这句话的分支节点；直接按分支导入会生成一堆
   名字几乎相同的子话题（这个样本里 7 个分支有 5 个是「服务器繁忙」）。 */
const TRANSIENT_FAILURE_RE = new RegExp([
  '服务器繁忙',
  '服务繁忙',
  '请稍后再试',
  '请稍后重试',
  '网络异常',
  '网络错误',
  '网络连接失败',
  '请求失败',
  '系统繁忙',
  '该对话已被删除',
  '这个问题我暂时无法回答',
  '让我们换个话题',
].join('|'));

/** 只有"单条、短、且是固定失败话术"的分支才认为没有价值。 */
/* 排序用：这个叶子 child 是不是一条"失败重试"消息。
   只看"没有子节点 + 只有一条 assistant 文本"的情况（和 isTransientFailureBranch 同义）。 */
function peekTransientChild(node, extractContent) {
  if (!node || !node.message) return false;
  if (node.children && node.children.length) return false;
  const items = contentItemsOf(node, extractContent).filter(Boolean);
  if (items.length !== 1) return false;
  const it = items[0];
  if (!it || it.role !== 'assistant' || it.thinking) return false;
  return isTransientFailureBranch({ entries: [{ text: it.text || '' }], branches: [] });
}

export function isTransientFailureBranch(branch) {
  if (!branch || !branch.entries || branch.entries.length !== 1) return false;
  if (branch.branches && branch.branches.length) return false;
  const text = previewText(branch.entries[0].text, 80);
  if (!text || text.length > 60) return false;
  return TRANSIENT_FAILURE_RE.test(text);
}

/* ============================================================
 * 引用头
 * ============================================================ */

function collectTopicIdMap(topic, map) {
  map.set(topic.scopeId, localIdFromMs(topic.createdAtMs));
  for (const br of topic.branches) collectTopicIdMap(br, map);
}

function processReplyHeaders(topic, topicIdMap, parentInfo) {
  for (let i = 0; i < topic.entries.length; i++) {
    const e = topic.entries[i];
    let header = '';

    if (i === 0 && parentInfo && !e._replyTo) {
      /* 分支首条是 user：如果它和父话题里那条用户消息**不一样**，
         说明这是"改了提问"产生的新分支，标出来更直观。 */
      const parentText = String(parentInfo.parentText || '').trim();
      const curText = String(e.text || '').trim();
      const edited = parentText && curText && parentText !== curText;
      header = '> 📌 此分支从「' + parentInfo.parentTitle + '」分出' +
               (edited ? '（原消息修改后，出现新分支）' : '') + '\n' +
               '> [[~' + parentInfo.parentTopicId + '#^' +
               parentInfo.parentBlockId + ']]\n\n';
    }

    if (e._altOf) {
      /* 变体头：↻ [[~tid#^锚点]] —— 不写回复头，也不建子话题 */
      const tgt = e._altOf;
      const tid = topicIdMap.get(tgt._scope);
      if (tid) {
        header = '↻ [[~' + tid + '#^' + entryBlockId(tgt) + ']]\n\n';
      }
      delete e._altOf;
      delete e._replyTo;
    } else if (e._replyTo) {
      const tgt = e._replyTo;
      const tid = topicIdMap.get(tgt._scope);
      if (tid) {
        const bid = entryBlockId(tgt);
        const pv = previewText(tgt.text, 60);
        header = '> ' + pv + '\n> [[~' + tid + '#^' + bid + ']]\n\n';
      }
      delete e._replyTo;
    }

    if (header) e.text = header + e.text;
  }

  for (const br of topic.branches) {
    const fromUser = br._fromUser;
    let parentInfo = null;
    if (fromUser) {
      const fromTopicId = topicIdMap.get(fromUser._scope);
      parentInfo = {
        parentTitle: topic.title,
        parentTopicId: fromTopicId,
        parentBlockId: entryBlockId(fromUser),
        parentText: fromUser.text,      /* 用来判断分支是不是"改了提问"产生的 */
      };
    }
    processReplyHeaders(br, topicIdMap, parentInfo);
  }
}

/* ============================================================
 * 磁盘写入
 * ============================================================ */

async function writeTopic(parentDir, topic, source, opts, onImage) {
  /* 目录名是持久化的真名：重扫时 scanDir 直接用它当 title。
     导入也必须用同一个名字，否则内存里显示原始标题、重载后变成
     sanitize/uniqueName 之后的目录名。 */
  const dirName = await uniqueName(parentDir, sanitizeName(topic.title));
  const safeTitle = dirName;
  const dir = await Storage.getDir(parentDir, dirName, { create: true });

  /* ★ 新增：图片复制逻辑 */
  if (opts && opts.photoDir) {
    /* alt 以 sticker: 开头的是贴纸，走下面的 _copy 计划（源文件在 stickers/），
       这里不能按普通照片去根目录/photos 找，否则会刷一堆"复制失败"。 */
    const IMG_RE = /!\[([^\]]*)\]\(attachments\/([^)]+)\)/g;
    const attachmentsDir = await Storage.getDir(dir, 'attachments', { create: true });

    for (const e of topic.entries) {
      let match;
      IMG_RE.lastIndex = 0;
      while ((match = IMG_RE.exec(e.text))) {
        if (String(match[1] || '').startsWith('sticker:')) continue;
        const fname = match[2];
        try {
          let srcFh;
          try { srcFh = await resolveFile(opts.photoDir, fname); }
          catch (e1) { srcFh = await resolveFile(opts.photoDir, 'photos/' + fname); }
          const blob = await srcFh.getFile();
          await Storage.writeBlob(attachmentsDir, fname, blob);
        } catch (err) {
          console.warn('[import] 图片复制失败', fname, err);
        } finally {
          if (onImage) onImage();   /* ★ 成功或失败都推进 */
        }
      }
    }

    /* 贴纸等"按计划复制"的附件：解析阶段已登记 source → target，
       同一目标只复制一次（同一张贴纸发很多次时不会重复写盘）。 */
    const copiedTargets = new Set();
    for (const e of topic.entries) {
      for (const c of (e._copy || [])) {
        if (!c || !c.source || !c.target) continue;
        if (copiedTargets.has(c.target)) continue;
        copiedTargets.add(c.target);
        /* 先按导出根目录的相对路径找；找不到再退回 basename
           （用户直接把 stickers 目录选进来时也能命中）。 */
        const base = String(c.source).split('/').pop();
        const candidates = (base && base !== c.source) ? [c.source, base] : [c.source];
        let lastErr = null;
        for (const rel of candidates) {
          try {
            const srcFh = await resolveFile(opts.photoDir, rel);
            const blob = await srcFh.getFile();
            await Storage.writeBlob(attachmentsDir, c.target, blob);
            lastErr = null;
            break;
          } catch (err) { lastErr = err; }
        }
        if (lastErr) {
          console.warn('[import] 贴纸复制失败', c.source, lastErr,
            '（若选的是 photos 子目录，请改选导出根目录）');
        }
        if (onImage) onImage();
      }
    }
  }

  const node = {
    title: safeTitle,
    _dir: dir,
    entries: topic.entries,
  };
  const months = new Set(topic.entries.map(e => monthKeyOfEntry(e)));
  for (const mk of months) await writeMonthFile(node, mk);

  const topicCreatedAt = fmtStamp(topic.createdAtMs);
  await atomicWriteText(dir, '_话题.json', JSON.stringify({
    createdAt: topicCreatedAt,
    source: source.source,
    sourceId: source.sourceId,
    intro: '',
  }, null, 2));

  return {
    id: uid(),
    title: safeTitle,
    _name: dirName,
    _dir: dir,
    topicId: topicCreatedAt,
    entries: topic.entries,
    children: [],
    pinned: [],
    folds: [],
    _hasOldFile: false,
  };
}

async function persistRecursive(parentDir, topic, source, opts, onImage) {
  const node = await writeTopic(parentDir, topic, source, opts, onImage);
  for (const br of topic.branches) {
    const sub = await persistRecursive(node._dir, br, source, opts, onImage);
    node.children.push(sub);
  }
  return node;
}

/* ============================================================
 * 顶层 API
 * ============================================================ */


/* ---------- 新增：数一个 topic 树里的图片总数 ---------- */
const IMG_REF_RE = /!\[[^\]]*\]\(attachments\/([^)]+)\)/g;

function countImages(topic) {
  let n = 0;
  for (const e of topic.entries) {
    IMG_REF_RE.lastIndex = 0;
    let m;
    while ((m = IMG_REF_RE.exec(e.text))) n++;
  }
  for (const br of topic.branches) n += countImages(br);
  return n;
}
/**
 * @param {FileSystemDirectoryHandle} parentDir
 * @param {Array} conversations  [{title, sourceId, sourceCreatedAt, root}]
 * @param {string} source        'deepseek' | 'claude' | 'qwen' | 'gemini' | 'telegram' | ...
 * @param {Function} [report]    (done, total) => void，进度回调
 */
/* 话题引用 ID 来自 createdAtMs；不同对话的首条记录可能落在同一毫秒，
   导入前统一压到互不相同的毫秒上，避免 "~2026-…" 引用撞车。 */
function uniquifyTopicTimes(topic, used) {
  if (!topic) return;
  if (topic.entries.length) {
    let ms = topic.createdAtMs;
    while (used.has(ms) && ms > 1) ms -= 1;
    used.add(ms);
    topic.createdAtMs = ms;
  }
  for (const br of topic.branches) uniquifyTopicTimes(br, used);
}

export async function importAsTopics(parentDir, conversations, source, report, opts) {
  const roots = [];

  /* 先把所有话题时间定下来（含分支），再写文件 */
  {
    const used = new Set();
    for (const conv of conversations) uniquifyTopicTimes(conv.root, used);
  }
  const totalConvs = conversations.length;

  let totalImages = 0;
  for (const conv of conversations) totalImages += countImages(conv.root);
  const totalWork = totalConvs + totalImages;
  let doneWork = 0;

  const bump = () => { doneWork++; if (report) report(doneWork, totalWork); };
  const onImage = () => bump();

  for (let i = 0; i < totalConvs; i++) {
    const conv = conversations[i];
    try {
      const topicIdMap = new Map();
      collectTopicIdMap(conv.root, topicIdMap);
      processReplyHeaders(conv.root, topicIdMap, null);
      const node = await persistRecursive(parentDir, conv.root, {
        source, sourceId: conv.sourceId,
      }, opts, onImage);
      roots.push(node);
    } catch (e) {
      console.error('[import] 对话导入失败:', conv.title, e);
    }
    bump();
  }
  return roots;
}


/* ============================================================
 * 辅助
 * ============================================================ */

export function countEntries(topic) {
  let n = topic.entries.length;
  for (const br of topic.branches) n += countEntries(br);
  return n;
}

/* ============================================================
 * 扁平流：不走消息树，直接收尾成 topic 结构
 * ============================================================ */

/**
 * 把一组扁平 entry 收尾成 topic 结构。
 *
 * 场景：数据源本身就是线性流（Telegram 私聊/频道），
 * 没有树、没有分支、没有 user/assistant 角色。
 *
 * @param {Array} entries  adapter 已经填好 id / text / createdAt /
 *   edited / editedAt / _tzOffset / _replyTo 的 entry 数组。
 *   _replyTo 指向同一数组里的另一个 entry 对象。
 * @param {object} opts
 *   title           {string}
 *   sourceCreatedAt {number}  源 created_at 毫秒；NaN 时用首条
 *   scopeId         {any}     topic 在引用系统里的 key；默认自增
 */
export function finalizeFlatTopic(entries, opts) {
  opts = opts || {};
  const scopeId = opts.scopeId != null ? opts.scopeId : nextScopeId();

  /* 关键：给每个 entry 挂 _scope。
     processReplyHeaders 靠它查 topicIdMap，拿到「被引用 entry
     所属 topic」的引用 ID。不挂的话 _replyTo 会被静默丢弃。 */
  for (const e of entries) {
    if (e._scope == null) e._scope = scopeId;
  }

  /* 先排序再取首条时间，避免输入乱序导致 createdAtMs 错 */
  const sorted = entries.slice().sort((a, b) => a.createdAt - b.createdAt);

  const topic = {
    scopeId,
    title: opts.title || '',
    createdAtMs: (Number.isFinite(opts.sourceCreatedAt) && opts.sourceCreatedAt > 0)
      ? opts.sourceCreatedAt
      : (sorted[0] ? sorted[0].createdAt : 1),
    entries: sorted,
    branches: [],
  };
  normalizeTimestamps(topic);
  if (topic.entries.length) {
    const first = topic.entries[0].createdAt;
    const srcMs = (Number.isFinite(opts.sourceCreatedAt) && opts.sourceCreatedAt > 0)
      ? opts.sourceCreatedAt : 0;
    topic.createdAtMs = (srcMs > 0 && srcMs < first)
      ? srcMs
      : Math.max(1, first - 1);
  }
  freezeWriteStamps(topic);
  return topic;
}

/* ============================================================
 * 导入 UI 流程（原先散在 app.js）
 * ============================================================ */

export function initImportPicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.txt,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  return input;
}

/* 一条对话里有多少条记录（只为在选择器里显示个数字）
   注意要连分支一起算：分支会被导入成子话题，只数主路径会少报。 */
function convCount(conv) {
  const root = conv && conv.root;
  return root ? countEntries(root) : 0;
}

/**
 * 用话题选择器挑要导入哪些对话。
 * 解析阶段就知道所有标题，所以这里给的是"外部列表"（这些话题还不在库里）。
 * @returns {Promise<number[]|null>} 选中的下标；取消返回 null
 */
function pickConversations(openTopicPicker, conversations) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };

    const items = conversations.map((c, i) => ({
      id: String(i),
      title: c && c.title ? c.title : '未命名',
      subtitle: convCount(c) + ' 条',
    }));

    const md = openTopicPicker({
      mode: 'multi',
      search: true,
      title: '要导入哪些话题？',
      hint: '文件里有 ' + conversations.length + ' 个话题，只导入勾选的（可搜索标题）。',
      okText: '导入选中',
      items,
      preselect: items.map(it => it.id),
      onPickMulti: ids => done(ids.map(Number)),
    });

    /* 取消 / Esc 关掉模态时也要 resolve，否则流程会挂住 */
    const root = (typeof document !== 'undefined') ? document.getElementById('modalRoot') : null;
    if (root && md && typeof MutationObserver === 'function') {
      const obs = new MutationObserver(() => {
        if (!md.isConnected) { obs.disconnect(); done(null); }
      });
      obs.observe(root, { childList: true, subtree: true });
    }
  });
}


async function showImportConfirmDialog(source, count, ui) {
  return new Promise(resolve => {
    let photoDir = null;
    let confirmed = false;

    const sourceName = {
      deepseek: 'DeepSeek', claude: 'Claude', qwen: '千问', telegram: 'Telegram', qq: 'QQ',
    }[source] || source;

    const md = ui.openModal(
      `<h3>确认导入</h3>
       <p class="sub">检测到 <b>${sourceName}</b> 导出格式。<br>包含 <b>${count}</b> 个话题。</p>
       <div style="margin:14px 0; padding:12px; background:var(--paper); border-radius:8px;">
         <p style="font-size:12.5px; margin-bottom:8px; color:var(--ink2);">如果导出包含图片/贴纸，请选择导出根目录（里面有 photos、stickers 的那一层）：</p>
         <div style="display:flex; align-items:center; gap:10px;">
           <button type="button" class="m-btn ghost" id="pickPhotoBtn" style="padding:6px 12px; font-size:12px; flex:none;">选择导出目录</button>
           <span id="photoStatus" style="font-size:12px; color:var(--ink3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">未选择（仅保留文字与路径）</span>
         </div>
       </div>
       <div class="modal-btns">
         <button class="m-btn ghost" data-close>取消</button>
         <button class="m-btn" data-ok style="background:var(--accent);color:#F5F1E4">下一步</button>
       </div>`,
      () => resolve({ ok: confirmed, photoDir })
    );

    md.querySelector('#pickPhotoBtn').addEventListener('click', async () => {
      try {
        if (PLATFORM.isTauri) {
          const dir = await invoke('plugin:dialog|open', {
            options: { directory: true, multiple: false, title: '选择图片文件夹' },
          });
          if (dir) {
            photoDir = dir;
            md.querySelector('#photoStatus').textContent = dir.split(/[\\\/]/).pop() || dir;
          }
        } else {
          const dir = await window.showDirectoryPicker({ mode: 'read' });
          if (dir) {
            photoDir = dir;
            md.querySelector('#photoStatus').textContent = dir.name;
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') ui.toast('选择文件夹失败：' + (e.message || e));
      }
    });

    md.querySelector('[data-close]').addEventListener('click', ui.closeModal);
    md.querySelector('[data-ok]').addEventListener('click', () => {
      confirmed = true;
      ui.closeModal();
    });
  });
}

/**
 * 导入失败时，把错误详情写到所选父话题目录，方便事后排查。
 * 文件名以 _ 开头，loader 不会把它当记录/月份文件。
 */
export async function writeImportFailureReport(parent, err, meta, deps) {
  deps = deps || {};
  const toast = deps.toast || (await import('./ui.js')).toast;
  const enqueue = deps.enqueue || (await import('./writer.js')).enqueue;
  const pdir = dirOf(parent);
  if (!pdir) {
    toast('导入失败，且目标目录不可用，错误日志未写入');
    return;
  }
  const now = Date.now();
  const name = '_导入失败-' + localIdFromMs(now) + '.md';
  const parentPath = pathTitles(parent) || '根目录';
  const detail = String((err && err.stack) || (err && err.message) || err || '未知错误')
    .replace(/```/g, "'''");
  const body = [
    '# 导入失败 · ' + fmtStamp(now),
    '',
    '- 时间：' + fmtStamp(now),
    '- 来源：' + (meta.source || '未知'),
    '- 文件：' + (meta.fileName || '未知'),
    '- 识别到的对话数：' + (meta.count || 0),
    '- 目标父话题：' + parentPath,
    '',
    '## 错误详情',
    '',
    '```text',
    detail,
    '```',
    '',
  ].join('\n');

  const r = await enqueue(() => atomicWriteText(pdir, name, body));
  if (r.ok) toast('已把错误详情写入：' + name);
  else toast('错误详情写入失败：' + ((r.err && r.err.message) || r.err));
}

/**
 * 核心导入流程。
 * @param {File} file
 * @param {{attempts: Array, renderAll: Function, select: Function}} deps
 */
export async function runImportFile(file, deps) {
  deps = deps || {};
  const attempts = deps.attempts || [];
  const renderAll = deps.renderAll || (() => {});
  const select = deps.select || (() => {});
  const ui = await import('./ui.js');
  const { openMovePicker } = await import('./ui-topicPicker.js');
  const { enqueue } = await import('./writer.js');
  const text = await file.text();

  let conversations = null, source = '', importFn = null;
  const _warn = console.warn;
  console.warn = () => {};
  for (const [src, parseFn, imp] of attempts) {
    try {
      conversations = parseFn(text);
      source = src;
      importFn = imp;
      break;
    } catch (e) {}
  }
  console.warn = _warn;

  if (!conversations) {
    ui.toast('无法识别的文件格式');
    return;
  }

  /* ★ 一个文件里通常有多个对话：先让用户按标题挑要导入哪些。
     这些话题还没进库，所以用"外部列表"模式 + 搜索，不走话题树。 */
  if (conversations.length > 1) {
    const { openTopicPicker } = await import('./ui-topicPicker.js');
    const picked = await pickConversations(openTopicPicker, conversations);
    if (picked === null) { ui.toast('已取消导入'); return; }
    if (!picked.length) { ui.toast('没有选中任何话题'); return; }
    conversations = picked.map(i => conversations[i]);
  }

  const { ok, photoDir } = await showImportConfirmDialog(source, conversations.length, ui);
  if (!ok) return;

  const hint = conversations.length === 1
    ? '把「' + conversations[0].title + '」导入到哪个话题下？'
    : '把 ' + conversations.length + ' 个对话导入到哪个话题下？';

  openMovePicker(hint, [], async (parentId) => {
    const parent = findNode(parentId);
    if (!parent) { ui.toast('找不到目标话题'); return; }
    try {
      const nodes = [];
      const r = await enqueue(async (report) => {
        const created = await importFn(dirOf(parent), conversations, report, { photoDir });
        for (const n of created) { parent.children.push(n); nodes.push(n); }
        Store.rebuildIndex();
        resetMeta();
        await writeOrder(parent);
      });
      if (!r.ok) throw (r.err || new Error('磁盘写入失败'));
      if (!nodes.length) throw new Error('导入任务完成，但没有任何话题被写入（详见控制台）');

      renderAll();
      if (nodes[0]) select(nodes[0].id);
      /* 统计要把分支算进去：分支是作为子话题写进去的，
         只数 nodes 的 entries 会少报（这个导出样本里 160 条会报成 152）。 */
      let topicCount = 0, entryCount = 0;
      const tally = n => {
        topicCount++;
        entryCount += n.entries.length;
        for (const c of n.children || []) tally(c);
      };
      for (const n of nodes) tally(n);
      ui.toast('已导入 ' + topicCount + ' 个话题，共 ' + entryCount + ' 条记录');
      console.log('[import] 识别为', source, '，解析出', conversations.length, '个对话');
    } catch (e) {
      console.error('[import]', e);
      renderAll();
      ui.toast('导入失败：' + ((e && e.message) || e));
      await writeImportFailureReport(parent, e, {
        source,
        fileName: file.name,
        count: conversations.length,
      }, { toast: ui.toast, enqueue });
    }
  });
}