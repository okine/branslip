// tests/import-graph.test.js
/* 静态导入图检查：
 *   - 所有相对 import/export/dynamic import 目标都存在
 *   - 不出现循环依赖
 *   - 除兼容壳 composer-time.js 外，所有 app/*.js 都能从 app.js 到达
 *
 * 这不是替代 module-load 的运行时检查，而是提前抓“新增了一条反向 import”
 * 这种只有读依赖图才能看见的问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(APP, 'app.js');
const LEGACY_UNREACHABLE = new Set(['composer-time.js', 'toolbar.js']);

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'vendor' || ent.name === 'tests') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(full));
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(src) {
  const s = stripComments(src);
  const specs = new Set();

  /* import './x.js' */
  for (const m of s.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    specs.add(m[1]);
  }
  /* import { ... } from './x.js' / export { ... } from './x.js' */
  for (const m of s.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g
  )) {
    specs.add(m[1]);
  }
  /* 动态 import('./x.js') */
  for (const m of s.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specs.add(m[1]);
  }
  return [...specs].filter(x => x.startsWith('.'));
}

test('导入图：目标存在、无循环、App 模块可达', () => {
  const files = listJs(APP);
  const graph = new Map();
  const missing = [];

  for (const file of files) {
    const edges = [];
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
      const target = path.resolve(path.dirname(file), spec);
      /* 只处理本目录内的 .js */
      if (!target.endsWith('.js')) continue;
      if (!fs.existsSync(target)) {
        missing.push(path.relative(APP, file) + ' -> ' + spec);
        continue;
      }
      edges.push(target);
    }
    graph.set(file, edges);
  }

  assert.deepEqual(missing, [], '存在指向不存在文件的 import');

  /* 循环检测 */
  const color = new Map();   // 0 未访问 / 1 栈中 / 2 完成
  const stack = [];
  const cycles = [];

  function visit(file) {
    color.set(file, 1);
    stack.push(file);
    for (const next of graph.get(file) || []) {
      if (!graph.has(next)) continue;
      const c = color.get(next) || 0;
      if (c === 1) {
        const i = stack.indexOf(next);
        cycles.push(stack.slice(i).concat(next).map(f => path.relative(APP, f)).join(' -> '));
      } else if (c === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(file, 2);
  }

  for (const file of files) if (!color.get(file)) visit(file);
  assert.deepEqual(cycles, [], '发现循环依赖');

  /* 可达性：从 app.js 出发 */
  const reachable = new Set();
  const walkReach = file => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const next of graph.get(file) || []) walkReach(next);
  };
  walkReach(ROOT);

  const unreachable = files
    .filter(f => !reachable.has(f))
    .map(f => path.relative(APP, f))
    .filter(f => !LEGACY_UNREACHABLE.has(f));
  assert.deepEqual(unreachable, [], '存在 app.js 到不了的模块');
});
