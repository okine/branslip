// tests/timeline.test.js
/* io.js 的时之间数据层 —— 区间 + 时间点，createdAt 当主键。
 *
 * 守两条不变量：
 *   ① createdAt 是只读身份，改 from / at 之后仍然定位得到同一条
 *   ② 两条记录撞上同一个 from / at 时不会串台（老实现拿它们当 key，会串）
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { rootEl } from './_browser-stubs.js';
globalThis.document.querySelector = sel => rootEl(sel);
globalThis.document.getElementById = id => rootEl('#' + id);

const { Store } = await import('../store.js');
const {
  readTimeline, writeTimeline,
  addTimelineRange, updateTimelineRange, removeTimelineRange,
  addTimelinePoint, updateTimelinePoint, removeTimelinePoint,
  TIMELINE_FILE,
} = await import('../io.js');

/* ---------- 内存目录句柄（够 writeJson / readJson 用） ---------- */
function makeDir() {
  const fs = new Map();
  const dirs = new Set();
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

const seed = async data => {
  writeTimeline && (await writeTimeline(data));
};

beforeEach(() => {
  const dir = makeDir();
  Store.setDir(dir);
  Store.fs.ready = false;      // 不走 writer 队列
  Store.fs.pending = 0;
  Store.fs.hasError = false;
  Store.fs.chain = Promise.resolve();
});

/* ============================================================
 * 读 / 写
 * ============================================================ */

test('readTimeline：文件不存在 → 空数组', async () => {
  const t = await readTimeline();
  assert.deepEqual(t, { points: [], ranges: [] });
});

test('readTimeline：丢掉没有 createdAt 的老数据', async () => {
  /* 明确不兼容老格式 —— 老记录会被过滤掉，这是有意的 */
  await writeTimeline({
    ranges: [{ from: 1000, to: null, label: '老区间' }],
    points: [{ at: 2000, label: '老时间点' }],
  });
  const t = await readTimeline();
  assert.equal(t.ranges.length, 0);
  assert.equal(t.points.length, 0);
});

test('readTimeline：按 createdAt 升序返回', async () => {
  await writeTimeline({
    ranges: [
      { createdAt: 300, from: 1, to: null, label: 'c' },
      { createdAt: 100, from: 1, to: null, label: 'a' },
      { createdAt: 200, from: 1, to: null, label: 'b' },
    ],
    points: [
      { createdAt: 500, at: 1, label: 'y' },
      { createdAt: 400, at: 1, label: 'x' },
    ],
  });
  const t = await readTimeline();
  assert.deepEqual(t.ranges.map(r => r.label), ['a', 'b', 'c']);
  assert.deepEqual(t.points.map(p => p.label), ['x', 'y']);
});

/* ============================================================
 * 新增：createdAt 发号
 * ============================================================ */

test('addTimelineRange：写入 createdAt + from/to/label', async () => {
  await addTimelineRange(1000, null, '工作');
  const { ranges } = await readTimeline();

  assert.equal(ranges.length, 1);
  const r = ranges[0];
  assert.equal(typeof r.createdAt, 'number');
  assert.equal(r.from, 1000);
  assert.equal(r.to, null, 'to=null 表示进行中');
  assert.equal(r.label, '工作');
});

test('addTimelinePoint：写入 createdAt + at/label', async () => {
  await addTimelinePoint(2000, '开始学画画');
  const { points } = await readTimeline();

  assert.equal(points.length, 1);
  assert.equal(typeof points[0].createdAt, 'number');
  assert.equal(points[0].at, 2000);
  assert.equal(points[0].label, '开始学画画');
});

test('★ createdAt 严格递增：连点两下也不会撞号', async () => {
  const floor = Date.now() - 5000;
  await addTimelineRange(floor, null, '一');
  await addTimelineRange(floor, null, '二');
  await addTimelinePoint(floor, '三');
  await addTimelineRange(floor, null, '四');

  const t = await readTimeline();

  /* 全部号互不相同 */
  const keys = [...t.ranges, ...t.points].map(x => x.createdAt);
  assert.equal(new Set(keys).size, keys.length, '四条记录的 createdAt 必须互不相同');

  /* 区间内部按 createdAt 严格递增（readTimeline 用 createdAt 排序，
     时间点那边的顺序不受区间影响，所以分开断言 —— 拼在一起本来就不单调） */
  for (const arr of [t.ranges, t.points]) {
    for (let i = 1; i < arr.length; i++) {
      assert.ok(arr[i].createdAt > arr[i - 1].createdAt,
        '同一个数组内 createdAt 要严格递增');
    }
  }

  /* 共用一个序号空间：把所有号从小到大排，应当正好等于发号的先后顺序 */
  const order = [...t.ranges, ...t.points]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(x => x.label);
  assert.deepEqual(order, ['一', '二', '三', '四'], '号的大小顺序 = 记录被记下的先后');
});

/* ============================================================
 * 区间：按 createdAt 定位
 * ============================================================ */

test('★ 改过起点之后，仍然能按 createdAt 找到同一条（老实现会失联）', async () => {
  await addTimelineRange(1000, null, '工作');
  const key = (await readTimeline()).ranges[0].createdAt;

  await updateTimelineRange(key, { from: 5000 });
  assert.equal((await readTimeline()).ranges[0].from, 5000);

  /* 关键：第二次操作还按 createdAt 找 —— 老实现会拿 5000 去 find，找不到自己 */
  const r2 = await updateTimelineRange(key, { label: '改过的名字' });
  assert.ok(r2, '必须还能定位到');
  assert.equal(r2.label, '改过的名字');
  assert.equal(r2.from, 5000, '起点保持上一次改的值');
});

test('★ 两个区间的 from 相同时互不干扰', async () => {
  await addTimelineRange(7777, null, '甲');
  await addTimelineRange(7777, null, '乙');

  const t = await readTimeline();
  assert.equal(t.ranges.length, 2);
  assert.equal(t.ranges[0].from, t.ranges[1].from, '前提：两条起点撞了');
  assert.notEqual(t.ranges[0].createdAt, t.ranges[1].createdAt);

  await updateTimelineRange(t.ranges[1].createdAt, { label: '只改乙' });
  const after = await readTimeline();
  assert.equal(after.ranges[0].label, '甲', '甲不能被误改');
  assert.equal(after.ranges[1].label, '只改乙');
});

test('updateTimelineRange：终止进行中区间（to 从 null 变具体值）', async () => {
  await addTimelineRange(1000, null, '工作');
  const key = (await readTimeline()).ranges[0].createdAt;

  await updateTimelineRange(key, { to: 9000 });
  const r = (await readTimeline()).ranges[0];
  assert.equal(r.to, 9000);
  assert.equal(r.from, 1000, 'from 不受影响');
});

test('updateTimelineRange：to: null 能显式写回"进行中"', async () => {
  await addTimelineRange(1000, 2000, '工作');
  const key = (await readTimeline()).ranges[0].createdAt;

  await updateTimelineRange(key, { to: null });
  assert.equal((await readTimeline()).ranges[0].to, null);
});

test('updateTimelineRange：createdAt 不在 → null，不改内容', async () => {
  await addTimelineRange(1000, null, '工作');
  assert.equal(await updateTimelineRange(999999, { label: 'x' }), null);
  assert.equal((await readTimeline()).ranges[0].label, '工作');
});

test('updateTimelineRange：patch 里给 createdAt 也会被忽略（身份只读）', async () => {
  await addTimelineRange(1000, null, '工作');
  const key = (await readTimeline()).ranges[0].createdAt;

  await updateTimelineRange(key, { createdAt: 42, label: '改了' });
  const r = (await readTimeline()).ranges[0];
  assert.equal(r.createdAt, key, 'createdAt 不能被 patch 改掉');
  assert.equal(r.label, '改了');
});

test('removeTimelineRange：按 createdAt 删，命中返回 true', async () => {
  await addTimelineRange(1000, null, '甲');
  await addTimelineRange(2000, null, '乙');
  const t = await readTimeline();

  assert.equal(await removeTimelineRange(t.ranges[0].createdAt), true);
  const after = await readTimeline();
  assert.deepEqual(after.ranges.map(r => r.label), ['乙']);

  assert.equal(await removeTimelineRange(t.ranges[0].createdAt), false, '再删一次 → false');
});

/* ============================================================
 * 时间点
 * ============================================================ */

test('★ 改过时刻之后仍然能按 createdAt 找到同一条', async () => {
  await addTimelinePoint(1000, '开始学画画');
  const key = (await readTimeline()).points[0].createdAt;

  await updateTimelinePoint(key, { at: 8888 });
  const p = await updateTimelinePoint(key, { label: '改过的名字' });
  assert.ok(p, '改过 at 之后还要能定位');
  assert.equal(p.at, 8888);
  assert.equal(p.label, '改过的名字');
});

test('★ 两个时间点的 at 相同时互不干扰', async () => {
  /* 手输时间只到分钟精度，撞 at 很容易发生 */
  await addTimelinePoint(60000, '甲');
  await addTimelinePoint(60000, '乙');
  const t = await readTimeline();

  assert.equal(t.points[0].at, t.points[1].at, '前提：两条时刻撞了');
  await updateTimelinePoint(t.points[0].createdAt, { label: '只改甲' });

  const after = await readTimeline();
  assert.equal(after.points[0].label, '只改甲');
  assert.equal(after.points[1].label, '乙');
});

test('removeTimelinePoint：按 createdAt 删', async () => {
  await addTimelinePoint(1000, '甲');
  await addTimelinePoint(2000, '乙');
  const key = (await readTimeline()).points[1].createdAt;

  assert.equal(await removeTimelinePoint(key), true);
  assert.deepEqual((await readTimeline()).points.map(p => p.label), ['甲']);
});

/* ============================================================
 * 区间和时间点互不串台
 * ============================================================ */

test('★ 区间和时间点撞上同一个时间值也不会互相影响', async () => {
  await addTimelineRange(5000, null, '区间');
  await addTimelinePoint(5000, '时间点');
  const t = await readTimeline();

  await updateTimelinePoint(t.points[0].createdAt, { label: '只改时间点' });
  await updateTimelineRange(t.ranges[0].createdAt, { label: '只改区间' });

  const after = await readTimeline();
  assert.equal(after.ranges[0].label, '只改区间');
  assert.equal(after.points[0].label, '只改时间点');
  assert.equal(after.ranges.length, 1);
  assert.equal(after.points.length, 1);
});

test('两边共用同一个 createdAt 序号空间（不会分头从 1 开始）', async () => {
  await addTimelineRange(1000, null, '区间');
  await addTimelinePoint(2000, '时间点');
  const t = await readTimeline();

  assert.notEqual(t.ranges[0].createdAt, t.points[0].createdAt);
});
