'use strict';
/* ================= theme.js =================
 * 主题：主色 / 气泡 / 描边 HSB，背景图片，蒙版强度。
 *
 * 状态：
 *   theme.main / bubble / border / bg / bgMask
 *   — 应用时把 CSS 变量写进 :root
 *   — 磁盘上存根目录的 _主题.json
 *
 * 导出：
 *   initTheme()        读盘 + 应用（connect 时调用）
 *   openThemePanel()   打开主题弹窗（toolbar.js 的“主题”按钮调用）
 *
 * 模块副作用：
 *   - 创建隐藏的 <input type=file> 用于挑背景图
 */

import { Storage } from './storage.js';
import { $, togglePop } from './utils.js';
import { Store } from './store.js';
import { resolveFile } from './io.js';
import { atomicWriteText } from './writeSecurity.js';
import { enqueue } from './writer.js';
import { toast, closeMenu, wireOutsideClose } from './ui.js';

/* ---------- 主题状态 ---------- */

const THEME_FILE = '_主题.json';
const THEME_KEY = { main: 'main', bubble: 'bubble', border: 'borderColor' };

export const theme = {
  main:   { h: 166, s: 62, b: 32 },
  bubble: null,
  borderColor: null,
  borderThickness:2,
  bg: null,
  bgMask: 45,
  dialogue: true, 
};
let themeTab = 'main';
let bgUrl = null;
let themeDirty = false;       // ★ 新增
/* ---------- 颜色与变量 ---------- */

function hsl(h, s, l) { return 'hsl(' + h + ' ' + s + '% ' + l + '%)'; }

function applyTheme() {
  const m = theme.main;
  const r = document.documentElement.style;

  r.setProperty('--accent',      hsl(m.h, m.s, m.b));
  r.setProperty('--accent-deep', hsl(m.h, m.s + 6, Math.max(8, m.b - 9)));
  r.setProperty('--accent-soft', hsl(m.h, Math.max(8, m.s - 30), 92));
  r.setProperty('--side',        hsl(m.h, m.s - 42, 89));
  r.setProperty('--paper',       hsl(m.h, m.s - 38, 95));
  r.setProperty('--line',        hsl(m.h, m.s - 40, 76));
  r.setProperty('--line-soft',   hsl(m.h, m.s - 42, 84));

  /* 气泡：有覆盖用覆盖，没有就派生 */
  const b = theme.bubble || { h: m.h, s: Math.max(8, m.s - 38), b: 90 };
  r.setProperty('--bubble', hsl(b.h, b.s, b.b));

  /* 描边 */
  const bdc = theme.borderColor || { h: m.h, s: Math.max(8, m.s - 30), b: 55 };
  const bdt = theme.borderThickness || 2;
  r.setProperty('--bubble-bd-color', 'hsl(' + bdc.h + ' ' + bdc.s + '% ' + bdc.b + '% / 0.35)');
  r.setProperty('--bubble-bd-width', bdt + 'px'); 

  /* 联动色相 —— 滑条轨道用 */
  const editing = (themeTab === 'main' || !theme[themeTab]) ? m : theme[themeTab];
  r.setProperty('--th', editing.h);

  /* 背景蒙版强度 */
  r.setProperty('--bg-mask', (theme.bgMask != null ? theme.bgMask : 45) / 100);
}

/* ---------- 读盘 / 写盘 ---------- */

async function readTheme() {
  try {
    const t = JSON.parse(await Storage.readText(Store.dir, THEME_FILE)) || {};
    /* 旧格式 → 新格式 */
    if (typeof t.hue === 'number' && !t.main) {
      theme.main = {
        h: t.hue,
        s: typeof t.sat === 'number' ? t.sat : 62,
        b: typeof t.bri === 'number' ? t.bri : 32,
        
      };
    } else if (t.main) {
      theme.main = t.main;
    }
    theme.bubble = t.bubble || null;
    theme.borderColor = t.borderColor || null; 
    theme.borderThickness = typeof t.borderThickness === 'number'
    ? t.borderThickness : 2;         
    theme.bg = t.bg || null;
    theme.bgMask = typeof t.bgMask === 'number' ? t.bgMask : 45;
    theme.dialogue = (t.dialogue !== false);
    return theme;
  } catch (e) { return theme; }
}

