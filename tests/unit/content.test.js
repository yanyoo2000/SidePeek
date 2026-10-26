/**
 * src/content.js 单元测试（node --test，零依赖）
 *
 * 分两部分：
 *   A. 纯函数：URL 判定 / 同页判定 / 宽度 clamp / 临时标题 —— 直接加载 IIFE 导出的
 *      globalThis.__SIDEPEEK_TEST__。
 *   B. 适配层行为：用 vm 沙箱 + 假 chrome / 假 document / 假 SidePeekDrawer 跑真实
 *      content.js，验证捕获阶段拦截、修饰键跳过、target="_blank"、I-15、幂等、宽度持久化。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_PATH = path.join(__dirname, '..', '..', 'src', 'content.js');
const CONTENT_CODE = fs.readFileSync(CONTENT_PATH, 'utf8');

// vm 沙箱里 new 出来的对象原型属于另一个 realm，deepStrictEqual 会因原型不同判负；
// 比较前统一 JSON 归一化。
const normalize = (value) => JSON.parse(JSON.stringify(value));

/* ================================================================== *
 * A. 纯函数
 * ================================================================== */

function loadPureApi() {
  const sandbox = { console, URL, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_CODE, sandbox, { filename: 'src/content.js' });
  assert.ok(sandbox.__SIDEPEEK_TEST__, 'content.js 应导出 globalThis.__SIDEPEEK_TEST__');
  return sandbox.__SIDEPEEK_TEST__;
}

const api = loadPureApi();

test('matchPeekUrl: 正例（video/av/bangumi/cheese/list + 子域 + 保留 query）', () => {
  const cases = [
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/BV1xx411c7mD/',
    'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.999.0.0&vd_source=abc123',
    'https://www.bilibili.com/video/av170001?p=2',
    'https://www.bilibili.com/bangumi/play/ep123456',
    'https://www.bilibili.com/bangumi/play/ss12345',
    'https://www.bilibili.com/cheese/play/ep123',
    'https://www.bilibili.com/list/ml1234567?bvid=BV1xx411c7mD',
    'https://www.bilibili.com/list/pl123',
    'https://m.bilibili.com/video/BV1xx411c7mD',
    'http://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/BV1xx411c7mD#reply123'
  ];
  for (const href of cases) {
    assert.equal(api.matchPeekUrl(href), href, `应命中：${href}`);
  }
});

test('matchPeekUrl: 保留全部分P/追踪参数原样（不重排、不丢参数）', () => {
  const href = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=3&spm_id_from=333.999&vd_source=a%2Fb';
  assert.equal(api.matchPeekUrl(href), href);
});

test('matchPeekUrl: 相对链接按当前页面解析', () => {
  assert.equal(
    api.matchPeekUrl('/video/BV1xx411c7mD?p=2', 'https://www.bilibili.com/'),
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2'
  );
});

test('matchPeekUrl: 反例（非视频页 / 非 B 站域 / 畸形 URL）', () => {
  const cases = [
    'https://www.bilibili.com/',
    'https://www.bilibili.com/video/',
    'https://www.bilibili.com/video/BV123',
    'https://www.bilibili.com/video/av',
    'https://space.bilibili.com/123456',
    'https://search.bilibili.com/all?keyword=%E6%B8%B8%E6%88%8F',
    'https://www.bilibili.com/read/cv123456',
    'https://www.bilibili.com/bangumi/media/md123',
    'https://evilbilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com.evil.com/video/BV1xx411c7mD',
    'https://notbilibili.com/video/BV1xx411c7mD',
    'javascript:void(0)',
    'ftp://www.bilibili.com/video/BV1xx411c7mD',
    '',
    null,
    undefined
  ];
  for (const href of cases) {
    assert.equal(api.matchPeekUrl(href), null, `不应命中：${String(href)}`);
  }
});

test('isPeekableUrl: 与 matchPeekUrl 判定一致', () => {
  assert.equal(api.isPeekableUrl('https://www.bilibili.com/video/BV1xx411c7mD'), true);
  assert.equal(api.isPeekableUrl('https://www.bilibili.com/'), false);
  assert.equal(api.isPeekableUrl('not a url'), false);
});

