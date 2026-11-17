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

/* 新版 DeepSeek 导出：扁平 messages[] + parent_id，不再有 mapping。 */
function messagesToIR(messages) {
  return (messages || [])
    .filter(m => m && m.id != null)
    .map(m => makeMessage(String(m.id), parseMs(m.inserted_at || m.created_at), {
      parentId: m.parent_id != null ? String(m.parent_id) : null,
      childrenIds: null,
      raw: m,
    }));
}

/* ---------- 内容提取 ---------- */

function deepSeekContentText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(deepSeekContentText).filter(Boolean).join('\n');
  if (v && typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (typeof v.content !== 'undefined') return deepSeekContentText(v.content);
    if (typeof v.thinking === 'string') return v.thinking;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  return v == null ? '' : String(v);
}

function deepSeekFragmentText(f) {
  if (!f || typeof f !== 'object') return '';
  if (f.content !== undefined) return deepSeekContentText(f.content);
  if (f.text !== undefined) return deepSeekContentText(f.text);
  if (f.answer !== undefined) return deepSeekContentText(f.answer);
  if (f.thinking !== undefined) return deepSeekContentText(f.thinking);
  return '';
}

function deepSeekFiles(ff) {
  const list = Array.isArray(ff.files) ? ff.files
    : (ff.files ? [ff.files] : (ff.file ? [ff.file] : []));
  const out = [];
  for (const file of list) {
    if (!file) continue;
    const obj = (typeof file === 'string') ? { name: file } : file;
    const name = obj.file_name || obj.name || obj.filename || obj.path ||
      (obj.export_path ? String(obj.export_path).split('/').pop() : '');
    if (name) out.push({ name: String(name), raw: obj });
    else out.push({ name: '', raw: obj });
  }
  return out;
}

