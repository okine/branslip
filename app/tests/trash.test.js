// tests/trash.test.js
/* trash.js —— 回收站恢复。
 *
 * 重点守一条不变量：**恢复出来的 entry 必须同时进 node.entries 和
 * entryIndex**。老实现直接调 Mutate.insertSorted，只改数组不动索引，
 * 于是 Store.entry(id) 找不到它 —— 跳转 / 引用 / 编辑 / 删除全落空。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { rootEl } from './_browser-stubs.js';

/* 模块顶层就绑 #dateJump / #trashBtn 之类，桩对 #id 一律给假元素 */
globalThis.document.querySelector = sel => rootEl(sel);
globalThis.document.getElementById = id => rootEl('#' + id);

const { Store } = await import('../store.js');
const { Storage } = await import('../storage.js');
const { TRASH_FILE, readTrash } = await import('../io.js');
const { markFsReady } = await import('../writer.js');
const { doTrashRestore } = await import('../trash.js');

/* ---------- 内存目录句柄 ----------
   足够支撑 readJson / writeJson / atomicWriteText 那一套（写参数 → close 落盘
   → getFile().text() 读回校验），这样恢复路径里读写 _回收站.json 的部分是真跑的。 */
function makeDir() {
  const fs = new Map();     // name → text
  const dirs = new Set();   // 子目录名
  return {
    _fs: fs,
    async getFileHandle(name, opts) {
      if (!fs.has(name) && !dirs.has(name)) {
        if (!(opts && opts.create)) throw new DOMException('NotFound', 'NotFoundError');
        fs.set(name, '');
      }
      return {
        async getFile() { return { text: async () => fs.get(name) }; },
        async createWritable() {
          let buf = '';
          return {
            async write(t) { buf += String(t); },
            async close() { fs.set(name, buf); },
          };
        },
      };
    },
    async getDirectoryHandle(name, opts) {
      if (!dirs.has(name)) {
        if (!(opts && opts.create)) throw new DOMException('NotFound', 'NotFoundError');
        dirs.add(name);
      }
      return this;
    },
    async removeEntry(name) { fs.delete(name); dirs.delete(name); },
    async *entries() {
      for (const [n] of fs) yield [n, { kind: 'file' }];
      for (const n of dirs) yield [n, { kind: 'directory' }];
    },
  };
}

const mk = (id, title, children = [], entries = []) => ({
  id, title, _name: title, _dir: null,
  children, entries, pinned: [], folds: [],
});

let A, dir;

function setup() {
  dir = makeDir();
  A = mk('A', '工作');
  A._dir = dir;                    // 恢复时会 enqueue 月份文件写入，给它一个能写的目录
  Store.root.children = [A];
  Store.root.entries = [];
  Store.root.pinned = [];
  Store.root.folds = [];
  Store.rebuildIndex();

  Store.ui.selectedId = null;
  Store.fs.ready = false;          // 落盘那半挂起 → 只验内存 + 回收站文件
  Store.fs.pending = 0;
  Store.fs.hasError = false;
  Store.fs.chain = Promise.resolve();

  Store.setDir(dir);
  return A;
}

const item = extra => Object.assign({
  id: 't1',
  text: '被删掉的那条',
  originalMs: 1000,
  originalStamp: '2026-09-17 09:00:00.000+08:00',
  deletedAt: '2026-09-18 10:00:00.000+08:00',
  fromTopic: '工作',
  fromTopicId: null,
  pinned: false,
}, extra);

beforeEach(() => { markFsReady(); setup(); });

test('前置：内存目录能支撑回收站文件的读写往返', async () => {
  await (await import('../io.js')).writeTrash([item()]);
  const back = await readTrash();
  assert.equal(back.length, 1);
  assert.equal(back[0].text, '被删掉的那条');
});