test('isSamePeekPage: 忽略追踪参数与尾部斜杠，但区分分P与不同视频', () => {
  const current = 'https://www.bilibili.com/video/BV1xx411c7mD';

  // 同一视频 + 不同 spm 追踪参数 → 视为同一页（I-15）
  assert.equal(api.isSamePeekPage(`${current}?spm_id_from=333.999&vd_source=abc`, current), true);
  // 尾部斜杠不影响判定
  assert.equal(api.isSamePeekPage(`${current}/`, current), true);
  // 分P 不同 → 不是同一页
  assert.equal(api.isSamePeekPage(`${current}?p=2`, current), false);
  // 两个不同视频
  assert.equal(
    api.isSamePeekPage('https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1yy411c7mE'),
    false
  );
  // 当前页不是视频页 → 不可能相同
  assert.equal(
    api.isSamePeekPage('https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/'),
    false
  );
  // 番剧同 ep 也识别为同页
  assert.equal(
    api.isSamePeekPage('https://www.bilibili.com/bangumi/play/ep123?spm_id_from=a', 'https://www.bilibili.com/bangumi/play/ep123'),
    true
  );
});

test('clampWidth: 上限/下限/取整/非法输入', () => {
  assert.equal(api.clampWidth(800, 420, 1080), 800);
  assert.equal(api.clampWidth(100, 420, 1080), 420);
  assert.equal(api.clampWidth(2000, 420, 1080), 1080);
  assert.equal(api.clampWidth(800.6, 420, 1080), 801);
  assert.equal(api.clampWidth('800', 420, 1080), 800);
  assert.equal(api.clampWidth(0, 420, 1080), 420);
  // 极端窄视口：maxWidth < minWidth 时以“不溢出屏幕”为先
  assert.equal(api.clampWidth(500, 420, 400), 400);
  // 非法值返回 null，调用方回落到 widthRatio
  assert.equal(api.clampWidth(null, 420, 1080), null);
  assert.equal(api.clampWidth(undefined, 420, 1080), null);
  assert.equal(api.clampWidth(NaN, 420, 1080), null);
  assert.equal(api.clampWidth(Infinity, 420, 1080), null);
});

test('computeWidthBounds: G-05 公式 hi=min(ratio*vw, vw-48) / lo=min(minWidth, hi)', () => {
  // 常规桌面视口：0.9*1200=1080 < 1200-48=1152 → 1080
  assert.deepEqual(normalize(api.computeWidthBounds(1200, 420, 0.9, 48)), { min: 420, max: 1080 });
  // 900px 窄视口：0.9*900=810 < 852 → 810
  assert.deepEqual(normalize(api.computeWidthBounds(900, 420, 0.9, 48)), { min: 420, max: 810 });
  // 480px：min(432, 432) = 432
  assert.deepEqual(normalize(api.computeWidthBounds(480, 420, 0.9, 48)), { min: 420, max: 432 });
  // 450px：0.9*450=405 > 402（vw-48）→ 402，lo 也跟着降到 402，保证 lo <= hi
  assert.deepEqual(normalize(api.computeWidthBounds(450, 420, 0.9, 48)), { min: 402, max: 402 });
  assert.deepEqual(normalize(api.computeWidthBounds(400, 420, 0.9, 48)), { min: 352, max: 352 });
  // 非法视口回落到 1280：0.9*1280=1152 < 1280-48
  assert.deepEqual(normalize(api.computeWidthBounds(0, 420, 0.9, 48)), { min: 420, max: 1152 });
});

