// tests/format.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  /* 转义 */
  escapeEntryBody, unescapeEntryBody,
  /* blockId / topicRefId */
  stampToBlockId, topicRefIdFromStamp, localIdFromMs,
  /* 解析 */
  parseStampToMs, parseStamp, normalizeRawStamp,
  /* 格式化 */
  fmtStamp, fmtStampLocal, fmtFull, fmtTime,
  dayKey, fmtDay, monthKey, monthFileName, MONTH_RE, imgStamp,stampForWrite, entryBlockId,
  monthKeyOfEntry, dayKeyOfEntry,
} from '../format.js';


/* ---------- 转义 round-trip ---------- */

const rt = s => unescapeEntryBody(escapeEntryBody(s));

test('escape: 行首 #', () => {
  assert.equal(rt('#标题'),      '#标题');
  assert.equal(rt('# 标题'),     '# 标题');
  assert.equal(rt('正文\n# 标题\n尾'), '正文\n# 标题\n尾');
});

test('escape: 非行首 # 不动', () => {
  assert.equal(rt('a # b'),    'a # b');
  assert.equal(rt('C#'),       'C#');
  assert.equal(rt('   #缩进'), '   #缩进');  // 前面有空格不算行首
});

test('escape: 字面量反斜杠 + #', () => {
  assert.equal(rt('\\#'),          '\\#');
  assert.equal(rt('\\# 不是标题'), '\\# 不是标题');
  assert.equal(rt('\\\\#'),        '\\\\#');       // 2 反斜杠
  assert.equal(rt('\\\\\\#'),      '\\\\\\#');     // 3 反斜杠
});

test('escape: 行首字面量反斜杠 + #', () => {
  /* 这些是转义最容易翻车的地方，写死当安全网 */
  assert.equal(rt('\\#开头'),   '\\#开头');
  assert.equal(rt('\\\\#开头'), '\\\\#开头');
});

test('escape: 混合 markdown', () => {
  const s = '# 一级\n\n正文 \\# 不是标题\n\n## 二级\n\n- 列表 #不是标签';
  assert.equal(rt(s), s);
});

test('escape: 全角 / emoji / 换行', () => {
  const s = '＃全角井号不是\n#真标题 😀\n\n🎉';
  assert.equal(rt(s), s);
});

test('escape: 空串 / 纯空白', () => {
  assert.equal(rt(''), '');
  assert.equal(rt('\n\n'), '\n\n');
});

test('escape: CRLF', () => {
  /* 输入可能来自 Windows 编辑器，转义规则是 gm 模式，
     要保证 \r\n 里 # 仍然被视为行首 */
  assert.equal(rt('# A\r\n# B'), '# A\r\n# B');
});

/* ---------- blockId / topicRefId 派生 ---------- */

test('stampToBlockId: 从磁盘时间戳派生 blockId', () => {
  assert.equal(
    stampToBlockId('2025-01-01 10:00:00.123 +08:00'),
    '2025-01-01_10-00-00-123'
  );
  assert.equal(
    stampToBlockId('2025-01-01T10:00:00.1Z'),
    '2025-01-01_10-00-00-100'
  );
  assert.equal(stampToBlockId('garbage'), null);
});

