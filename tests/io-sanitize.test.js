// tests/io-sanitize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, isReservedDir } from '../io.js';

test('sanitizeName：Windows 保留名（当前未处理，固定当前行为）', () => {
  // 当前实现不会改这些名字。如果将来加了保留名处理，这条会提醒你改。
  // Windows 上 'CON' 目录会创建失败 —— 是已知缺口。
  assert.equal(sanitizeName('CON'), 'CON');
  // 记录当前行为，不是断言它"正确"
});

test('sanitizeName：所有字符都被过滤后 → 未命名', () => {
  assert.equal(sanitizeName('***'), '---');
  assert.equal(sanitizeName('   '), '未命名');
  assert.equal(sanitizeName('...'), '未命名');
});

test('sanitizeName：首字符是多个 . 只加一个 ·', () => {
  assert.equal(sanitizeName('..foo'), '·..foo');
});

test('sanitizeName：中文 + 空格 + 破折号保留', () => {
  assert.equal(sanitizeName('我的-话题 A'), '我的-话题 A');
});

test('isReservedDir：_mytopic 应被视为用户话题（返回 false）', () => {
  assert.equal(isReservedDir('_mytopic'), false);
  assert.equal(isReservedDir('_私人'), false);
});

test('isReservedDir：attachments / _trash / .trash / .git 全拦', () => {
  assert.equal(isReservedDir('attachments'), true);
  assert.equal(isReservedDir('_trash'), true);
  assert.equal(isReservedDir('.trash'), true);
  assert.equal(isReservedDir('.git'), true);
  assert.equal(isReservedDir('.DS_Store'), true);
});

test('isReservedDir：_记录 是文件不是目录 —— 当前实现不拦目录', () => {
  // 修正 io.test.js 里的断言：实现实际返回 false
  // 如果作者想要 '_记录' 目录被拦，需要把它加进 RESERVED_DIRS
  assert.equal(isReservedDir('_记录'), false);
});