test('classifyPeekPath: G-09 白名单按类型拆分，/video/ 是唯一已实测类型', () => {
  assert.equal(api.classifyPeekPath('/video/BV1xx411c7mD'), 'video');
  assert.equal(api.classifyPeekPath('/video/av170001'), 'video');
  assert.equal(api.classifyPeekPath('/bangumi/play/ep123'), 'bangumi');
  assert.equal(api.classifyPeekPath('/cheese/play/ss123'), 'cheese');
  assert.equal(api.classifyPeekPath('/list/ml123'), 'list');
  assert.equal(api.classifyPeekPath('/list/pl123'), 'list');
  assert.equal(api.classifyPeekPath('/read/cv123'), null);
  assert.equal(api.classifyPeekPath('/video/'), null);
  assert.equal(api.classifyPeekPath(''), null);
  assert.equal(api.classifyPeekPath(null), null);

  // 白名单是唯一收窄点：删一行就关掉一类路径
  assert.deepEqual(
    [...api.PEEK_PATH_PATTERNS].map((item) => item.type),
    ['video', 'bangumi', 'cheese', 'list']
  );
  const bestEffort = [...api.PEEK_PATH_PATTERNS].filter((item) => item.bestEffort === true);
  assert.equal(bestEffort.length, 3, 'bangumi/cheese/list 必须标注为 best-effort');
  assert.equal(api.PEEK_PATH_PATTERNS[0].type, 'video');
  assert.equal(api.PEEK_PATH_PATTERNS[0].bestEffort, undefined, '/video/ 是已实测类型，不标 best-effort');
});

test('normalizeTitleText: 折叠空白 / 去标签 / 截断 / 非字符串', () => {
  assert.equal(api.normalizeTitleText('  【标题】 \n\t 视频  '), '【标题】 视频');
  assert.equal(api.normalizeTitleText('<b>标题</b>'), '标题');
  assert.equal(api.normalizeTitleText(null), '');
  assert.equal(api.normalizeTitleText(undefined), '');
  assert.equal(api.normalizeTitleText('一二三四五六七八九十', 5), '一二三四五');
});

test('scanPathForAnchor: 找最近 <a href>，遇到控件则不拦截', () => {
  const anchor = makeElement('A', { href: '/video/BV1xx411c7mD' });
  const span = makeElement('SPAN');
  const div = makeElement('DIV');
  const button = makeElement('BUTTON');
  const roleButton = makeElement('DIV', { role: 'button' });

  // 点击目标在 <a> 内部 → 命中
  assert.equal(api.scanPathForAnchor([span, anchor, div]), anchor);
  // 点击目标就是 <a> → 命中
  assert.equal(api.scanPathForAnchor([anchor]), anchor);
  // 按钮在 <a> 内侧（卡片上的「稍后再看」）→ 不拦截
  assert.equal(api.scanPathForAnchor([button, anchor, div]), null);
  // role="button" 同理
  assert.equal(api.scanPathForAnchor([roleButton, anchor]), null);
  // 没有 <a> → null
  assert.equal(api.scanPathForAnchor([span, div]), null);
  // 空 / 非法
  assert.equal(api.scanPathForAnchor([]), null);
  assert.equal(api.scanPathForAnchor(null), null);
  // 文本节点被跳过
  assert.equal(api.scanPathForAnchor([{ nodeType: 3 }, anchor]), anchor);
  // 无 href 的 <a> 只是占位，继续往上找外层 <a>
  const hrefLess = makeElement('A');
  assert.equal(api.scanPathForAnchor([hrefLess, anchor]), anchor);
});

test('isFromDrawerHost: 抽屉 Shadow DOM 内的点击要被忽略', () => {
  assert.equal(api.isFromDrawerHost([{ nodeType: 1, id: 'sidepeek-host' }]), true);
  assert.equal(api.isFromDrawerHost([{ nodeType: 1, id: 'app' }, { nodeType: 1, id: 'sidepeek-host' }]), true);
  assert.equal(api.isFromDrawerHost([{ nodeType: 1, id: 'app' }]), false);
  assert.equal(api.isFromDrawerHost(null), false);
});