test('topicRefIdFromStamp: 前缀截取，不受时区影响', () => {
  const a = topicRefIdFromStamp('2025-01-01 10:00:00.000+08:00');
  const b = topicRefIdFromStamp('2025-01-01 10:00:00.000-05:00');
  const c = topicRefIdFromStamp('2025-01-01 10:00:00.000Z');
  assert.equal(a, '2025-01-01_10-00-00-000');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('topicRefIdFromStamp: 秒/毫秒缺省补齐', () => {
  assert.equal(topicRefIdFromStamp('2025-01-01 10:00'),
               '2025-01-01_10-00-00-000');
  assert.equal(topicRefIdFromStamp('2025-01-01 10:00:05.7'),
               '2025-01-01_10-00-05-700');
});

/* ---------- 时间戳解析 ---------- */

test('parseStampToMs: 带时区 / 不带时区', () => {
  const withTz = parseStampToMs('2025','01','01','10','00','00','000','+08:00');
  const utc    = Date.UTC(2025, 0, 1, 2, 0, 0, 0);
  assert.equal(withTz, utc);

  /* 无时区 → 按本地时间解析，无论本地在哪，秒数都该一致 */
  const local = parseStampToMs('2025','01','01','10','00','00','000', null);
  assert.equal(local, new Date(2025, 0, 1, 10, 0, 0, 0).getTime());
});

test('parseStamp: 宽松匹配', () => {
  assert.equal(parseStamp('2025-01-01 10:00:00'),
               new Date(2025, 0, 1, 10, 0, 0).getTime());
  assert.equal(parseStamp('garbage'), null);
});

/* ---------- normalizeRawStamp ---------- */

test('normalizeRawStamp: ISO → 磁盘格式', () => {
  assert.equal(
    normalizeRawStamp('2025-01-01T10:00:00.399000+08:00'),
    '2025-01-01 10:00:00.399+08:00'
  );
  assert.equal(
    normalizeRawStamp('2025-01-01T10:00:00Z'),
    '2025-01-01 10:00:00.000Z'
  );
  assert.equal(normalizeRawStamp('not a date'), null);
});

/* ---------- 与 io / loader 联合：写入 → 解析 稳定性 ---------- */

/* 补一句：这层测试更重要，可以放到 io.test.js / 集成测试里做，
   这里只做转义函数自己的回归。 */
const samples = [
  '#标题', '正文 # 号', '\\#不是标题', '\\\\#两个斜杠',
  '#include <stdio.h>', 'a\n#顶格\nb', '\\#\\#\\#',
  '```\n#include\n```', '## 二级',
];
for (const s of samples) {
  test('roundtrip: ' + JSON.stringify(s), () => {
    assert.strictEqual(unescapeEntryBody(escapeEntryBody(s)), s);
  });
}

test('monthKey 把毫秒转成 YYYY-MM', () => {
  // new Date(2026, 8, 17) → 2026年9月17日（月份从0开始）
  const ms = new Date(2026, 8, 17, 12, 0, 0).getTime();
  assert.equal(monthKey(ms), '2026-09');
});

test('monthFileName 和 MONTH_RE 互相对得上', () => {
  const fname = monthFileName('2026-09');
  assert.equal(fname, '_记录-2026-09.md');

  // 用正则去匹配刚生成的文件名，应该能抓到 '2026-09'
  const m = fname.match(MONTH_RE);
  assert.ok(m, 'MONTH_RE 应该能匹配 monthFileName 的产物');
  assert.equal(m[1], '2026-09');
});

test('fmtTime 输出 HH:mm', () => {
  const ms = new Date(2026, 8, 17, 9, 5, 0).getTime();
  assert.equal(fmtTime(ms), '09:05');
});

test('fmtStampLocal 输出 YYYY-MM-DD HH:mm:ss.SSS', () => {
  const ms = new Date(2026, 8, 17, 9, 5, 3, 7).getTime();
  assert.equal(fmtStampLocal(ms), '2026-09-17 09:05:03.007');
});


test('fmtStamp 格式为 YYYY-MM-DD HH:mm:ss.SSS±HH:MM', () => {
  const ts = new Date(2026, 8, 17, 9, 5, 3, 7).getTime();
  const s = fmtStamp(ts);
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
});

test('fmtFull 输出中文长日期', () => {
  const ts = new Date(2026, 8, 17, 9, 5, 3).getTime();
  assert.equal(fmtFull(ts), '2026 年 9 月 17 日 09:05:03');
});

test('dayKey 把同一天的不同时刻归到同一 key', () => {
  const a = new Date(2026, 8, 17, 0, 0, 0).getTime();
  const b = new Date(2026, 8, 17, 23, 59, 59).getTime();
  assert.equal(dayKey(a), dayKey(b));
});

test('dayKey 不同天不同 key', () => {
  const a = new Date(2026, 8, 17).getTime();
  const b = new Date(2026, 8, 18).getTime();
  assert.notEqual(dayKey(a), dayKey(b));
});

test('fmtDay 今天 / 昨天 / 更早', () => {
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const today = now.getTime();
  const yest = today - 86400000;
  const long = new Date(2026, 8, 17, 12).getTime();

  assert.equal(fmtDay(today), '今天');
  assert.equal(fmtDay(yest), '昨天');
  assert.match(fmtDay(long), /周[日一二三四五六]/);
});

test('parseStamp 解析带时区', () => {
  assert.equal(
    parseStamp('2026-09-17 09:00:00.000+08:00'),
    Date.UTC(2026, 8, 17, 1, 0, 0, 0),
  );
});

test('parseStamp 解析无时区（本地时间）', () => {
  const ms = parseStamp('2026-09-17 09:00:00');
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 17);
  assert.equal(d.getHours(), 9);
});

test('parseStamp 非法输入返回 null', () => {
  assert.equal(parseStamp('乱七八糟'), null);
  assert.equal(parseStamp(''), null);
  assert.equal(parseStamp(null), null);
});

test('parseStampToMs 无时区走本地时间', () => {
  const ms = parseStampToMs('2026', '09', '17', '09', '00', '00', '000', null);
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getHours(), 9);
});

test('parseStampToMs 带 +08:00 时区', () => {
  const ms = parseStampToMs('2026', '09', '17', '09', '00', '00', '000', '+08:00');
  assert.equal(ms, Date.UTC(2026, 8, 17, 1, 0, 0, 0));
});

test('parseStampToMs 带 Z 时区（UTC）', () => {
  const ms = parseStampToMs('2026', '09', '17', '01', '00', '00', '000', 'Z');
  assert.equal(ms, Date.UTC(2026, 8, 17, 1, 0, 0, 0));
});

test('imgStamp 格式为 YYYYMMDD-HHmmss', () => {
  const s = imgStamp();
  assert.match(s, /^\d{8}-\d{6}$/);
});

/* ---------- stampForWrite / entryBlockId 写盘契约 ---------- */