export async function writeTheme() {
  await atomicWriteText(Store.dir, THEME_FILE, JSON.stringify({
    main: theme.main,
    bubble: theme.bubble,
    borderColor: theme.borderColor,          
    borderThickness: theme.borderThickness,
    bg: theme.bg,
    bgMask: theme.bgMask,
    dialogue: theme.dialogue,
  }, null, 2));
  themeDirty = false;         // ★
}

/* ---------- 背景图 ---------- */

function ensureBgLayer() {
  let d = document.getElementById('bgLayer');
  if (!d) { d = document.createElement('div'); d.id = 'bgLayer'; document.body.prepend(d); }
  return d;
}

async function applyBg(name) {
  const layer = ensureBgLayer();
  if (bgUrl) { URL.revokeObjectURL(bgUrl); bgUrl = null; }
  if (!name) {
    layer.style.backgroundImage = '';
    document.body.classList.remove('has-bg');
    return;
  }
  try {
    const fh = await resolveFile(Store.dir, name);
    bgUrl = URL.createObjectURL(await fh.getFile());
    layer.style.backgroundImage = 'url(' + bgUrl + ')';
    document.body.classList.add('has-bg');
  } catch (e) {
    console.error('[主题] 背景加载失败:', name, e);
    document.body.classList.remove('has-bg');
  }
}

export async function initTheme() {
  await readTheme();
  applyTheme();
  await applyBg(theme.bg);
}

/* ---------- 背景选择 + 裁剪 ---------- */

const bgPick = document.createElement('input');
bgPick.type = 'file';
bgPick.accept = 'image/*';
bgPick.addEventListener('change', async () => {
  const f = bgPick.files[0]; if (!f) return; bgPick.value = '';
  try {
    const bmp = await createImageBitmap(f);
    buildCropUI(bmp);
  } catch (e) {
    console.error('[主题] 解码失败', e);
    toast('这张图无法解码');
  }
});
document.body.appendChild(bgPick);
bgPick.style.display = 'none';

function buildCropUI(img) {
  const mask = document.createElement('div'); mask.className = 'crop-mask';
  mask.innerHTML = '<div class="crop-box"><h3>调整背景位置与缩放</h3>' +
    '<div class="crop-main"><canvas class="crop-canvas"></canvas>' +
    '<div class="crop-hint">拖动平移 · 滚轮缩放</div></div>' +
    '<div class="crop-foot"><div class="crop-zoom"><span>缩放</span>' +
    '<input type="range" id="cropZoom" min="20" max="400" value="100"></div>' +
    '<div class="spacer"></div>' +
    '<button class="c-cancel">取消</button><button class="c-ok">确认使用</button></div></div>';
  document.body.appendChild(mask);

  const box = mask.querySelector('.crop-main');
  const cv = mask.querySelector('.crop-canvas');
  const ctx = cv.getContext('2d');

  let vw = 0, vh = 0, base = 1, scale = 1, ox = 0, oy = 0;

   /* 所有退出路径（确认/取消/点遮罩/外部 remove）都走这里 */
  let ro = null;
  const origRemove = mask.remove.bind(mask);
  mask.remove = () => {
      if (ro) { ro.disconnect(); ro = null; }
      origRemove();
  };

  function resize() {
    const r = box.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    vw = r.width; vh = r.height;
    cv.width = Math.round(vw * devicePixelRatio);
    cv.height = Math.round(vh * devicePixelRatio);
    base = Math.max(vw / img.width, vh / img.height);
    draw();
  }
  function clamp() {
    const s = base * scale;
    const w = img.width * s, h = img.height * s;
    const maxX = Math.max(0, (w - vw) / 2), maxY = Math.max(0, (h - vh) / 2);
    ox = Math.min(Math.max(ox, -maxX), maxX);
    oy = Math.min(Math.max(oy, -maxY), maxY);
  }
  function draw() {
    clamp();
    const s = base * scale;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.drawImage(img, vw / 2 + ox - img.width * s / 2, vh / 2 + oy - img.height * s / 2,
      img.width * s, img.height * s);
  }
  function commit() {
    const s = base * scale;
    const srcW = vw / s, srcH = vh / s;
    const srcX = img.width / 2 - ox / s - srcW / 2;
    const srcY = img.height / 2 - oy / s - srcH / 2;
    const raw = Math.max(srcW, srcH);
    const k = Math.min(2560 / raw, 1);
    const outW = Math.max(1, Math.round(srcW * k));
    const outH = Math.max(1, Math.round(srcH * k));
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
    out.toBlob(async blob => {
      if (!blob) { toast('导出失败'); return; }
      const name = '主题背景.jpg';
      enqueue(async () => {
        for (const old of ['主题背景.jpg', '主题背景.png', '主题背景.webp']) {
          if (old === name) continue;
          try { await Storage.removeEntry(Store.dir, old); } catch (e) {}
        }
        await Storage.writeBlob(Store.dir, name, blob);
        theme.bg = name;
        await writeTheme();
        await applyBg(name);
      });
      mask.remove();
      toast('背景已保存（' + outW + '×' + outH + '）');
    }, 'image/jpeg', 0.92);
  }

  let drag = null;
  box.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, ox, oy };
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
  });
  box.addEventListener('pointermove', e => {
    if (!drag) return;
    ox = drag.ox + (e.clientX - drag.x);
    oy = drag.oy + (e.clientY - drag.y);
    draw();
  });
  box.addEventListener('pointerup', () => { drag = null; box.classList.remove('dragging'); });
  box.addEventListener('wheel', e => {
    e.preventDefault();
    scale = Math.min(4, Math.max(0.2, scale * (e.deltaY < 0 ? 1.08 : 0.926)));
    const z = mask.querySelector('#cropZoom');
    if (z) z.value = Math.round(scale * 100);
    draw();
  }, { passive: false });
  mask.querySelector('#cropZoom').addEventListener('input', e => {
    scale = +e.target.value / 100; draw();
  });
  mask.querySelector('.c-ok').addEventListener('click', commit);
  mask.querySelector('.c-cancel').addEventListener('click', () => mask.remove());
  mask.addEventListener('pointerdown', e => { if (e.target === mask) mask.remove(); });

  resize();
  ro = new ResizeObserver(resize);
  ro.observe(box);
}

