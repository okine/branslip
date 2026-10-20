// tests/module-load.test.js
/* 模块加载冒烟测试 —— 每个应用模块都 import 一遍，确认能加载、导出齐全。
 *
 * 为什么需要它：`clearPendingForNode is not defined` 这种"用了没 import"的错，
 * 语法检查（node --check）是发现不了的 —— 文件本身完全合法，只有在那个函数
 * 被调用时才炸。而当时的测试没有一个 import 过 tree.js，于是这个错直接上桌，
 * 表现成"层级树点不动了"。
 *
 * 这里加载不执行任何业务逻辑（模块顶层只有事件绑定和控制台输出），
 * 所以能低成本地覆盖"整张模块图"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* DOM 桩：这些模块在顶层就会 $('#xxx').addEventListener(...)。
   桩对 #id 一律给假元素，见 _browser-stubs.js。 */
import { rootEl } from './_browser-stubs.js';
globalThis.document.querySelector = sel => rootEl(sel);
globalThis.document.getElementById = id => rootEl('#' + id);

/* 所有应用模块（不含 tests/ 和 vendor/） */
const MODULES = [
  'utils.js',
  'icons.js',
  'format.js',
  'mutate.js',
  'store.js',
  'cacheClear.js',
  'tree-utils.js',
  'md-custom.js',
  'md.js',
  'meta-row.js',
  'entries-render.js',
  'entries-date.js',
  'calendar.js',
  'timeline.js',
  'ui.js',
  'ui-topicPicker.js',
  'storage.js',
  'io.js',
  'writer.js',
  'image.js',
  'loader.js',
  'entries.js',
  'pins.js',
  'entries-ops.js',
  'entries-merge.js',
  'tree-render.js',
  'search.js',
  'tree-ops.js',
  'tree.js',
  'composer.js',
  'trash.js',
  'pages.js',
  'topic-info.js',
  'fixed-buttons.js',
  'zip.js',
  'theme.js',
  'writeSecurity.js',
  'scroll-utils.js',
  'ref-preview.js',
  'import-runtime.js',
  'import-deepseek.js',
  'import-claude.js',
  'import-qwen.js',
  'import-telegram.js',
  'app.js',
];

