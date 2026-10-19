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

function splitMultiJSON(text) {
  const t = text.trim();
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [v];
  } catch (e) {}
  try {
    const v = JSON.parse('[' + t.replace(/,\s*$/, '') + ']');
    if (Array.isArray(v)) return v;
  } catch (e) {}
  throw new Error('不是合法的 JSON（单个对象、数组、拼接对象都试过了）');
}

/* ---------- mapping → IR ---------- */

function mappingToIR(mapping) {
  /* mapping 只有 children，没有 parent —— 反推一遍 */
  const parentOf = new Map();
  for (const [id, raw] of Object.entries(mapping)) {
    for (const cid of (raw && raw.children) || []) parentOf.set(cid, id);
  }

  const out = [];
  for (const [id, raw] of Object.entries(mapping)) {
    const msg = (raw && raw.message) || null;
    const at = (msg && msg.inserted_at && Number.isFinite(Date.parse(msg.inserted_at)))
      ? Date.parse(msg.inserted_at) : 0;
    out.push(makeMessage(id, at, {
      parentId: parentOf.get(id) || null,
      childrenIds: (raw && raw.children) || null,
      raw: msg,
    }));
  }
  return out;
}

/* ---------- 内容提取 ---------- */

function extractDeepSeekContent(msg) {
  if (!msg || !Array.isArray(msg.fragments)) return { role: 'skip' };

  const frags = msg.fragments;
  const reqFrag = frags.find(f =>
    f && f.type === 'REQUEST' && typeof f.content === 'string' && f.content.trim());
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

  if (reqFrag) {
    let text = reqFrag.content;
    if (fileFrags.length) {
      const names = [];
      for (const ff of fileFrags) for (const file of ff.files)
        if (file && file.file_name) names.push(file.file_name);
      if (names.length) {
        text = names.map(n => '📎 ' + n).join('\n') + '\n\n' + text;
      }
    }
    out.push({ role: 'user', text, thinking: '', rawStamp, tzOffset: tz });
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
    const sourceCreatedAt = conv.inserted_at ? Date.parse(conv.inserted_at) : NaN;

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
      sourceCreatedAt: conv.inserted_at || null,
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
