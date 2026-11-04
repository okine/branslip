// tests/import-adapters.test.js
'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQwenExport } from '../import-qwen.js';
import { parseTelegramExport } from '../import-telegram.js';
import { parseClaudeExport } from '../import-claude.js';
import { parseDeepSeekExport } from '../import-deepseek.js';
import { parseQQExport } from '../import-qq.js';
import { parseTelegramStream } from '../import-telegram.js';

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

test('parseDeepSeekExport：只有文件的 REQUEST 也生成用户记录', () => {
  const json = JSON.stringify({
    id: 'c-file', title: 'D',
    mapping: {
      root: { children: ['m1'], message: null },
      m1: {
        children: [],
        message: {
          inserted_at: '2025-01-01T10:00:00.000+08:00',
          fragments: [
            { type: 'REQUEST', content: '' },
            { type: 'FILE', files: [{ file_name: '报告.pdf' }] },
            { type: 'RESPONSE', content: '收到' },
          ],
        },
      },
    },
  });
  const root = parseDeepSeekExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.match(root.entries[0].text, /📎 报告\.pdf/);
  assert.equal(root.entries[1].text, '收到');
});

test('parseDeepSeekExport：NDJSON / 拼接对象', () => {
  const one = { id: 'a', title: 'A', mapping: {
    r: { children: ['m'], message: null },
    m: { children: [], message: { inserted_at: '2025-01-01T10:00:00+08:00', fragments: [{ type: 'REQUEST', content: '甲' }] } },
  } };
  const two = { id: 'b', title: 'B', mapping: {
    r: { children: ['n'], message: null },
    n: { children: [], message: { inserted_at: '2025-01-01T10:00:01+08:00', fragments: [{ type: 'REQUEST', content: '乙' }] } },
  } };
  const convs = parseDeepSeekExport(JSON.stringify(one) + '\n' + JSON.stringify(two));
  assert.equal(convs.length, 2);
  assert.equal(convs[0].root.entries[0].text, '甲');
  assert.equal(convs[1].root.entries[0].text, '乙');
});

test('parseDeepSeekExport：只有 parent 没有 children 的 mapping', () => {
  const T = '2025-01-01T10:00:00.000+08:00';
  const json = JSON.stringify({
    id: 'p', title: 'P',
    mapping: {
      root: { parent: null, message: null },
      m1: { parent: 'root', message: { inserted_at: T, fragments: [{ type: 'REQUEST', content: '问' }] } },
      m2: { parent: 'm1', message: { inserted_at: T, fragments: [{ type: 'RESPONSE', content: '答' }] } },
    },
  });
  const root = parseDeepSeekExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.equal(root.entries[0].text, '问');
  assert.equal(root.entries[1].text, '答');
  assert.equal(root.entries[1]._replyTo, root.entries[0]);
});

