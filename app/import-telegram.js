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
  /* 只合并“连续”的 grouped_id。
     Telegram 相册本身是连续的；这样流式解析可以边读边合并，
     不会把被其它消息插开的同 id 消息错误吞成一个相册。 */
  const units = [];
  let lastGid = null;
  let cur = null;
  for (const m of messages) {
    const gid = m.grouped_id != null ? String(m.grouped_id) : null;
    if (gid && gid === lastGid && cur) {
      cur.msgs.push(m);
      continue;
    }
    cur = { msgs: [m] };
    units.push(cur);
    lastGid = gid;
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

/* Telegram 导出里"已注销 / 不可见"的发送者：
   - from: null（账号注销后导出不给名字，只剩 from_id）
   - 占位名字："Deleted Account" / "此用户已注销" 等
   统一成一个可识别的占位发送者，避免这些消息在导入后丢掉发送者归属。 */
const SENDER_UNKNOWN = '（已注销账号）';
const DELETED_SENDER_NAMES = new Set([
  'deleted account', 'deleted', '此用户已注销', '已注销账号', '已注销', '未知用户',
]);

function senderNameOf(m) {
  const raw = String((m && m.from) || '').trim();
  if (!raw) return SENDER_UNKNOWN;
  if (DELETED_SENDER_NAMES.has(raw.toLowerCase())) return SENDER_UNKNOWN;
  return raw;
}

/* 相册里取第一个有名字的发送者；整组都没有名字才用占位 */
function unitSender(unit) {
  for (const m of unit.msgs) {
    const name = senderNameOf(m);
    if (name !== SENDER_UNKNOWN) return name;
  }
  return SENDER_UNKNOWN;
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
  const from = unitSender(unit);
  if (showSender) {
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

/* Telegram service 消息 → 一行可读文本。
   有 text 用 text；没有就按 action 生成中文说明；识别不了的至少保留 action。 */
const SERVICE_PHRASES = {
  create_channel: '创建了频道',
  create_group: '创建了群组',
  edit_group_photo: '更新了群头像',
  delete_group_photo: '删除了群头像',
  change_title: '修改了群名',
  join_group_by_link: '通过链接加入了群组',
  join_group_by_request: '通过申请加入了群组',
  leave_group: '离开了群组',
  remove_members: '移除了成员',
  invite_members: '邀请了成员',
  call: '发起了通话',
  migrate_to_supergroup: '升级为超级群',
  migrate_from_group: '从群组迁移',
  set_message_ttl: '设置了消息自动删除',
  delete_auto_delete_timer: '关闭了消息自动删除',
  send_star_gift: '赠送了礼物',
};

function serviceText(m) {
  const text = m.text ? flattenText(m.text).trim() : '';
  if (text) return text;
  const phrase = SERVICE_PHRASES[m.action];
  const title = String(m.title || m.new_title || '').trim();
  const actor = String(m.actor || '').trim();
  if (!phrase) return m.action ? ('系统事件：' + m.action) : '';
  let line = phrase + (title ? '「' + title + '」' : '');
  return actor ? (actor + ' ' + line) : line;
}

function isPinService(m) {
  return m && m.type === 'service' &&
    (m.action === 'pin_message' || m.action === 'unpin_message');
}

function makeSystemEntry(m, tz) {
  const line = serviceText(m);
  if (!line) return null;
  return {
    id: uid(),
    text: ':::system\n' + line + '\n:::',
    createdAt: parseTime(m),
    edited: false,
    editedAt: null,
    _tzOffset: tz,
  };
}

/* ---------- 单个 chat ---------- */

function parseOneChat(chat) {
  const all = Array.isArray(chat.messages) ? chat.messages : [];
  const messages = all.filter(m => m && m.type === 'message');
  /* 置顶/取消置顶是 service 消息，不在 messages 里；单独收集，等 entry 建好后按
     Telegram 的 message_id 映射成 entry.createdAt 写进 _置顶.json。 */
  const pinEvents = all.filter(m => m && m.type === 'service' &&
    (m.action === 'pin_message' || m.action === 'unpin_message'));
  if (!messages.length) return null;

  const senders = new Set(messages.map(senderNameOf));
  const showSender = senders.size > 1;
  const tz = -new Date().getTimezoneOffset();
  const serviceEntries = all
    .filter(m => m && m.type === 'service' && !isPinService(m))
    .map(m => makeSystemEntry(m, tz))
    .filter(Boolean);

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
  for (const se of serviceEntries) entries.push(se);
  const root = finalizeFlatTopic(entries, {
    title,
    sourceCreatedAt: NaN,
  });
  root._importPins = resolvePins(pinEvents, byTgId);

  if (!root.entries.length) return null;
  return {
    title,
    sourceId: chat.id != null ? String(chat.id) : null,
    sourceCreatedAt: null,
    root,
  };
}

/* ---------- 流式解析（避免 file.text() + JSON.parse 的峰值） ----------
 *
 * Telegram 导出是 `{ ..., "messages": [ {...}, {...} ] }`。
 * 边读 Blob 流边按对象切分 messages，逐条交给 builder 转成 entry；
 * 内存里只保留 entry + 当前一条消息，不再同时持有整个文件字符串
 * 和整棵 JSON 树。
 */

function jsonField(prefix, key, asNumber) {
  const src = String(prefix || '');
  const re = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[-0-9.]+)');
  const m = re.exec(src);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return asNumber ? Number(v) : v;
  } catch (e) { return null; }
}

/* 从 buffer[0] 的 `{` 找到配对的 `}`（字符串内的括号不算）。
   返回结束位置（不含），不完整返回 -1。 */
function findObjectEnd(s) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
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

/* Telegram 的置顶事件 → 本应用 _置顶.json 里的 createdAt 数组。
   现在按“多置顶”处理：pin 追加，unpin 移除；同一目标只保留一次。
   pin 的目标不可见（被删/占位）时忽略，但不清掉其它置顶。 */
function resolvePins(events, byTgId) {
  const out = [];
  for (const ev of events || []) {
    if (ev.message_id == null) continue;
    const tgt = byTgId.get(String(ev.message_id));
    if (!tgt) continue;
    const ms = tgt.createdAt;
    const at = out.indexOf(ms);
    if (ev.action === 'pin_message') {
      if (at < 0) out.push(ms);
    } else if (at >= 0) {
      out.splice(at, 1);
    }
  }
  return out;
}

function createChatBuilder(chat) {
  const senders = new Set();
  const entries = [];
  const byTgId = new Map();
  const pinEvents = [];
  const serviceEntries = [];

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

  let pendingAlbum = null;

  function pushUnit(unit) {
    const built = buildUnit(unit, false, targetFor);
    if (!built.text.trim()) return;
    const editedAt = Math.max(0, ...unit.msgs.map(m =>
      m.edited_unixtime ? Number(m.edited_unixtime) * 1000 : 0));
    const e = {
      id: uid(),
      text: built.text,
      createdAt: unitTime(unit),
      edited: unit.msgs.some(m => !!m.edited),
      editedAt: editedAt || null,
      _tzOffset: -new Date().getTimezoneOffset(),
      _sender: unitSender(unit),
    };
    if (built.copies && built.copies.length) e._copy = built.copies;
    /* 只留回复 id，不把整条原始消息留在内存里——峰值来自这里 */
    const replying = unit.msgs.find(m => m.reply_to_message_id != null);
    if (replying) e._replyMsgId = String(replying.reply_to_message_id);
    entries.push(e);
    for (const m of unit.msgs) if (m.id != null) byTgId.set(String(m.id), e);
  }

  return {
    add(m) {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'service') {
        if (isPinService(m)) pinEvents.push(m);
        else {
          const se = makeSystemEntry(m, -new Date().getTimezoneOffset());
          if (se) serviceEntries.push(se);
        }
        return;
      }
      if (m.type !== 'message') return;
      senders.add(senderNameOf(m));

      const gid = m.grouped_id != null ? String(m.grouped_id) : null;
      if (gid) {
        if (pendingAlbum && pendingAlbum.gid === gid) {
          pendingAlbum.unit.msgs.push(m);
          return;
        }
        if (pendingAlbum) pushUnit(pendingAlbum.unit);
        pendingAlbum = { gid, unit: { msgs: [m] } };
        return;
      }
      if (pendingAlbum) { pushUnit(pendingAlbum.unit); pendingAlbum = null; }
      pushUnit({ msgs: [m] });
    },

    finish() {
      if (pendingAlbum) { pushUnit(pendingAlbum.unit); pendingAlbum = null; }

      const showSender = senders.size > 1;
      if (showSender) {
        for (const e of entries) {
          const safe = String(e._sender || SENDER_UNKNOWN).replace(/[\r\n]+/g, ' ');
          e.text = '**' + escMd(safe) + '**\n' + e.text;
        }
      }
      for (const e of entries) delete e._sender;

      for (const e of entries) {
        if (e._replyMsgId == null) continue;
        const tgt = byTgId.get(e._replyMsgId);
        if (tgt && tgt !== e) e._replyTo = tgt;
        else e.text = '> [引用的原消息不可见或已被删除]\n\n' + e.text;
        delete e._replyMsgId;
      }

      const title = String(chat.name || '').trim() || 'Telegram 对话';
      for (const se of serviceEntries) entries.push(se);
      const root = finalizeFlatTopic(entries, { title, sourceCreatedAt: NaN });
      root._importPins = resolvePins(pinEvents, byTgId);
      if (!root.entries.length) return null;
      return {
        title,
        sourceId: chat.id != null ? String(chat.id) : null,
        sourceCreatedAt: null,
        root,
      };
    },
  };
}

