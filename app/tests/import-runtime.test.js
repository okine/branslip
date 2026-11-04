// tests/import-runtime.test.js
'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeMessage,
  buildMessageTree,
  extractFromTree,
  freezeWriteStamps,
  previewText,
  branchTitle,
  countEntries,
  isTransientFailureBranch,
} from '../import-runtime.js';

/* ============================================================
 * makeMessage
 * ============================================================ */

test('makeMessage: 基本字段', () => {
  const m = makeMessage('id-1', 1000, { parentId: 'p', raw: { x: 1 } });
  assert.equal(m.id, 'id-1');
  assert.equal(m.at, 1000);
  assert.equal(m.parentId, 'p');
  assert.deepEqual(m.message, { x: 1 });
});

test('makeMessage: id / parentId 强制转字符串', () => {
  const m = makeMessage(123, 1000, { parentId: 456 });
  assert.equal(m.id, '123');
  assert.equal(m.parentId, '456');
});

test('makeMessage: at 非有限数字 → 0', () => {
  assert.equal(makeMessage('a', NaN).at, 0);
  assert.equal(makeMessage('a', undefined).at, 0);
  assert.equal(makeMessage('a', Infinity).at, 0);
  assert.equal(makeMessage('a', '123').at, 0);   // 字符串不算
});

test('makeMessage: childrenIds 逐项转字符串', () => {
  const m = makeMessage('a', 1000, { childrenIds: [1, 2, 3] });
  assert.deepEqual(m.childrenIds, ['1', '2', '3']);
});

test('makeMessage: 不传 opts', () => {
  const m = makeMessage('a', 1000);
  assert.equal(m.parentId, null);
  assert.equal(m.childrenIds, null);
  assert.equal(m.message, null);
});

/* ============================================================
 * buildMessageTree
 * ============================================================ */

test('buildMessageTree: 单根', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000),
    makeMessage('b', 2000, { parentId: 'a' }),
    makeMessage('c', 3000, { parentId: 'b' }),
  ]);
  assert.equal(tree.id, 'a');
  assert.equal(tree.children[0].id, 'b');
  assert.equal(tree.children[0].children[0].id, 'c');
});

test('buildMessageTree: 多根 → 虚拟根', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000),
    makeMessage('b', 2000),
  ]);
  assert.equal(tree.id, '__virtual_root__');
  assert.equal(tree.children.length, 2);
});

test('buildMessageTree: 空输入 → 虚拟根', () => {
  const tree = buildMessageTree([]);
  assert.equal(tree.id, '__virtual_root__');
  assert.deepEqual(tree.children, []);
});

test('buildMessageTree: childrenIds 与 parentId 都提供，边不重复', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { childrenIds: ['b'] }),
    makeMessage('b', 2000, { parentId: 'a', childrenIds: ['c'] }),
    makeMessage('c', 3000, { parentId: 'b' }),
  ]);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].children.length, 1);
  assert.equal(tree.children[0].children[0].id, 'c');
});

test('buildMessageTree: 只给 parentId 也能连', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000),
    makeMessage('b', 2000, { parentId: 'a' }),
  ]);
  assert.equal(tree.id, 'a');
  assert.equal(tree.children[0].id, 'b');
});

test('buildMessageTree: 只给 childrenIds 也能连', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { childrenIds: ['b'] }),
    makeMessage('b', 2000),
  ]);
  assert.equal(tree.id, 'a');
  assert.equal(tree.children[0].id, 'b');
});

test('buildMessageTree: parentId 指向不存在的 id → 视为根', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000),
    makeMessage('b', 2000, { parentId: 'ghost' }),
  ]);
  assert.equal(tree.id, '__virtual_root__');
  assert.equal(tree.children.length, 2);
});

test('buildMessageTree: 子节点按 at 升序', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000),
    makeMessage('b', 3000, { parentId: 'a' }),
    makeMessage('c', 2000, { parentId: 'a' }),
  ]);
  assert.deepEqual(tree.children.map(n => n.id), ['c', 'b']);
});

test('buildMessageTree: _depth 自下而上计算', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000),
    makeMessage('b', 2000, { parentId: 'a' }),
    makeMessage('c', 3000, { parentId: 'b' }),
  ]);
  assert.equal(tree._depth, 3);
  assert.equal(tree.children[0]._depth, 2);
  assert.equal(tree.children[0].children[0]._depth, 1);
});

