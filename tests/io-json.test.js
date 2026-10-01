// tests/io-json.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* 最小目录句柄：files 是 name → text 的 Map */
function makeDir() {
  const files = new Map();
  return {
    _files: files,
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts?.create) throw new DOMException('NotFound', 'NotFoundError');
        files.set(name, '');
      }
      return {
        async getFile() {
          return { text: async () => files.get(name) };
        },
        async createWritable() {
          let buf = '';
          return {
            async write(t) { buf += String(t); },
            async close() { files.set(name, buf); },
          };
        },
      };
    },
    async removeEntry(n) { files.delete(n); },
    async *entries() { for (const [n] of files) yield [n, { kind: 'file' }]; },
  };
}

const { Storage } = await import('../storage.js');
Storage.readText = async (dir, name) => {
  const fh = await dir.getFileHandle(name);
  return (await fh.getFile()).text();
};

const { readJson, writeJson, pushTrash, TRASH_FILE, TRASH_MAX } = await import('../io.js');
const { Store } = await import('../store.js');

/* ---------- readJson ---------- */

test('readJson：文件缺失 → fallback', async () => {
  const dir = makeDir();
  const v = await readJson(dir, 'x.json', Array.isArray, ['fallback']);
  assert.deepEqual(v, ['fallback']);
});

test('readJson：JSON 非法 → fallback', async () => {
  const dir = makeDir();
  dir._files.set('x.json', '{ 不是 json');
  const v = await readJson(dir, 'x.json', Array.isArray, []);
  assert.deepEqual(v, []);
});

test('readJson：校验失败 → fallback', async () => {
  const dir = makeDir();
  dir._files.set('x.json', '{"a":1}');
  const v = await readJson(dir, 'x.json', Array.isArray, []);
  assert.deepEqual(v, []);
});

test('readJson：dir 为 null → fallback', async () => {
  assert.deepEqual(await readJson(null, 'x.json', Array.isArray, [1]), [1]);
});

/* ---------- writeJson 往返 ---------- */

test('writeJson → readJson 往返', async () => {
  const dir = makeDir();
  await writeJson(dir, 'x.json', { n: 1, list: ['a', 'b'] });
  const back = await readJson(dir, 'x.json', x => x && x.n === 1, null);
  assert.deepEqual(back, { n: 1, list: ['a', 'b'] });
});

/* ---------- pushTrash ---------- */

test('pushTrash：塞满后截尾，返回 dropped 数', async () => {
  Store.setDir(makeDir());
  for (let i = 0; i < TRASH_MAX + 3; i++) {
    await pushTrash({ id: 'x' + i, text: 't' + i });
  }
  const raw = JSON.parse(Store.dir._files.get(TRASH_FILE));
  assert.equal(raw.length, TRASH_MAX);
  // 最新的在最前
  assert.equal(raw[0].id, 'x' + (TRASH_MAX + 2));
  Store.setDir(null);
});

test('pushTrash：未超出上限时 dropped=0', async () => {
  Store.setDir(makeDir());
  const r = await pushTrash({ id: 'a' });
  assert.equal(r.dropped, 0);
  Store.setDir(null);
});