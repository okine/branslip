// tests/import-copy.test.js
'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './_browser-stubs.js';

const { parseTelegramExport, importTelegramAsTopics } = await import('../import-telegram.js');
const { imageRefs } = await import('../md.js');

/* 内存目录：模拟 FileSystemDirectoryHandle，足够跑导入/复制 */
function memDir(name) {
  const files = new Map(), dirs = new Map();
  return {
    kind: 'directory', name,
    async getFileHandle(n, o) {
      if (!files.has(n)) {
        if (!(o && o.create)) { const e = new Error('NF'); e.name = 'NotFoundError'; throw e; }
        files.set(n, Buffer.alloc(0));
      }
      const buf = files.get(n);
      return {
        async getFile() {
          return { name: n, size: buf.length, type: '',
            text: async () => buf.toString('utf8'),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
        },
        async createWritable() {
          let s = '';
          return { async write(v) { s += String(v); }, async close() { files.set(n, Buffer.from(s)); }, async abort() {} };
        },
      };
    },
    async getDirectoryHandle(n, o) {
      if (!dirs.has(n)) {
        if (!(o && o.create)) { const e = new Error('NF'); e.name = 'NotFoundError'; throw e; }
        dirs.set(n, memDir(n));
      }
      return dirs.get(n);
    },
    async removeEntry(n) { files.delete(n); dirs.delete(n); },
    async *entries() {
      for (const [n] of files) yield [n, { kind: 'file' }];
      for (const [n] of dirs) yield [n, { kind: 'directory' }];
    },
    _files: files, _dirs: dirs,
  };
}

function exportDirWith(names) {
  const root = memDir('export');
  const photos = memDir('photos');
  for (const n of names) photos._files.set(n, Buffer.from('x'));
  root._dirs.set('photos', photos);
  return root;
}

function msg(id, at, text, extra) {
  return Object.assign({
    id, type: 'message', date_unixtime: String(at),
    from: 'A', from_id: 'user1', text,
  }, extra || {});
}

test('图片复制：回复引用图片时，不吞掉回复自己的图片', async () => {
  /* 被引用消息：55 字正文 + 图片；previewText 截 60 字正好切进 ![](...) */
  const long = 'x'.repeat(55);
  const json = JSON.stringify({ id: 1, name: 'T', messages: [
    msg(1, 1700000000, long, { photo: 'photos/p1.jpg' }),
    msg(2, 1700000001, '', { photo: 'photos/p2.jpg', reply_to_message_id: 1 }),
  ] });
  const store = memDir('store');
  const steps = [];
  const created = await importTelegramAsTopics(
    store,
    parseTelegramExport(json),
    null,
    { photoDir: exportDirWith(['p1.jpg', 'p2.jpg']), step: fn => { steps.push(1); return fn(() => {}); } }
  );
  const n = created[0];
  /* 刚导入的内存节点也要带 source/owner，否则右键菜单看不到"设置主视角" */
  assert.equal(n.source, 'telegram');
  assert.equal(n.owner, null);
  const att = n._dir._dirs.get('attachments');
  assert.deepEqual([...att._files.keys()].sort(), ['p1.jpg', 'p2.jpg']);
  assert.equal(n.entries.length, 2);
  /* 回复头里应是 [图片] 占位，不能是没闭合的 ![]() */
  assert.match(n.entries[1].text, /\[图片\]/);
  assert.doesNotMatch(n.entries[1].text.split('\n')[0], /!\[/);
  /* 回复正文里自己的图片还在 */
  assert.ok(imageRefs(n.entries[1].text).some(r => r.path === 'attachments/p2.jpg'));
  assert.ok(steps.length >= 3, '应当被拆成多个队列步骤');
});

test('任务细分：40 张图至少分成 2 批复制，进度按步推进', async () => {
  const messages = [];
  const names = [];
  for (let i = 0; i < 40; i++) {
    const name = 'n' + i + '.jpg';
    names.push(name);
    messages.push(msg(i + 1, 1700000000 + i, '', { photo: 'photos/' + name }));
  }
  const json = JSON.stringify({ id: 1, name: 'T', messages });
  const store = memDir('store');
  const steps = [];
  const reports = [];
  const stats = { topics: 0, entries: 0, images: 0, imageFailed: 0, pins: 0, services: 0, failedConvs: 0, failures: [] };
  const created = await importTelegramAsTopics(
    store,
    parseTelegramExport(json),
    null,
    {
      photoDir: exportDirWith(names),
      stats,
      step: fn => { steps.push(1); return fn((d, t) => reports.push([d, t])); },
    }
  );
  const n = created[0];
  const att = n._dir._dirs.get('attachments');
  assert.equal(att._files.size, 40);
  assert.equal(stats.topics, 1);
  assert.equal(stats.entries, 40);
  assert.equal(stats.images, 40);
  assert.equal(stats.imageFailed, 0);
  assert.ok(steps.length >= 5, '30 张一批 + 月份 + 话题，步骤数应明显大于 1');
  assert.equal(reports.length, 42, '40 次复制 + 1 个月份 + 1 个话题');
  assert.deepEqual(reports[reports.length - 1], [42, 42]);
});