test('extractTempTitle: 先用 textContent，空则兜底 [title] 属性 / 子元素 [title]', () => {
  // SPEC §4.3：链接文字优先
  const plain = makeElement('A', {}, {}, ' 普通链接文字 ');
  assert.equal(api.extractTempTitle(plain), '普通链接文字');

  // 纯图片卡片链接没有文字 → 用自身的 title 属性
  const imageOnly = makeElement('A', { title: '【干净标题】' });
  assert.equal(api.extractTempTitle(imageOnly), '【干净标题】');

  // 自身也没有 title → 找子元素的 [title]
  const nestedTitleNode = makeElement('SPAN', { title: '嵌套标题' });
  const withNested = makeElement('A', {}, {}, '   ', nestedTitleNode);
  assert.equal(api.extractTempTitle(withNested), '嵌套标题');

  assert.equal(api.extractTempTitle(null), '');
});

/* ================================================================== *
 * B. 适配层行为（假 chrome / 假 document / 假抽屉）
 * ================================================================== */

function makeElement(tagName, attrs = {}, extra = {}, textContent = '', querySelectorResult = null) {
  return {
    nodeType: 1,
    tagName,
    id: extra.id,
    textContent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      return querySelectorResult;
    }
  };
}

function makeAnchor(href, extraAttrs = {}, textContent = '') {
  const attrs = Object.assign({ href }, extraAttrs);
  return makeElement('A', attrs, {}, textContent);
}

function createDrawerStub() {
  const instances = [];
  function FakeDrawer(options) {
    this.options = options;
    this.openCalls = [];
    this.opened = false;
    instances.push(this);
  }
  FakeDrawer.prototype.open = function (url, opts) {
    this.openCalls.push({ url, opts });
    this.opened = true;
    this.options.onOpen(url);
    return this;
  };
  FakeDrawer.prototype.close = function () {
    this.opened = false;
    this.options.onClose();
    return this;
  };
  FakeDrawer.prototype.isOpen = function () {
    return this.opened;
  };
  FakeDrawer.prototype.toggle = function () {};
  FakeDrawer.prototype.setWidth = function (px) {
    this.width = px;
  };
  return { FakeDrawer, instances };
}

function createFakeChrome(options) {
  const calls = { sendMessage: [], storageGetKeys: [], storageSet: [] };
  const chrome = {
    runtime: {
      id: 'sidepeek-test',
      lastError: undefined,
      sendMessage(message, callback) {
        calls.sendMessage.push(message);
        if (typeof options.respondTitle === 'function') {
          options.respondTitle(message, callback);
        } else {
          callback({ title: null });
        }
      }
    },
    storage: {
      local: {
        get(key, callback) {
          calls.storageGetKeys.push(key);
          const result = {};
          if (typeof options.storedWidth === 'number') result[key] = options.storedWidth;
          callback(result);
        },
        set(payload) {
          calls.storageSet.push(payload);
        }
      }
    }
  };
  return { chrome, calls };
}

function bootContent(options = {}) {
  const { chrome, calls } = createFakeChrome(options);
  const documentStub = {
    listeners: [],
    documentElement: { clientWidth: options.innerWidth ?? 1200 },
    addEventListener(type, handler, capture) {
      this.listeners.push({ type, handler, capture });
    }
  };
  const windowLike = {
    innerWidth: options.innerWidth ?? 1200,
    location: { href: options.currentUrl ?? 'https://www.bilibili.com/' }
  };
  if (options.Drawer) windowLike.SidePeekDrawer = options.Drawer;

  const sandbox = {
    console: { warn() {}, log() {}, error: console.error },
    URL,
    URLSearchParams,
    chrome,
    document: documentStub,
    window: windowLike,
    // 单测里不需要真定时器：避免标题超时 / 初始化兜底把测试拖慢
    setTimeout() {
      return 0;
    },
    clearTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_CODE, sandbox, { filename: 'src/content.js' });

  return {
    sandbox,
    chrome,
    calls,
    document: documentStub,
    windowLike,
    clickListener: documentStub.listeners.find((item) => item.type === 'click'),
    api: sandbox.__SIDEPEEK_TEST__
  };
}