test('buildMessageTree: 缺时间 → 父 +1ms', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: {} }),
    makeMessage('b', 0, { parentId: 'a', raw: {} }),
  ]);
  assert.equal(tree.children[0].at, 1001);
});

test('buildMessageTree: 时间倒挂 → 父 +1ms', () => {
  const tree = buildMessageTree([
    makeMessage('a', 5000, { raw: {} }),
    makeMessage('b', 1000, { parentId: 'a', raw: {} }),
  ]);
  assert.equal(tree.children[0].at, 5001);
});

test('buildMessageTree: 多级时间修正沿链传播', () => {
  /* a(1000) → b(0) → c(0) 应变成 a(1000) → b(1001) → c(1002) */
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: {} }),
    makeMessage('b', 0, { parentId: 'a', raw: {} }),
    makeMessage('c', 0, { parentId: 'b', raw: {} }),
  ]);
  assert.equal(tree.children[0].at, 1001);
  assert.equal(tree.children[0].children[0].at, 1002);
});

/* ============================================================
 * extractFromTree
 * ============================================================ */

const echoExtract = m => ({ role: m.role, text: m.text, thinking: '' });

test('extractFromTree: 单条 user 消息', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '你好' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.equal(topic.title, 'T');
  assert.equal(topic.entries.length, 1);
  assert.equal(topic.entries[0].text, '你好');
  assert.equal(topic.entries[0].createdAt, 1000);
  assert.equal(topic.createdAtMs, 999, '话题时间 = 首条记录 - 1ms');
});

test('extractFromTree: user + assistant', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '问' } }),
    makeMessage('b', 2000, { parentId: 'a', raw: { role: 'assistant', text: '答' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.equal(topic.entries.length, 2);
  assert.equal(topic.entries[0].text, '问');
  assert.equal(topic.entries[1].text, '答');
});

test('extractFromTree: assistant 的 _replyTo 指向父链上的 user', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '问' } }),
    makeMessage('b', 2000, { parentId: 'a', raw: { role: 'assistant', text: '答' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  const userEntry = topic.entries[0];
  const aiEntry = topic.entries[1];
  assert.equal(aiEntry._replyTo, userEntry, 'assistant 应引用父链上的 user entry');
});

test('extractFromTree: thinking 生成 :::think 块', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => ({ role: 'assistant', text: '正文', thinking: '思考' }),
  });
  assert.equal(topic.entries[0].text, ':::think\n思考\n:::\n\n正文');
});

test('extractFromTree: thinking 里的 ::: 被转义，避免提前闭合', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => ({
      role: 'assistant', text: '',
      thinking: '前\n::: 危险\n后',
    }),
  });
  assert.ok(topic.entries[0].text.includes('\\::: 危险'),
    '内层 ::: 应被转义成 \\:::');
});

test('extractFromTree: skip 被过滤', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: {} }),
    makeMessage('b', 2000, { parentId: 'a', raw: {} }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => ({ role: 'skip' }),
  });
  assert.equal(topic.entries.length, 0);
});

test('extractFromTree: 空 text + 空 thinking 被过滤', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => ({ role: 'user', text: '', thinking: '' }),
  });
  assert.equal(topic.entries.length, 0);
});

test('extractFromTree: 数组返回 → 多条 entry', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => [
      { role: 'user', text: 'A', thinking: '' },
      { role: 'assistant', text: 'B', thinking: '' },
    ],
  });
  assert.equal(topic.entries.length, 2);
  assert.equal(topic.entries[0].text, 'A');
  assert.equal(topic.entries[1].text, 'B');
});

test('extractFromTree: 数组内 assistant 引用同 node 的 user（DeepSeek 一问一答）', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => [
      { role: 'user', text: '问', thinking: '' },
      { role: 'assistant', text: '答', thinking: '' },
    ],
  });
  assert.equal(topic.entries[1]._replyTo, topic.entries[0],
    '同 node 内的 RESPONSE 应 reply 本 node 的 REQUEST');
});

test('extractFromTree: 子节点 assistant 引用本节点的 user，不是父节点的', () => {
  /*  m1: REQUEST "问1" + RESPONSE "答1"
   *   └─ m2: REQUEST "问2" + RESPONSE "答2"
   */
  const tree = buildMessageTree([
    makeMessage('m1', 1000, { raw: {} }),
    makeMessage('m2', 2000, { parentId: 'm1', raw: {} }),
  ]);
  let call = 0;
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => {
      call++;
      return call === 1
        ? [{ role: 'user', text: '问1', thinking: '' },
           { role: 'assistant', text: '答1', thinking: '' }]
        : [{ role: 'user', text: '问2', thinking: '' },
           { role: 'assistant', text: '答2', thinking: '' }];
    },
  });
  const [问1, 答1, 问2, 答2] = topic.entries;
  assert.equal(答1._replyTo, 问1);
  assert.equal(答2._replyTo, 问2, '答2 应 reply 问2，而不是问1');
});

