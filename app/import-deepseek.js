'use strict';
/* ================= import-deepseek.js =================
 * DeepSeek 聊天导出 → 时枝笺话题。
 * 只负责「DeepSeek 格式 ↔ runtime IR」的适配。
 */

import {
  buildMessageTree, extractFromTree, importAsTopics,
  makeMessage, countEntries,
} from './import-runtime.js';
import { normalizeRawStamp, tzOffsetFromStamp } from './format.js';

/* ---------- 顶层解析 ---------- */

function scanValueEnd(s, start) {
  const first = s[start];
  if (first !== '{' && first !== '[') {
    let i = start;
    while (i < s.length && !/[\s,]/.test(s[i])) i++;
    return i;
  }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function splitMultiJSON(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('文件是空的');

  /* 单对象 / 数组 */
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [v];
  } catch (e) {}

  /* NDJSON / 拼接对象 / 多个数组：按顶层 JSON 值逐个切 */
  const out = [];
  let i = 0;
  while (i < t.length) {
    while (i < t.length && /[\s,]/.test(t[i])) i++;
    if (i >= t.length) break;
    const end = scanValueEnd(t, i);
    if (end < 0 || end <= i) {
      throw new Error('不是合法的 JSON（第 ' + i + ' 个字符附近无法解析）');
    }
    const chunk = t.slice(i, end);
    let v;
    try { v = JSON.parse(chunk); }
    catch (e) { throw new Error('不是合法的 JSON：' + e.message); }
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
    i = end;
  }
  if (!out.length) throw new Error('没有解析出任何对话');
  return out;
}

function parseMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/* ---------- mapping → IR ---------- */

function mappingToIR(mapping) {
  /* mapping 可能只有 children，也可能只有 parent；两种都兼容并取并集。 */
  const parentOf = new Map();
  const childOf = new Map();
  const addChild = (pid, cid) => {
    if (!pid || pid === cid) return;
    if (!childOf.has(pid)) childOf.set(pid, []);
    childOf.get(pid).push(cid);
  };

  for (const [id, raw] of Object.entries(mapping)) {
    const self = String(id);
    const p = raw && raw.parent;
    if (p != null && p !== '') {
      const pid = String(p);
      parentOf.set(self, pid);
      addChild(pid, self);
    }
    for (const cid of ((raw && raw.children) || [])) {
      const child = String(cid);
      parentOf.set(child, self);
      addChild(self, child);
    }
  }

  const out = [];
  for (const [id, raw] of Object.entries(mapping)) {
    const self = String(id);
    const msg = (raw && raw.message) || null;
    const at = parseMs(msg && msg.inserted_at);
    const kids = new Set();
    for (const cid of ((raw && raw.children) || [])) kids.add(String(cid));
    for (const cid of (childOf.get(self) || [])) kids.add(cid);
    /* 父指针指向自己会成环，直接忽略 */
    const parentId = parentOf.get(self) === self ? null : (parentOf.get(self) || null);
    out.push(makeMessage(self, at, {
      parentId,
      childrenIds: kids.size ? [...kids] : null,
      raw: msg,
    }));
  }
  return out;
}

/* ---------- 内容提取 ---------- */

function extractDeepSeekContent(msg) {
  if (!msg || !Array.isArray(msg.fragments)) return { role: 'skip' };

  const frags = msg.fragments;
  const reqFrags = frags.filter(f => f && f.type === 'REQUEST');
  const aiFrags = frags.filter(f =>
    f && (f.type === 'RESPONSE' || f.type === 'THINK') &&
    typeof f.content === 'string' && f.content.trim());
  const fileFrags = frags.filter(f =>
    f && f.type === 'FILE' && Array.isArray(f.files));

  const raw = msg.inserted_at;
  const tzFromRaw = tzOffsetFromStamp(raw);
  const tz = (tzFromRaw != null) ? tzFromRaw : -new Date().getTimezoneOffset();
  const rawStamp = normalizeRawStamp(raw);

  /* ★ 一个 node 可能同时有 REQUEST 和 RESPONSE → 返回数组 */
  const out = [];

  /* ★ 文件-only 的 REQUEST 也要生成用户记录：
     以前只找 content.trim() 的 REQUEST，用户只发附件时整条消息会消失。 */
  const fileNames = [];
  const seenNames = new Set();
  for (const ff of fileFrags) for (const file of ff.files) {
    if (!file) continue;
    const name = file.file_name || file.name;
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    fileNames.push(name);
  }
  const reqText = reqFrags
    .map(f => (typeof f.content === 'string' ? f.content.trim() : ''))
    .filter(Boolean)
    .join('\n\n');

  if (reqFrags.length || fileNames.length) {
    let text = reqText;
    if (fileNames.length) {
      const files = fileNames.map(n => '📎 ' + n).join('\n');
      text = text ? files + '\n\n' + text : files;
    }
    if (text) {
      out.push({ role: 'user', text, thinking: '', rawStamp, tzOffset: tz });
    }
  }

  if (aiFrags.length) {
    const parts = [];
    const thinks = [];
    for (const f of aiFrags) {
      if (f.type === 'THINK') thinks.push(f.content);
      else if (f.type === 'RESPONSE') parts.push(f.content);
    }
    out.push({
      role: 'assistant',
      text: parts.join('\n\n'),
      thinking: thinks.join('\n\n'),
      rawStamp, tzOffset: tz,
    });
  }

  return out.length ? out : { role: 'skip' };
}

/* ---------- 顶层 API ---------- */

export function parseDeepSeekExport(jsonText) {
  const raw = splitMultiJSON(jsonText);
  const convs = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== 'object' || !conv.mapping) {
      continue;
    }

    const tree = buildMessageTree(mappingToIR(conv.mapping));

    const title = String(conv.title || '导入的对话').trim() || '导入的对话';
    const sourceCreatedAt = parseMs(conv.inserted_at) || NaN;

    const root = extractFromTree(tree, {
      title, sourceCreatedAt, extractContent: extractDeepSeekContent,
    });

    if (!root.entries.length && !root.branches.length) {
      console.warn('[import-deepseek] 跳过：没有任何消息', title);
      continue;
    }

    convs.push({
      title,
      sourceId: conv.id || null,
      sourceCreatedAt: sourceCreatedAt,
      root,
    });

    console.log('[import-deepseek]', title, '→', countEntries(root), '条 ·',
                root.branches.length, '个分支');
  }

  if (!convs.length) throw new Error('文件里没有任何有效的对话');
  return convs;
}

export function importDeepSeekAsTopics(parentDir, conversations, report, opts) {
  return importAsTopics(parentDir, conversations, 'deepseek', report, opts);
}
