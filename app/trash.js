'use strict';
/* ================= trash.js =================
 * 回收站页面。
 *
 * 两个回收站：
 *   - 消息级：根目录 _回收站.json，可恢复/彻底删除
 *   - 话题级：根目录 .trash/，可恢复/彻底删除
 *
 * 与其它模块的边界：
 *   - 需要 renderAll（在 app）→ 通过 wireTrash 注入
 *   - renderEntries / updateTopCount / renderPins 从 entries.js 直接 import
 */

import { Storage } from './storage.js';
import { esc, uid } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { parseStamp } from './format.js';
import {
  readTrash, writeTrash, readTrashDirs,
  dirOf, uniqueName, moveDir, writeOrder,
  persistMonthOf, writePins,getTrashDir,
} from './io.js';
import { scanDir } from './loader.js';
import { enqueue } from './writer.js';
import { toast, confirmDialog, openFullPage } from './ui.js';
import { openMovePicker } from './ui-topicPicker.js';
import { walk, findByPath, findNode } from './tree-utils.js';
import { renderEntries, updateTopCount } from './entries.js';
import { renderPins } from './pins.js';

/* ---------- 依赖注入 ---------- */
let D = { renderAll: () => {} };
export function wireTrash(h) { Object.assign(D, h); }

/* ---------- 模块状态 ---------- */
let trashTab = 'msg';   /* 'msg' | 'topic' */
const recKey = x => x.id || x.deletedAt || '';

/* _trash/ 与 .trash/ 都不存在时 getTrashDir 会抛错。
   对“清空回收站”来说这是正常的空状态，不是失败。 */
function isMissingEntryError(err) {
  if (!err) return false;
  if (err.name === 'NotFoundError') return true;
  const msg = String(err.message || err);
  return /not\s*found|no such file|does not exist|不存在|os error 2/i.test(msg);
}
/* ============================================================
 * 回收站页面
 * ============================================================ */


