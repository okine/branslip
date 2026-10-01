'use strict';
/* ================= import-qwen.js =================
 * 千问聊天导出 → 时枝笺话题。
 *
 * 关键：Qwen 只给秒级 Unix 时间戳，所以 adapter 里 ×1000；
 *      不设 _rawStamp，让 stampForWrite 用 _tzOffset 重新格式化。
 */

import {
  buildMessageTree, extractFromTree, importAsTopics,
  makeMessage, countEntries,
} from './import-runtime.js';

/* ---------- 顶层解析 ---------- */

function splitJSON(text) {
  const t = String(text || '').trim();
  let v;
  try { v = JSON.parse(t); }
  catch (e) { throw new Error('不是合法的 JSON：' + e.message); }

  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && v.chat) return [v];
  throw new Error('不认识的 Qwen 导出格式');
}

/* ---------- 内容提取 ---------- */

function joinArr(a) {
  if (!Array.isArray(a)) return '';
  return a.map(s => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean).join('\n\n');
}

function extractQwenContent(msg) {
  const tz = -new Date().getTimezoneOffset();

  if (msg.role === 'user') {
    let text = String(msg.content || '');
    const files = Array.isArray(msg.files) ? msg.files : [];
    const names = files.map(f => f && (f.name || f.file_name)).filter(Boolean);
    if (names.length) {
      const head = names.map(n => '📎 ' + n).join('\n');
      text = text ? head + '\n\n' + text : head;
    }
    if (!text.trim()) return { role: 'skip' };
    return { role: 'user', text, thinking: '', tzOffset: tz };
  }

  if (msg.role !== 'assistant') return { role: 'skip' };

  const list = Array.isArray(msg.content_list) ? msg.content_list : [];
  const texts = [];
  const thinks = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.status && item.status !== 'finished') continue;

    if (item.phase === 'answer') {
      if (typeof item.content === 'string' && item.content.trim())
        texts.push(item.content);
      continue;
    }

    if (item.phase === 'thinking_summary') {
      const extra = item.extra || {};
      const titles   = joinArr(extra.summary_title  && extra.summary_title.content);
      const thoughts = joinArr(extra.summary_thought && extra.summary_thought.content);

      const parts = [];
      if (titles) {
        parts.push('**要点**\n' +
          titles.split(/\n+/).map(t => '- ' + t.trim()).filter(t => t !== '- ').join('\n'));
      }
      if (thoughts) parts.push(thoughts);

      /* 结构变了也要能兜底 */
      if (!parts.length && typeof item.content === 'string' && item.content.trim())
        parts.push(item.content);
      if (parts.length) thinks.push(parts.join('\n\n'));
    }
  }

  const text = texts.join('\n\n');
  const thinking = thinks.join('\n\n');
  if (!text && !thinking) return { role: 'skip' };
  return { role: 'assistant', text, thinking, tzOffset: tz };
}

/* ---------- history.messages → IR ---------- */

function messagesToIR(messagesMap) {
  const out = [];
  for (const [id, m] of Object.entries(messagesMap)) {
    if (!m || !m.id) continue;
    const at = Number.isFinite(m.timestamp) ? m.timestamp * 1000 : 0;
    out.push(makeMessage(id, at, {
      parentId: m.parentId || null,
      childrenIds: Array.isArray(m.childrenIds) ? m.childrenIds : null,
      raw: m,
    }));
  }
  return out;
}

/* ---------- 顶层 API ---------- */

export function parseQwenExport(jsonText) {
  const raw = splitJSON(jsonText);
  const convs = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue;
    const map = conv.chat && conv.chat.history && conv.chat.history.messages;
    if (!map || typeof map !== 'object') {
      console.warn('[import-qwen] 跳过：没有 chat.history.messages', conv.id);
      continue;
    }

    const tree = buildMessageTree(messagesToIR(map));

    const title = String(conv.title || '').trim() || 'Qwen 对话';
    const sourceCreatedAt = Number.isFinite(conv.created_at)
      ? conv.created_at * 1000 : NaN;

    const root = extractFromTree(tree, {
      title, sourceCreatedAt, extractContent: extractQwenContent,
    });

    if (!root.entries.length && !root.branches.length) {
      console.warn('[import-qwen] 跳过：没有任何内容', title);
      continue;
    }

    convs.push({
      title,
      sourceId: conv.id || null,
      sourceCreatedAt: conv.created_at || null,
      root,
    });

    console.log('[import-qwen]', title, '→', countEntries(root), '条 ·',
                root.branches.length, '个分支');
  }

  if (!convs.length) throw new Error('文件里没有任何有效的对话');
  return convs;
}

export function importQwenAsTopics(parentDir, conversations, report) {
  return importAsTopics(parentDir, conversations, 'qwen', report);
}