/**
 * 流式解析 Telegram 导出。只支持单 chat（最常见的 result.json / chat.json）。
 * 返回与 parseTelegramExport 相同结构的 conversations。
 *
 * @param {Blob|File} blob
 * @param {(n:number)=>void} [onProgress]  每 500 条回调一次
 */
export async function parseTelegramStream(blob, onProgress) {
  if (!blob || typeof blob.stream !== 'function') {
    throw new Error('当前环境不支持流式读取');
  }
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let builder = null;
  let chat = null;
  let count = 0;

  async function readMore() {
    const { value, done } = await reader.read();
    if (done) return false;
    buf += decoder.decode(value, { stream: true });
    return true;
  }

  /* 1. 找到顶层 "messages": [ */
  while (!builder) {
    const hit = /"messages"\s*:\s*\[/.exec(buf);
    if (hit) {
      chat = {
        name: jsonField(buf.slice(0, hit.index), 'name'),
        id: jsonField(buf.slice(0, hit.index), 'id', true),
      };
      buf = buf.slice(hit.index + hit[0].length);
      builder = createChatBuilder(chat);
      break;
    }
    if (!(await readMore())) throw new Error('没有找到 messages 数组');
    /* 防止把整个文件都读进来：正常 Telegram 头部只有几百字节 */
    if (buf.length > 8 * 1024 * 1024) throw new Error('Telegram 头部异常长');
  }

  /* 2. 逐个对象切 messages 数组 */
  for (;;) {
    while (buf.length && (buf[0] === ',' || /\s/.test(buf[0]))) buf = buf.slice(1);
    if (!buf.length) {
      if (!(await readMore())) break;
      continue;
    }
    if (buf[0] === ']') {               /* messages 数组结束 */
      break;
    }
    if (buf[0] !== '{') throw new Error('messages 里出现非对象元素');
    const end = findObjectEnd(buf);
    if (end < 0) {
      if (!(await readMore())) throw new Error('JSON 不完整');
      continue;
    }
    const raw = buf.slice(0, end);
    buf = buf.slice(end);
    let m;
    try { m = JSON.parse(raw); }
    catch (e) { throw new Error('单条消息 JSON 无效：' + e.message); }
    builder.add(m);
    count++;
    if (onProgress && count % 500 === 0) onProgress(count);
  }

  try { await reader.cancel(); } catch (e) {}
  const conv = builder.finish();
  if (!conv) throw new Error('文件里没有任何有效的对话');
  return [conv];
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