function deepSeekFileTarget(file) {
  const raw = file && file.raw || {};
  const name = String((file && file.name) || raw.file_name || 'file');
  const base = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'file';
  const id = String(raw.id || raw.file_id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return 'deepseek_' + (id || 'file') + '_' + base;
}

function deepSeekRawFragment(f) {
  let body;
  try { body = JSON.stringify(f, null, 2); }
  catch (e) { body = String(f); }
  const type = String((f && f.type) || 'UNKNOWN').replace(/[^\w.-]/g, '_');
  return ':::raw ' + type + '\n' + body + '\n:::';
}

function deepSeekFallbackFragments(msg) {
  /* 极少数导出不再给 fragments，只剩 role/content/text/answer。 */
  const role = String(msg && msg.role || '').toLowerCase();
  const out = [];
  const think = msg && (msg.thinking || msg.reasoning);
  if (think) out.push({ type: 'THINK', content: think });
  const content = msg && (msg.content !== undefined ? msg.content : msg.text !== undefined ? msg.text : msg.answer);
  if (content !== undefined && content !== null) {
    if (Array.isArray(content)) {
      for (const block of content) {
        const t = String((block && block.type) || '').toLowerCase();
        if (t === 'thinking' || t === 'think') out.push({ type: 'THINK', content: block });
        else out.push({ type: role === 'user' ? 'REQUEST' : 'RESPONSE', content: block });
      }
    } else {
      out.push({ type: role === 'user' ? 'REQUEST' : 'RESPONSE', content });
    }
  }
  return out;
}

export function extractDeepSeekContent(msg) {
  if (!msg || typeof msg !== 'object') return { role: 'skip' };

  const rawFrags = Array.isArray(msg.fragments) ? msg.fragments
    : (msg.fragments && typeof msg.fragments === 'object' ? [msg.fragments] : []);
  const frags = rawFrags.length ? rawFrags : deepSeekFallbackFragments(msg);

  const raw = msg.inserted_at || msg.created_at || msg.timestamp;
  const tzFromRaw = tzOffsetFromStamp(raw);
  const tz = (tzFromRaw != null) ? tzFromRaw : -new Date().getTimezoneOffset();
  const rawStamp = normalizeRawStamp(raw);

  const reqTexts = [];
  const aiParts = [];
  const unknown = [];
  const fileItems = [];
  const seenFiles = new Set();

  for (const f of frags) {
    if (!f || typeof f !== 'object') {
      unknown.push(deepSeekRawFragment(f));
      continue;
    }
    const type = String(f.type || '').toUpperCase();
    if (type === 'REQUEST') {
      const text = deepSeekFragmentText(f);
      if (text) reqTexts.push(text);
    } else if (type === 'RESPONSE' || type === 'THINK') {
      /* 非字符串 content 也保留，不能因为类型判断丢掉整条回答。 */
      const text = deepSeekFragmentText(f);
      if (text) aiParts.push({ type, text });
    } else if (type === 'FILE') {
      for (const file of deepSeekFiles(f)) {
        const rawFile = file.raw || {};
        const target = deepSeekFileTarget(file);
        const source = rawFile.export_path || null;
        const image = !!(rawFile.is_image || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || ''));
        const key = (rawFile.id || target) + '\u0000' + target;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        fileItems.push({ name: file.name || 'file', target, source, image: !!source && image });
      }
    } else {
      /* 未知 fragment 不静默 skip：原样保留在可读的 raw 块里。 */
      unknown.push(deepSeekRawFragment(f));
    }
  }

  const out = [];
  let reqText = reqTexts.join('\n\n');
  const userFiles = [];
  const aiFiles = [];
  const role = String(msg.role || '').toUpperCase();
  const hasRequest = reqTexts.length > 0 || frags.some(x => String((x && x.type) || '').toUpperCase() === 'REQUEST');
  const fileText = item => item.image
    ? '![' + item.name + '](attachments/' + item.target + ')'
    : '📎 ' + item.name;
  for (const item of fileItems) {
    if (role === 'USER' || (!role && hasRequest)) {
      userFiles.push(item);
      reqText = (reqText ? reqText + '\n\n' : '') + fileText(item);
    } else {
      aiFiles.push(item);
    }
  }
  if (reqText) out.push({
    role: 'user', text: reqText, thinking: '',
    rawStamp, tzOffset: tz,
    copy: userFiles.filter(x => x.source).map(x => ({ source: x.source, target: x.target })),
  });

  const aiFileText = aiFiles.map(fileText).join('\n\n');
  const aiBody = aiParts.map(part => {
    if (part.type === 'THINK') {
      const safe = String(part.text).replace(/(^|\n):::/g, '$1\\:::');
      return ':::think\n' + safe + '\n:::';
    }
    return part.text;
  }).filter(Boolean).join('\n\n');

  const extra = unknown.join('\n\n');
  const aiKnown = [aiFileText, aiBody].filter(Boolean).join('\n\n');
  const body = aiKnown && extra ? aiKnown + '\n\n' + extra : (aiKnown || extra);
  if (body) out.push({
    role: 'assistant', text: body, thinking: '',
    rawStamp, tzOffset: tz,
    copy: aiFiles.filter(x => x.source).map(x => ({ source: x.source, target: x.target })),
  });

  return out.length ? out : { role: 'skip' };
}

/* 新版导出的 chat_session_index.json：只有目录，不含正文。 */
export function parseDeepSeekIndex(jsonText) {
  let v;
  try { v = JSON.parse(jsonText); } catch (e) { return null; }
  if (!Array.isArray(v) || !v.length) return null;
  if (!v.every(x => x && typeof x === 'object' && x.id && 'message_count' in x)) return null;
  return v;
}

/* ---------- 顶层 API ---------- */

export function parseDeepSeekExport(jsonText) {
  const raw = splitMultiJSON(jsonText);
  const convs = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue;
    const hasMapping = !!conv.mapping;
    const hasMessages = Array.isArray(conv.messages);
    if (!hasMapping && !hasMessages) continue;

    const tree = buildMessageTree(hasMapping
      ? mappingToIR(conv.mapping)
      : messagesToIR(conv.messages));

    const title = String(conv.title || '导入的对话').trim() || '导入的对话';
    const sourceCreatedAt = parseMs(conv.inserted_at || conv.created_at) || NaN;

    const root = extractFromTree(tree, {
      title, sourceCreatedAt, extractContent: extractDeepSeekContent,
      activeId: conv.current_message_id != null ? String(conv.current_message_id) : null,
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
