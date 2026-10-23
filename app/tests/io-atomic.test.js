// tests/io-atomic.test.js
/* io.js —— 写盘协议 + 崩溃恢复。
 *
 * 这两条路径一旦出错就是数据丢失，所以不依赖其它模块、自己起一套
 * 完整的内存目录句柄，走真实的读写往返。
 *
 * 守的不变量：
 *   atomicWriteText 成功 → .tmp 被删；失败 → .tmp 保留（下次启动能恢复）
 *   recoverTempFiles:
 *     完整 .tmp（含尾标记）→ 覆盖目标 + 备份现有 → 删 .tmp
 *     残缺 .tmp（无尾标记）→ 丢弃，不动目标
 *     .json .tmp 剥掉尾标记后 parse 失败 → 保留 .tmp，不动目标
 *     目标不存在 → 不产生 .bak
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ---------- 内存目录句柄 ---------- */

function makeDir() {
  const files = new Map();   // name → text
  const dir = {
    _files: files,
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!(opts && opts.create)) {
          throw new DOMException('NotFound', 'NotFoundError');
        }
        files.set(name, '');
      }
      return {
        async getFile() {
          const text = files.get(name);
          return {
            text: async () => text,
            arrayBuffer: async () =>
              new TextEncoder().encode(text).buffer,
            size: text.length,
            lastModified: Date.now(),
          };
        },
        async createWritable() {
          let buf = '';
          return {
            async write(t) { buf += String(t); },
            async close() { files.set(name, buf); },
            async seek() {},
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
    async *entries() {
      for (const [n] of files) yield [n, { kind: 'file' }];
    },
  };
  return dir;
}

globalThis.DOMException = globalThis.DOMException ||
  class extends Error { constructor(msg, name) { super(msg); this.name = name || 'Error'; } };

const { Storage } = await import('../storage.js');
const orig = { ...Storage };

/* 用同一套内存句柄实现 Storage 的几个原语 —— 只补 io.js 用到的那些 */
Storage.listEntries = async dir => {
  const out = [];
  for await (const [n, h] of dir.entries()) out.push({ name: n, kind: h.kind });
  return out;
};
Storage.readText = async (dir, name) => {
  const fh = await dir.getFileHandle(name);
  return (await fh.getFile()).text();
};
Storage.getFile = async (dir, name) => {
  const fh = await dir.getFileHandle(name);   // 不存在会抛
  return fh.getFile();
};
Storage.writeBlob = async (dir, name, blob) => {
  const text = typeof blob === 'string' ? blob : await blob.text();
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
};
Storage.removeEntry = async (dir, name) => dir.removeEntry(name);

const { atomicWriteText, recoverTempFiles } = await import('../writeSecurity.js');

/* ---------- 前置：句柄能跑通往返 ---------- */

beforeEach(() => {
  /* 每个用例用全新 dir，不共享状态 */
});

/* ============================================================
 * atomicWriteText
 * ============================================================ */

test('atomicWriteText：成功路径 —— 目标写入 + .tmp 被清掉', async () => {
  const dir = makeDir();
  await atomicWriteText(dir, 'a.md', 'hello');

  assert.equal(dir._files.get('a.md'), 'hello');
  assert.equal(dir._files.has('a.md.tmp'), false, '.tmp 必须被清掉');
});

test('atomicWriteText：先写 .tmp，成功才删 —— 中间态含尾标记', async () => {
  /* 观察 .tmp 的内容，验证"尾标记是完整性凭据"这条协议 */
  const dir = makeDir();
  let tmpTextSeen = null;

  /* 打桩 createWritable：第一次写（.tmp）时抓下内容 */
  const origGet = dir.getFileHandle.bind(dir);
  dir.getFileHandle = async (name, opts) => {
    const fh = await origGet(name, opts);
    const origWrite = fh.createWritable.bind(fh);
    fh.createWritable = async () => {
      const w = await origWrite();
      const origWriteFn = w.write.bind(w);
      w.write = async t => {
        if (name.endsWith('.tmp')) tmpTextSeen = String(t);
        return origWriteFn(t);
      };
      return w;
    };
    return fh;
  };

  await atomicWriteText(dir, 'a.md', 'hello');
  assert.ok(tmpTextSeen, '.tmp 应当被写过');
  assert.ok(tmpTextSeen.endsWith('\n<<<SZJ-EOF>>>\n'), '尾标记必须存在');
  assert.ok(tmpTextSeen.startsWith('hello'), '正文在尾标记之前');
});

test('★ atomicWriteText：读回校验失败 → 抛错 + 保留 .tmp', async () => {
  const dir = makeDir();
  const origReadText = Storage.readText;

  /* 让 a.md 读回来是错的内容 —— 模拟"写盘没写全 / 被外部篡改" */
  Storage.readText = async (d, name) => {
    if (name === 'a.md') return 'CORRUPTED';
    return origReadText(d, name);
  };

  try {
    await assert.rejects(
      () => atomicWriteText(dir, 'a.md', 'expected'),
      /写入校验失败/
    );
  } finally {
    Storage.readText = origReadText;
  }

  assert.equal(dir._files.has('a.md.tmp'), true,
    '校验失败时 .tmp 必须保留 —— 下次启动才能恢复');
  assert.match(dir._files.get('a.md.tmp'), /<<<SZJ-EOF>>>/);
});

/* ============================================================
 * recoverTempFiles
 * ============================================================ */

test('recoverTempFiles：空目录 → 0', async () => {
  const dir = makeDir();
  assert.equal(await recoverTempFiles(dir), 0);
});

test('recoverTempFiles：dir 为 null → 0，不抛错', async () => {
  assert.equal(await recoverTempFiles(null), 0);
});

test('★ recoverTempFiles：完整 .tmp + 目标不存在 → 恢复，无 .bak', async () => {
  const dir = makeDir();
  dir._files.set('a.md.tmp', 'recovered content\n<<<SZJ-EOF>>>\n');

  const n = await recoverTempFiles(dir);

  assert.equal(n, 1);
  assert.equal(dir._files.get('a.md'), 'recovered content');
  assert.equal(dir._files.has('a.md.tmp'), false, '.tmp 被消费掉');
  assert.equal(dir._files.has('a.md.bak'), false,
    '目标不存在时不该产生空 .bak');
});

test('★ recoverTempFiles：完整 .tmp + 目标存在 → 覆盖前先备份', async () => {
  const dir = makeDir();
  dir._files.set('a.md', 'OLD CONTENT');
  dir._files.set('a.md.tmp', 'new content\n<<<SZJ-EOF>>>\n');

  const n = await recoverTempFiles(dir);

  assert.equal(n, 1);
  assert.equal(dir._files.get('a.md'), 'new content');
  assert.equal(dir._files.get('a.md.bak'), 'OLD CONTENT',
    '覆盖前必须把旧内容备份到 .bak');
  assert.equal(dir._files.has('a.md.tmp'), false);
});

test('★ recoverTempFiles：残缺 .tmp（无尾标记）→ 丢弃，不动目标', async () => {
  const dir = makeDir();
  dir._files.set('a.md', 'STILL GOOD');
  dir._files.set('a.md.tmp', 'half-written...');   // 没有尾标记

  const n = await recoverTempFiles(dir);

  assert.equal(n, 0);
  assert.equal(dir._files.get('a.md'), 'STILL GOOD',
    '残缺的 .tmp 不能覆盖好文件');
  assert.equal(dir._files.has('a.md.tmp'), false,
    '残缺的 .tmp 应该被清掉，免得每次启动都扫到');
});

test('recoverTempFiles：空字符串 .tmp → 丢弃', async () => {
  const dir = makeDir();
  dir._files.set('a.md.tmp', '');

  const n = await recoverTempFiles(dir);
  assert.equal(n, 0);
  assert.equal(dir._files.has('a.md.tmp'), false);
});

test('★ recoverTempFiles：.json 剥掉尾标记后 parse 失败 → 保留 .tmp，不动目标', async () => {
  const dir = makeDir();
  dir._files.set('_置顶.json', '[1000, 2000]');       // 当前内容
  dir._files.set('_置顶.json.tmp', '{ broken JSON\n<<<SZJ-EOF>>>\n');

  const n = await recoverTempFiles(dir);

  assert.equal(n, 0);
  assert.equal(dir._files.get('_置顶.json'), '[1000, 2000]',
    '结构校验失败时不能覆盖目标');
  assert.equal(dir._files.has('_置顶.json.tmp'), true,
    '.tmp 保留给用户手动处理 —— 不能悄悄删掉可能是好内容的凭据');
});

test('recoverTempFiles：非 .tmp 文件不碰', async () => {
  const dir = makeDir();
  dir._files.set('a.md', 'normal');
  dir._files.set('_话题.json', '{"createdAt":"x"}');

  const n = await recoverTempFiles(dir);
  assert.equal(n, 0);
  assert.equal(dir._files.get('a.md'), 'normal');
  assert.equal(dir._files.get('_话题.json'), '{"createdAt":"x"}');
});

test('recoverTempFiles：多个 .tmp 逐个处理', async () => {
  const dir = makeDir();
  dir._files.set('a.md.tmp', 'AAA\n<<<SZJ-EOF>>>\n');
  dir._files.set('b.md.tmp', 'BBB\n<<<SZJ-EOF>>>\n');
  dir._files.set('c.md.tmp', '残缺');   // 被丢弃

  const n = await recoverTempFiles(dir);

  assert.equal(n, 2);
  assert.equal(dir._files.get('a.md'), 'AAA');
  assert.equal(dir._files.get('b.md'), 'BBB');
  assert.equal(dir._files.has('c.md'), false);
  assert.equal(dir._files.has('c.md.tmp'), false);
});

test('recoverTempFiles：恢复一次后 .tmp 消失，再扫一遍不会重复', async () => {
  const dir = makeDir();
  dir._files.set('a.md.tmp', 'x\n<<<SZJ-EOF>>>\n');

  assert.equal(await recoverTempFiles(dir), 1);
  assert.equal(await recoverTempFiles(dir), 0, '第二次扫应当什么都不做');
});

/* ---------- 写盘 → 崩溃 → 恢复，端到端 ---------- */

test('★ 写盘一半时崩溃 → .tmp 完整 → 恢复出正确内容', async () => {
  /* 场景：atomicWriteText 第 1 步写完 .tmp，第 2 步没写目标就崩了 */
  const dir = makeDir();
  dir._files.set('note.md.tmp', '完整内容\n<<<SZJ-EOF>>>\n');

  const n = await recoverTempFiles(dir);

  assert.equal(n, 1);
  assert.equal(dir._files.get('note.md'), '完整内容');
  assert.equal(dir._files.has('note.md.tmp'), false);
});

test('★ 写盘一半时崩溃 + 目标已有旧内容 → 恢复新内容，旧内容在 .bak', async () => {
  const dir = makeDir();
  dir._files.set('note.md', '上次的内容');
  dir._files.set('note.md.tmp', '这次的内容\n<<<SZJ-EOF>>>\n');

  await recoverTempFiles(dir);

  assert.equal(dir._files.get('note.md'), '这次的内容');
  assert.equal(dir._files.get('note.md.bak'), '上次的内容');
});

/* ---------- 还原 ---------- */
test.after(() => {
  /* 让本文件之外的测试不受影响 —— 虽然 node:test 每个文件独立进程，
     显式还原更稳妥 */
  Object.assign(Storage, orig);
});
test('不完整代理项：.tmp 与正式文件都用清洗后的文本（不会校验失败）', async () => {
  const dir = makeDir();
  const raw = 'a\uD800b';              // 孤立高代理项
  const cleaned = 'a\uFFFDb';
  await atomicWriteText(dir, 'x.md', raw);
  assert.equal(dir._files.get('x.md'), cleaned, '正式文件应是清洗后的');
  assert.equal(dir._files.has('x.md.tmp'), false, '成功后 .tmp 应被删');
});
