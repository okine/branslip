'use strict';
/* ================= import-qq.js =================
 * QQ 消息记录（QQChatExporter JSON）→ 时枝笺话题。
 *
 * 源格式（https://github.com/shuakami/qq-chat-exporter）：
 *   {
 *     chatInfo: { name, type, selfUid, selfUin, peerUid },
 *     messages: [
 *       { id, timestamp, sender: {uid,name,nickname},
 *         type, content: {text, elements}, recalled, system },
 *       ...
 *     ]
 *   }
 *
 * 消息 type 取值：text / system / type_17 / forward / json / reply
 *
 * 语义：
 *   - 一个 chat = 一个话题；消息线性时间流，没有分支
 *   - 所有条目都是「user」——QQ 里没有 assistant 角色
 *   - 群聊多发送者 → 每条前加 **名字**；系统消息不加
 *   - reply 类型 → 若被引用消息也在此次导出里，走 _replyTo；
 *     否则退化成内联 `> 引用原文` 引用头
 */

import { uid } from './utils.js';
import {
  finalizeFlatTopic, importAsTopics, countEntries,
} from './import-runtime.js';

/* ---------- Markdown 转义 ---------- */

const MD_ESC_RE = /[\\`*_[\]()]/g;
function escMd(s) {
  return String(s).replace(MD_ESC_RE, '\\$&');
}

/* ---------- 顶层 JSON 解析 ---------- */

function parseJSON(text) {
  const t = String(text || '').trim();
  let v;
  try { v = JSON.parse(t); }
  catch (e) { throw new Error('不是合法的 JSON：' + e.message); }

  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray(v.messages)) return [v];
  throw new Error('不是 QQChatExporter 导出的格式');
}

/* ---------- 单条消息 → 纯文本 ---------- */

function renderText(msg) {
  let text = (msg.content && msg.content.text) || '';

  /* "[回复消息]" 前缀去掉——引用交给 _replyTo / 内联引用单独处理 */
  text = text.replace(/^\[回复消息\]/, '');

  /* "[图片:xxx.jpg]" → 独立一行 📎 xxx.jpg */
  text = text.replace(/\[图片:([^\]]+)\]/g, '\n📎 $1\n');

  /* 折叠多余空行 */
  text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');

  return text;
}

function findReplyData(msg) {
  const els = (msg.content && msg.content.elements) || [];
  for (const el of els) {
    if (el && el.type === 'reply' && el.data) return el.data;
  }
  return null;
}

/* ---------- messages → entries ---------- */

/* ---------- 发送者 ---------- */

/* 已注销 / 不可见账号：QQ 导出里可能 name 为空 */
const SENDER_UNKNOWN = '（已注销账号）';
const DELETED_SENDER_NAMES = new Set([
  'deleted account', 'deleted', '此用户已注销', '已注销账号', '已注销', '未知用户',
]);

function senderNameOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return SENDER_UNKNOWN;
  if (DELETED_SENDER_NAMES.has(s.toLowerCase())) return SENDER_UNKNOWN;
  return s;
}

function messagesToEntries(messages) {
  const entries = [];
  const byId = new Map();
  const senders = new Set();
  const tz = -new Date().getTimezoneOffset();

  /* 第一遍：造 entry，记录回复关系 */
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.recalled) continue;

    const isSystem = msg.system === true || msg.type === 'system';
    const senderName = isSystem
      ? ''
      : senderNameOf(msg.sender && msg.sender.name);

    const text = renderText(msg);
    if (!text) continue;

    if (senderName) senders.add(senderName);

    const entry = {
      id: uid(),
      /* QQ 系统消息用 ::system 块保存，重载后仍能按服务消息渲染 */
      text: isSystem ? (':::system\n' + text.trim() + '\n:::') : text,
      createdAt: Number(msg.timestamp) || 0,
      edited: false,
      editedAt: null,
      _tzOffset: tz,
      _msgId: String(msg.id),
      _senderName: senderName,
    };
    entries.push(entry);
    if (entry._msgId) byId.set(entry._msgId, entry);

    const replyData = findReplyData(msg);
    if (replyData) entry._replyData = replyData;
  }

  /* 第二遍：回复解析 + 发送者前缀 */
  const showSender = senders.size > 1;

  for (const e of entries) {
    let body = e.text;

    if (e._replyData) {
      const refId = String(e._replyData.referencedMessageId
                      || e._replyData.messageId || '');
      const tgt = refId ? byId.get(refId) : null;

      if (tgt && tgt !== e) {
        /* 被引用消息也在本次导出里 → 走 runtime 的引用头 */
        e._replyTo = tgt;
      } else {
        /* 找不到目标 → 内联引用原文 */
        const who = String(e._replyData.senderName || '').trim();
        const what = String(e._replyData.content || '').trim();
        body = '> ' + (who ? who + ': ' : '') + what + '\n\n' + body;
      }
      delete e._replyData;
    }

    if (showSender && e._senderName) {
      body = '**' + escMd(e._senderName) + '**\n' + body;
    }

    e.text = body;
    delete e._msgId;
    delete e._senderName;
  }

  return entries;
}

/* ---------- 顶层 API ---------- */

export function parseQQExport(jsonText) {
  const arr = parseJSON(jsonText);
  const convs = [];

  for (const data of arr) {
    if (!data || typeof data !== 'object') continue;

    const chatInfo = data.chatInfo || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];

    if (!messages.length) {
      console.warn('[import-qq] 跳过：没有 messages', chatInfo.name);
      continue;
    }

    const title = String(chatInfo.name || '').trim() || 'QQ 对话';
    const entries = messagesToEntries(messages);

    if (!entries.length) {
      console.warn('[import-qq] 跳过：没有任何内容', title);
      continue;
    }

    const root = finalizeFlatTopic(entries, {
      title,
      sourceCreatedAt: NaN,
    });

    convs.push({
      title,
      sourceId: chatInfo.peerUid != null ? String(chatInfo.peerUid) : null,
      sourceCreatedAt: null,
      root,
    });

    console.log('[import-qq]', title, '→', countEntries(root), '条');
  }

  if (!convs.length) throw new Error('文件里没有任何有效的对话');
  return convs;
}

export function importQQAsTopics(parentDir, conversations, report, opts) {
  return importAsTopics(parentDir, conversations, 'qq', report, opts);
}