/**
 * src/core/peek-drawer.js 单元测试（node --test，零依赖）
 *
 * 为什么需要这个文件（REVIEW-01 M-01）：core 承载 History 状态机、sandbox 守护、拖拽、
 * destroy 全部高风险逻辑，之前没有任何自动化断言。这里用一套**极简 fake DOM / History**
 * 在 node 里跑真实 core 代码，覆盖：
 *   - sandbox 静态值与净化（含 P-07 大小写绕过）
 *   - History 状态机：peek → open、非 peek → hide、无二次 back、I-10 前进重开
 *   - M-04 前进重开时标题回填（真实 core 调用顺序）
 *   - M-02 关闭态 inert / 焦点归还顺序
 *   - M-03 F5 后 #sidepeek= 残留自愈
 *   - B-01 拖拽跨 iframe：iframe 命中开关、buttons===0 兜底、blur 收尾、关闭/销毁清拖拽
 *   - N-01~N-04 拖拽收尾/落盘/iframe 重建/关闭顺序；N-06 自愈 once 护栏
 *   - N-07 sandbox 守护（MutationObserver 恢复）；N-09 content↔background 路径白名单一致
 *   - destroy 后 document/window 监听净计数为 0
 *   - P-03 / P-05 / P-06 / P-08 / P-16
 *   - I-10 回归：open A → 切 B → 关闭 → 前进重开，history.length 不增长 且 标题回填
 *
 * 说明：fake DOM 只实现 core 真正用到的 API，刻意保持小巧；它不模拟布局/样式计算，
 * 样式类断言（动画、computedStyle）放 QA 的真浏览器验收里做。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CORE_PATH = path.join(ROOT, 'src', 'core', 'peek-drawer.js');
const CONTENT_PATH = path.join(ROOT, 'src', 'content.js');

const SidePeekDrawer = require(CORE_PATH);

/* ================================================================== *
 * 1. 极简 fake DOM / BOM
 * ================================================================== */

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function createEnv(options = {}) {
  const listenerCounts = new Map(); // "type|capture" -> 净增计数
  const winListeners = new Map(); // "type|capture" -> [fn]
  const docListeners = new Map();

  function listenerKey(type, captureOrOptions) {
    const capture =
      typeof captureOrOptions === 'boolean'
        ? captureOrOptions
        : !!(captureOrOptions && captureOrOptions.capture);
    return `${type}|${capture ? 'capture' : 'bubble'}`;
  }

  function addListener(map, type, fn, captureOrOptions) {
    const key = listenerKey(type, captureOrOptions);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fn);
    listenerCounts.set(key, (listenerCounts.get(key) || 0) + 1);
  }

  function removeListener(map, type, fn, captureOrOptions) {
    const key = listenerKey(type, captureOrOptions);
    const list = map.get(key) || [];
    const index = list.indexOf(fn);
    if (index !== -1) list.splice(index, 1);
    listenerCounts.set(key, (listenerCounts.get(key) || 0) - 1);
  }

  const findIn = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const hit = findIn(child, predicate);
      if (hit) return hit;
    }
    if (node.shadowRoot) {
      const hit = findIn(node.shadowRoot, predicate);
      if (hit) return hit;
    }
    return null;
  };

  const elementsById = new Map();

  function makeElement(tag, documentRef) {
    const listeners = new Map();
    const el = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      id: '',
      className: '',
      textContent: '',
      innerHTML: '',
      value: '',
      isConnected: false,
      parentNode: null,
      children: [],
      attributes: Object.create(null),
      style: { cssText: '', width: '', pointerEvents: '', cursor: '', userSelect: '' },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') {
          this.id = String(value);
          elementsById.set(this.id, this);
        }
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name);
      },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        child.isConnected = true;
        return child;
      },
      insertBefore(child, reference) {
        const index = this.children.indexOf(reference);
        if (index === -1) this.children.push(child);
        else this.children.splice(index, 0, child);
        child.parentNode = this;
        child.isConnected = true;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
        child.isConnected = false;
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      // 元素级监听不进全局计数：destroy 的断言只关心 document/window 上的监听是否净归零，
      // 元素级监听随节点回收（与真实浏览器一致）。
      addEventListener(type, fn, captureOrOptions) {
        const key = listenerKey(type, captureOrOptions);
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
      },
      removeEventListener(type, fn, captureOrOptions) {
        const list = listeners.get(listenerKey(type, captureOrOptions)) || [];
        const index = list.indexOf(fn);
        if (index !== -1) list.splice(index, 1);
      },
      dispatch(type, event) {
        const list = listeners.get(`${type}|bubble`) || [];
        list.slice().forEach((fn) => fn(event));
      },
      focus() {
        if (documentRef) documentRef.activeElement = this;
      },
      blur() {},
      select() {},
      getBoundingClientRect() {
        return { left: 100, top: 0, width: 600, height: 800 };
      },
      get offsetWidth() {
        return 600;
      },
      attachShadow(init) {
        const root = makeElement('#shadow-root', documentRef);
        root.host = this;
        root.shadowMode = init && init.mode;
        this.shadowRoot = root;
        return root;
      }
    };

    el.classList = {
      add() {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        for (const name of arguments) set.add(name);
        el.className = Array.from(set).join(' ');
      },
      remove() {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        for (const name of arguments) set.delete(name);
        el.className = Array.from(set).join(' ');
      },
      contains(name) {
        return el.className.split(/\s+/).filter(Boolean).indexOf(name) !== -1;
      },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !this.contains(name) : !!force;
        if (shouldAdd) this.add(name);
        else this.remove(name);
        return shouldAdd;
      }
    };

    // iframe：设置 src 后异步触发一次 load（模拟浏览器真实加载完成）
    if (el.tagName === 'IFRAME') {
      const originalSetAttribute = el.setAttribute;
      el.setAttribute = function setAttributeWithLoad(name, value) {
        originalSetAttribute.call(this, name, value);
        if (name !== 'src') return;
        const self = this;
        setTimeout(() => {
          if (!self.isConnected) return;
          self.dispatch('load', { type: 'load', target: self });
        }, 0);
      };
    }

    return el;
  }

  const documentElement = makeElement('html');
  const body = makeElement('body');
  documentElement.appendChild(body);
  // 布局视口宽度（不含纵向滚动条）：默认等于 innerWidth；可用 options.clientWidth 模拟"有滚动条"。
  documentElement.clientWidth =
    options.clientWidth === undefined ? options.innerWidth || 1280 : options.clientWidth;

  const documentRef = {
    documentElement,
    body,
    activeElement: null,
    createElement(tag) {
      return makeElement(tag, documentRef);
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    execCommand() {
      return true;
    },
    addEventListener(type, fn, captureOrOptions) {
      addListener(docListeners, type, fn, captureOrOptions);
    },
    removeEventListener(type, fn, captureOrOptions) {
      removeListener(docListeners, type, fn, captureOrOptions);
    }
  };

  const location = { href: options.href || 'https://sidepeek.test/page' };
  Object.defineProperty(location, 'hash', {
    configurable: true,
    get() {
      const index = this.href.indexOf('#');
      return index === -1 ? '' : this.href.slice(index);
    }
  });

  const resolveUrl = (url) => new URL(url, location.href).href;
  const historyEntries = [
    { state: options.initialState === undefined ? null : options.initialState, url: location.href }
  ];
  let historyIndex = 0;
  const history = {
    get length() {
      return historyEntries.length;
    },
    get state() {
      return historyEntries[historyIndex].state;
    },
    pushState(state, _title, url) {
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ state, url: resolveUrl(url) });
      historyIndex = historyEntries.length - 1;
      location.href = historyEntries[historyIndex].url;
    },
    replaceState(state, _title, url) {
      historyEntries[historyIndex] = { state, url: resolveUrl(url) };
      location.href = historyEntries[historyIndex].url;
    },
    back() {
      if (historyIndex === 0) return;
      historyIndex -= 1;
      location.href = historyEntries[historyIndex].url;
      schedulePopState();
    },
    forward() {
      if (historyIndex === historyEntries.length - 1) return;
      historyIndex += 1;
      location.href = historyEntries[historyIndex].url;
      schedulePopState();
    },
    go(delta) {
      const next = historyIndex + Number(delta || 0);
      if (next < 0 || next >= historyEntries.length) return;
      historyIndex = next;
      location.href = historyEntries[historyIndex].url;
      schedulePopState();
    },
    __entries: historyEntries,
    __index: () => historyIndex,
    __setCurrentState(state) {
      historyEntries[historyIndex].state = state;
    }
  };

  const rafQueue = [];
  let rafId = 0;
  if (options.replaceStateSpy) {
    const originalReplace = history.replaceState.bind(history);
    history.replaceState = function spy(state, title, url) {
      options.replaceStateSpy.push(String(url));
      return originalReplace(state, title, url);
    };
  }

  const windowRef = {
    innerWidth: options.innerWidth || 1280,
    requestAnimationFrame(fn) {
      rafId += 1;
      rafQueue.push({ id: rafId, fn });
      return rafId;
    },
    cancelAnimationFrame(id) {
      const index = rafQueue.findIndex((task) => task.id === id);
      if (index !== -1) rafQueue.splice(index, 1);
    },
    addEventListener(type, fn, captureOrOptions) {
      addListener(winListeners, type, fn, captureOrOptions);
    },
    removeEventListener(type, fn, captureOrOptions) {
      removeListener(winListeners, type, fn, captureOrOptions);
    },
    open() {
      return null;
    },
    __dispatch(type, event) {
      const list = winListeners.get(`${type}|bubble`) || [];
      list.slice().forEach((fn) => fn(event));
    },
    __hasListener(type, capture) {
      const key = `${type}|${capture ? 'capture' : 'bubble'}`;
      return (winListeners.get(key) || []).length > 0;
    },
    __flushRaf() {
      const tasks = rafQueue.splice(0);
      tasks.forEach((task) => task.fn());
    }
  };

  function schedulePopState() {
    setTimeout(() => {
      const event = { type: 'popstate', state: history.state };
      windowRef.__dispatch('popstate', event);
    }, 0);
  }

  // ---- fake MutationObserver：让 _guardSandbox 这条安全命门分支可在 node 里被覆盖（N-07） ----
  const mutationObservers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      mutationObservers.push(this);
    }
    observe(target, options) {
      this.observed.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
    /** 测试钩子：手动触发一次回调（模拟 sandbox 属性被外部脚本改写） */
    __trigger() {
      if (!this.disconnected) this.callback([], this);
    }
  }

  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    MutationObserver: globalThis.MutationObserver
  };
  globalThis.window = windowRef;
  globalThis.document = documentRef;
  globalThis.location = location;
  globalThis.history = history;
  // 用 fake MutationObserver 替代（真实浏览器里它负责 sandbox 守护）。
  // 注意不要动 globalThis.navigator：Node 21+ 自带只读 getter，赋值会直接抛错。
  globalThis.MutationObserver = FakeMutationObserver;

  const env = {
    window: windowRef,
    document: documentRef,
    location,
    history,
    body,
    documentElement,
    find(className) {
      return findIn(documentElement, (node) => !!(node.classList && node.classList.contains(className)));
    },
    findHost() {
      return findIn(documentElement, (node) => node.id === 'sidepeek-host');
    },
    shadowRoot() {
      const host = env.findHost();
      return host ? host.shadowRoot : null;
    },
    listenerNet() {
      const result = {};
      for (const [key, value] of listenerCounts.entries()) {
        if (value !== 0) result[key] = value;
      }
      return result;
    },
    countOf(type, capture) {
      return listenerCounts.get(`${type}|${capture ? 'capture' : 'bubble'}`) || 0;
    },
    mutationObservers,
    flushRaf() {
      windowRef.__flushRaf();
    },
    restore() {
      for (const key of Object.keys(previousGlobals)) {
        if (previousGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = previousGlobals[key];
      }
    }
  };

  return env;
}

