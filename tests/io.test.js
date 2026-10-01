// tests/io.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeName, isReservedDir, dirOf } from '../io.js';
import { Store } from '../store.js';

/* ---------- sanitizeName ---------- */

test('sanitizeName 替换文件系统非法字符', () => {
  assert.equal(sanitizeName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
});

test('sanitizeName 折叠连续空白', () => {
  assert.equal(sanitizeName('  foo   bar  '), 'foo bar');
});

test('sanitizeName 去掉结尾的点与空格', () => {
  assert.equal(sanitizeName('foo...  '), 'foo');
});

test('sanitizeName 给以 . 或 _ 开头的名字加前缀', () => {
  assert.equal(sanitizeName('.hidden'), '·.hidden');
  assert.equal(sanitizeName('_secret'), '·_secret');
});

test('sanitizeName 去掉开头的 · 再判前缀', () => {
  // '···abc' → 去掉所有开头 · → 'abc' → 不以 . 或 _ 开头 → 'abc'
  assert.equal(sanitizeName('···abc'), 'abc');
});

test('sanitizeName 空输入回退到"未命名"', () => {
  assert.equal(sanitizeName(''), '未命名');
  assert.equal(sanitizeName(null), '未命名');
  assert.equal(sanitizeName(undefined), '未命名');
});

test('sanitizeName 保留中文与常规符号', () => {
  assert.equal(sanitizeName('工作-2026'), '工作-2026');
});

/* ---------- isReservedDir ---------- */

test('isReservedDir 拦截 attachments 与隐藏目录', () => {
  assert.equal(isReservedDir('attachments'), true);
  assert.equal(isReservedDir('.trash'), true);
  assert.equal(isReservedDir('_trash'), true);
});

test('isReservedDir 放行以 _ 开头的用户话题', () => {
  assert.equal(isReservedDir('_mytopic'), false);
  assert.equal(isReservedDir('_记录'), false);   // '_记录' 是文件不是目录
});

test('isReservedDir 放行普通话题名', () => {
  assert.equal(isReservedDir('工作'), false);
  assert.equal(isReservedDir('my-topic'), false);
});

/* ---------- dirOf ---------- */

test('dirOf 普通节点返回 _dir', () => {
  const fake = { name: 'd' };
  assert.equal(dirOf({ id: 'x', _dir: fake }), fake);
});

test('dirOf 根节点返回 Store.dir', () => {
  const fake = { name: 'root' };
  Store.setDir(fake);
  assert.equal(dirOf({ id: '__root__' }), fake);
  Store.setDir(null);
});

test('dirOf null 返回 null', () => {
  assert.equal(dirOf(null), null);
});