test('★ doTrashRestore：恢复后 Store.entry(id) 必须找得到（索引同步）', async () => {
  /* 老实现直接调 Mutate.insertSorted，只改 entries 不动 entryIndex。
     这条断言就是专门钉住它的 —— 跳转 / 引用 / 编辑 / 删除都依赖这个索引。 */
  const A2 = setup();
  Store.ui.selectedId = 'A';       // 触发 doTrashRestore 里的 UI 刷新分支

  const eid = await doTrashRestore(item(), 'A');

  assert.equal(typeof eid, 'string', '恢复成功要返回新 entry 的 id');
  assert.equal(A2.entries.length, 1);
  assert.equal(A2.entries[0].id, eid);

  const hit = Store.entry(eid);
  assert.ok(hit, '恢复出来的记录必须进 entryIndex');
  assert.equal(hit.node, A2);
  assert.equal(hit.e, A2.entries[0]);
});

test('doTrashRestore：按 createdAt 插到正确位置', async () => {
  const A2 = setup();
  Store.addEntry(A2, { id: 'old', text: '更早', createdAt: 500 });
  Store.addEntry(A2, { id: 'new', text: '更晚', createdAt: 5000 });

  const eid = await doTrashRestore(item({ originalMs: 1000 }), 'A');

  assert.deepEqual(A2.entries.map(x => x.text), ['更早', '被删掉的那条', '更晚']);
  for (const e of A2.entries) assert.ok(Store.entry(e.id), '每一条都要在索引里：' + e.text);
  assert.equal(A2.entries[1].id, eid);
});

test('doTrashRestore：同毫秒冲突顺延，且顺延后的新条目也进索引', async () => {
  const A2 = setup();
  Store.addEntry(A2, { id: 'taken', text: '占了 1000ms', createdAt: 1000 });

  const eid = await doTrashRestore(item({ originalMs: 1000 }), 'A');

  const restored = A2.entries.find(x => x.id === eid);
  assert.equal(restored.createdAt, 1001, '同毫秒要顺延，否则两条排序不稳');
  assert.ok(Store.entry(eid), '顺延后的记录同样要进索引');
});

test('doTrashRestore：item.pinned 时恢复为置顶', async () => {
  const A2 = setup();
  const eid = await doTrashRestore(item({ pinned: true }), 'A');

  assert.equal(A2.pinned.includes(A2.entries[0].createdAt), true);
  assert.equal(Store.entry(eid).e, A2.entries[0]);
});

test('doTrashRestore：恢复成功后把该条从回收站文件里划掉', async () => {
  setup();
  const io = await import('../io.js');
  await io.writeTrash([item({ id: 'keep' }), item({ id: 'gone' })]);

  await doTrashRestore(item({ id: 'gone' }), 'A');

  const back = await readTrash();
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'keep', '只划掉被恢复的那条');
});

test('doTrashRestore：released 的 _writeStamp 被清掉，重新按 createdAt 生成', async () => {
  const A2 = setup();
  const eid = await doTrashRestore(item(), 'A');
  const e = A2.entries.find(x => x.id === eid);

  assert.equal(e._writeStamp, undefined, '新条目不该带旧时间串');
  const bid = (await import('../mutate.js')).Mutate.entryBlockId(e);
  assert.match(bid, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/);
});

test('doTrashRestore：话题不存在 / item 为空 → false，不动任何状态', async () => {
  const A2 = setup();
  assert.equal(await doTrashRestore(item(), '不存在'), false);
  assert.equal(await doTrashRestore(null, 'A'), false);
  assert.equal(A2.entries.length, 0);
});

test('doTrashRestore：时间戳坏掉 → false，且不写进 entries、不动回收站', async () => {
  const A2 = setup();
  const io = await import('../io.js');
  await io.writeTrash([item()]);

  const ok = await doTrashRestore(
    item({ originalMs: undefined, originalStamp: '不是时间' }), 'A');

  assert.equal(ok, false);
  assert.equal(A2.entries.length, 0, '时间戳异常时不能留下半条记录');
  assert.equal((await readTrash()).length, 1, '回收站条目也不能被划掉');
});