export async function openTrashPage() {
  const arr  = await readTrash();
  const dirs = await readTrashDirs();

  const page = openFullPage({
    title: () => '回收站 · ' + (arr.length + dirs.length),
  
    actions: () => '',      // ★ 清空按钮移到侧栏
  
    sidebar: () => {        // ★ 新增
      const items = [
        { key: 'msg',   label: '消息', count: arr.length,  icon: I.pen },
        { key: 'topic', label: '话题', count: dirs.length, icon: I.folder },
      ];
      let html = items.map(it =>
        '<button class="pp-side-item' + (trashTab === it.key ? ' on' : '') +
          '" data-ttab="' + it.key + '">' +
          '<span class="pp-side-icon">' + it.icon + '</span>' +
          '<span class="pp-side-label">' + it.label + '</span>' +
          (it.count ? '<span class="pp-side-count">' + it.count + '</span>' : '') +
        '</button>'
      ).join('');
      if (arr.length + dirs.length) {
        html += '<button class="pp-side-clear tp-clear">清空</button>';
      }
      return html;
    },
  

    /* 列表内容 */
    render: () => {
      let cards = '';
      for (const t of arr) {
        const key = recKey(t);
        const preview = (t.text || '').slice(0, 300);
        cards += '<div class="pp-card tp-card" data-key="' + esc(key) + '">' +
          '<div class="tp-meta">删除于 ' + esc(t.deletedAt || '') +
            ' · 来自「' + esc(t.fromTopic || '?') + '」' +
            (t.pinned ? ' · 曾置顶' : '') + '</div>' +
          '<div class="tp-text">' + esc(preview) + '</div>' +
          '<div class="pp-acts">' +
            '<button data-trestore>恢复</button>' +
            '<button data-tforget>彻底删除</button>' +
          '</div></div>';
      }

      let topicCards = '';
      for (const t of dirs) {
        topicCards += '<div class="pp-card tp-card" data-tdir="' + esc(t.name) + '">' +
          '<div class="tp-meta">删除于 ' + esc(t.mtime || '') + '</div>' +
          '<div class="tp-text">' + esc(t.title) + '</div>' +
          '<div class="pp-acts">' +
            '<button data-topicrestore>恢复</button>' +
            '<button data-topicforget>彻底删除</button>' +
          '</div></div>';
      }

      if (trashTab === 'topic')
        return topicCards || '<div class="pp-empty">没有已删除的话题</div>';
      return cards || '<div class="pp-empty">没有已删除的消息</div>';
    },

    onEvent: async (ev, api) => {
      const redraw = api.redraw;
      const close  = api.close;

      /* 切换页签 */
      const tb = ev.target.closest('[data-ttab]');
      if (tb) { trashTab = tb.dataset.ttab; redraw(); return; }

      /* 清空回收站：话题目录 + 消息级条目一起清。
         两边的失败都要能看见，不能删不掉还报"已清空"。 */
      const clr = ev.target.closest('.tp-clear');
      if (clr) {
        if (!await confirmDialog('清空回收站', '此操作无法撤销。',
            { danger: true, okText: '清空' })) return;

        /* 1. 话题级 + 2. 消息级，都放进同一个串行写队列。 */
        let wanted = 0, removed = 0, dirErr = null;
        const r = await enqueue(async () => {
          try {
            const td = await getTrashDir();
            const items = await Storage.listEntries(td);
            for (const { name, kind } of items) {
              if (kind !== 'directory') continue;
              wanted++;
              try { await Storage.removeEntry(td, name, { recursive: true }); removed++; }
              catch (e) { dirErr = dirErr || e; }
            }
          } catch (e) {
            /* 只有真的看到过话题目录、或错误不是“目录不存在”时才算失败。 */
            if (wanted > 0 || !isMissingEntryError(e)) dirErr = e;
          }

          /* 先落盘再改内存 —— 写失败时保持原状。 */
          if (arr.length) await writeTrash([]);
        });

        if (!r.ok) {
          /* 失败时不要清空 dirs：磁盘上没删掉的东西要留在列表里。 */
          try {
            const fresh = await readTrashDirs();
            dirs.length = 0; dirs.push(...fresh);
          } catch (e) {}
          redraw();
          toast('清空回收站失败：' + ((r.err && r.err.message) || r.err || '未知错误'));
          return;
        }

        arr.length = 0;
        /* 部分目录删除失败时也要反映真实剩余，不能假装清空。 */
        try {
          const fresh = await readTrashDirs();
          dirs.length = 0; dirs.push(...fresh);
        } catch (e) { dirs.length = 0; }
        redraw();

        if (dirErr) {
          toast('部分话题删除失败（成功 ' + removed + ' / 共 ' + wanted + '）：' +
                (dirErr.message || dirErr));
        } else {
          toast('回收站已清空');
        }
        return;
      }

      /* 彻底删除单条消息 */
      const fg = ev.target.closest('[data-tforget]');
      if (fg) {
        const card = fg.closest('.tp-card');
        const key  = card && card.dataset.key;
        if (key == null || key === '') return;
        if (!await confirmDialog('彻底删除这条记录', '此操作无法撤销。',
            { danger: true, okText: '删除' })) return;

        const i = arr.findIndex(x => recKey(x) === key);
        if (i < 0) {
          toast('找不到对应的回收站条目，请关闭后重新打开回收站');
          return;
        }
        arr.splice(i, 1);
        const r = await enqueue(() => writeTrash(arr));
        if (!r.ok) {
          console.error('[trash] 写入失败:', r.err);
          toast('写入失败：' + ((r.err && r.err.message) || r.err || '未知错误'));
          arr.length = 0;
          arr.push(...await readTrash());
          redraw();
          return;
        }
        redraw();
        toast('已彻底删除');
        return;
      }

      /* 恢复单条消息 */
      const rs = ev.target.closest('[data-trestore]');
      if (rs) {
        const card = rs.closest('.tp-card');
        const key  = card && card.dataset.key;
        if (!key) return;
        const item = arr.find(x => recKey(x) === key);
        if (!item) { toast('这条记录已不在回收站'); redraw(); return; }

        /* 先按 topicId 找 —— 这是身份 */
        let node = null;
        if (item.fromTopicId) {
          walk(Store.root, x => { if (x.topicId === item.fromTopicId) node = x; });
        }
        /* ID 找不到 → 退回按名字找 */
        if (!node) {
          const segs = (item.fromTopic || '').split('/').map(s => s.trim()).filter(Boolean);
          const byName = segs.length ? findByPath(segs.join('\u0001')) : null;
          if (byName) {
            let useByName = true;
            if (item.fromTopicId) {
              useByName = await confirmDialog(
                '恢复位置',
                '原话题已不存在，找到一个同名话题「' + byName.title + '」。要恢复到它里面吗？'
              );
            }
            if (useByName) node = byName;
            else {
              pickTarget(item, arr, redraw);
              return;
            }
          }
        }
        if (!node) {
          toast('原话题已不存在，请手动选择');
          pickTarget(item, arr, redraw);
          return;
        }

        const ok = await doTrashRestore(item, node.id);
        if (ok) {
          const i = arr.indexOf(item);
          if (i >= 0) arr.splice(i, 1);
          redraw();
        }
        return;
      }

      /* 恢复已删除的话题 */
      const tr = ev.target.closest('[data-topicrestore]');
      if (tr) {
        const card = tr.closest('.tp-card');
        const name = card && card.dataset.tdir;
        if (!name) return;
        let freshTitle = '';
        const r = await enqueue(async () => {
          const td = await getTrashDir();
          const src = await Storage.getDir(td, name);
          let meta = null;
          try {
            const txt = await Storage.readText(src, '_回收信息.json');
            meta = JSON.parse(txt);
          } catch (e) {}
          if (!meta) throw new Error('缺少位置信息，无法自动恢复');

          const segs = (meta.parentPath || '').split('/').map(s => s.trim()).filter(Boolean);
          const pnode = segs.length ? findByPath(segs.join('\u0001')) : Store.root;
          if (!pnode) throw new Error('原父话题已不存在，无法自动恢复');

          const pdir = dirOf(pnode);
          const finalName = await uniqueName(pdir, meta.originalName || name);
          const restored = await moveDir(src, pdir, finalName);
          try { await Storage.removeEntry(restored, '_回收信息.json'); } catch (e) {}
          try { await Storage.removeEntry(td, name, { recursive: true }); } catch (e) {}

          const fresh = await scanDir(restored, finalName);
          freshTitle = fresh.title;
          pnode.children.push(fresh);
          Store.rebuildIndex();
          await writeOrder(pnode);
        });
        if (!r.ok) {
          toast('恢复失败：' + ((r.err && r.err.message) || r.err || '未知错误'));
          return;
        }
        D.renderAll();
        const i = dirs.findIndex(x => x.name === name);
        if (i >= 0) dirs.splice(i, 1);
        redraw();
        toast('已恢复话题「' + (freshTitle || name) + '」');
        return;
      }

      /* 彻底删除话题 */
      const tf = ev.target.closest('[data-topicforget]');
      if (tf) {
        const card = tf.closest('.tp-card');
        const name = card && card.dataset.tdir;
        if (!name) return;
        if (!await confirmDialog('彻底删除话题「' + name + '」', '此操作无法撤销。',
            { danger: true, okText: '删除' })) return;
        const r = await enqueue(async () => {
          const td = await getTrashDir();
          await Storage.removeEntry(td, name, { recursive: true });
        });
        if (!r.ok) {
          toast('彻底删除失败：' + ((r.err && r.err.message) || r.err || '未知错误'));
          return;
        }
        const i = dirs.findIndex(x => x.name === name);
        if (i >= 0) dirs.splice(i, 1);
        redraw();
        toast('已彻底删除');
        return;
      }
    },
  });
}

