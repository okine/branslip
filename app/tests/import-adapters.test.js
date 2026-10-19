// tests/import-adapters.test.js
'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQwenExport } from '../import-qwen.js';
import { parseTelegramExport } from '../import-telegram.js';
import { parseClaudeExport } from '../import-claude.js';
import { parseDeepSeekExport } from '../import-deepseek.js';

test('parseTelegramExport：单 chat', () => {
  const json = JSON.stringify({
    id: 1, name: '测试群',
    messages: [
      { id: 1, type: 'message', date_unixtime: '1700000000',
        from: 'A', text: '你好' },
      { id: 2, type: 'message', date_unixtime: '1700000001',
        from: 'B', text: '再见' },
    ],
  });
  const convs = parseTelegramExport(json);
  assert.equal(convs.length, 1);
  assert.equal(convs[0].title, '测试群');
  assert.equal(convs[0].root.entries.length, 2);
  // 多发送者 → 每条前加 **A** / **B**
  assert.match(convs[0].root.entries[0].text, /\*\*A\*\*/);
});

test('parseTelegramExport：reply 生成 _replyTo（写盘后变引用头）', () => {
  const json = JSON.stringify({
    id: 1, name: 'G', messages: [
      { id: 10, type: 'message', date_unixtime: '1700000000',
        from: 'A', text: '第一条' },
      { id: 11, type: 'message', date_unixtime: '1700000001',
        from: 'B', text: '回复',
        reply_to_message_id: 10 },
    ],
  });
  const convs = parseTelegramExport(json);
  // 排序后 [第一条, 回复]
  const [a, b] = convs[0].root.entries;
  assert.equal(b._replyTo, a);
});

test('parseQwenExport：秒级 timestamp × 1000', () => {
  const json = JSON.stringify({
    id: 'c1', title: 'Q',
    created_at: 1_700_000_000,
    chat: {
      history: {
        messages: {
          m1: {
            id: 'm1', role: 'user', content: '你好',
            timestamp: 1_700_000_000,
          },
        },
      },
    },
  });
  const convs = parseQwenExport(json);
  assert.equal(convs.length, 1);
  assert.equal(convs[0].root.entries[0].createdAt, 1_700_000_000_000);
});

test('parseClaudeExport：content 数组只取 text 与 thinking', () => {
  const json = JSON.stringify({
    uuid: 'u1', name: 'C',
    created_at: '2025-01-01T10:00:00.000+08:00',
    chat_messages: [
      { uuid: 'm1', sender: 'human', created_at: '2025-01-01T10:00:00.000+08:00',
        content: [{ type: 'text', text: '问' }] },
      { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant',
        created_at: '2025-01-01T10:00:01.000+08:00',
        content: [
          { type: 'thinking', thinking: '思路' },
          { type: 'text', text: '答' },
        ] },
    ],
  });
  const convs = parseClaudeExport(json);
  assert.equal(convs.length, 1);
  const [q, a] = convs[0].root.entries;
  assert.equal(q.text, '问');
  assert.match(a.text, /:::think\n思路\n:::/);
  assert.match(a.text, /答/);
});

test('parseDeepSeekExport：一个 node 内的 REQUEST + RESPONSE 生成两条 entry', () => {
  const json = JSON.stringify({
    id: 'c1', title: 'D',
    mapping: {
      root: {
        children: ['m1'],
        message: null,
      },
      m1: {
        children: [],
        message: {
          inserted_at: '2025-01-01T10:00:00.000+08:00',
          fragments: [
            { type: 'REQUEST', content: '问' },
            { type: 'RESPONSE', content: '答' },
          ],
        },
      },
    },
  });
  const convs = parseDeepSeekExport(json);
  assert.equal(convs[0].root.entries.length, 2);
  assert.equal(convs[0].root.entries[0].text, '问');
  assert.equal(convs[0].root.entries[1].text, '答');
});

test('parseXxxExport：无法识别的格式抛错', () => {
  assert.throws(() => parseTelegramExport('not json'));
  assert.throws(() => parseQwenExport('{"foo":1}'));
  assert.throws(() => parseClaudeExport('{"foo":1}'));
});