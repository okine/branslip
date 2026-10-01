'use strict';
/* ================= import-claude.js =================
 * Claude (claude.ai) 聊天导出 → 时枝笺话题。
 */

import {
  buildMessageTree, extractFromTree, importAsTopics,
  makeMessage, countEntries,
} from './import-runtime.js';
import { normalizeRawStamp, tzOffsetFromStamp } from './format.js';

const ROOT_UUID = '00000000-0000-4000-8000-000000000000';

/* ---------- 顶层解析 ---------- */

function splitJSON(text) {
  const t = String(text || '').trim();
  let v;
  try { v = JSON.parse(t); }
  catch (e) { throw new Error('不是合法的 JSON：' + e.message); }

  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    if (Array.isArray(v.chat_messages)) return [v];
    if (Array.isArray(v.conversations)) return v.conversations;
  }
  throw new Error('不认识的 Claude 导出格式');
}

function parseTs(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/* ---------- chat_messages → IR ---------- */

function messagesToIR(messages) {
  return messages
    .filter(m => m && m.uuid)
    .map(m => makeMessage(m.uuid, parseTs(m.created_at), {
      parentId: (m.parent_message_uuid && m.parent_message_uuid !== ROOT_UUID)
        ? m.parent_message_uuid : null,
      raw: m,
    }));
}

/* ---------- 内容提取 ---------- */

function extractContent(msg) {
  const content = msg.content;
  if (!Array.isArray(content)) return { role: 'skip' };

  const texts = [];
  const thinks = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'text') {
      if (typeof item.text === 'string' && item.text.trim()) texts.push(item.text);
    } else if (item.type === 'thinking') {
      let t = '';
      if (typeof item.thinking === 'string' && item.thinking.trim()) {
        t = item.thinking;
      } else if (Array.isArray(item.summaries)) {
        t = item.summaries
          .map(s => (s && typeof s.summary === 'string') ? s.summary : '')
          .filter(Boolean).join('\n\n');
      }
      if (t.trim()) thinks.push(t);
    }
  }

  const raw = msg.created_at;
  const tzFromRaw = tzOffsetFromStamp(raw);
  const tz = (tzFromRaw != null) ? tzFromRaw : -new Date().getTimezoneOffset();
  const rawStamp = normalizeRawStamp(raw);

  if (msg.sender === 'human') {
    const fileNames = Array.isArray(msg.files)
      ? msg.files.map(f => f && f.file_name).filter(Boolean) : [];
    let body = texts.join('\n\n');
    if (fileNames.length) {
      const head = fileNames.map(n => '📎 ' + n).join('\n');
      body = body ? head + '\n\n' + body : head;
    }
    if (!body.trim()) return { role: 'skip' };
    return { role: 'user', text: body, thinking: '', rawStamp, tzOffset: tz };
  }

  if (msg.sender === 'assistant') {
    const text = texts.join('\n\n');
    const thinking = thinks.join('\n\n');
    if (!text && !thinking) return { role: 'skip' };
    return { role: 'assistant', text, thinking, rawStamp, tzOffset: tz };
  }

  return { role: 'skip' };
}

/* ---------- 标题 ---------- */

function pickTitle(conv, tree) {
  const name = String(conv.name || '').trim();
  if (name) return name;

  const summary = String(conv.summary || '').trim();
  if (summary) return summary.slice(0, 40);

  const first = firstHumanText(tree);
  if (first) {
    const line = first.split('\n').map(s => s.trim()).find(s => s);
    if (line) return line.slice(0, 20);
  }

  const d = new Date(conv.created_at);
  if (Number.isFinite(d.getTime())) {
    const p = n => String(n).padStart(2, '0');
    return 'Claude-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes());
  }
  return 'Claude 对话';
}

function firstHumanText(node) {
  const sorted = [...node.children].sort((a, b) => a.at - b.at);
  for (const c of sorted) {
    if (c.message && c.message.sender === 'human') {
      const content = c.message.content;
      if (Array.isArray(content)) {
        const text = content
          .filter(x => x && x.type === 'text' && typeof x.text === 'string')
          .map(x => x.text).join('\n\n');
        if (text.trim()) return text;
      }
    }
    const r = firstHumanText(c);
    if (r) return r;
  }
  return '';
}

/* ---------- 顶层 API ---------- */

export function parseClaudeExport(jsonText) {
  const raw = splitJSON(jsonText);
  const convs = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue;
    const messages = conv.chat_messages;
    if (!Array.isArray(messages) || !messages.length) {
      console.warn('[import-claude] 跳过：没有 chat_messages', conv.uuid);
      continue;
    }

    const tree = buildMessageTree(messagesToIR(messages));

    const title = pickTitle(conv, tree);
    const sourceCreatedAt = parseTs(conv.created_at);

    const root = extractFromTree(tree, {
      title, sourceCreatedAt, extractContent,
    });

    if (!root.entries.length && !root.branches.length) {
      console.warn('[import-claude] 跳过：没有任何消息', title);
      continue;
    }

    convs.push({
      title,
      sourceId: conv.uuid || null,
      sourceCreatedAt: conv.created_at || null,
      root,
    });

    console.log('[import-claude]', title, '→', countEntries(root), '条 ·',
                root.branches.length, '个分支');
  }

  if (!convs.length) throw new Error('文件里没有任何有效的对话');
  return convs;
}

export function importClaudeAsTopics(parentDir, conversations, report) {
  return importAsTopics(parentDir, conversations, 'claude', report);
}