/* 手动挑恢复目标：让用户选一个话题，再恢复 */
function pickTarget(item, arr, redraw) {
  openMovePicker('恢复到哪个话题？', [], tid => {
    doTrashRestore(item, tid).then(ok => {
      if (!ok) return;
      const i = arr.indexOf(item);
      if (i >= 0) arr.splice(i, 1);
      redraw();
    });
  });
}

/* ============================================================
 * 恢复一条已删除的消息
 * ============================================================ */

/**
 * 把一条回收站消息恢复到指定话题。
 *
 * 内存那一半必须走 Store.insertSorted —— 它同时维护 node.entries 与
 * entryIndex。直接调 Mutate.insertSorted 会漏索引，恢复出来的记录
 * Store.entry(id) 找不到，跳转 / 引用 / 编辑 / 删除全部落空。
 *
 * @returns {Promise<string|false>} 成功返回新 entry 的 id，失败返回 false
 */
export async function doTrashRestore(item, topicId) {
  const node = findNode(topicId);
  if (!node) return false;
  if (!item) return false;

  let ts = (typeof item.originalMs === 'number')
    ? item.originalMs
    : parseStamp(item.originalStamp);
  if (!Number.isFinite(ts)) { toast('时间戳异常，无法恢复'); return false; }

  const r = Store.insertSorted(node, {
    id: uid(), text: item.text, createdAt: ts,
    edited: false, editedAt: null,
  });
  const e = r.entry;

  /* ★ 把冻结的时间串带回来：createdAt 不变、_writeStamp 也不变，
     这样 entryBlockId 还是原来那个，所有 [[~tid#^bid]] 引用继续有效。
     Mutate.insertSorted 只认自己的字段，所以这里补一步并重建 blockIndex。 */
  if (item.writeStamp) {
    const oldBid = Mutate.entryBlockId(e);
    e._writeStamp = item.writeStamp;
    Store.reindexEntry(e, node, oldBid);
  }

  if (item.pinned) {
    Mutate.addPin(node, e);
  }

  const wr = await enqueue(async () => {
    if (item.pinned) await writePins(node);
    await persistMonthOf(node, e.createdAt);

    /* 从回收站里删掉这条 —— 用和 draw() 同一套 key（id 优先，退回 deletedAt） */
    const k0 = item.id || item.deletedAt || '';
    const cur = await readTrash();
    const k = cur.findIndex(x => (x.id || x.deletedAt || '') === k0);
    if (k >= 0) {
      cur.splice(k, 1);
      await writeTrash(cur);
    }
  });
  if (!wr.ok) {
    /* 写盘失败 → 撤掉刚插入的内存记录，避免界面里出现一条磁盘上没有的记录 */
    Store.removeEntry(node, e.id);
    if (Store.ui.selectedId === node.id) { renderEntries(); updateTopCount(); }
    renderPins();
    toast('恢复写盘失败：' + ((wr.err && wr.err.message) || wr.err || '未知错误'));
    return false;
  }

  if (Store.ui.selectedId === node.id) { renderEntries(); updateTopCount(); }
  renderPins();
  toast('已恢复到「' + node.title + '」');
  return e.id;
}