test('parseXxxExport：无法识别的格式抛错', () => {
  assert.throws(() => parseTelegramExport('not json'));
  assert.throws(() => parseQwenExport('{"foo":1}'));
  assert.throws(() => parseClaudeExport('{"foo":1}'));
});
test('parseTelegramExport：纯占位消息跳过，话题时间按首条真实消息算', () => {
  const json = JSON.stringify({
    id: 1, name: 'T',
    messages: [
      { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', text: '' },
      { id: 2, type: 'message', date_unixtime: '1700000010', from: 'A', text: '真消息' },
    ],
  });
  const convs = parseTelegramExport(json);
  assert.equal(convs[0].root.entries.length, 1, '空消息不该生成记录');
  assert.equal(convs[0].root.entries[0].createdAt, 1700000010000);
  assert.equal(convs[0].root.createdAtMs, 1700000010000 - 1, '话题时间 = 首条 - 1ms');
});

test('parseTelegramExport：回复被跳过的占位消息 → 兜底引用前缀', () => {
  const json = JSON.stringify({
    id: 1, name: 'T',
    messages: [
      { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', text: '' },
      { id: 2, type: 'message', date_unixtime: '1700000010', from: 'A', text: '回复空消息',
        reply_to_message_id: 1 },
    ],
  });
  const convs = parseTelegramExport(json);
  const e = convs[0].root.entries[0];
  assert.match(e.text, /引用的原消息不可见或已被删除/);
});

test('parseDeepSeekExport：失败重试进翻页，且不当主回答', () => {
  const T = '2026-10-23T00:00:00.000+08:00';
  const json = JSON.stringify([{
    id: 'c', title: 'T', inserted_at: T,
    mapping: {
      root: { id: 'root', parent: null, children: ['1'], message: null },
      '1': { id: '1', parent: 'root', children: ['16', '18', '22'],
        message: { inserted_at: T, fragments: [{ type: 'REQUEST', content: '问' }] } },
      '16': { id: '16', parent: '1', children: [],
        message: { inserted_at: T, fragments: [{ type: 'RESPONSE', content: '服务器繁忙，请稍后再试。' }] } },
      '18': { id: '18', parent: '1', children: [],
        message: { inserted_at: T, fragments: [{ type: 'RESPONSE', content: '网络异常，请稍后重试' }] } },
      '22': { id: '22', parent: '1', children: [],
        message: { inserted_at: T, fragments: [{ type: 'RESPONSE', content: '真正的回答' }] } },
    },
  }]);
  const root = parseDeepSeekExport(json)[0].root;
  assert.equal(root.branches.length, 0, '不应生成子话题');
  assert.equal(root.entries.length, 4);
  assert.equal(root.entries[1].text, '真正的回答', '主回答不能是失败重试');
  const alts = root.entries.filter(e => e._altOf);
  assert.equal(alts.length, 2, '两个失败重试都进翻页');
});

test('parseTelegramExport：相册（同 grouped_id 的多张图）合成一条记录', () => {
  const json = JSON.stringify({
    id: 1, name: 'T',
    messages: [
      { id: 10, type: 'message', date_unixtime: '1700000000', from: 'A',
        text: '', photo: 'photos/photo_1.jpg', grouped_id: 777 },
      { id: 11, type: 'message', date_unixtime: '1700000001', from: 'A',
        text: '', photo: 'photos/photo_2.jpg', grouped_id: 777 },
      { id: 12, type: 'message', date_unixtime: '1700000002', from: 'A',
        text: '配文', photo: 'photos/photo_3.jpg', grouped_id: 777 },
    ],
  });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 1, '相册只生成一条记录');
  const text = root.entries[0].text;
  assert.equal((text.match(/!\[\]\(attachments\//g) || []).length, 3, '三张图都在同一条里');
  assert.match(text, /配文/);
  assert.equal(root.entries[0].createdAt, 1700000000000, '时间取最早一张');
  assert.equal(root.createdAtMs, 1700000000000 - 1, '话题时间 = 首条 - 1ms');
});

test('parseTelegramExport：回复相册里任意一张 → 链到同一条记录', () => {
  const json = JSON.stringify({
    id: 1, name: 'T',
    messages: [
      { id: 10, type: 'message', date_unixtime: '1700000000', from: 'A',
        text: '', photo: 'photos/a.jpg', grouped_id: 9 },
      { id: 11, type: 'message', date_unixtime: '1700000001', from: 'A',
        text: '', photo: 'photos/b.jpg', grouped_id: 9 },
      { id: 20, type: 'message', date_unixtime: '1700000010', from: 'B',
        text: '回复第二张', reply_to_message_id: 11 },
    ],
  });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.equal(root.entries[1]._replyTo, root.entries[0], '回复图 2 也指向相册那条记录');
});

/* ---------- 贴纸 ---------- */

const stickerMsg = (over) => Object.assign({
  id: 1, type: 'message', date_unixtime: '1700000000', from: 'A',
  media_type: 'sticker', sticker_emoji: '⭐', text: '',
}, over);

test('parseTelegramExport：静态贴纸用原文件', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [stickerMsg({
    file: 'stickers/sticker.webp',
    thumbnail: 'stickers/sticker.webp_thumb.jpg',
    mime_type: 'image/webp',
  })] });
  const e = parseTelegramExport(json)[0].root.entries[0];
  assert.match(e.text, /!\[sticker:⭐\]\(attachments\/sticker\.webp\)/);
  assert.deepEqual(e._copy, [{ source: 'stickers/sticker.webp', target: 'sticker.webp' }]);
});

test('parseTelegramExport：动画贴纸用 _thumb.jpg', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [stickerMsg({
    file: 'stickers/AnimatedSticker.tgs',
    thumbnail: 'stickers/AnimatedSticker.tgs_thumb.jpg',
    mime_type: 'application/x-tgsticker',
  })] });
  const e = parseTelegramExport(json)[0].root.entries[0];
  assert.match(e.text, /attachments\/AnimatedSticker\.tgs_thumb\.jpg/);
  assert.deepEqual(e._copy, [{ source: 'stickers/AnimatedSticker.tgs_thumb.jpg', target: 'AnimatedSticker.tgs_thumb.jpg' }]);
});

