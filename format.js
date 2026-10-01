// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= format.js =================
 * 时间 / 日期的格式化与解析。
 *
 * 两个方向：
 *   毫秒 → 字符串    fmtStamp / fmtTime / fmtDay / monthKey / imgStamp
 *   字符串 → 毫秒    parseStampToMs / parseStamp
 *
 * 文件名相关：monthKey / monthFileName / MONTH_RE 必须保持同步。
 * 纯函数，无外部依赖。
 */

/* ---------- 毫秒 → 字符串 ---------- */

/* 本地时间字符串，不带时区 —— 用于文件名、回收站目录名 */
/* format.js —— 新增 */

/* entry 正文的转义。写盘唯一入口。
 * 顺序：先保护已有的 \#，再转义行首 #。
 * 顺序不能反 —— 反了会把 "\\#foo" 里的 "\#" 也二次转义。 */
/* 从 'YYYY-MM-DD HH:mm:ss.mmm [+HH:MM]' 或含该前缀的任意字符串里
 * 截出 blockId 形式：'YYYY-MM-DD_HH-mm-ss-mmm'。
 * 用于 entryBlockId 从 _writeStamp 派生。 */
function stampToBlockId(s) {
  if (!s) return null;
  const m = String(s).match(
    /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/
  );
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3] + '_' +
         m[4] + '-' + m[5] + '-' + m[6] + '-' +
         (m[7] ? m[7].padEnd(3, '0') : '000');
}
function escapeEntryBody(t) {
  return String(t)
    .replace(/\\#/g, '\\\\#')   // 1. 保护既有的 \#
    .replace(/^#/gm, '\\#');    // 2. 转义行首 #
}
/* ============================================================
 * 时区 / 引用 ID —— 所有时间戳转换的唯一入口
 * ============================================================ */

/* 从字符串里提取时区偏移（分钟，东区为正）。
 * 无后缀 → null；'Z' → 0。 */
function tzOffsetFromStamp(s) {
  if (!s) return null;
  const m = String(s).match(/(Zz|[+-]\d{2}:?\d{2})\s*$/);
  if (!m) return null;
  if (m[1].toUpperCase() === 'Z') return 0;
  const sign = m[1][0] === '+' ? 1 : -1;
  const hh = parseInt(m[1].slice(1, 3), 10);
  const mm = parseInt(m[1].slice(3).replace(':', ''), 10) || 0;
  return sign * (hh * 60 + mm);
}

/* 毫秒 + 时区偏移 → 'YYYY-MM-DD HH:mm:ss.mmm±HH:MM' */
function fmtStampAtTz(ms, tzMin) {
  const d = new Date(ms + tzMin * 60000);
  const p = n => String(n).padStart(2, '0');
  const sign = tzMin >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(tzMin) / 60));
  const om = p(Math.abs(tzMin) % 60);
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + '.' +
         String(d.getUTCMilliseconds()).padStart(3, '0') + sign + oh + ':' + om;
}

/* 毫秒 → 'YYYY-MM-DD_HH-mm-ss-mmm'（本地时区字段）。
 * blockId 的 fallback 与 topicRefId 共用同一构造。 */
function localIdFromMs(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' +
         p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()) + '-' +
         String(d.getMilliseconds()).padStart(3, '0');
}

/* 原始导出时间戳 → 归一化字符串。
 *   '2025-02-11T09:42:22.399000+08:00'
 *   → '2025-02-11 09:42:22.399+08:00'
 * 非法输入返回 null。 */
function normalizeRawStamp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace('T', ' ');

  const tzm = s.match(/(Z|[+-]\d{2}:?\d{2})\s*$/i);
  let tz = '';
  if (tzm) {
    tz = /^z$/i.test(tzm[1]) ? 'Z'
       : tzm[1].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    s = s.slice(0, tzm.index).trim();
  }

  if (/\.\d+$/.test(s)) {
    s = s.replace(/\.(\d+)$/, (m, d) => '.' + d.padEnd(3, '0').slice(0, 3));
  } else {
    s += '.000';
  }

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(s)) return null;
  return s + tz;
}

/* entry → 写盘用时间戳字符串。
 * 优先 _rawStamp（保留原始时区与格式）；
 * 否则按 _tzOffset 或当前本地时区格式化。 */
function stampForWrite(e) {
  if (e._rawStamp) return e._rawStamp;
  const tz = (e._tzOffset != null) ? e._tzOffset : -new Date().getTimezoneOffset();
  return fmtStampAtTz(e.createdAt, tz);
}