function createDrawer(env, options = {}) {
  return new SidePeekDrawer(
    Object.assign(
      {
        defaultWidth: 600,
        widthRatio: 0.5,
        minWidth: 420,
        maxWidthRatio: 0.9
      },
      options
    )
  );
}

function shadowEl(env, className) {
  return env.find(className);
}

function safeDestroy(drawer) {
  try {
    if (drawer) drawer.destroy();
  } catch (error) {
    /* 测试收尾：忽略 */
  }
}

/* ================================================================== *
 * 2. 静态契约：sandbox
 * ================================================================== */

test('SANDBOX: 恰好是 6 个安全 token，且绝不含 allow-top-navigation*', () => {
  assert.equal(typeof SidePeekDrawer, 'function');
  const tokens = SidePeekDrawer.SANDBOX.split(/\s+/);
  assert.deepEqual(tokens, [
    'allow-scripts',
    'allow-same-origin',
    'allow-forms',
    'allow-popups',
    'allow-presentation',
    'allow-downloads'
  ]);
  assert.equal(/allow-top-navigation/i.test(SidePeekDrawer.SANDBOX), false);
  assert.ok(SidePeekDrawer.FORBIDDEN_SANDBOX_TOKENS.indexOf('allow-top-navigation') !== -1);
  assert.ok(
    SidePeekDrawer.FORBIDDEN_SANDBOX_TOKENS.indexOf('allow-top-navigation-by-user-activation') !== -1
  );
});