test('parseTelegramExport：贴纸没有文件也没有缩略图 → emoji 占位', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [stickerMsg({
    file: '(File not included. Change data exporting settings to download.)',
    thumbnail: '(File not included. Change data exporting settings to download.)',
    mime_type: 'video/webm', sticker_emoji: '😅',
  })] });
  const e = parseTelegramExport(json)[0].root.entries[0];
  assert.match(e.text, /:::sticker 😅:::/);
  assert.equal(e._copy, undefined);
});

test('parseTelegramExport：同一贴纸重复发 → 同一个附件目标', () => {
  const m = stickerMsg({ file: 'stickers/sticker.webp', mime_type: 'image/webp' });
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { ...m, id: 1 }, { ...m, id: 2, date_unixtime: '1700000001' },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.equal(root.entries[0]._copy[0].target, 'sticker.webp');
  assert.equal(root.entries[1]._copy[0].target, 'sticker.webp');
});

test('parseTelegramExport：不同贴纸撞文件名 → 目标名加后缀', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    stickerMsg({ id: 1, file: 'stickers/a/sticker.webp', mime_type: 'image/webp' }),
    stickerMsg({ id: 2, date_unixtime: '1700000001', file: 'stickers/b/sticker.webp', mime_type: 'image/webp' }),
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries[0]._copy[0].target, 'sticker.webp');
  assert.equal(root.entries[1]._copy[0].target, 'sticker_2.webp');
});

/* ---------- 已注销账号 ---------- */

test('parseTelegramExport：from 为 null 的消息标记为已注销账号', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'user1', text: '你好' },
    { id: 2, type: 'message', date_unixtime: '1700000001', from: null, from_id: 'user0', text: '匿名消息' },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.match(root.entries[0].text, /^\*\*A\*\*/);
  assert.match(root.entries[1].text, /^\*\*（已注销账号）\*\*/);
  assert.match(root.entries[1].text, /匿名消息/);
});

test('parseTelegramExport：Deleted Account 归一化为已注销账号', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'message', date_unixtime: '1700000000', from: 'B', from_id: 'user2', text: '嗨' },
    { id: 2, type: 'message', date_unixtime: '1700000001', from: 'Deleted Account', from_id: 'user3', text: '旧消息' },
    { id: 3, type: 'message', date_unixtime: '1700000002', from: '此用户已注销', from_id: 'user4', text: '另一条' },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.match(root.entries[1].text, /^\*\*（已注销账号）\*\*/);
  assert.match(root.entries[2].text, /^\*\*（已注销账号）\*\*/);
});

test('parseQQExport：空发送者标记为已注销账号', () => {
  const json = JSON.stringify([{
    chatInfo: { name: 'Q', peerUid: 'g1' },
    messages: [
      { id: 1, timestamp: 1700000000000, sender: { uid: 'u1', name: 'A' }, content: { text: '嗨' } },
      { id: 2, timestamp: 1700000001000, sender: { uid: 'u2', name: '' }, content: { text: '旧消息' } },
    ],
  }]);
  const root = parseQQExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.match(root.entries[0].text, /^\*\*A\*\*/);
  assert.match(root.entries[1].text, /^\*\*（已注销账号）\*\*/);
});

test('parseTelegramExport：service pin_message 恢复置顶', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'u1', text: '被置顶' },
    { id: 2, type: 'service', date_unixtime: '1700000001', action: 'pin_message', message_id: 1 },
    { id: 3, type: 'message', date_unixtime: '1700000002', from: 'A', from_id: 'u1', text: '后面的' },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.deepEqual(root._importPins, [root.entries[0].createdAt]);
});