/* entry → blockId（'YYYY-MM-DD_HH-mm-ss-mmm'）。
 * 优先 _writeStamp / _rawStamp（跨时区稳定）；
 * fallback 到 createdAt 的本地字段。
 * 整个引用系统里 blockId 的唯一来源。 */
function entryBlockId(e) {
  const s = e._writeStamp || e._rawStamp;
  if (s) {
    const b = stampToBlockId(s);
    if (b) return b;
  }
  return localIdFromMs(e.createdAt);
}

/* 话题 createdAt 字符串 → 引用 ID。
 * 与 md.js:topicRefId 同构 —— 后者从 _话题.json 里
 * fmtStamp() 写入的字符串中截出本地时间字段。 */
function topicRefIdFromStamp(s) {
  if (!s) return null;
  const m = String(s).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/
  );
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3] + '_' + m[4] + '-' + m[5] + '-' +
         (m[6] || '00') + '-' + (m[7] ? m[7].padEnd(3, '0') : '000');
}
/* entry 正文的反解。读盘唯一入口。
 * 顺序恰好是写的逆：先还原行首，再还原保护。 */
function unescapeEntryBody(t) {
  return String(t)
    .replace(/^\\#/gm, '#')     // 1. 还原行首 #
    .replace(/\\\\#/g, '\\#');  // 2. 还原被保护的 \#
}
function fmtStampLocal(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
}

/* 带时区偏移 —— 用于记录头、引用、回收站条目里的可读时间 */
function fmtStamp(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();           /* 分钟，东区为正 */
  const sign = off >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return fmtStampLocal(ts) + sign + oh + ':' + om;
}

/* HH:mm */
function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0');
}

/* 完整中文日期时间 —— 用于「编辑于 ...」的 tooltip */
function fmtFull(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* 日期分组的 key —— 用于 day-chip 的去重判断 */
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

/* 人类读的日期 —— 今天 / 昨天 / 9月17日 周三 / 2025年 9月17日 周三 */
function fmtDay(ts) {
  const d = new Date(ts), t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 864e5
  );
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  const wk = '日一二三四五六'[d.getDay()];
  let s = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wk;
  if (d.getFullYear() !== t.getFullYear()) s = d.getFullYear() + '年 ' + s;
  return s;
}

/* 月份 key 'YYYY-MM' */
function monthKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/* 月文件名 —— 必须与 MONTH_RE 保持同步 */
function monthFileName(mk) { return '_记录-' + mk + '.md'; }
const MONTH_RE = /^_记录-(\d{4}-\d{2})\.md$/;

/* 图片文件名里的短时间戳：YYYYMMDD-HHmmss */
function imgStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* ---------- 字符串 → 毫秒 ---------- */

/*
 * 统一的"戳 → 毫秒"解析，新老格式都能吃。
 * tz 为空（undefined / null / 空串）→ 按本地时间解析。
 */
function parseStampToMs(y, mo, d, h, mi, s, msStr, tz) {
  const ms = msStr ? Number(msStr.padEnd(3, '0')) : 0;
  const ss = s ? String(+s).padStart(2, '0') : '00';
  if (tz) {
    const tzn = (typeof tz === 'string' && tz.toUpperCase() === 'Z')
    ? 'Z'
    : (tz.includes(':') ? tz : tz.slice(0, 3) + ':' + tz.slice(3));
    return Date.parse(
      y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + ss + '.' +
      String(ms).padStart(3, '0') + tzn
    );
  }
  return new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0, ms).getTime();
}

/*
 * 宽松解析 —— 从各种格式的字符串里抓时间戳。
 * 匹配不到返回 null。
 * 用于：旧格式的 _置顶.json / _折叠.json / 回收站条目。
 */
function parseStamp(s) {
  const m = String(s).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?\s*([Zz]|[+-]\d{2}:?\d{2})?/
  );
  if (!m) return null;
  return parseStampToMs(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
}

export {
  fmtStampLocal,
  fmtStamp,
  fmtTime,
  fmtFull,
  dayKey,
  fmtDay,
  monthKey,
  monthFileName,
  MONTH_RE,
  imgStamp,
  parseStampToMs,
  parseStamp,
  escapeEntryBody,
  unescapeEntryBody,
  stampToBlockId,
  /* 新增 */
  tzOffsetFromStamp, fmtStampAtTz, localIdFromMs,
  normalizeRawStamp, stampForWrite, entryBlockId, topicRefIdFromStamp,
};