/* ---------- 主题弹窗 ---------- */

let themePopAC = null;
function openThemePop(anchor) {
  closeMenu();
  if (themePopAC) { themePopAC.abort(); themePopAC = null; } 
  document.querySelectorAll('.theme-pop').forEach(p => p.remove());

  const pop = document.createElement('div'); pop.className = 'theme-pop';
  const tabs = [
    ['main', '主色'],
    ['bubble', '气泡'],
    ['border', '描边'],
  ];
  const m = theme.main;
  const cur = {
    main:   { h: m.h, s: m.s, b: m.b },
    bubble: theme.bubble || { h: m.h, s: Math.max(8, m.s - 38), b: 90 },
    border: theme.borderColor || { h: m.h, s: Math.max(8, m.s - 30), b: 55 },
  }[themeTab];

  pop.innerHTML = '<h4>主题</h4>' +
    '<div class="theme-tabs">' + tabs.map(([k, label]) =>
      '<button class="theme-tab' + (k === themeTab ? ' on' : '') + '" data-tab="' + k + '">' + label + '</button>'
    ).join('') + '</div>' +
    '<div class="hs-row"><label>色相</label>' +
      '<input type="range" id="thH" min="0" max="360" value="' + cur.h + '">' +
      '<span id="thHv">' + cur.h + '</span></div>' +
    '<div class="hs-row"><label>饱和</label>' +
      '<input type="range" id="thS" min="8" max="90" value="' + cur.s + '">' +
      '<span id="thSv">' + cur.s + '</span></div>' +
    '<div class="hs-row"><label>明度</label>' +
      '<input type="range" id="thB" min="12" max="95" value="' + cur.b + '">' +
      '<span id="thBv">' + cur.b + '</span></div>' +
    (themeTab !== 'main'
      ? '<button class="theme-reset" id="thReset">↺ 跟随主色</button>'
      : '') +
    (themeTab === 'border'
      ? '<div class="hs-row"><label>粗细</label>' +
      '<input type="range" id="thW" min="0" max="6" step="1" value="' +
      (theme.borderThickness != null ? theme.borderThickness : 2) + '">' +
      '<span id="thWv">' + (theme.borderThickness != null ? theme.borderThickness : 2) + 'px</span>' +
      '</div>'
      : '') +
    '<div class="hs-row" style="margin-top:14px"><label>蒙版</label>' +
      '<input type="range" id="thM" min="0" max="90" value="' + (theme.bgMask != null ? theme.bgMask : 45) + '">' +
      '<span id="thMv">' + (theme.bgMask != null ? theme.bgMask : 45) + '</span></div>' +
    '<div class="theme-row"><label>背景图片（保存在根目录）</label><div class="theme-btns">' +
    '<button id="bgPickBtn">选择图片</button>' +
    '<button id="bgClearBtn">移除背景</button></div></div>' +
    '<p class="theme-note">色相、气泡、描边各自独立保存（_主题.json），<br>换设备或重扫后依然生效。</p>';
  document.body.appendChild(pop);

  const r = (anchor || $('#themeBtn') || $('#tbTheme')).getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const narrow = typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 860px)').matches;
  if (narrow) {
    /* 手机：贴着按钮上方展开 */
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pw - 8)) + 'px';
    pop.style.top = Math.max(8, r.top - ph - 8) + 'px';
  } else {
    /* 桌面：放在工具栏右侧，不盖住按钮 */
    pop.style.left = Math.max(8, Math.min(r.right + 10, innerWidth - pw - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(r.top, innerHeight - ph - 8)) + 'px';
  }


  const key = THEME_KEY[themeTab];
  const commit = () => {
    const h = +pop.querySelector('#thH').value;
    const s = +pop.querySelector('#thS').value;
    const b = +pop.querySelector('#thB').value;
    if (themeTab === 'main') theme.main = { h, s, b };
    else theme[key] = { h, s, b };

    /* 描边 tab 特有的粗细 */
    const wEl = pop.querySelector('#thW');
    if (wEl) theme.borderThickness = +wEl.value;

    applyTheme();
  };
  let themeRaf = null;
  const upd = () => {
    if (themeRaf) return;
    themeRaf = requestAnimationFrame(() => {
      themeRaf = null;
      if (!pop.isConnected) return;         /* 弹窗已关 → 跳过 */

      commit();
      pop.querySelector('#thHv').textContent = +pop.querySelector('#thH').value;
      pop.querySelector('#thSv').textContent = +pop.querySelector('#thS').value;
      pop.querySelector('#thBv').textContent = +pop.querySelector('#thB').value;
      const wEl = pop.querySelector('#thW'), wv = pop.querySelector('#thWv');
      if (wEl && wv) wv.textContent = wEl.value + 'px';
    });
  };
  ['thH', 'thS', 'thB','thW'].forEach(id => {
    const el = pop.querySelector('#' + id);
    if (el) el.addEventListener('input', upd);
  });

  let saveTimer = null;
  const save = () => {
    themeDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => enqueue(() => writeTheme()), 300);
  };
  ['thH', 'thS', 'thB','thW'].forEach(id => {
    const el = pop.querySelector('#' + id);
    if (el) el.addEventListener('change', save);
  });

  const mask = pop.querySelector('#thM');
  if (mask) {
    mask.addEventListener('input', () => {
      theme.bgMask = +mask.value;
      pop.querySelector('#thMv').textContent = theme.bgMask;
      applyTheme();
    });
    mask.addEventListener('change', save);
  }

  pop.querySelector('.theme-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    themeTab = b.dataset.tab;
    pop.remove(); openThemePop(anchor);
  });

  const rst = pop.querySelector('#thReset');
  if (rst) rst.addEventListener('click', () => {
    theme[THEME_KEY[themeTab]] = null;
    applyTheme();
    themeDirty = true;
    enqueue(() => writeTheme());
    pop.remove(); openThemePop(anchor);
  });

  pop.querySelector('#bgPickBtn').addEventListener('click', () => bgPick.click());
  pop.querySelector('#bgClearBtn').addEventListener('click', () => {
    enqueue(async () => {
      if (theme.bg) { try { await Storage.removeEntry(Store.dir, theme.bg); } catch (e) {} }
      theme.bg = null;
      await writeTheme();
    });
    applyBg(null);
    toast('已移除背景');
  });

  themePopAC = new AbortController();
  wireOutsideClose(pop, () => {
    pop.remove();
    if (themePopAC) { themePopAC.abort(); themePopAC = null; }
  }, themePopAC.signal, t => (
    (anchor && (t === anchor || anchor.contains(t))) ||
    t.closest('#tbTheme') || t.closest('#themeBtn')
  ));
}


/* ---------- 主题入口（toolbar.js 调用） ---------- */

export async function openThemePanel(anchor) {
  /* 主题面板开着时再点同一个按钮 → 收起（见 utils.togglePop） */
  if (togglePop(anchor, '.theme-pop')) return;
  if (!themeDirty) await readTheme();
  themeTab = 'main';
  openThemePop(anchor);
}