test('parseTelegramExport：service 消息生成系统行', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'service', date_unixtime: '1700000000',
      actor: 'A', action: 'join_group_by_link' },
    { id: 2, type: 'message', date_unixtime: '1700000001', from: 'A', from_id: 'u1', text: '嗨' },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.match(root.entries[0].text, /^:::system\n/);
  assert.match(root.entries[0].text, /加入了群组/);
});

test('parseTelegramExport：service 消息生成系统行（流式）', async () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'service', date_unixtime: '1700000000',
      actor: 'A', action: 'join_group_by_link' },
    { id: 2, type: 'message', date_unixtime: '1700000001', from: 'A', from_id: 'u1', text: '嗨' },
  ] });
  const conv = (await parseTelegramStream(new Blob([json])))[0];
  assert.equal(conv.root.entries.length, 2);
  assert.match(conv.root.entries[0].text, /^:::system\n/);
});

test('parseTelegramExport：多置顶保留全部 pin 事件（unpin 才移除）', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'u1', text: '一' },
    { id: 2, type: 'message', date_unixtime: '1700000001', from: 'A', from_id: 'u1', text: '二' },
    { id: 3, type: 'service', date_unixtime: '1700000002', action: 'pin_message', message_id: 1 },
    { id: 4, type: 'service', date_unixtime: '1700000003', action: 'pin_message', message_id: 2 },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.equal(root.entries.length, 2);
  assert.deepEqual(root._importPins, [root.entries[0].createdAt, root.entries[1].createdAt]);
});

test('parseTelegramExport：unpin 的消息不会留在置顶', () => {
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'u1', text: '一' },
    { id: 2, type: 'message', date_unixtime: '1700000001', from: 'A', from_id: 'u1', text: '二' },
    { id: 3, type: 'service', date_unixtime: '1700000002', action: 'pin_message', message_id: 1 },
    { id: 4, type: 'service', date_unixtime: '1700000003', action: 'pin_message', message_id: 2 },
    { id: 5, type: 'service', date_unixtime: '1700000004', action: 'unpin_message', message_id: 1 },
  ] });
  const root = parseTelegramExport(json)[0].root;
  assert.deepEqual(root._importPins, [root.entries[1].createdAt]);
});

/* ---------- 流式解析（大文件导入用） ---------- */

test('parseTelegramStream：与同步解析结果一致', async () => {
  const json = JSON.stringify({
    id: 1, name: 'T', type: 'personal_chat',
    messages: [
      { id: 1, type: 'message', date_unixtime: '1700000000', from: 'A', from_id: 'u1', text: '嗨' },
      { id: 2, type: 'message', date_unixtime: '1700000001', from: 'B', from_id: 'u2', grouped_id: 'g1', photo: 'photos/a.jpg', text: '' },
      { id: 3, type: 'message', date_unixtime: '1700000002', from: 'B', from_id: 'u2', grouped_id: 'g1', photo: 'photos/b.jpg', text: '' },
      { id: 4, type: 'message', date_unixtime: '1700000003', from: 'A', from_id: 'u1', reply_to_message_id: 1, text: '回你' },
      { id: 5, type: 'message', date_unixtime: '1700000004', from: 'B', from_id: 'u2', media_type: 'sticker', mime_type: 'image/webp', sticker_emoji: '💖', file: 'stickers/x.webp', text: '' },
      { id: 6, type: 'service', date_unixtime: '1700000005', action: 'pin_message' },
    ],
  });
  const a = parseTelegramExport(json)[0];
  const b = (await parseTelegramStream(new Blob([json])))[0];
  assert.equal(b.root.entries.length, a.root.entries.length);
  for (let i = 0; i < a.root.entries.length; i++) {
    assert.equal(b.root.entries[i].text, a.root.entries[i].text, 'entry ' + i);
    assert.equal(b.root.entries[i].createdAt, a.root.entries[i].createdAt);
    const ca = (a.root.entries[i]._copy || []).map(x => x.target);
    const cb = (b.root.entries[i]._copy || []).map(x => x.target);
    assert.deepEqual(cb, ca);
    const ra = a.root.entries[i]._replyTo;
    const rb = b.root.entries[i]._replyTo;
    assert.equal(!!rb, !!ra);
    if (ra) assert.equal(rb.text, ra.text);
  }
});
