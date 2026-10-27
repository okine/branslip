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
 * 附件：可选随消息复制文件。
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
      // ★ 修复：防止链接文字里的 [ ] ( ) 破坏 Markdown 链接结构
      const txt = String(part.text || part.href).replace(/[\[\]()]/g, '\\$&');
      out += '[' + txt + '](' + part.href + ')';
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

function photoLine(photo) {
  const p = String(photo).replace(/\\/g, '/');
  // 取文件名，空格换下划线，防止 Markdown 图片正则被截断
  const name = p.split('/').pop().replace(/\s+/g, '_');
  return '![](attachments/' + name + ')';
}

function fileLine(m) {
  const tag = m.media_type === 'sticker'
    ? '[贴纸' + (m.sticker_emoji ? ' ' + m.sticker_emoji : '') + '] '
    : '📎 ';
  return tag + m.file_name;
}

/* ★ Telegram 导出把"一条带多张图的消息"（相册）拆成多条
   共享 grouped_id 的消息。这里按 grouped_id 合并成一个单元，
   否则发 4 张图会变成 4 条独立记录。 */
function groupUnits(messages) {
  const units = [];
  const byGroup = new Map();
  for (const m of messages) {
    const gid = m.grouped_id != null ? String(m.grouped_id) : null;
    if (gid) {
      const u = byGroup.get(gid);
      if (u) { u.msgs.push(m); continue; }
      const nu = { msgs: [m] };
      byGroup.set(gid, nu);
      units.push(nu);
    } else {
      units.push({ msgs: [m] });
    }
  }
  return units;
}

/* 附件目标名：去掉空格/括号等会让 Markdown 图片正则截断的字符 */
function safeStickerName(src) {
  const base = String(src).replace(/\\/g, '/').split('/').pop() || 'sticker';
  return base.replace(/[^\w.\-]+/g, '_').replace(/_+\./g, '.').replace(/^_+|_+$/g, '') || 'sticker';
}

/* 贴纸：静态图用原文件，动画（tgs/webm）用 _thumb.jpg；两者都没有就退化成 emoji 块 */
function stickerParts(m) {
  if (m.media_type !== 'sticker' && !m.sticker_emoji) return null;
  const emoji = String(m.sticker_emoji || '贴纸').trim() || '贴纸';
  const animated = /^(application\/x-tgsticker|video\/)/i.test(m.mime_type || '');
  const isImage = /^image\//i.test(m.mime_type || '');
  const file = isRealPath(m.file) ? m.file : null;
  const thumb = isRealPath(m.thumbnail) ? m.thumbnail : null;
  const src = animated ? thumb : (file || thumb);
  let name = '';
  if (src) {
    name = safeStickerName(src);
    if (!/\.[A-Za-z0-9]+$/.test(name)) {
      name += /^image\/png/i.test(m.mime_type || '') ? '.png'
            : /^image\/jpe?g/i.test(m.mime_type || '') ? '.jpg'
            : '.webp';
    }
  }
  if (!src) return { line: ':::sticker ' + emoji + ':::' };
  return { line: '![sticker:' + emoji + '](attachments/' + name + ')', src, name };
}

/* 一条记录（可能是相册）的正文 + 需要复制的附件清单 */
function buildUnit(unit, showSender, targetFor) {
  const parts = [];
  const copies = [];
  const seen = new Set();
  for (const m of unit.msgs) {
    const t = flattenText(m.text).trimEnd();
    if (t) parts.push(t);

    const st = stickerParts(m);
    if (st) {
      parts.push(st.line);
      if (st.src) {
        const target = targetFor(st.src, st.name);
        if (!seen.has(target)) { seen.add(target); copies.push({ source: st.src, target }); }
      }
      continue;                       /* 贴纸不再走下面的 📎 文本 */
    }

    if (isRealPath(m.photo)) parts.push(photoLine(m.photo));
    if (isRealPath(m.file_name)) parts.push(fileLine(m));
  }
  let body = parts.join('\n\n');
  const from = unit.msgs[0].from;
  if (showSender && from) {
    const safeFrom = String(from).replace(/[\r\n]+/g, ' ');
    body = '**' + escMd(safeFrom) + '**\n' + body;
  }
  return { text: body, copies };
}

/* 相册时间 = 最早一条；编辑标记取任意一条 + 最晚编辑时间 */
function unitTime(unit) {
  let best = 0;
  for (const m of unit.msgs) {
    const t = parseTime(m);
    if (t && (!best || t < best)) best = t;
  }
  return best;
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

  /* 1. 一个单元（单条消息 / 一整组相册）→ 一个 entry；
        既没有文字、也没有附件的纯占位单元直接跳过。 */
  const units = groupUnits(messages);
  const entries = [];
  const kept = [];                    /* { unit, e }，只含保留下来的单元 */
  const byTgId = new Map();

  /* 附件目标名：同一源文件只复制一次；不同源文件撞名加 _2/_3 */
  const targetBySource = new Map();
  const usedTargets = new Set();
  const targetFor = (src, name) => {
    if (targetBySource.has(src)) return targetBySource.get(src);
    const base = name || safeStickerName(src);
    let target = base, i = 2;
    while (usedTargets.has(target)) {
      const dot = base.lastIndexOf('.');
      target = dot > 0
        ? base.slice(0, dot) + '_' + i + base.slice(dot)
        : base + '_' + i;
      i++;
    }
    usedTargets.add(target);
    targetBySource.set(src, target);
    return target;
  };

  for (const unit of units) {
    const built = buildUnit(unit, showSender, targetFor);
    if (!built.text.trim()) continue;
    const editedAt = Math.max(0, ...unit.msgs.map(m =>
      m.edited_unixtime ? Number(m.edited_unixtime) * 1000 : 0));
    const e = {
      id: uid(),
      text: built.text,
      createdAt: unitTime(unit),
      edited: unit.msgs.some(m => !!m.edited),
      editedAt: editedAt || null,
      _tzOffset: tz,
    };
    if (built.copies && built.copies.length) e._copy = built.copies;
    entries.push(e);
    kept.push({ unit, e });
    /* 组内任何一条消息的 id 都指向同一条记录，回复任意一张图也能链上 */
    for (const m of unit.msgs) if (m.id != null) byTgId.set(String(m.id), e);
  }

  /* 2. reply_to_message_id → _replyTo
        runtime 会在写盘阶段把它变成 `> 引用原文\n> [[~tid#^bid]]` 头 */
  for (const { unit, e } of kept) {
    const replying = unit.msgs.find(m => m.reply_to_message_id != null);
    if (!replying) continue;
    const tgt = byTgId.get(String(replying.reply_to_message_id));
    if (tgt && tgt !== e) {
      e._replyTo = tgt;
    } else {
      // 目标不存在（service 消息、被删消息、或被上面跳过的占位消息）：
      // 拿不到 entry 对象，用纯文本前缀兜底，至少让读者知道这是回复。
      e.text = '> [引用的原消息不可见或已被删除]\n\n' + e.text;
    }
  }

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

export function importTelegramAsTopics(parentDir, conversations, report, opts) {
  return importAsTopics(parentDir, conversations, 'telegram', report, opts);
}