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

function messagesToIR(messages, stats) {
  const list = messages.filter(m => m && m.uuid);
  const ids = new Set(list.map(m => m.uuid));

  /* Claude 的导出有时会缺 assistant 消息，导致 human 的 parent UUID
     在文件里找不到。以前这种节点会变成多个 root，被拆成多个子话题。
     这里按时间顺序把“父节点缺失”的消息接到上一条存在消息上，保持线性。 */
  const sorted = list.slice().sort((a, b) => {
    const d = parseTs(a.created_at) - parseTs(b.created_at);
    return d || list.indexOf(a) - list.indexOf(b);
  });
  let prev = null;
  return sorted.map(m => {
    let pid = (m.parent_message_uuid && m.parent_message_uuid !== ROOT_UUID)
      ? m.parent_message_uuid : null;
    if (pid && !ids.has(pid)) {
      if (stats) stats.missingParents = (stats.missingParents || 0) + 1;
      pid = prev ? prev.uuid : null;
    }
    prev = m;
    return makeMessage(m.uuid, parseTs(m.created_at), {
      parentId: pid,
      raw: m,
    });
  });
}

/* ---------- 内容提取 ---------- */

function textOfContent(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.map(x => {
    if (!x || typeof x !== 'object') return '';
    if (typeof x.text === 'string') return x.text;
    if (typeof x.content === 'string') return x.content;
    return '';
  }).filter(Boolean).join('\n\n');
}

function attachmentNames(msg) {
  const out = [];
  const add = f => {
    if (!f || typeof f !== 'object') return;
    const n = f.file_name || f.name ||
      (f.file_uuid ? 'file_' + String(f.file_uuid).slice(0, 8) : '');
    if (n && !out.includes(n)) out.push(n);
  };
  if (Array.isArray(msg.files)) msg.files.forEach(add);
  if (Array.isArray(msg.attachments)) msg.attachments.forEach(add);
  return out;
}

function extractContent(msg) {
  let content = msg.content;
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  if (!Array.isArray(content) || !content.length) {
    content = (typeof msg.text === 'string' && msg.text.trim())
      ? [{ type: 'text', text: msg.text }]
      : [];
  }

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
    } else if (item.type === 'tool_use') {
      const name = String(item.name || item.tool_name || '工具');
      const input = item.input != null ? JSON.stringify(item.input, null, 2) : '';
      texts.push('🔧 使用工具：' + name + (input ? '\n\n```json\n' + input + '\n```' : ''));
    } else if (item.type === 'tool_result') {
      const t = textOfContent(item.content) || textOfContent(item.text);
      if (t.trim()) texts.push('📎 工具结果\n\n' + t);
    }
  }

  /* 有些导出把正文只放在顶层 text；content 里可能只有空 text/tool 块。 */
  if (!texts.length && !thinks.length &&
      typeof msg.text === 'string' && msg.text.trim()) {
    texts.push(msg.text);
  }

  const raw = msg.created_at;
  const tzFromRaw = tzOffsetFromStamp(raw);
  const tz = (tzFromRaw != null) ? tzFromRaw : -new Date().getTimezoneOffset();
  const rawStamp = normalizeRawStamp(raw);

  if (msg.sender === 'human') {
    const fileNames = attachmentNames(msg);
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

export function parseClaudeExport(jsonText, stats) {
  stats = stats || {};
  const raw = splitJSON(jsonText);
  const convs = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue;
    const messages = conv.chat_messages;
    if (!Array.isArray(messages) || !messages.length) {
      console.warn('[import-claude] 跳过：没有 chat_messages', conv.uuid);
      stats.skippedEmptyConversations = (stats.skippedEmptyConversations || 0) + 1;
      continue;
    }

    for (const m of messages) {
      const c = m && m.content;
      const hasContent = (typeof c === 'string' && c.trim()) ||
        (Array.isArray(c) && c.length) ||
        (typeof m.text === 'string' && m.text.trim());
      if (!hasContent) stats.skippedEmptyMessages = (stats.skippedEmptyMessages || 0) + 1;
      for (const f of [...(Array.isArray(m.files) ? m.files : []),
                       ...(Array.isArray(m.attachments) ? m.attachments : [])]) {
        if (f && !f.file_name && !f.name) {
          stats.missingFileNames = (stats.missingFileNames || 0) + 1;
        }
      }
    }

    const tree = buildMessageTree(messagesToIR(messages, stats));

    const title = pickTitle(conv, tree);
    const sourceCreatedAt = parseTs(conv.created_at);

    const root = extractFromTree(tree, {
      title, sourceCreatedAt, extractContent,
    });

    if (!root.entries.length && !root.branches.length) {
      console.warn('[import-claude] 跳过：没有任何消息', title);
      stats.skippedEmptyConversations = (stats.skippedEmptyConversations || 0) + 1;
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

export function importClaudeAsTopics(parentDir, conversations, report, opts) {
  return importAsTopics(parentDir, conversations, 'claude', report, opts);
}