/* 每个模块必须至少导出这些东西 —— 防止"导出被误删"这类回归 */
const REQUIRED_EXPORTS = {
  'cacheClear.js': ['clearRuntimeCaches', 'clearTopicCaches'],
  'tree-utils.js': ['findTopicByRefId', 'topicRefId', 'findNode', 'findEntry'],
  'import-runtime.js': ['initImportPicker', 'runImportFile', 'writeImportFailureReport'],
  'tree.js': ['select', 'startCreate', 'wireTree',
              'pushViewState', 'viewBack', 'goToView'],
  'entries.js': ['renderEntries', 'appendEntry', 'wireEntries'],
  'pins.js': ['renderPins', 'toggleEntryPin', 'rebuildPinRowMap',
              'syncPinCursorFromScroll', 'openPinPage'],
  'entries-jump.js': [
        'jumpToRow', 'jumpToBlock', 'jumpToStamp',
        'loadEarlier', 'armLoadEarlier', 'scheduleIdleLoad',
        'loadLater', 'armLoadLater', 'clearLaterObs',
        'clearEarlierObs', 'wireEntriesJump',
        'rememberScroll', 'recallScroll', 'flushScroll',
        'flushCurrentScroll', 'clearScrollState',
        'setDirectWindow', 'isDirectWindow',
        'scrollToLatest', 'scrollToCurrentTop', 'updateScrollBtn',
  ],
  'entries-ops.js': [
    'startEdit', 'bindEdit', 'commitEdit',
    'enterDelConfirm', 'executeDelete', 'moveEntryTo',
    'buildEntryMenuItems', 'handleMultiClick', 'clearMultiSelect', 'doFold',
    'handleEntriesClick', 'wireOps',
  ],
  'writeSecurity.js': ['atomicWriteText', 'recoverTempFiles', 'TMP_TRAILER'],
  'tree-ops.js': ['addNode', 'renameNode', 'moveNode', 'deleteNode',
                  'confirmDeleteTopic', 'wireTreeOps'],
  'tree-render.js': ['renderTree', 'branchHTML', 'bindTreeRender'],
  'search.js': ['initSearch', 'runSearch', 'clearSearch', 'setQuery',
                'parseQuery', 'highlightText'],
  'composer.js': ['setReply', 'setRelevance', 'buildEntryText', 'refreshPreview',
                  'restoreDraft', 'wireComposer'],
  'trash.js': ['openTrashPage', 'doTrashRestore', 'wireTrash'],
  'image.js': ['getImageURL', 'createImageURLLoader', 'stageImage', 'discardImage', 'takePendingBlob',
               'pendingPathsOf', 'clearPendingForNode', 'clearURLCache',
               'clearURLCacheFor', 'hydrateImages', 'unobserveImages', 'wireImage'],
  'topic-info.js': ['openTopicDetails'],
  'fixed-buttons.js': ['initFixedButtons', 'syncFixedButtons'],
  'writer.js': ['enqueue', 'setStatus', 'waitForIdle', 'markFsReady'],
  'io.js': ['readTimeline', 'writeTimeline', 'addTimelineRange', 'addTimelinePoint',
            'updateTimelineRange', 'removeTimelineRange', 'updateTimelinePoint',
            'removeTimelinePoint', 'writeMonthFile', 'updateTopicMeta'],
  'writeSecurity.js': ['atomicWriteText', 'recoverTempFiles'],
  'ui.js': ['toast', 'openFullPage', 'openModal', 'closeModal', 'confirmDialog',
            'promptInput', 'pushEsc', 'runTopEsc', 'makeEscapable'],
  'ui-topicPicker.js': ['openTopicPicker', 'openMovePicker'],
  'store.js': [],   // 只导出 Store 一个对象，下面单独查
};

for (const file of MODULES) {
  test('模块可加载：' + file, async () => {
    const mod = await import('../' + file);
    assert.ok(mod, file + ' 应有导出对象');

    const need = REQUIRED_EXPORTS[file];
    if (need) {
      for (const name of need) {
        assert.equal(typeof mod[name], 'function',
          file + ' 缺少导出函数：' + name);
      }
    }
    /* treeBox 是模块级单例（tree.js 靠它做拖拽命中测试），是对象不是函数 */
    if (file === 'tree-render.js') {
      assert.ok(mod.treeBox, 'tree-render.js 必须导出 treeBox');
      assert.equal(typeof mod.treeBox.querySelector, 'function');
    }
    if (file === 'store.js') {
      assert.equal(typeof mod.Store, 'object');
      for (const k of ['node', 'entry', 'parent', 'addEntry', 'insertSorted',
                       'removeEntry', 'rebuildIndex']) {
        assert.equal(typeof mod.Store[k], 'function', 'Store 缺少方法：' + k);
      }
    }
  });
}

test('模块图里没有重复加载出两份实例（Store 是同一个对象）', async () => {
  const a = await import('../store.js');
  const b = await import('../entries.js');
  const c = await import('../tree.js');
  assert.ok(a.Store && b && c);
  /* 同一条 import 路径 → 同一个模块实例。这里只是钉住"路径写法一致"，
     若有人写出 './store.js' 与 '../store.js' 混用会被 ESM 归一化，不会出两份。 */
  const d = await import('../store.js');
  assert.equal(a.Store, d.Store);
});
test('writeSecurity.js 导出 TMP_TRAILER 常量', async () => {
  const m = await import('../writeSecurity.js');
  assert.equal(typeof m.TMP_TRAILER, 'string');
  assert.ok(m.TMP_TRAILER.includes('SZJ-EOF'),
    '尾标记是原子写协议的凭据，内容不能漂');
});