// tests/loader.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* 极简 in-memory 目录句柄 */
function mockDir(files = {}) {
  return {
    name: '(mock)',
    async *entries() {
      for (const [name, v] of Object.entries(files)) {
        yield [name, { kind: v.kind }];
      }
    },
    async getFileHandle(name, opts) {
      const v = files[name];
      if (!v || v.kind !== 'file') {
        if (!opts?.create) throw new DOMException('NotFound', 'NotFoundError');
        files[name] = { kind: 'file', text: '' };
      }
      const rec = files[name];
      return {
        async getFile() { return { text: async () => rec.text, size: rec.text.length }; },
        async createWritable() {
          return {
            async write(t) { rec.text = t; },
            async close() {},
            async seek() {},
          };
        },
      };
    },
    async getDirectoryHandle(name, opts) {
      const v = files[name];
      if (!v || v.kind !== 'directory') {
        if (!opts?.create) throw new DOMException('NotFound', 'NotFoundError');
        files[name] = { kind: 'directory', dir: mockDir({}) };
      }
      return files[name].dir;
    },
    async removeEntry(name) { delete files[name]; },
    _raw: files,
  };
}
globalThis.DOMException = globalThis.DOMException || class extends Error {};

const { Storage } = await import('../storage.js');
const orig = { ...Storage };
Storage.getDir = (dir, name, opts) => dir.getDirectoryHandle(name, opts);
Storage.listEntries = async dir => {
  const out = [];
  for await (const [n, h] of dir.entries()) out.push({ name: n, kind: h.kind });
  return out;
};
Storage.readText = async (dir, name) => (await dir.getFileHandle(name)).getFile().then(f => f.text());

const { scanDir, scanChildren, loadSilentTopic } = await import('../loader.js');

test('scanDir：读月份文件合并 entries，按时间排序', async () => {
  const dir = mockDir({
    '_话题.json': { kind: 'file', text: '{"createdAt":"2026-09-17 09:00:00.000+08:00"}' },
    '_记录-2026-09.md': {
      kind: 'file',
      text: [
        '# 话题 · 2026-09',
        '',
        '## 2026-09-17 09:00:00.000+08:00',
        '',
        'A',
        '',
        '## 2026-09-18 10:00:00.000+08:00',
        '',
        'B',
      ].join('\n'),
    },
  });
  const node = await scanDir(dir, '测试话题');
  assert.equal(node.entries.length, 2);
  assert.equal(node.entries[0].text, 'A');
  assert.equal(node.entries[1].text, 'B');
  assert.ok(node.entries[0].createdAt < node.entries[1].createdAt);
});

test('scanDir：silent 话题启动时只读元数据，打开后再加载', async () => {
  const dir = mockDir({
    '_话题.json': { kind: 'file', text: '{"createdAt":"2026-09-17 09:00:00.000+08:00","silent":true}' },
    '_记录-2026-09.md': {
      kind: 'file',
      text: '## 2026-09-17 09:00:00.000+08:00\n\n静默内容',
    },
  });
  const node = await scanDir(dir, '静默话题');
  assert.equal(node.silent, true);
  assert.equal(node._entriesLoaded, false);
  assert.equal(node.entries.length, 0);
  assert.equal(await loadSilentTopic(node), 1);
  assert.equal(node._entriesLoaded, true);
  assert.equal(node.entries[0].text, '静默内容');
});

test('scanDir：同 (createdAt, text) 去重', async () => {
  const dir = mockDir({
    '_记录-2026-09.md': {
      kind: 'file',
      text: [
        '## 2026-09-17 09:00:00.000+08:00',
        '',
        '重复',
        '',
        '## 2026-09-17 09:00:00.000+08:00',
        '',
        '重复',
      ].join('\n'),
    },
  });
  const node = await scanDir(dir, 'X');
  assert.equal(node.entries.length, 1, '双落盘的旧文件应该被兜底去重');
});

test('scanDir：_hasOldFile 被识别', async () => {
  const dir = mockDir({
    '_记录.md': { kind: 'file', text: '## 2026-09-17 09:00:00.000+08:00\n\n旧' },
  });
  const node = await scanDir(dir, 'X');
  assert.equal(node._hasOldFile, true);
  assert.equal(node.entries.length, 1);
});

test('scanChildren：按 _顺序.json 排序', async () => {
  const parent = mockDir({});
  await parent.getDirectoryHandle('话题A', { create: true });
  await parent.getDirectoryHandle('话题B', { create: true });
  // 写顺序文件
  const orderFile = await parent.getFileHandle('_顺序.json', { create: true });
  const w = await orderFile.createWritable();
  await w.write(JSON.stringify(['话题B', '话题A']));
  await w.close();

  const list = await scanChildren(parent);
  assert.deepEqual(list.map(n => n.title), ['话题B', '话题A']);
});

test('scanChildren：没有 _顺序.json 时按 title 排序', async () => {
  const parent = mockDir({});
  await parent.getDirectoryHandle('乙', { create: true });
  await parent.getDirectoryHandle('甲', { create: true });
  const list = await scanChildren(parent);
  assert.equal(list.length, 2);
  // 中文 localeCompare 通常 甲 < 乙
  assert.equal(list[0].title, '甲');
});

test('scanChildren：跳过 attachments / _trash / .hidden', async () => {
  const parent = mockDir({});
  await parent.getDirectoryHandle('正常', { create: true });
  await parent.getDirectoryHandle('attachments', { create: true });
  await parent.getDirectoryHandle('_trash', { create: true });
  await parent.getDirectoryHandle('.git', { create: true });
  const list = await scanChildren(parent);
  assert.deepEqual(list.map(n => n.title), ['正常']);
});

/* 完成后还原 Storage（可选，测试文件间不共享模块实例其实不需要） */

test('scanDir：_记录-2026-09.md 和 _记录-2026-10.md 合并去重', async () => {
  const dir = mockDir({
    '_记录-2026-09.md': { kind: 'file', text:
      '## 2026-09-30 09:00:00.000+08:00\n\nA' },
    '_记录-2026-10.md': { kind: 'file', text:
      '## 2026-10-01 09:00:00.000+08:00\n\nB' },
  });
  const node = await scanDir(dir, 'X');
  assert.equal(node.entries.length, 2);
  assert.ok(node.entries[0].createdAt < node.entries[1].createdAt);
});

test('scanDir：_记录.md 与 _记录-YYYY-MM.md 内容重叠时按 (createdAt,text) 去重', async () => {
  const dir = mockDir({
    '_记录.md': { kind: 'file', text:
      '## 2026-09-17 09:00:00.000+08:00\n\n同一条' },
    '_记录-2026-09.md': { kind: 'file', text:
      '## 2026-09-17 09:00:00.000+08:00\n\n同一条' },
  });
  const node = await scanDir(dir, 'X');
  assert.equal(node.entries.length, 1);
});