function createClickEvent(pathNodes, init = {}) {
  const event = {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    prevented: false,
    propagationStopped: false,
    immediateStopped: false,
    composedPath() {
      return pathNodes;
    },
    preventDefault() {
      this.prevented = true;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    stopImmediatePropagation() {
      this.immediateStopped = true;
    }
  };
  return Object.assign(event, init);
}

test('初始化：用 storage.local 的 sidepeek.width 作 defaultWidth，并传对 sandbox', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer, storedWidth: 900 });

  assert.equal(booted.calls.storageGetKeys[0], 'sidepeek.width');
  assert.equal(stub.instances.length, 1);

  const options = stub.instances[0].options;
  assert.equal(options.defaultWidth, 900);
  assert.equal(options.zIndex, 2147483000);
  assert.equal(options.widthRatio, 0.62);
  assert.equal(options.minWidth, 420);
  assert.equal(options.maxWidthRatio, 0.9);
  assert.equal(
    options.sandbox,
    'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads'
  );
  // 反 frame-buster：sandbox 里出现 allow-top-navigation 就等于把抽屉废掉
  assert.equal(options.sandbox.includes('allow-top-navigation'), false);
  assert.equal(typeof options.resolveTitle, 'function');
  assert.equal(typeof options.persistWidth, 'function');
  assert.equal(typeof options.onOpen, 'function');
  assert.equal(typeof options.onClose, 'function');
  assert.equal(options.isPeekableUrl('https://www.bilibili.com/video/BV1xx411c7mD'), true);
  assert.equal(options.isPeekableUrl('https://www.bilibili.com/'), false);

  // 监听必须是捕获阶段
  assert.equal(booted.clickListener.capture, true);
  assert.equal(booted.document.listeners.length, 1);
});

test('初始化：存储值超上限时 clamp 后传给 defaultWidth', () => {
  const stub = createDrawerStub();
  bootContent({ Drawer: stub.FakeDrawer, storedWidth: 9999 });
  assert.equal(stub.instances[0].options.defaultWidth, 1080); // floor(1200 * 0.9)
});

test('窄视口 900px：defaultWidth / persistWidth 用 G-05 上界（810）', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer, storedWidth: 9999, innerWidth: 900 });
  assert.equal(stub.instances[0].options.defaultWidth, 810);

  stub.instances[0].options.persistWidth(9999);
  assert.deepEqual(normalize(booted.calls.storageSet), [{ 'sidepeek.width': 810 }]);
});

test('初始化：无存储值 → defaultWidth 为 null（core 回落到 widthRatio）', () => {
  const stub = createDrawerStub();
  bootContent({ Drawer: stub.FakeDrawer });
  assert.equal(stub.instances[0].options.defaultWidth, null);
});

test('core 未注入时完全不接管点击（不破坏 B 站页面）', () => {
  const booted = bootContent();
  assert.equal(booted.clickListener, undefined);
  assert.equal(booted.document.listeners.length, 0);
  assert.equal(booted.windowLike.__SIDEPEEK_LOADED__, true);
});

test('core 构造抛错时同样不接管点击', () => {
  function ThrowingDrawer() {
    throw new Error('boom');
  }
  const booted = bootContent({ Drawer: ThrowingDrawer });
  assert.equal(booted.document.listeners.length, 0);
});

test('点击 target="_blank" 的卡片链接 → 拦截并用完整 URL 打开抽屉（I-01/I-14）', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer });
  const href = 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.999&vd_source=abc';
  const anchor = makeAnchor(href, { target: '_blank', title: '【标题】' });

  const event = createClickEvent([makeElement('SPAN'), anchor, makeElement('DIV')]);
  booted.clickListener.handler(event);

  assert.equal(event.prevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(event.immediateStopped, true);

  const drawer = stub.instances[0];
  assert.equal(drawer.openCalls.length, 1);
  assert.equal(drawer.openCalls[0].url, href, 'query 参数必须原样带进 iframe');
  assert.deepEqual(normalize(drawer.openCalls[0].opts), { title: '【标题】' });
  assert.equal(booted.windowLike.__SIDEPEEK_EXT__.getActiveUrl(), href);
});

