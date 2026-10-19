// tests/composer-time.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCreatedAtMs } from '../composer-time.js';

test('空 entries → 直接用 now', () => {
  const now = 1_700_000_000_000;
  const r = nextCreatedAtMs([], now);
  assert.equal(r.ms, now);
  assert.equal(r.drift, 0);
});

test('正常时序（now > last）→ 用 now', () => {
  const now = 1_700_000_000_000;
  const r = nextCreatedAtMs([{ createdAt: now - 1000 }], now);
  assert.equal(r.ms, now);
  assert.equal(r.drift, 0);
});

test('上一条在未来 → last+1，drift 正数', () => {
  const now = 1_700_000_000_000;
  const future = now + 3600_000;
  const r = nextCreatedAtMs([{ createdAt: future }], now);
  assert.equal(r.ms, future + 1);
  assert.equal(r.drift, 3600_000);
});

test('now === last.createdAt → last+1（同毫秒保护）', () => {
  const now = 1_700_000_000_000;
  const r = nextCreatedAtMs([{ createdAt: now }], now);
  assert.equal(r.ms, now + 1);
  assert.equal(r.drift, 0);
});

test('只读最后一条（不遍历整组）', () => {
  const now = 1_700_000_000_000;
  const r = nextCreatedAtMs([
    { createdAt: now - 10000 },
    { createdAt: now - 5000 },
    { createdAt: now - 1000 },
  ], now);
  assert.equal(r.ms, now);
});