test('extractFromTree: 每条 entry 都有 _scope 和 _tzOffset', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: {} }),
    makeMessage('b', 2000, { parentId: 'a', raw: {} }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, tzOffset: 480,
    extractContent: () => ({ role: 'user', text: 'x', thinking: '' }),
  });
  for (const e of topic.entries) {
    assert.equal(e._scope, topic.scopeId);
    assert.equal(e._tzOffset, 480);
  }
});

test('extractFromTree: rawStamp 透传', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => ({
      role: 'user', text: 'x', thinking: '',
      rawStamp: '2026-09-17 09:05:03.007+08:00',
    }),
  });
  assert.equal(topic.entries[0]._rawStamp, '2026-09-17 09:05:03.007+08:00');
});

test('extractFromTree: 同毫秒 entry 被 normalizeTimestamps 顺延', () => {
  const tree = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => [
      { role: 'user', text: 'A', thinking: '' },
      { role: 'user', text: 'B', thinking: '' },
    ],
  });
  assert.equal(topic.entries[0].createdAt, 1000);
  assert.equal(topic.entries[1].createdAt, 1001);
});

test('extractFromTree: sourceCreatedAt 覆盖首条时间', () => {
  const tree = buildMessageTree([makeMessage('a', 5000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: 100000, extractContent: echoExtract,
  });
  assert.equal(topic.createdAtMs, 100000);
});

test('extractFromTree: sourceCreatedAt NaN → 用首条 at', () => {
  const tree = buildMessageTree([makeMessage('a', 5000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN,
    extractContent: () => ({ role: 'user', text: 'x', thinking: '' }),
  });
  assert.equal(topic.createdAtMs, 4999, '话题时间 = 首条记录 - 1ms');
});

test('extractFromTree: 不同 topic 的 scopeId 不同', () => {
  const tree1 = buildMessageTree([makeMessage('a', 1000, { raw: {} })]);
  const tree2 = buildMessageTree([makeMessage('b', 2000, { raw: {} })]);
  const t1 = extractFromTree(tree1, {
    title: 'T1', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  const t2 = extractFromTree(tree2, {
    title: 'T2', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.notEqual(t1.scopeId, t2.scopeId);
});

/* ---------- 分叉 ---------- */

test('extractFromTree: 分叉 → 主分支最深，其余成子话题', () => {
  /*  a ─┬─ b ─ c ─ d   (深 3)
   *      └─ e           (深 1) */
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '根' } }),
    makeMessage('b', 2000, { parentId: 'a', raw: { role: 'assistant', text: '主1' } }),
    makeMessage('c', 3000, { parentId: 'b', raw: { role: 'user', text: '主2' } }),
    makeMessage('d', 4000, { parentId: 'c', raw: { role: 'assistant', text: '主3' } }),
    makeMessage('e', 2500, { parentId: 'a', raw: { role: 'assistant', text: '侧' } }),
  makeMessage('f', 2600, { parentId: 'e', raw: { role: 'user', text: '侧后续' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.equal(topic.entries.length, 4);
  assert.deepEqual(topic.entries.map(e => e.text), ['根', '主1', '主2', '主3']);
  assert.equal(topic.branches.length, 1);
  assert.equal(topic.branches[0].entries.length, 2);
  assert.equal(topic.branches[0].entries[0].text, '侧');
});

test('extractFromTree: 分叉 → 子话题标题 [分支] + 首条预览', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '根' } }),
    makeMessage('b', 2500, { parentId: 'a', raw: { role: 'assistant', text: '被选为主分支' } }),
    makeMessage('b2', 2600, { parentId: 'b', raw: { role: 'user', text: '主后续' } }),
    makeMessage('c', 2000, { parentId: 'a', raw: { role: 'assistant', text: '侧分支首条' } }),
    makeMessage('c2', 2050, { parentId: 'c', raw: { role: 'user', text: '侧后续' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  /* 同深 → 时间最新的 b 作主，c 作子话题 */
  assert.equal(topic.entries.length, 3);
  assert.equal(topic.entries[1].text, '被选为主分支');
  assert.equal(topic.branches.length, 1);
  assert.equal(topic.branches[0].title, '[分支] 侧分支首条');
});

test('extractFromTree: 同深分支 → 时间最新的作主分支', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '根' } }),
    makeMessage('b', 2500, { parentId: 'a', raw: { role: 'assistant', text: 'B' } }),
    makeMessage('b2', 2600, { parentId: 'b', raw: { role: 'user', text: 'B后续' } }),
    makeMessage('c', 2000, { parentId: 'a', raw: { role: 'assistant', text: 'C' } }),
    makeMessage('c2', 2050, { parentId: 'c', raw: { role: 'user', text: 'C后续' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.equal(topic.entries[1].text, 'B');
  assert.equal(topic.branches[0].entries[0].text, 'C');
});

test('extractFromTree: 子话题的 _fromUser 指向分支点用户消息', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '根' } }),
    makeMessage('b', 2500, { parentId: 'a', raw: { role: 'assistant', text: 'B' } }),
    makeMessage('b2', 2600, { parentId: 'b', raw: { role: 'user', text: 'B后续' } }),
    makeMessage('c', 2000, { parentId: 'a', raw: { role: 'assistant', text: 'C' } }),
    makeMessage('c2', 2050, { parentId: 'c', raw: { role: 'user', text: 'C后续' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  /* 侧分支的 _fromUser 是「根」entry（在父 topic 里） */
  assert.equal(topic.branches[0]._fromUser, topic.entries[0]);
});

/* ============================================================
 * freezeWriteStamps
 * ============================================================ */

test('freezeWriteStamps: 每条 entry 拿到 _writeStamp（带 tzOffset 后缀）', () => {
  const t = {
    entries: [
      { id: 'a', text: 'x', createdAt: 1000, _tzOffset: 480 },
      { id: 'b', text: 'y', createdAt: 2000, _tzOffset: 480 },
    ],
    branches: [],
  };
  freezeWriteStamps(t);
  assert.ok(t.entries[0]._writeStamp);
  assert.ok(t.entries[1]._writeStamp);
  assert.match(t.entries[0]._writeStamp,
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
});

test('freezeWriteStamps: 已有 _writeStamp 不被覆盖', () => {
  const t = {
    entries: [{ id: 'a', text: 'x', createdAt: 1000, _writeStamp: 'FROZEN' }],
    branches: [],
  };
  freezeWriteStamps(t);
  assert.equal(t.entries[0]._writeStamp, 'FROZEN');
});

test('freezeWriteStamps: _rawStamp 优先于重新格式化', () => {
  const t = {
    entries: [{
      id: 'a', text: 'x', createdAt: 1000, _tzOffset: 480,
      _rawStamp: '2026-09-17 09:05:03.007+08:00',
    }],
    branches: [],
  };
  freezeWriteStamps(t);
  assert.equal(t.entries[0]._writeStamp, '2026-09-17 09:05:03.007+08:00');
});

test('freezeWriteStamps: 递归 branches', () => {
  const t = {
    entries: [],
    branches: [
      { entries: [{ id: 'a', text: 'x', createdAt: 1000, _tzOffset: 480 }], branches: [] },
      {
        entries: [],
        branches: [{ entries: [{ id: 'b', text: 'y', createdAt: 2000, _tzOffset: 480 }], branches: [] }],
      },
    ],
  };
  freezeWriteStamps(t);
  assert.ok(t.branches[0].entries[0]._writeStamp);
  assert.ok(t.branches[1].branches[0].entries[0]._writeStamp);
});

/* ============================================================
 * previewText
 * ============================================================ */

test('previewText: 去掉 :::think 块', () => {
  assert.equal(previewText(':::think\n思考\n:::\n\n正文'), '正文');
});

test('previewText: 去掉 :::think 块但保留后续内容', () => {
  assert.equal(
    previewText(':::think\n思考\n:::\n正文A\n\n正文B'),
    '正文A 正文B'
  );
});

test('previewText: 跳过 📎 / > / \\# 开头的行', () => {
  const s = '📎 file.pdf\n> 引用\n\\# 转义标题\n正文';
  assert.equal(previewText(s), '正文');
});

test('previewText: 合并多行为空格', () => {
  assert.equal(previewText('a\nb\nc'), 'a b c');
});

test('previewText: 默认截断到 60 字', () => {
  const s = 'x'.repeat(100);
  assert.equal(previewText(s).length, 60);
});

test('previewText: 自定义 maxLen', () => {
  assert.equal(previewText('abcdefg', 3), 'abc');
});

test('previewText: 空输入', () => {
  assert.equal(previewText(''), '');
  assert.equal(previewText(null), '');
  assert.equal(previewText(undefined), '');
});

/* ============================================================
 * branchTitle
 * ============================================================ */

test('branchTitle: [分支] + 首条预览', () => {
  const b = { entries: [{ text: '第一次回复' }] };
  assert.equal(branchTitle(b), '[分支] 第一次回复');
});

test('branchTitle: 空 entries → [分支]', () => {
  assert.equal(branchTitle({ entries: [] }), '[分支]');
});

test('branchTitle: 首条超 20 字被截断', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三';   // 25 字
  const t = branchTitle({ entries: [{ text: long }] });
  assert.equal(t, '[分支] 一二三四五六七八九十一二三四五六七八九十');   // 20 字
});

test('branchTitle: 首条全是 think → 回落 [分支] 分支', () => {
  const b = { entries: [{ text: ':::think\n思考\n:::' }] };
  assert.equal(branchTitle(b), '[分支] 分支');
});

/* ============================================================
 * countEntries
 * ============================================================ */

test('countEntries: 递归计数', () => {
  const t = {
    entries: [{}, {}, {}],
    branches: [
      { entries: [{}], branches: [] },
      {
        entries: [{}],
        branches: [
          { entries: [{}, {}], branches: [] },
        ],
      },
    ],
  };
  assert.equal(countEntries(t), 3 + 1 + 1 + 2);
});

test('countEntries: 空 topic 返回 0', () => {
  assert.equal(countEntries({ entries: [], branches: [] }), 0);
});

test('message: null 的容器节点不参与时间修正', () => {
  /* 复现 DeepSeek 的结构：容器 root（message: null, at: 0）
     挂两条真实消息，时间应保持原样，不被拉到 Date.now() */
  const tree = buildMessageTree([
    makeMessage('root', 0, { raw: null }),                     // 容器
    makeMessage('a', 1234567890, { parentId: 'root', raw: { x: 1 } }),
    makeMessage('b', 1234567891, { parentId: 'a', raw: { x: 2 } }),
  ]);
  assert.equal(tree.id, 'root');
  assert.equal(tree.at, 0, '容器节点自身 at 保持 0');
  assert.equal(tree.children[0].at, 1234567890, '真实消息保持原始时间');
  assert.equal(tree.children[0].children[0].at, 1234567891);
});

test('容器节点下第一条消息带时间时，整棵子树不被拉到 Date.now()', () => {
  const before = Date.now();
  const tree = buildMessageTree([
    makeMessage('root', 0, { raw: null }),
    makeMessage('a', 1234567890, { parentId: 'root', raw: {} }),
  ]);
  assert.ok(tree.children[0].at < before, '子消息不该等于或大于当前时间');
  assert.equal(tree.children[0]._atAdjusted, undefined, '不该被标记为修正过');
});
/* ============================================================
 * isTransientFailureBranch（重试产生的噪音分支）
 * ============================================================ */

const mkBranch = (texts) => ({ entries: texts.map(t => ({ text: t })), branches: [] });

test('服务器繁忙类单条短分支→当噪音跳过', () => {
  assert.equal(isTransientFailureBranch(mkBranch(['服务器繁忙，请稍后再试。'])), true);
  assert.equal(isTransientFailureBranch(mkBranch(['网络异常，请稍后重试'])), true);
  assert.equal(isTransientFailureBranch(mkBranch(['你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。'])), true);
});

test('正常回答 / 多条 / 有子分支的不跳', () => {
  assert.equal(isTransientFailureBranch(mkBranch(['这是一个正常的回答。'])), false);
  assert.equal(isTransientFailureBranch(mkBranch(['服务器繁忙', '补充一条'])), false);
  const withSub = mkBranch(['服务器繁忙']);
  withSub.branches.push(mkBranch(['x']));
  assert.equal(isTransientFailureBranch(withSub), false);
  assert.equal(isTransientFailureBranch(null), false);
});

test('长文本（超 60 字）不跳，避免误伤', () => {
  const long = '服务器繁忙' + '啊'.repeat(80);
  assert.equal(isTransientFailureBranch(mkBranch([long])), false);
});

test('导入：没有时间戳的消息用对话时间兜底，不用 Date.now()', () => {
  const SRC = Date.parse('2025-02-11T09:42:22.105+08:00');
  const tree = buildMessageTree([
    makeMessage('a', 0, { raw: {} }),
    makeMessage('b', 0, { parentId: 'a', raw: {} }),
  ]);
  const root = extractFromTree(tree, {
    title: 'x', sourceCreatedAt: SRC,
    extractContent: () => ({ role: 'user', text: 'hi' }),
  });
  assert.equal(root.createdAtMs, root.entries[0].createdAt - 1);
  assert.equal(root.entries.length, 2);
  for (const e of root.entries) {
    const d = Math.abs(e.createdAt - SRC);
    assert.ok(d < 10, '时间应落在对话的 2025 年，而不是今天：' + e.createdAt);
  }
  assert.ok(root.entries[0].createdAt < root.entries[1].createdAt, '仍然保持顺序');
});

/* ============================================================
 * 变体（叶子再生成）规则
 * ============================================================ */

test('extractFromTree: 叶子再生成 → 变体，不建子话题', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '问题' } }),
    makeMessage('b', 2500, { parentId: 'a', raw: { role: 'assistant', text: '主回答' } }),
    makeMessage('c', 2000, { parentId: 'a', raw: { role: 'assistant', text: '另一版' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.equal(topic.branches.length, 0, '叶子再生成不该建子话题');
  assert.equal(topic.entries.length, 3);
  assert.equal(topic.entries[1].text, '主回答');
  assert.equal(topic.entries[2].text, '另一版');
  assert.equal(topic.entries[2]._altOf, topic.entries[1], '变体挂在主回答上');
  assert.equal(topic.entries[2]._scope, topic.entries[1]._scope, '和主回答同一个话题');
});

test('extractFromTree: 改了提问的分支（首条是 user）仍是子话题', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '问题' } }),
    makeMessage('b', 2500, { parentId: 'a', raw: { role: 'assistant', text: '主回答' } }),
    makeMessage('c', 2000, { parentId: 'a', raw: { role: 'user', text: '改过的提问' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: NaN, extractContent: echoExtract,
  });
  assert.equal(topic.branches.length, 1);
  assert.equal(topic.branches[0].entries[0].text, '改过的提问');
  assert.equal(topic.entries.length, 2);
});