test('修饰键点击（Ctrl/Cmd/Shift/Alt）不拦截（I-02）', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    const stub = createDrawerStub();
    const booted = bootContent({ Drawer: stub.FakeDrawer });
    const anchor = makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD');

    const event = createClickEvent([anchor], { [modifier]: true });
    booted.clickListener.handler(event);

    assert.equal(event.prevented, false, `${modifier} 点击不应被拦截`);
    assert.equal(stub.instances[0].openCalls.length, 0);
  }
});

test('鼠标中键/右键不拦截（I-03）', () => {
  for (const button of [1, 2]) {
    const stub = createDrawerStub();
    const booted = bootContent({ Drawer: stub.FakeDrawer });
    const event = createClickEvent([makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD')], { button });
    booted.clickListener.handler(event);
    assert.equal(event.prevented, false);
    assert.equal(stub.instances[0].openCalls.length, 0);
  }
});

test('当前页就是该视频（仅差追踪参数）→ 不打开抽屉（I-15）', () => {
  const stub = createDrawerStub();
  const booted = bootContent({
    Drawer: stub.FakeDrawer,
    currentUrl: 'https://www.bilibili.com/video/BV1xx411c7mD'
  });
  const anchor = makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999');

  const event = createClickEvent([anchor]);
  booted.clickListener.handler(event);

  assert.equal(event.prevented, false);
  assert.equal(stub.instances[0].openCalls.length, 0);
});

test('非视频链接 / 非 B 站链接 / 抽屉自身点击 → 不拦截', () => {
  const cases = [
    [makeAnchor('https://www.bilibili.com/read/cv123456')],
    [makeAnchor('https://space.bilibili.com/123456')],
    [makeAnchor('https://www.bilibili.com/')],
    [makeAnchor('https://evilbilibili.com/video/BV1xx411c7mD')],
    [makeElement('BUTTON'), makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD')],
    [makeElement('DIV', {}, { id: 'sidepeek-host' }), makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD')],
    [makeElement('DIV')]
  ];
  for (const pathNodes of cases) {
    const stub = createDrawerStub();
    const booted = bootContent({ Drawer: stub.FakeDrawer });
    const event = createClickEvent(pathNodes);
    booted.clickListener.handler(event);
    assert.equal(event.prevented, false);
    assert.equal(stub.instances[0].openCalls.length, 0);
  }
});

test('B 站自己已 preventDefault 的点击不再重复处理', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer });
  const event = createClickEvent([makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD')], {
    defaultPrevented: true
  });
  booted.clickListener.handler(event);
  assert.equal(stub.instances[0].openCalls.length, 0);
});

test('同上视频再次点击：已打开时仍交给 core 处理（core 负责只换 src，I-08）', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer });
  const hrefA = 'https://www.bilibili.com/video/BV1xx411c7mD';
  const hrefB = 'https://www.bilibili.com/video/BV1yy411c7mE';

  booted.clickListener.handler(createClickEvent([makeAnchor(hrefA)]));
  booted.clickListener.handler(createClickEvent([makeAnchor(hrefB)]));

  const drawer = stub.instances[0];
  assert.equal(drawer.openCalls.length, 2);
  assert.equal(drawer.openCalls[1].url, hrefB);
  assert.equal(booted.windowLike.__SIDEPEEK_EXT__.getActiveUrl(), hrefB);
});

test('persistWidth: clamp 后写入 chrome.storage.local', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer, storedWidth: 900 });
  const drawer = stub.instances[0];

  drawer.options.persistWidth(2000); // 上限 floor(1200*0.9)=1080
  drawer.options.persistWidth(100); // 下限 420
  drawer.options.persistWidth(777.6); // 取整

  assert.deepEqual(normalize(booted.calls.storageSet), [
    { 'sidepeek.width': 1080 },
    { 'sidepeek.width': 420 },
    { 'sidepeek.width': 778 }
  ]);
});

