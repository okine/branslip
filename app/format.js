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
 *
 * 优先级：_writeStamp > _rawStamp > 按 _tzOffset / 当前本地时区格式化。
 *
 * _writeStamp 一旦冻结就是"磁盘上那一串"的唯一副本：
 *   - 新建条目时 composer 会显式写入；
 *   - 读盘时 parseEntries 会从 ## 行还原。
 * 重写整个月份文件（编辑 / 删除 / 重命名 / 迁移）时如果跳过它、改用
 * "当前时区"重算，那么换时区或跨过夏令时后，同一个 createdAt 会格式化出
 * 不同的墙上时间；下次启动 parseEntries 得到的 _writeStamp 随之改变，
 * entryBlockId 也就变了，所有 [[~tid#^bid]] 引用全部断链。
 * 所以这里必须优先复用已经冻结的字符串，绝不能重新推导。
 */
function stampForWrite(e) {
  if (e._writeStamp) return e._writeStamp;
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

/* 按条目自己的时区格式化 HH:mm:ss —— 变体翻页条用 */
function fmtTimeOfEntry(e) {
  const off = entryTzOffset(e);
  const d = new Date(e.createdAt + off * 60000);
  const p = n => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

/* 按条目自己的时区显示日期（今天/昨天/几月几日） */
function fmtDayOfEntry(e) {
  return fmtDay(e.createdAt + entryTzOffset(e) * 60000);
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

/* 'YYYY-M-D'（M 从 0 起）→ 可比较的数值。
   不能直接字符串比较：'2026-9-x' > '2026-10-x' 会错。 */
   function dayKeyNum(k) {
    const [y, m, d] = String(k).split('-').map(Number);
    return y * 10000 + m * 100 + d;
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

/* ============================================================
 * 条目自己的时区（身份层）—— 月份/日期归属必须以它为准
 * ============================================================
 *
 * 为什么不能直接用 monthKey(createdAt)：
 *   它按**设备本地时区**取年月日，而磁盘上 `## ` 行写的是
 *   _writeStamp 自带的偏移。同一毫秒在上海写进 `_记录-2026-01.md`、
 *   在纽约再打开就会显示成 2025-12，文件归属和显示时间对不上。
 *
 * 规则：月份/日期归属 = `_writeStamp`（或 `_rawStamp`）里的**字面字段**；
 *   没有磁盘串时才退回 _tzOffset；再没有才用本地时区。
 */

/* 条目自带偏移（分钟，东区为正） */
function entryTzOffset(e) {
  const s = e && (e._writeStamp || e._rawStamp);
  if (s) {
    const tz = tzOffsetFromStamp(s);
    if (tz != null) return tz;
  }
  if (e && e._tzOffset != null) return e._tzOffset;
  return -new Date().getTimezoneOffset();
}

/* 月份归属：优先用磁盘串的 'YYYY-MM' 字面值 */
function monthKeyOfEntry(e) {
  if (!e) return monthKey(Date.now());
  const s = e._writeStamp || e._rawStamp;
  if (s) {
    const m = String(s).match(/^(\d{4})-(\d{2})/);
    if (m) return m[1] + '-' + m[2];
  }
  const off = entryTzOffset(e);
  const d = new Date(e.createdAt + off * 60000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/* 日期分组 key：同样按条目自己的偏移取年月日 */
function dayKeyOfEntry(e) {
  if (!e) return dayKey(Date.now());
  const s = e._writeStamp || e._rawStamp;
  if (s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return (+m[1]) + '-' + (+m[2] - 1) + '-' + (+m[3]);   /* 与 dayKey 同构（月从 0 起） */
  }
  const off = entryTzOffset(e);
  const d = new Date(e.createdAt + off * 60000);
  return d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate();
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

/* ============================================================
 * 记录时间戳计算（原 composer-time.js）
 * ============================================================ */

const CLOCK_DRIFT_WARN_MS = 30 * 1000;

export function nextCreatedAtMs(entries, now) {
  const last = entries[entries.length - 1];
  if (!last || now > last.createdAt) return { ms: now, drift: 0 };
  return { ms: last.createdAt + 1, drift: last.createdAt - now };
}

export const CLOCK_DRIFT_THRESHOLD = CLOCK_DRIFT_WARN_MS;

export {
  fmtStampLocal,
  fmtStamp,
  fmtTime,
  fmtFull,
  dayKey,
  fmtDay,
  monthKey,
  /* 条目级（按条目自己的时区归属）—— 写入月文件 / 日期分组必须用这两个 */
  monthKeyOfEntry,
  dayKeyOfEntry,
  fmtDayOfEntry,
  fmtTimeOfEntry,
  entryTzOffset,
  monthFileName,
  MONTH_RE,
  dayKeyNum,
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