/* ================================================================== *
 * 3. sandbox 净化（P-07）
 * ================================================================== */

test('sanitizeSandbox: 剔除 allow-top-navigation 与 -by-user-activation，并去重归一化', () => {
  const drawer = createDrawer(null, {
    sandbox:
      'allow-scripts  allow-same-origin allow-top-navigation allow-top-navigation-by-user-activation allow-forms'
  });
  assert.deepEqual(drawer._sandbox.split(/\s+/), [
    'allow-scripts',
    'allow-same-origin',
    'allow-forms'
  ]);
});

test('sanitizeSandbox: 大小写变体 Allow-Top-Navigation 也必须被剔除（P-07）', () => {
  const drawer = createDrawer(null, {
    sandbox: 'allOW-scRipts Allow-Same-Origin Allow-Top-Navigation ALLOW-TOP-NAVIGATION-BY-USER-ACTIVATION'
  });
  assert.equal(/top-navigation/i.test(drawer._sandbox), false);
  assert.deepEqual(drawer._sandbox.split(/\s+/), ['allow-scripts', 'allow-same-origin']);
});

test('sanitizeSandbox: 缺 allow-scripts / allow-same-origin 时回退到内置组合', () => {
  for (const sandbox of ['allow-scripts', 'allow-same-origin', 'allow-forms allow-popups']) {
    const drawer = createDrawer(null, { sandbox });
    assert.equal(drawer._sandbox, SidePeekDrawer.SANDBOX, `sandbox=${sandbox}`);
  }
  // 空 / 非字符串也回退
  assert.equal(createDrawer(null, { sandbox: '   ' })._sandbox, SidePeekDrawer.SANDBOX);
  assert.equal(createDrawer(null, { sandbox: null })._sandbox, SidePeekDrawer.SANDBOX);
});

/* ================================================================== *
 * 3.1 QA MINOR-2：48px 遮罩必须以布局视口（clientWidth）为基准
 * ================================================================== */

