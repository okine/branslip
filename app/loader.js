'use strict';
/* ================= loader.js =================
 * 磁盘扫描：把目录树读成内存里的 node 树。
 *
 *   scanDir(dir, name)      读单个目录 → node
 *   scanChildren(dir)       读所有子目录 → node[]（按 _顺序.json 排）
 *
 * 只依赖 Storage / io / md / utils。不碰 UI。
 */

import { Storage } from './storage.js';
import { Store, draftTopicIds } from './store.js';
import { collapseAll, findNode, findByPath, pOf } from './tree-utils.js';
import { rewriteAllOrders } from './io.js';
import { uid }     from './utils.js';
import { MONTH_RE } from './format.js';
import { parseEntries } from './md.js';
import {
  ENTRY_FILE, isReservedDir,
  readOrder, readPins, readFolds,
} from './io.js';
import { recoverTempFiles } from './writeSecurity.js';

export async function scanChildren(dir) {
  const kids = [];
  const items = await Storage.listEntries(dir);
  for (const { name, kind } of items) {
    if (kind === 'directory' && !isReservedDir(name)) {
      const sub = await Storage.getDir(dir, name);
      kids.push(scanDir(sub, name));
    }
  }
  const list = await Promise.all(kids);
  const order = await readOrder(dir);
  if (order) {
    const idx = new Map(order.map((n, i) => [n, i]));
    list.sort((a, b) => {
      const ka = idx.has(a._name) ? idx.get(a._name) : Infinity;
      const kb = idx.has(b._name) ? idx.get(b._name) : Infinity;
      return ka !== kb ? ka - kb : a.title.localeCompare(b.title, 'zh');
    });
  } else {
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  return list;
}

export async function scanDir(dir, name) {
  await recoverTempFiles(dir);
  const node = {
    id: uid(), title: name, _name: name, _dir: dir,
    entries: [], children: [], _hasOldFile: false,
    /* 本次扫描中"读失败 / 解析失败"的月份文件名。写盘侧据此拒绝删除：
       内存里没有该月，不代表盘上没有（见 io.writeMonthFile）。 */
    _loadErrors: new Set(),
  };

  const jobs = [];
  node.topicId  = null;
  node.source   = null;
  node.sourceId = null;
  node.intro    = '';
  node.scroll   = null;
  try {
    const raw = await Storage.readText(dir, '_话题.json');
    const meta = JSON.parse(raw) || {};
    node.topicId  = meta.createdAt || null;
    node.source   = meta.source   || null;    // ★
    node.sourceId = meta.sourceId || null;    // ★
    node.intro    = typeof meta.intro === 'string' ? meta.intro : '';
    /* 简介的创建时间 / 最后更新时间（都在 _话题.json 里） */
    node.introCreatedAt = typeof meta.introCreatedAt === 'string' ? meta.introCreatedAt : null;
    node.introAt  = typeof meta.introAt === 'string' ? meta.introAt : null;
    if (meta.scroll && Number.isFinite(meta.scroll.top)) {
      node.scroll = { top: meta.scroll.top };
      /* 顶部锚点（新格式才有）：记录 id + 像素偏移，跨分页/清缓存更稳 */
      if (typeof meta.scroll.id === 'string' && meta.scroll.id) {
        node.scroll.id = meta.scroll.id;
        node.scroll.off = Number.isFinite(meta.scroll.off) ? meta.scroll.off : 0;
      }
    }
  } catch (e) {}

  const items = await Storage.listEntries(dir);
  for (const { name: fn, kind } of items) {
    if (kind !== 'file') continue;
    if (fn === ENTRY_FILE || MONTH_RE.test(fn)) {
      if (fn === ENTRY_FILE) node._hasOldFile = true;
      jobs.push((async () => {
        try {
          const txt = await Storage.readText(dir, fn);
          const parsed = parseEntries(txt);
          /* 有 "## " 条目行却解析出 0 条 = 解析失败（不是空月份）。
             旧判断用 /^#\s/，而月份文件第一行恒为 "# 话题 · YYYY-MM"，
             所以这条告警从未触发过。 */
          if (!parsed.length && /^##\s/m.test(txt)) {
            node._loadErrors.add(fn);
            console.error('[scanDir] 有条目行但解析出 0 条，已标记为不可删除:',
              node.title, fn, txt.slice(0, 200));
          }
          node.entries.push(...parsed);
        } catch (e) {
          node._loadErrors.add(fn);
          console.error('[scanDir] 读取失败:', node.title, fn, e);
        }
      })());
    }
  }
  await Promise.all(jobs);
  node.entries.sort((a, b) => a.createdAt - b.createdAt);

  /* 去重：旧单文件合并、追加写入崩溃导致的双重落盘，都靠这里兜底 */
  {
    const seen = new Set();
    node.entries = node.entries.filter(e => {
      const k = e.createdAt + '\u0000' + e.text;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  const [pinned, folds, children] = await Promise.all([
    readPins(node),
    readFolds(node),
    scanChildren(dir),
  ]);
  node.pinned = pinned;
  node.folds = folds;
  node.children = children;
  return node;
}

/* ---------- 重扫（app.js 只负责注入渲染能力） ---------- */
let PORTS = {};
export function wireLoader(p) { Object.assign(PORTS, p || {}); }

/* 这些能力由 app.js 注入，loader 本身不碰 UI / 缓存模块 */
const say = m => { try { PORTS.toast?.(m); } catch (e) {} };
const ask = (t, m, o) => (PORTS.confirmDialog ? PORTS.confirmDialog(t, m, o) : Promise.resolve(true));

export async function rescanFromDisk() {
  if (!Store.fs.ready) { say('尚未连接文件夹'); return; }

  if (Store.fs.pending > 0) {
    const wait = await ask(
      '还有写入未完成',
      '有 ' + Store.fs.pending + ' 个磁盘写入任务正在排队。\n' +
      '重新读取磁盘前建议先等它们完成，否则可能读到旧内容。',
      { okText: '等待完成', cancelText: '直接重扫' }
    );
    if (wait) {
      say('等待写入完成…');
      await PORTS.waitForIdle?.();
    }
  }

  const taBefore = (typeof document !== 'undefined') ? document.querySelector('#inputArea') : null;
  const draft = (taBefore && taBefore.value.trim()) ? taBefore.value : null;
  const editing = Store.ui.editingEntry || Store.ui.renaming || Store.ui.creatingParent;

  const drafts = draftTopicIds();
  if (drafts.length) {
    const first = findNode(drafts[0]);
    const name = first ? first.title : '（已删除的话题）';
    const more = drafts.length > 1 ? '（另有 ' + (drafts.length - 1) + ' 个）' : '';
    const go = await ask(
      '有未发送的草稿',
      '有 ' + drafts.length + ' 个话题里存在未发送的草稿，最早的一个是「' + name + '」' + more + '。\n' +
      '是否先跳过去看一眼？',
      { okText: '去看看', cancelText: '继续重扫' }
    );
    if (go) { PORTS.select?.(drafts[0]); return; }
  }

  if (draft || editing) {
    const ok = await ask(
      '重新读取磁盘',
      '当前有未保存的输入框草稿或正在编辑的记录，重新读取会丢弃编辑。要继续吗？',
      { danger: true, okText: '继续' }
    );
    if (!ok) return;
  }

  const selNode = Store.ui.selectedId ? findNode(Store.ui.selectedId) : null;
  const selPath = selNode ? pOf(selNode) : null;
  const draftPath = (draft && selNode) ? pOf(selNode) : null;

  PORTS.enqueue?.(async () => {
    Store.root.children = await scanChildren(Store.dir);
    Store.rebuildIndex();
    PORTS.clearCaches?.();
    PORTS.resetMeta?.();
    try {
      const cnt = await rewriteAllOrders(Store.root);
      console.log('[rescan] 已重写 ' + cnt + ' 个顺序文件');
    } catch (e) {
      console.warn('[rescan] 重写顺序失败', e);
    }

    Store.ui.viewHistory = [];
    Store.ui.drafts.clear();
    Store.ui.viewCursor = -1;
    history.replaceState({ root: true }, '');

    Store.collapsed.clear();
    collapseAll();

    Store.ui.editingEntry = null;
    Store.ui.creatingParent = null;
    Store.ui.renaming = null;

    Store.ui.selectedId = null;
    PORTS.renderAll?.();
    const t = selPath ? findByPath(selPath) : null;
    if (t) PORTS.select?.(t.id);
    else if (Store.root.children[0]) PORTS.select?.(Store.root.children[0].id);

    if (draft && draftPath) {
      const restored = findByPath(draftPath);
      if (restored && restored.id === Store.ui.selectedId) {
        const ta2 = (typeof document !== 'undefined') ? document.querySelector('#inputArea') : null;
        if (ta2 && !ta2.value) {
          ta2.value = draft;
          ta2.dispatchEvent(new Event('input'));
        }
      }
    }

    say('已从磁盘重新读取');
  });
}
