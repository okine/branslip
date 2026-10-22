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

function assignTimes(node, parentAt) {
    /* 只有带 message 的节点代表真实消息，参与时间修正。
     message: null 的节点（虚拟根、DeepSeek 的占位 root）是纯容器，
     跳过修正、也不推进 cur —— 否则它们的 at=0 会被误判为「缺时间」
     而被补成 Date.now()，把整棵子树的时间戳都拉到当下。

     修正分两种：
       'bump'  —— 为了让时间严格递增（父时间 + 1ms）。
                  原始 rawStamp 依然可信，只差 1ms，可重新生成。
       'infer' —— 整条父链都没有时间，用 Date.now() 兜底。
                  rawStamp 与真实时间差距未知，直接丢弃。 */
  let cur = parentAt;
  if (node.message) {
    if (!node.at || node.at <= parentAt) {
      if (parentAt > 0) {
        node.at = parentAt + 1;
        node._atAdjusted = 'bump';
      } else {
        node.at = Date.now();
        node._atAdjusted = 'infer';
      }
    }
    cur = node.at;
  }
  for (const c of node.children) assignTimes(c, cur);
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

  const baseMs = Number.isFinite(sourceCreatedAt) && sourceCreatedAt > 0
    ? sourceCreatedAt
    : (findFirstAt(tree) || Date.now());

  const root = {
    scopeId: nextScopeId(),
    title,
    createdAtMs: baseMs,
    entries: [],
    branches: [],
  };

  walkSubtree(tree, null, root, extractContent, tzOffset);
  normalizeAll(root);
  freezeWriteStamps(root);
  return root;
}

function findFirstAt(node) {
  if (node.at) return node.at;
  for (const c of node.children) {
    const r = findFirstAt(c);
    if (r) return r;
  }
  return 0;
}

let scopeCounter = 0;
function nextScopeId() { return ++scopeCounter; }

function walkSubtree(node, parentUser, ctx, extractContent, defaultTz) {
  let myUser = parentUser;

  if (node.message && node.at) {
    const c = extractContent(node.message);
    const items = Array.isArray(c) ? c : (c ? [c] : []);

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

  /* 主分支 = 最深子树，其次时间最新 */
  const children = [...node.children].sort((a, b) => {
    if (a._depth !== b._depth) return b._depth - a._depth;
    return b.at - a.at;
  });

  walkSubtree(children[0], myUser, ctx, extractContent, defaultTz);

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
    ctx.branches.push(subCtx);
  }
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
      header = '> 📌 此分支从「' + parentInfo.parentTitle + '」分出\n' +
               '> [[~' + parentInfo.parentTopicId + '#^' +
               parentInfo.parentBlockId + ']]\n\n';
    }

    if (e._replyTo) {
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
    const IMG_RE = /!\[[^\]]*\]\(attachments\/([^)]+)\)/g;
    const attachmentsDir = await Storage.getDir(dir, 'attachments', { create: true });

    for (const e of topic.entries) {
      let match;
      IMG_RE.lastIndex = 0;
      while ((match = IMG_RE.exec(e.text))) {
        const fname = match[1];
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
  }

  const node = {
    title: safeTitle,
    _dir: dir,
    entries: topic.entries,
  };
  const months = new Set(topic.entries.map(e => monthKey(e.createdAt)));
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
export async function importAsTopics(parentDir, conversations, source, report, opts) {
  const roots = [];
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
      : (sorted[0] ? sorted[0].createdAt : Date.now()),
    entries: sorted,
    branches: [],
  };
  normalizeTimestamps(topic);
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
         <p style="font-size:12.5px; margin-bottom:8px; color:var(--ink2);">如果导出包含图片，请选择对应的文件夹以便一并导入：</p>
         <div style="display:flex; align-items:center; gap:10px;">
           <button type="button" class="m-btn ghost" id="pickPhotoBtn" style="padding:6px 12px; font-size:12px; flex:none;">选择图片文件夹</button>
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
      ui.toast('已导入 ' + nodes.length + ' 个话题，共 ' +
        nodes.reduce((s, n) => s + n.entries.length, 0) + ' 条记录');
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