test('resolveTitle: 发 PEEK_TITLE 消息并返回 background 给的标题', async () => {
  const stub = createDrawerStub();
  const booted = bootContent({
    Drawer: stub.FakeDrawer,
    respondTitle(message, callback) {
      callback({ title: ' 真实视频标题 ' });
    }
  });
  const drawer = stub.instances[0];
  const href = 'https://www.bilibili.com/video/BV1xx411c7mD';

  booted.clickListener.handler(createClickEvent([makeAnchor(href)]));
  const title = await drawer.options.resolveTitle(href);

  assert.equal(title, '真实视频标题');
  assert.deepEqual(normalize(booted.calls.sendMessage), [{ type: 'PEEK_TITLE', url: href }]);
});

test('resolveTitle: background 返回 null / 抛错时静默降级', async () => {
  const stub = createDrawerStub();
  const booted = bootContent({
    Drawer: stub.FakeDrawer,
    respondTitle(message, callback) {
      callback({ title: null });
    }
  });
  const drawer = stub.instances[0];
  const href = 'https://www.bilibili.com/video/BV1xx411c7mD';
  booted.clickListener.handler(createClickEvent([makeAnchor(href)]));
  assert.equal(await drawer.options.resolveTitle(href), null);

  // sendMessage 抛错（扩展上下文失效）也不能 reject
  const throwing = bootContent({
    Drawer: createDrawerStub().FakeDrawer,
    respondTitle() {
      throw new Error('Extension context invalidated.');
    }
  });
  const throwingDrawer = throwing.sandbox.window.__SIDEPEEK_EXT__.getDrawer();
  const href2 = 'https://www.bilibili.com/video/BV1yy411c7mE';
  throwing.clickListener.handler(createClickEvent([makeAnchor(href2)]));
  assert.equal(await throwingDrawer.options.resolveTitle(href2), null);
});

test('resolveTitle: 用户已切到别的视频 / 关掉抽屉时，旧标题不串台', async () => {
  const stub = createDrawerStub();
  const hrefA = 'https://www.bilibili.com/video/BV1xx411c7mD';
  const hrefB = 'https://www.bilibili.com/video/BV1yy411c7mE';
  const booted = bootContent({
    Drawer: stub.FakeDrawer,
    respondTitle(message, callback) {
      callback({ title: message.url === hrefA ? 'A 的标题' : 'B 的标题' });
    }
  });
  const drawer = stub.instances[0];

  // 先点 A，再点 B，然后 A 的标题才回来
  booted.clickListener.handler(createClickEvent([makeAnchor(hrefA)]));
  booted.clickListener.handler(createClickEvent([makeAnchor(hrefB)]));
  assert.equal(await drawer.options.resolveTitle(hrefA), null, '已切走的视频不能再改标题');

  // B 的标题正常
  assert.equal(await drawer.options.resolveTitle(hrefB), 'B 的标题');

  // 关掉抽屉后，任何标题都不再需要
  drawer.close();
  assert.equal(await drawer.options.resolveTitle(hrefB), null);
});

test('幂等：重复注入 content.js 只初始化一次', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer });

  vm.runInContext(CONTENT_CODE, booted.sandbox, { filename: 'src/content.js' });

  assert.equal(stub.instances.length, 1, '不应重复创建抽屉');
  assert.equal(booted.document.listeners.length, 1, '不应重复注册 click 监听');
});

test('临时标题取链接文字：无 [title] 时使用 textContent', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer });
  const anchor = makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD', {}, '  一个视频标题  ');
  booted.clickListener.handler(createClickEvent([anchor]));
  assert.deepEqual(normalize(stub.instances[0].openCalls[0].opts), { title: '一个视频标题' });
});

test('临时标题为空时 open 不带 title 参数', () => {
  const stub = createDrawerStub();
  const booted = bootContent({ Drawer: stub.FakeDrawer });
  const anchor = makeAnchor('https://www.bilibili.com/video/BV1xx411c7mD', {}, '   ');
  booted.clickListener.handler(createClickEvent([anchor]));
  assert.equal(stub.instances[0].openCalls[0].opts, undefined);
});