test('MINOR-2: clientWidth=477 / innerWidth=492 时，clamp 上限 ≤477-48 且遮罩 ≥48px', () => {
  const env = createEnv({ innerWidth: 492, clientWidth: 477 });
  const drawer = createDrawer(env, { defaultWidth: 600, minWidth: 420, maxWidthRatio: 0.9 });
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    drawer.setWidth(2000); // 触发上限 clamp
    const applied = drawer._appliedWidth;
    // 以布局视口 477 为基准：hi = min(0.9*477, 477-48) = min(429.3, 429) = 429
    assert.equal(applied, Math.round(Math.min(0.9 * 477, 477 - 48)));
    assert.equal(applied, 429);
    assert.ok(applied <= 477 - 48, 'clamp 上限必须 ≤ clientWidth - 48');
    assert.ok(477 - applied >= 48, `实际可点遮罩 ${477 - applied}px 必须 >= 48px`);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('MINOR-2: 窗口变化（clientWidth=1200 / innerWidth=1215）时遮罩仍 ≥48px', () => {
  const env = createEnv({ innerWidth: 1215, clientWidth: 1200 });
  const drawer = createDrawer(env, { defaultWidth: 600, minWidth: 420, maxWidthRatio: 0.9 });
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    drawer.setWidth(2000);
    const applied = drawer._appliedWidth;
    // hi = min(0.9*1200, 1200-48) = min(1080, 1152) = 1080
    assert.equal(applied, 1080);
    assert.ok(1200 - applied >= 48, `实际可点遮罩 ${1200 - applied}px 必须 >= 48px`);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('MINOR-2: clientWidth 为 0 / undefined 时回退 innerWidth，不崩', () => {
  for (const layoutWidth of [0, undefined]) {
    const env = createEnv({ innerWidth: 492 });
    env.documentElement.clientWidth = layoutWidth;
    const drawer = createDrawer(env, { defaultWidth: 600, minWidth: 420, maxWidthRatio: 0.9 });
    try {
      drawer.open('https://sidepeek.test/v/1', { title: 'A' });
      drawer.setWidth(2000);
      // 回退 innerWidth=492：hi = min(0.9*492, 492-48) = min(442.8, 444) = 443
      assert.equal(drawer._appliedWidth, 443, `clientWidth=${layoutWidth} 时应回退 innerWidth`);
    } finally {
      safeDestroy(drawer);
      env.restore();
    }
  }
});

test('MINOR-2: 无滚动条（innerWidth === clientWidth）时宽度口径不变', () => {
  const env = createEnv({ innerWidth: 1280, clientWidth: 1280 });
  const drawer = createDrawer(env, { defaultWidth: 600, minWidth: 420, maxWidthRatio: 0.9 });
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    assert.equal(drawer._appliedWidth, 600, 'defaultWidth 未被误改');
    drawer.setWidth(99999);
    assert.equal(drawer._appliedWidth, 1152, '宽视口上限仍为 0.9*1280');
    assert.ok(1280 - 1152 >= 48);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 4. DOM 结构 / M-02 inert / sandbox 属性
 * ================================================================== */

test('open: Shadow DOM 结构、iframe sandbox 属性、关闭态 inert 与 pointer-events 分层', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    assert.equal(env.findHost(), null, '初始不应创建宿主（懒创建）');

    const pageAnchor = env.document.createElement('a');
    env.body.appendChild(pageAnchor);
    env.document.activeElement = pageAnchor;

    drawer.open('https://sidepeek.test/v/1', { title: '视频一' });
    const host = env.findHost();
    assert.ok(host, 'open 后应有 #sidepeek-host');
    assert.notEqual(host.style.cssText.indexOf('pointer-events:none'), -1, '宿主必须 pointer-events:none');
    assert.notEqual(host.style.cssText.indexOf('position:fixed'), -1);

    const drawerEl = shadowEl(env, 'sp-drawer');
    const frameEl = shadowEl(env, 'sp-frame');
    const maskEl = shadowEl(env, 'sp-mask');
    assert.ok(drawerEl && frameEl && maskEl);
    assert.equal(drawerEl.classList.contains('sp-open'), true);
    assert.equal(drawerEl.hasAttribute('inert'), false, '展开态必须移除 inert');
    assert.equal(drawerEl.getAttribute('aria-hidden'), 'false');
    assert.equal(drawerEl.getAttribute('aria-modal'), null, '不得声明 aria-modal（无焦点陷阱）');
    assert.equal(env.document.activeElement, drawerEl, '打开后焦点交给抽屉');

    // iframe sandbox 必须逐字等于静态白名单，且不含顶层导航
    assert.equal(frameEl.getAttribute('sandbox'), SidePeekDrawer.SANDBOX);
    assert.equal(/allow-top-navigation/i.test(frameEl.getAttribute('sandbox')), false);

    // 关闭态：inert + aria-hidden + 焦点先归还
    drawer.close();
    await tick(40);
    assert.equal(drawer.isOpen(), false);
    assert.equal(shadowEl(env, 'sp-drawer').hasAttribute('inert'), true, '关闭态抽屉必须 inert');
    assert.equal(shadowEl(env, 'sp-drawer').getAttribute('aria-hidden'), 'true');
    assert.equal(env.document.activeElement, pageAnchor, '关闭时必须把焦点还给打开前的元素');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('open: 展开态 aria-hidden=false 且 inert 被移除', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    const pageAnchor = env.document.createElement('a');
    env.body.appendChild(pageAnchor);
    env.document.activeElement = pageAnchor;
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    const drawerEl = shadowEl(env, 'sp-drawer');
    assert.equal(drawerEl.getAttribute('aria-hidden'), 'false');
    assert.equal(drawerEl.hasAttribute('inert'), false);
    assert.equal(env.document.activeElement, drawerEl, '打开后焦点应交给抽屉（Esc 才收得到）');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 5. History 状态机（popstate / 无二次 back / I-10）
 * ================================================================== */

test('popstate: peek → open、非 peek → hide、hide 过程中不再 back()', async () => {
  const env = createEnv();
  const closes = [];
  const drawer = createDrawer(env, { onClose: () => closes.push(1) });
  try {
    const backCalls = [];
    const realBack = env.history.back.bind(env.history);
    env.history.back = () => {
      backCalls.push(1);
      return realBack();
    };

    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    assert.equal(drawer.isOpen(), true);
    const lengthAfterOpen = env.history.length;
    assert.equal(env.history.state.__sidepeek, 1);

    // 用户按后退：popstate(state=null) → 收起
    env.history.back();
    await tick(30);
    assert.equal(drawer.isOpen(), false);
    assert.equal(env.history.length, lengthAfterOpen);
    assert.equal(env.history.state, null);
    assert.equal(backCalls.length, 1, '关闭只应触发 1 次 back()');
    assert.equal(closes.length, 1, 'onClose 只调一次');

    // 前进：popstate(peek) → 重新打开，且不 push 新条目
    env.history.forward();
    await tick(40);
    assert.equal(drawer.isOpen(), true);
    assert.equal(drawer._url, 'https://sidepeek.test/v/1');
    assert.equal(env.history.length, lengthAfterOpen, '前进重开不应增长 history.length');
    assert.equal(backCalls.length, 1, 'popstate 处理里绝不能再 back()');
    assert.equal(closes.length, 1);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('popstate: state 非 peek 时立即收起，且不清理/改写 history', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    const replaceSpy = [];
    const realReplace = env.history.replaceState.bind(env.history);
    env.history.replaceState = (state, title, url) => {
      replaceSpy.push(String(url));
      return realReplace(state, title, url);
    };

    // 模拟 B 站 SPA 覆盖掉我们的条目后触发 popstate（state=null）
    env.window.__dispatch('popstate', { type: 'popstate', state: { bilibili: true } });
    assert.equal(drawer.isOpen(), false);
    assert.deepEqual(replaceSpy, [], 'popstate 收起路径不应调用 replaceState');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 6. M-04 / I-10：前进重开时标题回填（真实 core 顺序 + 适配层模拟）
 * ================================================================== */

test('M-04/I-10 回归：open A → 切 B → 关闭 → 前进重开，history.length 不增长且标题回填', async () => {
  const env = createEnv();
  let activeUrl = null;
  const resolved = [];
  const adapter = {
    onOpen: (url) => {
      activeUrl = url;
    },
    onClose: () => {
      activeUrl = null;
    },
    // 真实 content.js 的 resolveTitle：第一行就要求 activeUrl === url（防串台）
    resolveTitle: (url) => {
      if (activeUrl !== url) return Promise.resolve(null);
      resolved.push(url);
      return Promise.resolve(`真实标题:${url}`);
    }
  };
  const drawer = createDrawer(env, adapter);
  try {
    const urlA = 'https://sidepeek.test/v/A';
    const urlB = 'https://sidepeek.test/v/B';
    const baseLength = env.history.length;

    drawer.open(urlA, { title: '临时A' });
    await tick(30);
    assert.equal(env.history.length, baseLength + 1);
    assert.equal(drawer.isOpen(), true);

    // I-08：切 B，只换内容、不重播、history 长度不变
    drawer.open(urlB, { title: '临时B' });
    await tick(30);
    assert.equal(env.history.length, baseLength + 1, '切换不得新增历史条目');
    assert.equal(shadowEl(env, 'sp-drawer').classList.contains('sp-open'), true, '不得重播入场动画');

    // 关闭（走 back + popstate）
    drawer.close();
    await tick(40);
    assert.equal(drawer.isOpen(), false);
    assert.equal(env.history.length, baseLength + 1);
    assert.equal(env.location.hash, '');

    // 场景里刻意保留旧标题状态，验证「前进重开」时没有 options.title 也能回填
    assert.equal(shadowEl(env, 'sp-title').textContent, '真实标题:' + urlB);

    // 浏览器前进：peek 记录重新打开抽屉
    env.history.forward();
    await tick(60);
    assert.equal(drawer.isOpen(), true);
    assert.equal(drawer._url, urlB);
    assert.equal(env.history.length, baseLength + 1, 'I-10 回归：前进 re-open 不得增长 history.length');
    assert.ok(resolved.indexOf(urlB) !== -1, 'resolveTitle 必须在 onOpen 之后被调用（M-04）');
    assert.equal(shadowEl(env, 'sp-title').textContent, '真实标题:' + urlB, '前进重开必须回填标题');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 7. M-03：F5 刷新残留自愈
 * ================================================================== */

test('M-03: #sidepeek= 与 history.state.__sidepeek 残留会在实例初始化时被清理一次', () => {
  SidePeekDrawer.__resetHistoryHealGuardForTest(); // N-06：每个用例模拟"文档首次初始化"
  const replaceSpy = [];
  const env = createEnv({
    href: 'https://sidepeek.test/page#sidepeek=https%3A%2F%2Fsidepeek.test%2Fv%2F1',
    initialState: { __sidepeek: 1, url: 'https://sidepeek.test/v/1' },
    replaceStateSpy: replaceSpy
  });
  const drawer = createDrawer(env);
  try {
    assert.deepEqual(replaceSpy, ['https://sidepeek.test/page'], '应恰好 replaceState 一次且去掉 hash');
    assert.equal(env.history.state, null);
    assert.equal(env.location.hash, '');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('M-03: 没有残留时不碰 history（不抢 B 站 SPA 路由）', () => {
  SidePeekDrawer.__resetHistoryHealGuardForTest();
  const replaceSpy = [];
  const env = createEnv({ replaceStateSpy: replaceSpy });
  const drawer = createDrawer(env);
  try {
    assert.deepEqual(replaceSpy, []);
    assert.equal(env.history.state, null);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('N-06: 自愈整个文档生命周期只执行一次，不会清掉后续正在记账的历史条目', () => {
  SidePeekDrawer.__resetHistoryHealGuardForTest();
  const env = createEnv({
    href: 'https://sidepeek.test/page#sidepeek=https%3A%2F%2Fsidepeek.test%2Fv%2F1',
    initialState: { __sidepeek: 1, url: 'https://sidepeek.test/v/1' }
  });
  const first = createDrawer(env);
  try {
    assert.equal(env.location.hash, '', '首次初始化应清掉残留');

    // 模拟"抽屉已经打开、正在记账"的活条目（页面运行期绝不能再被自愈清掉）
    env.history.pushState(
      { __sidepeek: 1, url: 'https://sidepeek.test/v/live' },
      '',
      env.location.href.split('#')[0] + '#sidepeek=' + encodeURIComponent('https://sidepeek.test/v/live')
    );
    const liveHash = env.location.hash;
    const liveState = env.history.state;

    const second = createDrawer(env); // 第二个实例（测试 / 未来热重载）
    try {
      assert.equal(env.location.hash, liveHash, 'once 护栏：第二次构造不得再清理');
      assert.deepEqual(env.history.state, liveState);
    } finally {
      safeDestroy(second);
    }
  } finally {
    safeDestroy(first);
    env.restore();
  }
});

/* ================================================================== *
 * 7.1 N-07：sandbox 守护（_guardSandbox）
 * ================================================================== */

test('N-07: sandbox 被外部改写/移除时，_guardSandbox 会恢复成内置组合', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);

    const frameEl = shadowEl(env, 'sp-frame');
    const observer = env.mutationObservers[env.mutationObservers.length - 1];
    assert.ok(observer, '应创建 MutationObserver 守护 sandbox');
    assert.equal(observer.observed[0].target, frameEl);
    assert.deepEqual(observer.observed[0].options.attributeFilter, ['sandbox']);

    // 外部脚本放宽（含顶层导航 token）→ 必须恢复
    frameEl.setAttribute('sandbox', `${SidePeekDrawer.SANDBOX} allow-top-navigation`);
    observer.__trigger();
    assert.equal(frameEl.getAttribute('sandbox'), SidePeekDrawer.SANDBOX);

    // 大小写变体也要识别
    frameEl.setAttribute('sandbox', `Allow-Top-Navigation ${SidePeekDrawer.SANDBOX}`);
    observer.__trigger();
    assert.equal(frameEl.getAttribute('sandbox'), SidePeekDrawer.SANDBOX);

    // 整个属性被移除 → 必须恢复
    frameEl.removeAttribute('sandbox');
    observer.__trigger();
    assert.equal(frameEl.getAttribute('sandbox'), SidePeekDrawer.SANDBOX);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 8. B-01：拖拽跨 iframe
 * ================================================================== */

test('B-01: 拖拽开始关闭 iframe 命中，结束/关闭/销毁都会还原', async () => {
  const env = createEnv();
  const persist = [];
  const drawer = createDrawer(env, { persistWidth: (px) => persist.push(px) });
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    const frameEl = shadowEl(env, 'sp-frame');
    assert.equal(frameEl.style.pointerEvents, '');

    const dragStart = {
      button: 0,
      clientX: 900,
      preventDefault() {},
      stopPropagation() {}
    };
    drawer._handleDragStart(dragStart);
    assert.equal(frameEl.style.pointerEvents, 'none', '拖拽期间 iframe 必须不可命中');
    assert.equal(env.countOf('mousemove', true), 1);
    assert.equal(env.countOf('mouseup', true), 1);
    assert.equal(env.documentElement.style.cursor, 'ew-resize');
    assert.equal(env.documentElement.style.userSelect, 'none');

    // mousemove 节流到 rAF：flush 前不改宽度，flush 后按最近位置算
    drawer._handleDragMove({ buttons: 1, clientX: 800 });
    env.flushRaf();
    assert.equal(drawer._width, 700, '600 + (900-800) = 700');

    // 松手（真实 mouseup 路径）
    drawer._handleDragEnd();
    assert.equal(frameEl.style.pointerEvents, '');
    assert.equal(env.documentElement.style.cursor, '', 'cursor 必须还原，不能污染 B 站');
    assert.equal(env.documentElement.style.userSelect, '');
    assert.equal(env.countOf('mousemove', true), 0);
    assert.equal(env.countOf('mouseup', true), 0);
    assert.deepEqual(persist, [700], '松手必须回调 persistWidth');

    // buttons === 0 兜底：mouseup 丢失后无按键移动 → 视为松手，且不再改宽度
    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    const widthBefore = drawer._width;
    drawer._handleDragMove({ buttons: 0, clientX: 500 });
    assert.equal(drawer._drag, null, 'buttons===0 必须结束拖拽');
    assert.equal(drawer._width, widthBefore, 'mouseup 丢失后的移动不得再改宽度');
    assert.equal(env.documentElement.style.cursor, '');
    assert.equal(frameEl.style.pointerEvents, '');

    // window.blur 兜底：监听已挂 + 触发后收尾
    assert.equal(env.window.__hasListener('blur', false), true, '必须监听 window blur');
    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    env.window.__dispatch('blur', { type: 'blur' });
    assert.equal(drawer._drag, null, 'blur 必须视为松手');
    assert.equal(env.documentElement.style.cursor, '');

    // 拖拽中关闭：拖拽态不得跨关闭存活
    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    drawer._hide();
    assert.equal(drawer._drag, null, '_hide 必须结束拖拽');
    assert.equal(env.documentElement.style.cursor, '');
    assert.equal(frameEl.style.pointerEvents, '');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 8.1 N-01 / N-02 / N-03 / N-04：拖拽收尾、落盘、iframe 重建、关闭顺序
 * ================================================================== */

test('N-01: 松手时先同步 flush 待执行 rAF 再落盘（宽度不回退、persist 值不偏）', async () => {
  const env = createEnv();
  const persist = [];
  const drawer = createDrawer(env, { persistWidth: (px) => persist.push(px) });
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);

    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    drawer._handleDragMove({ buttons: 1, clientX: 700 }); // 只排进 rAF，尚未应用
    assert.equal(drawer._appliedWidth, 600, 'rAF 未 flush 前样式宽度还是旧值');

    drawer._handleDragEnd(); // 松手：必须先补算最后一帧再落盘
    assert.equal(drawer._width, 800, '松手必须补算 900-700=200 的位移');
    assert.equal(drawer._appliedWidth, 800, '松手后视觉宽度不得回退');
    assert.deepEqual(persist, [800], 'persistWidth 必须是最终宽度，不能偏小');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('N-02: mouseup 丢失（buttons===0 兜底）也会把这次拖拽的宽度落盘', async () => {
  const env = createEnv();
  const persist = [];
  const drawer = createDrawer(env, { persistWidth: (px) => persist.push(px) });
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);

    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    drawer._handleDragMove({ buttons: 1, clientX: 700 });
    drawer._handleDragMove({ buttons: 0, clientX: 650 }); // mouseup 丢了：下一次无按键移动

    assert.equal(drawer._drag, null);
    assert.deepEqual(persist, [800], '兜底路径也必须持久化最终宽度');
    assert.equal(env.documentElement.style.cursor, '');
    assert.equal(shadowEl(env, 'sp-frame').style.pointerEvents, '');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('N-03: 拖拽中切 URL（重建 iframe）后，新节点仍然不可命中', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/A', { title: 'A' });
    await tick(20);
    const frameA = shadowEl(env, 'sp-frame');

    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    assert.equal(frameA.style.pointerEvents, 'none');

    drawer.open('https://sidepeek.test/v/B', { title: 'B' }); // 重建 iframe
    const frameB = shadowEl(env, 'sp-frame');
    assert.notEqual(frameB, frameA, '切 URL 应重建 iframe 节点');
    assert.equal(frameB.style.pointerEvents, 'none', 'N-03：新节点必须补上不可命中');
    assert.equal(drawer._drag !== null, true, '拖拽态不应被换页打断');

    drawer._handleDragEnd();
    assert.equal(frameB.style.pointerEvents, '', '松手后恢复命中策略');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('N-04: _hide 顺序 = 先还焦点 → 置 inert → 再 aria-hidden', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    const drawerEl = shadowEl(env, 'sp-drawer');
    const order = [];

    const realRestore = drawer._restoreFocus.bind(drawer);
    drawer._restoreFocus = function restoreSpy() {
      order.push('restore-focus');
      return realRestore();
    };
    const realSet = drawerEl.setAttribute.bind(drawerEl);
    drawerEl.setAttribute = function setSpy(name, value) {
      if (name === 'inert' || name === 'aria-hidden') order.push(`attr:${name}`);
      return realSet(name, value);
    };

    drawer._hide();
    assert.deepEqual(order, ['restore-focus', 'attr:inert', 'attr:aria-hidden']);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('N-04b: 上一个焦点不可聚焦（focus() 是 no-op）时，显式 blur 抽屉内焦点', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    // 模拟 <body> 这类不可聚焦元素：focus() 是 no-op
    const bodyEl = env.body;
    bodyEl.focus = function noopFocus() {};
    env.document.activeElement = bodyEl;

    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    assert.equal(env.document.activeElement, shadowEl(env, 'sp-drawer'));

    let blurCalls = 0;
    shadowEl(env, 'sp-drawer').blur = function blurSpy() {
      blurCalls += 1;
    };

    drawer._hide();
    assert.equal(blurCalls, 1, '焦点不可归还时必须显式 blur，避免 aria-hidden 被 Chrome 拦掉');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 9. destroy：监听器净计数归零 + 幂等 + 之后 open 抛错
 * ================================================================== */

test('destroy: window/document 监听净计数归零，拖拽中销毁也能清干净', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    assert.equal(env.window.__hasListener('keydown', true), true);
    assert.equal(env.window.__hasListener('resize', false), true);
    assert.equal(env.window.__hasListener('popstate', false), true);
    assert.equal(env.window.__hasListener('blur', false), true);

    // 拖拽中 destroy：document 上的 mousemove/mouseup 必须也摘掉
    drawer._handleDragStart({ button: 0, clientX: 900, preventDefault() {}, stopPropagation() {} });
    assert.equal(env.countOf('mousemove', true), 1);

    drawer.destroy();
    assert.deepEqual(env.listenerNet(), {}, 'destroy 后所有监听净计数必须为 0');
    assert.equal(env.documentElement.style.cursor, '');
    assert.equal(env.documentElement.style.userSelect, '');
    assert.equal(env.findHost(), null, 'destroy 必须移除宿主节点');

    drawer.destroy(); // 幂等
    assert.throws(() => drawer.open('https://sidepeek.test/v/2'), /destroy/);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 10. MINOR：P-03 / P-05 / P-06 / P-08
 * ================================================================== */

test('P-03: 只拦截「顶层 URL 完全相同」的自我嵌套；同路径不同 query 交给 core 打开', async () => {
  const env = createEnv({ href: 'https://sidepeek.test/v/1?p=2' });
  const drawer = createDrawer(env);
  try {
    // 完全相同的 URL（忽略 hash）→ 不打开
    drawer.open('https://sidepeek.test/v/1?p=2#reply', { title: 'same' });
    assert.equal(drawer.isOpen(), false);
    assert.equal(env.history.length, 1, '同一 URL 不应产生历史条目');

    // 同 path 但无 query（适配层判定为不同页）→ core 必须真的打开，不能出现死点
    drawer.open('https://sidepeek.test/v/1', { title: 'no-query' });
    assert.equal(drawer.isOpen(), true, 'P-03：不得把「目标无 search」误判为同页');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('P-05: close() 后 popstate 未落地前再次 open()，不会把 _closePending 卡死', async () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);

    // 模拟 back() 被吃掉（popstate 不来）
    const realBack = env.history.back.bind(env.history);
    env.history.back = () => {};
    drawer.close();
    assert.equal(drawer._closePending, true);

    // 关闭还没落地就再次打开
    drawer.open('https://sidepeek.test/v/2', { title: 'B' });
    assert.equal(drawer._closePending, false, 'open() 必须复位 _closePending');
    assert.equal(drawer._closeGuard, null, 'open() 必须清掉旧的关闭兜底定时器');

    // 恢复后仍能正常关闭
    env.history.back = realBack;
    drawer.close();
    await tick(40);
    assert.equal(drawer.isOpen(), false);
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('P-06: 宿主页面注入 <style id="sidepeek-core-css"> 也不能改写抽屉样式', async () => {
  const env = createEnv();
  const evilStyle = env.document.createElement('style');
  evilStyle.setAttribute('id', 'sidepeek-core-css');
  evilStyle.textContent = '.sp-drawer{display:none!important}' + 'x'.repeat(300);
  env.documentElement.appendChild(evilStyle);

  const drawer = createDrawer(env);
  try {
    drawer.open('https://sidepeek.test/v/1', { title: 'A' });
    await tick(20);
    const root = env.shadowRoot();
    const styleEl = root.children.find((child) => child.tagName === 'STYLE');
    assert.ok(styleEl);
    assert.equal(styleEl.textContent, SidePeekDrawer.CSS_TEXT, '样式必须只来自内嵌 CSS_TEXT');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

test('P-08: _legacyCopy 抛错时临时 textarea 也必须被移除', () => {
  const env = createEnv();
  const drawer = createDrawer(env);
  try {
    env.document.execCommand = () => {
      throw new Error('execCommand denied');
    };
    const ok = drawer._legacyCopy('https://sidepeek.test/v/1');
    assert.equal(ok, false);
    const leftovers = env.body.children.filter((child) => child.tagName === 'TEXTAREA');
    assert.deepEqual(leftovers, [], '不得在 B 站 body 里残留 textarea');
  } finally {
    safeDestroy(drawer);
    env.restore();
  }
});

/* ================================================================== *
 * 11. P-16：跨文件常量一致性
 * ================================================================== */

test('P-16: core 的 SANDBOX 与 content.js 的 SANDBOX 完全一致', () => {
  const contentSource = fs.readFileSync(CONTENT_PATH, 'utf8');
  const match = contentSource.match(/var\s+SANDBOX\s*=\s*'([^']+)'/);
  assert.ok(match, '应能在 content.js 中提取 SANDBOX 常量');
  assert.equal(match[1].trim(), SidePeekDrawer.SANDBOX);
  assert.equal(/allow-top-navigation/i.test(match[1]), false);
});

/* ================================================================== *
 * 12. P-15：CSS 防漂移脚本可执行且当前一致
 * ================================================================== */

test('P-15: node scripts/check-css-sync.mjs 可执行且当前 CSS 一致', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-css-sync.mjs')], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.match(output, /CSS in sync \(\d+ bytes\)/);
});

/* ================================================================== *
 * 13. N-09：content.js ↔ background.js 路径白名单行为一致性
 * ================================================================== */

function loadContentTestApi() {
  const sandbox = { console, URL, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), sandbox, { filename: 'src/content.js' });
  return sandbox.__SIDEPEEK_TEST__;
}

function loadBackgroundTestApi() {
  const sandbox = { console, URL };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8'), sandbox, {
    filename: 'src/background.js'
  });
  return sandbox.__SIDEPEEK_TEST_BG__;
}

test('N-09: content 的 PEEK_PATH_PATTERNS 与 background 的 PEEK_PATH_RE 行为一致', () => {
  const contentApi = loadContentTestApi();
  const backgroundApi = loadBackgroundTestApi();
  assert.ok(contentApi && typeof contentApi.classifyPeekPath === 'function');
  // 注意：vm 跨 realm，instanceof RegExp 会判 false，用 toString 判类型
  assert.equal(Object.prototype.toString.call(backgroundApi && backgroundApi.PEEK_PATH_RE), '[object RegExp]');

  const pathnames = [
    // 正例：四类白名单
    '/video/BV1xx411c7mD',
    '/video/BV1xx411c7mD/',
    '/video/av170001',
    '/bangumi/play/ep123456',
    '/bangumi/play/ss12345',
    '/cheese/play/ep123',
    '/list/ml1234567',
    '/list/pl123',
    // 反例 / 边界
    '/',
    '/video/',
    '/video/BV123',
    '/video/av',
    '/bangumi/media/md123',
    '/bangumi/play/md123',
    '/cheese/play/',
    '/list/',
    '/list/abc1',
    '/read/cv123456',
    '/search/all',
    '/space/123456',
    ''
  ];

  for (const pathname of pathnames) {
    const contentHit = !!contentApi.classifyPeekPath(pathname);
    const backgroundHit = backgroundApi.PEEK_PATH_RE.test(pathname);
    assert.equal(contentHit, backgroundHit, `content 与 background 对路径 ${JSON.stringify(pathname)} 判定不一致`);
  }

  // 明确断言几个关键正例两侧都放行、几个关键反例两侧都拒绝
  for (const pathname of ['/video/BV1xx411c7mD', '/bangumi/play/ep1', '/cheese/play/ss1', '/list/ml1']) {
    assert.equal(contentApi.classifyPeekPath(pathname) !== null, true, pathname);
    assert.equal(backgroundApi.PEEK_PATH_RE.test(pathname), true, pathname);
  }
  for (const pathname of ['/read/cv1', '/search/all', '/']) {
    assert.equal(contentApi.classifyPeekPath(pathname), null, pathname);
    assert.equal(backgroundApi.PEEK_PATH_RE.test(pathname), false, pathname);
  }
});