test('话题时间：原始创建时间更早 → 用原始时间', () => {
  const tree = buildMessageTree([makeMessage('a', 5000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: 3000,
    extractContent: () => ({ role: 'user', text: 'x', thinking: '' }),
  });
  assert.equal(topic.createdAtMs, 3000, '原时间更早，保留原时间');
  assert.equal(topic.entries[0].createdAt, 5000);
});

test('话题时间：原始时间与首条同一毫秒 → 让开 1ms', () => {
  const tree = buildMessageTree([makeMessage('a', 5000, { raw: {} })]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: 5000,
    extractContent: () => ({ role: 'user', text: 'x', thinking: '' }),
  });
  assert.equal(topic.createdAtMs, 4999, '和首条撞毫秒时仍让开 1ms');
});

test('话题时间：分支子话题没有原时间 → 首条 - 1ms', () => {
  const tree = buildMessageTree([
    makeMessage('a', 1000, { raw: { role: 'user', text: '根' } }),
    makeMessage('b', 2000, { parentId: 'a', raw: { role: 'assistant', text: '主' } }),
    makeMessage('b2', 2100, { parentId: 'b', raw: { role: 'user', text: '继续' } }),
    makeMessage('c', 1500, { parentId: 'a', raw: { role: 'assistant', text: '侧' } }),
    makeMessage('c2', 1600, { parentId: 'c', raw: { role: 'user', text: '侧继续' } }),
  ]);
  const topic = extractFromTree(tree, {
    title: 'T', sourceCreatedAt: 500,
    extractContent: echoExtract,
  });
  assert.equal(topic.createdAtMs, 500, '主话题用原时间');
  assert.equal(topic.branches.length, 1);
  assert.equal(topic.branches[0].createdAtMs, topic.branches[0].entries[0].createdAt - 1);
});

test('previewText：图片语法不参与截断（不会留下没闭合的 ![]()）', () => {
  const text = 'x'.repeat(55) + '\n\n![](attachments/photo_1@2026-01-01.jpg)';
  const pv = previewText(text, 60);
  assert.doesNotMatch(pv, /!\[/);
  assert.match(pv, /\[图片\]/);
});

test('previewText：贴纸语法换成 [贴纸]', () => {
  const pv = previewText('![](attachments/x.webp)', 60);
  assert.equal(pv, '[图片]');
  assert.equal(previewText(':::sticker 💖:::', 60), '💖');
});
