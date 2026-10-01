'use strict';
/* ================= import-telegram.js =================
 * Telegram 聊天导出（JSON）→ 时枝笺话题。
 *
 * Telegram 的语义：
 *   - 一条消息流（线性时间序），不是对话树
 *   - 消息没有 user/assistant 角色，只有 from（发送者）
 *   - reply_to_message_id 用 runtime 的 _replyTo 表示，写盘后自动
 *     生成 `> 引用原文` + 跳转链接的引用头
 *
 * 话题切分：一个 chat = 一个话题。全账户导出生成 N 个话题。
 *
 * 发送者前缀：多发送者时每条 entry 前加 **from**；
 *             单发送者（频道、Saved Messages）不加，保持正文干净。
 *
 * 附件：当前只保留文本路径（photos/xxx），不复制实际文件。
 */

import { uid } from './utils.js';
import {
  finalizeFlatTopic, importAsTopics, countEntries,
} from './import-runtime.js';

/* ---------- 顶层解析 ---------- */
/* 转义会触发 marked 语法的字符。
   注意 \ 要放最前，避免把后来的 \* 里的 \ 又转一遍。 */
const MD_ESC_RE = /[\\`*_[\]()]/g;
function escMd(s) {
  return String(s).replace(MD_ESC_RE, '\\$&');
}

function splitJSON(text) {
  const t = String(text || '').trim();
  let v;
  try { v = JSON.parse(t); }
  catch (e) { throw new Error('不是合法的 JSON：' + e.message); }

  if (v && typeof v === 'object') {
    if (Array.isArray(v.messages)) return [v];                        // 单 chat
    if (v.chats && Array.isArray(v.chats.list)) return v.chats.list;  // 全账户
  }
  throw new Error('不认识的 Telegram 导出格式');
}

/* ---------- text 字段 → 纯文本 ---------- */

function flattenText(t) {
  if (typeof t === 'string') return t;
  if (!Array.isArray(t)) return '';
  let out = '';
  for (const part of t) {
    if (typeof part === 'string') { out += part; continue; }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text_link' && part.href) {
      out += '[' + (part.text || part.href) + '](' + part.href + ')';
    } else if (typeof part.text === 'string') {
      out += part.text;
    }
  }
  return out;
}

/* ---------- 附件占位 ---------- */

function isRealPath(s) {
  return typeof s === 'string' && s && !/^\(File not included/.test(s);
}

function buildBody(m, showSender) {
  let body = flattenText(m.text);

  if (isRealPath(m.photo)) {
    const line = '[图片] ' + m.photo;
    body = body ? body + '\n\n' + line : line;
  }

  if (isRealPath(m.file_name)) {
    const tag = m.media_type === 'sticker'
      ? '[贴纸' + (m.sticker_emoji ? ' ' + m.sticker_emoji : '') + '] '
      : '📎 ';
    const line = tag + m.file_name;
    body = body ? body + '\n\n' + line : line;
  }

  if (showSender && m.from) {
    body = '**' + escMd(m.from) + '**\n' + body; 
  }
  return body;
}

/* ---------- 时间 ---------- */

function parseTime(m) {
  const n = Number(m.date_unixtime);
  if (Number.isFinite(n) && n > 0) return n * 1000;   // 秒 → 毫秒
  const t = Date.parse(m.date);
  return Number.isFinite(t) ? t : 0;
}

/* ---------- 单个 chat ---------- */

function parseOneChat(chat) {
  const all = Array.isArray(chat.messages) ? chat.messages : [];
  const messages = all.filter(m => m && m.type === 'message');
  if (!messages.length) return null;

  const senders = new Set(messages.map(m => m.from).filter(Boolean));
  const showSender = senders.size > 1;
  const tz = -new Date().getTimezoneOffset();

  /* 1. 每条 TG 消息 → 一个 entry */
  const entries = messages.map(m => ({
    id: uid(),
    text: buildBody(m, showSender),
    createdAt: parseTime(m),
    edited: !!m.edited,
    editedAt: m.edited_unixtime ? Number(m.edited_unixtime) * 1000 : null,
    _tzOffset: tz,
  }));

  /* 2. 建立 tg id → entry 的映射，供 reply 用 */
  const byTgId = new Map();
  messages.forEach((m, i) => {
    if (m.id != null) byTgId.set(String(m.id), entries[i]);
  });

  /* 3. reply_to_message_id → _replyTo
        runtime 会在写盘阶段把它变成 `> 引用原文\n> [[~tid#^bid]]` 头 */
  messages.forEach((m, i) => {
    if (m.reply_to_message_id == null) return;
    const tgt = byTgId.get(String(m.reply_to_message_id));
    if (tgt && tgt !== entries[i]) entries[i]._replyTo = tgt;
  });

  const title = String(chat.name || '').trim() || 'Telegram 对话';
  const root = finalizeFlatTopic(entries, {
    title,
    sourceCreatedAt: NaN,
  });

  if (!root.entries.length) return null;
  return {
    title,
    sourceId: chat.id != null ? String(chat.id) : null,
    sourceCreatedAt: null,
    root,
  };
}

/* ---------- 顶层 API ---------- */

export function parseTelegramExport(jsonText) {
  const raw = splitJSON(jsonText);
  const convs = [];

  for (const chat of raw) {
    if (!chat || typeof chat !== 'object') continue;
    const conv = parseOneChat(chat);
    if (!conv) {
      console.warn('[import-telegram] 跳过：没有消息', chat.name);
      continue;
    }
    convs.push(conv);
    console.log('[import-telegram]', conv.title, '→',
                countEntries(conv.root), '条');
  }

  if (!convs.length) throw new Error('文件里没有任何有效的对话');
  return convs;
}

export function importTelegramAsTopics(parentDir, conversations, report) {
  return importAsTopics(parentDir, conversations, 'telegram', report);
}