test('stampForWrite: _rawStamp 优先，不随本地时区变', () => {
  const e = {
    createdAt: Date.parse('2025-01-01T02:00:00.000Z'),
    _rawStamp: '2025-01-01 10:00:00.000+08:00',
    _tzOffset: -300, // 故意给一个不同偏移，也不该覆盖 _rawStamp
  };
  assert.equal(stampForWrite(e), '2025-01-01 10:00:00.000+08:00');
});

test('★ stampForWrite: 读盘后的 _writeStamp 优先 —— 跨时区编辑不改 blockId', () => {
  /* parseEntries 只还原 _writeStamp，不还原 _rawStamp / _tzOffset。
     如果这里重新按"当前本地时区"格式化，换时区/夏令时后 blockId 会漂。 */
  const parsed = {
    createdAt: Date.parse('2025-01-01T02:00:00.000Z'),
    _writeStamp: '2025-01-01 10:00:00.000+08:00',
  };
  assert.equal(stampForWrite(parsed), parsed._writeStamp);
  assert.equal(entryBlockId(parsed), '2025-01-01_10-00-00-000');
});

test('entryBlockId: 从 _rawStamp / _writeStamp 派生，与本地时区无关', () => {
  const e = {
    createdAt: Date.parse('2025-01-01T02:00:00.000Z'),
    _writeStamp: '2025-01-01 10:00:00.000+08:00',
  };
  assert.equal(entryBlockId(e), '2025-01-01_10-00-00-000');
});

test('stampForWrite → entryBlockId 与 stampToBlockId 一致', () => {
  const e = {
    createdAt: Date.parse('2025-01-01T02:00:00.000Z'),
    _rawStamp: '2025-01-01 10:00:00.000+08:00',
  };
  assert.equal(entryBlockId(e), stampToBlockId(stampForWrite(e)));
});

// 追加到 format.test.js
test('parseStamp 接受小写 z（ISO 宽松）', () => {
  const ms = parseStamp('2026-09-17 01:00:00.000z');
  assert.equal(ms, Date.UTC(2026, 8, 17, 1, 0, 0, 0));
});

test('parseStampToMs 拒绝完全非法的输入', () => {
  // 只给一堆字
  assert.equal(parseStampToMs('x', 'y', 'z', '1', '2', '3', '4', null), NaN);
});

test('escapeEntryBody 行首 \\r\\n 之后的 #', () => {
  const s = 'a\r\n#B';
  // \r\n 之后 # 仍然该被转义
  assert.equal(escapeEntryBody(s), 'a\r\n\\#B');
});

test('entryBlockId fallback 到本地字段', () => {
  const e = { createdAt: new Date(2026, 8, 17, 9, 5, 3, 7).getTime() };
  assert.equal(entryBlockId(e), '2026-09-17_09-05-03-007');
});

test('stampForWrite 无 _rawStamp / _tzOffset → 用本地时区', () => {
  const e = { createdAt: Date.parse('2025-01-01T02:00:00.000Z') };
  const s = stampForWrite(e);
  assert.match(s, /^2025-01-01 \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
});

/* ============================================================
 * 条目级时区归属（P0）：月份/日期必须跟自己的 ## 行一致
 * ============================================================ */

/* 一条在 UTC-5 写下的跨年记录 */
const NY_NEW_YEAR = {
  createdAt: Date.parse('2025-12-31T23:30:00.000-05:00'),
  _writeStamp: '2025-12-31 23:30:00.000-05:00',
  _tzOffset: -300,
};

test('月份归属：取 ## 行的字面年月，不受本机时区影响', () => {
  assert.equal(monthKeyOfEntry(NY_NEW_YEAR), '2025-12');
  /* 对比：按本机时区的旧算法（这台机器是 +08）会得到 2026-01 */
  if (new Date().getTimezoneOffset() === -480) {
    assert.equal(monthKey(NY_NEW_YEAR.createdAt), '2026-01');
  }
});

test('日分组归属：和 dayKey 同构（月从 0 起），也按字面值', () => {
  assert.equal(dayKeyOfEntry(NY_NEW_YEAR), '2025-11-31');
});

test('没有磁盘串时用 _tzOffset；都没有时退回本机', () => {
  const withTz = { createdAt: NY_NEW_YEAR.createdAt, _tzOffset: -300 };
  assert.equal(monthKeyOfEntry(withTz), '2025-12');
  assert.equal(dayKeyOfEntry(withTz), '2025-11-31');

  const plain = { createdAt: NY_NEW_YEAR.createdAt };
  assert.equal(monthKeyOfEntry(plain), monthKey(NY_NEW_YEAR.createdAt));
  assert.equal(dayKeyOfEntry(plain), dayKey(NY_NEW_YEAR.createdAt));
});

test('_rawStamp 也能作为时区依据', () => {
  const e = { createdAt: NY_NEW_YEAR.createdAt, _rawStamp: '2026-01-01 12:30:00.000+08:00' };
  assert.equal(monthKeyOfEntry(e), '2026-01');
  assert.equal(dayKeyOfEntry(e), '2026-0-1');
});
