// tests/composer-text.test.js
/* composer.js —— buildEntryText：回复 / 关联的引用头拼装。
 *
 * 守的是这条不变量：**引用里的 tid 必须是被引用条目所属的话题**，
 * 而不是"发送时输入框所在的话题"。跨话题回复时两者不同，
 * 写错就会生成指向一条不存在记录的引用。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* composer.js 顶层有 `const ta = $('#inputArea')`，必须是真元素 */
import { registerEl, fakeEl } from './_browser-stubs.js';
registerEl('#inputArea', fakeEl());

const { Store } = await import('../store.js');
const { buildEntryText } = await import('../composer.js');
const { topicRefIdFromStamp } = await import('../format.js');

const mk = (id, title, topicId) => ({
  id, title, _name: title, _dir: null, topicId,
  children: [], entries: [], pinned: [], folds: [],
});

const TID_A = '2026-09-17 09:00:00.000+08:00';
const TID_B = '2026-10-01 12:30:00.000+08:00';

let A, B;
beforeEach(() => {
  A = mk('A', '工作', TID_A);
  B = mk('B', '生活', TID_B);
  Store.root.children = [A, B];
  Store.root.entries = [];
  Store.rebuildIndex();
  Store.ui.selectedId = 'B';
});

/* ---------- 不带回复/关联 ---------- */

test('没有回复也没有关联 → 原样返回', () => {
  assert.equal(buildEntryText('随手记一句', B, null, null), '随手记一句');
});

/* ---------- 回复 ---------- */

test('回复：同话题时引用指向当前话题', () => {
  const text = buildEntryText('我的回应', B, { blockId: 'BID', text: '被回的那条', node: B }, null);

  assert.match(text, /^> 被回的那条\n> \[\[~[\d_-]+#\^BID\]\]\n\n我的回应$/);
  assert.ok(text.includes(topicRefIdFromStamp(TID_B)), '应该引用 B 的 tid');
});

test('★ 跨话题回复：引用指向条目所属话题，不是当前话题', () => {
  /* 场景：在 A 里双击某条进回复态，切到 B，然后在 B 里发送 */
  const text = buildEntryText('跨话题回应', B,
    { blockId: 'BID', text: 'A 里的那条', node: A }, null);

  assert.ok(text.includes(topicRefIdFromStamp(TID_A)),
    '必须引用 A 的 tid —— 写成 B 的 tid 就指向一条不存在的记录');
  assert.ok(!text.includes(topicRefIdFromStamp(TID_B)),
    '不能引用当前话题 B');
  assert.match(text, /\n\n跨话题回应$/);
});

test('回复：node 缺失（老调用方 / 兜底）→ 回落到当前话题', () => {
  const text = buildEntryText('x', B, { blockId: 'BID', text: 't' }, null);
  assert.ok(text.includes(topicRefIdFromStamp(TID_B)));
});

test('回复：预览只取第一行前 60 字', () => {
  const long = 'x'.repeat(100) + '\n第二行不该出现';
  const text = buildEntryText('r', B, { blockId: 'BID', text: long, node: B }, null);

  assert.ok(text.includes('x'.repeat(60)));
  assert.ok(!text.includes('第二行不该出现'));
});

/* ---------- 关联 ---------- */

test('关联：格式是 ∝ 关键字 + 引用，正文整段保留', () => {
  const text = buildEntryText('想起这个\n还有第二行', B,
    null, { blockId: 'BID', text: '源头那条', node: A });

  assert.match(text, /^> 源头那条\n∝ 想起这个 \[\[~[\d_-]+#\^BID\]\]\n\n想起这个\n还有第二行$/);
  assert.ok(text.includes(topicRefIdFromStamp(TID_A)), '关联同样要指向条目所属话题');
});

test('关联：关键字取输入第一行前 30 字，空则回落「关联」', () => {
  const withKw = buildEntryText('y'.repeat(50) + '\n正文', B,
    null, { blockId: 'BID', text: 't', node: B });
  assert.ok(withKw.includes('∝ ' + 'y'.repeat(30) + ' '));

  /* 输入以换行开头 → 第一行是空串 → 回落 */
  const noKw = buildEntryText('\n正文', B, null, { blockId: 'BID', text: 't', node: B });
  assert.ok(noKw.includes('∝ 关联 '));
});

/* ---------- 优先级 ---------- */

test('关联优先于回复（互斥逻辑失效时的兜底）', () => {
  const text = buildEntryText('x', B,
    { blockId: 'RID', text: '回复目标', node: B },
    { blockId: 'LID', text: '关联目标', node: A });

  assert.ok(text.includes('#^LID'), '应该走关联分支');
  assert.ok(!text.includes('#^RID'));
});

/* ---------- 引用格式 ---------- */

test('topicId 缺失的话题 → 回落成路径引用（不能抛出）', () => {
  const plain = mk('C', '无名', null);
  Store.root.children.push(plain);
  Store.rebuildIndex();

  const text = buildEntryText('x', B, { blockId: 'BID', text: 't', node: plain }, null);
  assert.ok(text.includes('[[无名#^BID]]'), '没有 topicId 时用路径引用');
});
