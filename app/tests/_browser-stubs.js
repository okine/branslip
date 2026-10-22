// tests/_browser-stubs.js
/* 极简浏览器 API 桩。给"间接 import 到 DOM 模块"的用例共用。
 *
 * 必须在 import 被测模块**之前** import 本文件 —— image.js 在模块顶层就调
 * resetImgObserver() → new IntersectionObserver(...)，Node 里没有这些 API。
 *
 * 只补到"模块加载不炸"为止：桩里不做任何真实行为，
 * 真的需要断言 DOM 的用例请自己造更完整的假元素。
 */
'use strict';

export function fakeEl() {
  /* style 单独给一个可扩展对象：theme.js 的 applyTheme 会调
     documentElement.style.setProperty，app.js 也会设 --nav-btn-top */
  const style = {
    setProperty() {},
    removeProperty() {},
    getPropertyValue() { return ''; },
  };
  return {
    className: '',
    textContent: '',
    title: '',
    innerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    style,
    /* children 必须是可迭代的：entries.js 的 topCutItem() 会
       `for (const el of box.children)`。缺了它会在 select() 里同步炸。 */
    children: [],
    childElementCount: 0,
    firstElementChild: null,
    lastElementChild: null,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    insertBefore() {},
    remove() {},
    insertAdjacentHTML() {},
    replaceWith() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    blur() {},
    click() {},
    dispatchEvent() {},
    setSelectionRange() {},
    scrollTo() {},
    scrollIntoView() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  };
}

/* UI 的挂载点。ui.js 的 toast() / openMenuAt() / openModal() 会往这些
   根节点上 appendChild —— 桩里没有就会 "Cannot read properties of null"。 */
const roots = {
  '#toastRoot': fakeEl(),
  '#menuRoot': fakeEl(),
  '#modalRoot': fakeEl(),
};

/* 用例可以登记自己关心的元素，querySelector 会优先命中。
   例：测试 composer.js 时需要 #inputArea 真实存在。 */
const registry = Object.create(null);
export function registerEl(sel, el) { registry[sel] = el || fakeEl(); return registry[sel]; }

const idCache = Object.create(null);

/**
 * 兜底：`#id` 一律给一个稳定的假元素。
 *
 * 因为好几个模块在**顶层**就 `$('#xxx').addEventListener(...)`
 * （entries-date.js 的 #dateJump、tree.js 的 #crumbs / #searchInput …），
 * 这里返回 null 的话，光是 import 就会 "Cannot read properties of null"。
 * 非 `#` 选择器仍然返回 null，好让代码里的 `if (!el) return` 守卫照常生效。
 */
export function rootEl(sel) {
  if (sel in registry) return registry[sel];
  if (roots[sel]) return roots[sel];
  if (typeof sel === 'string' && sel.charCodeAt(0) === 35 /* '#' */) {
    if (!idCache[sel]) idCache[sel] = fakeEl();
    return idCache[sel];
  }
  return null;
}

if (!globalThis.document) {
  globalThis.document = {
    querySelector: sel => rootEl(sel),
    getElementById: id => rootEl('#' + id),
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
    body: fakeEl(),
    documentElement: fakeEl(),
    addEventListener() {},
    removeEventListener() {},
  };
}

if (!globalThis.window) {
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    /* fixed-buttons.js 用 matchMedia('(max-width:860px)') 决定工具栏放哪 */
    matchMedia() {
      return {
        matches: false, media: '',
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      };
    },
  };
}

/* history：tree.js 的 pushViewState / boot.js 会调
   history.pushState / replaceState。Node 里没有这个全局。 */
if (!globalThis.history) {
  globalThis.history = {
    state: null,
    pushState(s) { this.state = s; },
    replaceState(s) { this.state = s; },
    back() {},
    forward() {},
    go() {},
  };
}

/* IntersectionObserver / ResizeObserver / MutationObserver：只要能被 new 出来 */
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!globalThis.MutationObserver) {
  globalThis.MutationObserver = class {
    constructor() {}
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
}

/* requestIdleCallback 桩成"永不回调"。
   它是空闲预加载（entries.js 的 scheduleIdleLoad / merge 的
   scheduleMergedIdleLoad）的入口 —— 真跑起来会在测试结束后继续动 DOM，
   报出 "asynchronous activity after the test ended"。测试不需要它。 */
if (!globalThis.requestIdleCallback) {
  globalThis.requestIdleCallback = () => 0;
  globalThis.cancelIdleCallback = () => {};
}
