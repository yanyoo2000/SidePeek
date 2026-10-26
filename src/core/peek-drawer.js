/*!
 * SidePeek · 核心抽屉引擎（peek-drawer.js）v0.1.0
 * ---------------------------------------------------------------------------
 * 定位：零依赖、不含任何 chrome.* API 的纯前端引擎。
 *       content script 直接 <script> 加载即可用；普通网页里 <script src> 也能跑。
 *
 * 三条硬约束（见 docs/SPEC.md §3 与 docs/TECH-FINDINGS.md）：
 *   1. 全局只暴露 window.SidePeekDrawer（IIFE，无 ESM / import / require）；
 *   2. 全部 DOM 与样式关在 Shadow DOM 里，绝不污染 B 站页面，也绝不被页面样式污染；
 *   3. iframe 必须带限制性 sandbox（缺 allow-top-navigation）—— 这是挡住 B 站
 *      跨源 frame-buster 的唯一手段，任何代码都不允许动态放宽或移除。
 *
 * 样式来源说明：content script 无法同步读取 .css 文件，所以这里内嵌一份 CSS 字符串；
 * src/core/peek-drawer.css 是同一份内容的人类可读副本。改一处必须改另一处
 * （dev-core 用脚本逐字比对，避免漂移）。需要主题覆盖时可在构造参数里传 options.css。
 */
;(function () {
  'use strict';

  // ── 常量 ────────────────────────────────────────────────────────────────

  var VERSION = '0.1.0';

  /**
   * iframe sandbox 白名单。
   *
   * 为什么恰好是这一串（不是"随手抄的"）：
   *  - B 站视频页里有跨源 frame-buster，只要 iframe 能导航顶层，它就会把整个页面顶走
   *    （TECH-FINDINGS 结论 1，Lead 已在 search.bilibili.com 实测）；
   *  - allow-same-origin 必须保留，否则 iframe 变不透明源，登录态/Cookie 读取异常；
   *  - allow-scripts / allow-forms / allow-popups / allow-presentation / allow-downloads
   *    是播放器、弹幕、评论、下载等正常功能所需；
   *  - 刻意 **不含** allow-top-navigation / allow-top-navigation-by-user-activation。
   *
   * 下面的 _guardSandbox() 会盯着这个属性：一旦被外部脚本改写或移除，立刻恢复。
   */
  var SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads';
  var FORBIDDEN_SANDBOX_TOKENS = ['allow-top-navigation', 'allow-top-navigation-by-user-activation'];

  var DEFAULTS = {
    zIndex: 2147483000,
    widthRatio: 0.62,
    minWidth: 420,
    maxWidthRatio: 0.9,
    defaultWidth: null,
    sandbox: SANDBOX,
    isPeekableUrl: null,
    resolveTitle: null,
    persistWidth: null,
    onOpen: null,
    onClose: null,
    autoFocus: true,
    css: null
  };

  var LOAD_TIMEOUT_MS = 8000; // 超时无 load 即判定"打不开"，给错误态，不让用户对着白板干等
  var CLOSE_UNLOAD_DELAY_MS = 360; // 收起动画 320ms 放完再停 iframe，避免看到黑底往外滑
  var HISTORY_CLOSE_GUARD_MS = 300; // history.back() 后等 popstate 的兜底时长
  var MIN_MASK_GUTTER = 48; // 窄屏下抽屉左侧必须留出的可点遮罩宽度（SPEC §7 G-05）

  /**
   * 内嵌样式。内容必须与 src/core/peek-drawer.css 逐字一致（脚本会比对）。
   * Shadow DOM 的 <style> 是同步的，这是"零依赖 + 首帧就有样式、不闪"的唯一可靠做法。
   */
  var CSS_TEXT = `/*
 * SidePeek · 核心抽屉样式（peek-drawer.css）
 *
 * 这份文本会被 peek-drawer.js 以字符串形式注入 Shadow DOM 的 <style>；
 * 修改本文件时，请同步修改 peek-drawer.js 里的 CSS_TEXT —— 两者必须逐字一致
 * （dev-core 用脚本比对过，避免"改了 CSS 却忘了内嵌副本"）。
 *
 * 所有选择器都活在 Shadow DOM 里：宿主页面的样式进不来，这里的样式也不会漏出去。
 */

:host {
  all: initial;
  box-sizing: border-box;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

/* ---------- 遮罩：只负责"点外面关闭"与视觉压暗 ---------- */

.sp-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  opacity: 0;
  /* 关闭态必须彻底不吃点击：宿主虽然 pointer-events:none，但遮罩自己铺满视口。
     只在展开态打开 pointer-events（见下面的 :host([data-open="true"])）。 */
  pointer-events: none;
  transition: opacity 0.32s cubic-bezier(0.32, 0.72, 0, 1);
}

:host([data-open="true"]) .sp-mask {
  opacity: 1;
  pointer-events: auto;
}

/* ---------- 抽屉本体 ---------- */

.sp-drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100%;
  width: var(--sp-width, 62vw);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px 0 0 14px;
  background: #17181c;
  color: #f1f2f4;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.24);
  /* 只用 transform 折叠/展开：width 过渡会触发布局重排，B 站这种长列表页面会明显掉帧。 */
  transform: translateX(100%);
  transition: transform 0.32s cubic-bezier(0.32, 0.72, 0, 1);
  pointer-events: none;
  will-change: transform;
  -webkit-font-smoothing: antialiased;
}

.sp-drawer.sp-open {
  transform: translateX(0);
  pointer-events: auto;
}

.sp-drawer:focus {
  outline: none;
}

/* I-12：双击标题全屏化（可选特性） */

.sp-drawer[data-fullscreen="true"] {
  width: 100vw !important;
  border-radius: 0;
}

.sp-drawer[data-fullscreen="true"] .sp-resizer {
  display: none;
}

/* ---------- 左边缘拖拽区（I-07） ---------- */

.sp-resizer {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 6px;
  z-index: 3;
  cursor: ew-resize;
  background: transparent;
  transition: background-color 0.16s ease;
}

.sp-resizer:hover,
.sp-resizer.sp-dragging {
  background: rgba(0, 174, 236, 0.55);
}

/* ---------- 头部 ---------- */

.sp-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 8px 0 14px;
  background: #1e1f25;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  user-select: none;
}

.sp-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
  color: #e8e9ed;
}

.sp-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.sp-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #c9ccd4;
  font: inherit;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.sp-actions button:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.sp-actions button:active {
  background: rgba(255, 255, 255, 0.16);
}

.sp-actions button:focus-visible {
  outline: 2px solid #00aeec;
  outline-offset: 1px;
}

.sp-actions svg {
  display: block;
  width: 18px;
  height: 18px;
}

/* ---------- iframe 区域 ---------- */

.sp-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: #000000;
}

.sp-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #000000;
}

.sp-loading {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 4;
  height: 2px;
  background: linear-gradient(90deg, rgba(0, 174, 236, 0) 0%, #00aeec 50%, rgba(0, 174, 236, 0) 100%);
  background-size: 200% 100%;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  animation: sp-loading-slide 1.1s linear infinite;
}

.sp-loading.sp-visible {
  opacity: 1;
}

@keyframes sp-loading-slide {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

/* ---------- 错误态 + 重试（iframe 加载失败时） ---------- */

.sp-error {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
  background: #17181c;
  color: #c9ccd4;
}

.sp-error.sp-visible {
  display: flex;
}

.sp-error-msg {
  max-width: 440px;
  font-size: 14px;
  font-weight: 600;
  color: #f1f2f4;
}

.sp-error-sub {
  max-width: 440px;
  font-size: 12px;
  line-height: 1.6;
  color: #7f8493;
  word-break: break-all;
}

.sp-error-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.sp-error-actions button {
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: #24262e;
  color: #f1f2f4;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.sp-error-actions button:hover {
  background: #2f323c;
}

.sp-error-actions button:focus-visible {
  outline: 2px solid #00aeec;
  outline-offset: 1px;
}

/* ---------- 轻提示 ---------- */

.sp-toast {
  position: absolute;
  left: 50%;
  bottom: 28px;
  z-index: 6;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.82);
  color: #ffffff;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  transform: translate(-50%, 8px);
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.sp-toast.sp-visible {
  opacity: 1;
  transform: translate(-50%, 0);
}

/* ---------- 窄屏 ---------- */

@media (max-width: 640px) {
  .sp-drawer {
    border-radius: 0;
  }
}

/* ---------- 尊重「减少动态效果」偏好 ---------- */

@media (prefers-reduced-motion: reduce) {
  .sp-drawer,
  .sp-mask {
    transition-duration: 0.01ms;
  }

  .sp-loading {
    animation: none;
  }
}
`;

  // 图标是模块内常量字符串，不含任何外部/用户数据，直接 innerHTML 没有 XSS 面。
  var SVG_OPEN_TAB =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 3h7v7"></path><path d="M21 3l-9 9"></path><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"></path></svg>';
  var SVG_COPY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15.5V5.5A2.5 2.5 0 0 1 7.5 3h10"></path></svg>';
  var SVG_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>';

  // ── 与 DOM 无关的小工具 ─────────────────────────────────────────────────

  function isFn(value) {
    return typeof value === 'function';
  }

  function warn() {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn.apply(console, ['[SidePeek]'].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function numOr(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function positiveOr(value, fallback) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  /** SPEC §3.3 的 history.state 形状判定。B 站的 state 里没有这个字段，不会误判。 */
  function isPeekState(state) {
    return !!(state && state.__sidepeek);
  }

  function stripHash(href) {
    var index = href.indexOf('#');
    return index === -1 ? href : href.slice(0, index);
  }

  function trimTrailingSlash(href) {
    return href.length > 1 && href.charAt(href.length - 1) === '/' ? href.slice(0, -1) : href;
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function viewportWidth() {
    if (typeof window === 'undefined') return 1280;
    return window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1280;
  }

  /**
   * sandbox 只允许"同等或更严格"：调用方传进来的字符串里，任何顶层导航 token 都会被剔掉。
   * 这不是"防御性编程"，这是安全底线——放宽 sandbox 等于把反 frame-buster 关掉。
   */
  function sanitizeSandbox(input) {
    if (typeof input !== 'string' || !input.trim()) return SANDBOX;

    var tokens = input.trim().split(/\s+/);
    var kept = [];
    var stripped = [];

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (FORBIDDEN_SANDBOX_TOKENS.indexOf(token) !== -1) {
        stripped.push(token);
        continue;
      }
      if (kept.indexOf(token) === -1) kept.push(token);
    }

    if (stripped.length) {
      warn('已忽略 sandbox 中的 ' + stripped.join(' ') + '：它会让 B 站 frame-buster 重新生效、把整个页面顶走（TECH-FINDINGS 结论 1）');
    }

    // 这两个 token 缺一个，B 站要么放不了视频、要么读不到登录态，不如直接用内置组合。
    if (kept.indexOf('allow-scripts') === -1 || kept.indexOf('allow-same-origin') === -1) {
      warn('sandbox 缺少 allow-scripts / allow-same-origin，已回退到内置组合');
      return SANDBOX;
    }

    return kept.join(' ');
  }

  function makeButton(act, label, svg) {
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-act', act);
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.innerHTML = svg; // 常量 SVG，见上方说明
    return button;
  }

  // ── 构造函数 ────────────────────────────────────────────────────────────

  function SidePeekDrawer(options) {
    if (!(this instanceof SidePeekDrawer)) return new SidePeekDrawer(options);

    var opts = {};
    for (var key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) opts[key] = DEFAULTS[key];
    }
    if (options) {
      for (var name in options) {
        if (Object.prototype.hasOwnProperty.call(options, name) && options[name] !== undefined) {
          opts[name] = options[name];
        }
      }
    }
    // 数值项统一兜底，避免 NaN 流进 clamp 把宽度算成 0
    opts.zIndex = numOr(opts.zIndex, DEFAULTS.zIndex);
    opts.widthRatio = positiveOr(opts.widthRatio, DEFAULTS.widthRatio);
    opts.minWidth = positiveOr(opts.minWidth, DEFAULTS.minWidth);
    opts.maxWidthRatio = positiveOr(opts.maxWidthRatio, DEFAULTS.maxWidthRatio);
    opts.defaultWidth = positiveOr(opts.defaultWidth, null);
    this._opts = opts;

    // 提前在构造期把 sandbox 定死，后续只有 _createFrame() 会用它
    this._sandbox = sanitizeSandbox(opts.sandbox);

    // ── 运行期状态 ──
    this._mounted = false; // Shadow DOM 是否已创建（懒创建：第一次 open 才挂到页面上）
    this._destroyed = false;
    this._open = false; // 抽屉是否处于展开逻辑态
    this._fullscreen = false;
    this._url = null; // 当前抽屉承载的绝对 URL
    this._titleText = '';
    this._width = null; // 用户"想要的宽度"（px），null 表示还没手动设过
    this._appliedWidth = 0; // 当前真正写进 style 的宽度
    this._frame = null;
    this._frameReady = false;
    this._loadToken = 0; // 每次换页 +1，让旧超时/旧回调失效
    this._loadTimer = null;
    this._titleToken = 0; // 让旧的异步标题解析失效（跨视频串台）
    this._historyToken = 0; // 让 close 的 popstate 兜底定时器失效
    this._closePending = false; // 已发出 history.back()，等 popstate
    this._closeGuard = null;
    this._unloadTimer = null;
    this._toastTimer = null;
    this._drag = null; // 拖拽中：{ startX, startWidth }
    this._savedRootStyle = null; // 拖拽期间临时改的 html cursor/user-select 原值
    this._prevFocus = null; // 打开前的焦点，关闭时还回去
    this._sandboxObserver = null;

    // 所有会 addEventListener 的方法都在这里 bind 一次。
    // 为什么：removeEventListener 比较的是函数引用，不 bind 的话 destroy() 根本解不掉监听器。
    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleResize = this._handleResize.bind(this);
    this._handlePopState = this._handlePopState.bind(this);
    this._handleMaskClick = this._handleMaskClick.bind(this);
    this._handleActionClick = this._handleActionClick.bind(this);
    this._handleDragStart = this._handleDragStart.bind(this);
    this._handleDragMove = this._handleDragMove.bind(this);
    this._handleDragEnd = this._handleDragEnd.bind(this);
    this._handleTitleDblClick = this._handleTitleDblClick.bind(this);
    this._handleFrameLoad = this._handleFrameLoad.bind(this);
    this._handleFrameError = this._handleFrameError.bind(this);
    this._handleRetry = this._handleRetry.bind(this);
    this._handleOpenTab = this._handleOpenTab.bind(this);
    this._handleIsolation = this._handleIsolation.bind(this);
  }

  // ── DOM 构建（懒执行） ──────────────────────────────────────────────────

  SidePeekDrawer.prototype._ensureDom = function () {
    if (this._mounted) return true;
    if (typeof document === 'undefined' || !document.documentElement) {
      warn('当前环境没有 document，无法创建抽屉（node 里 require 只用于加载检查）');
      return false;
    }

    var doc = document;

    // 宿主：fixed 铺满视口，但 pointer-events:none。
    // 这是"关闭态完全不挡 B 站页面点击"的根本保证；需要交互的子元素再各自打开 pointer-events。
    // 挂到 <html> 而不是 <body>：B 站偶尔给 body 加 transform/filter，
    // 那会改变 position:fixed 的参照系，抽屉的位置就飞了。
    var host = doc.createElement('div');
    host.id = 'sidepeek-host';
    host.style.cssText = [
      'position:fixed',
      'top:0',
      'right:0',
      'bottom:0',
      'left:0',
      'z-index:' + this._opts.zIndex,
      'pointer-events:none',
      'display:block',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent'
    ].join(';');

    if (!host.attachShadow) {
      warn('当前浏览器不支持 Shadow DOM，抽屉无法隔离样式，已放弃初始化');
      return false;
    }
    var shadow = host.attachShadow({ mode: 'open' });

    // 样式：Shadow DOM 内 <style>，同步生效。宿主页面无论怎么写 CSS 都影响不到这里。
    var style = doc.createElement('style');
    style.setAttribute('data-sidepeek', 'core');
    style.textContent = this._resolveCss();
    shadow.appendChild(style);

    // 遮罩（DOM 顺序在抽屉之前 —— 抽屉后绘制，所以层级更高）
    var mask = doc.createElement('div');
    mask.className = 'sp-mask';
    mask.setAttribute('aria-hidden', 'true');
    shadow.appendChild(mask);

    // 抽屉本体
    var drawer = doc.createElement('div');
    drawer.className = 'sp-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'SidePeek 侧边预览');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('tabindex', '-1');

    // 左边缘 6px 拖拽区（I-07）
    var resizer = doc.createElement('div');
    resizer.className = 'sp-resizer';
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', '拖动调整预览宽度');
    resizer.setAttribute('aria-valuemin', '0');
    drawer.appendChild(resizer);

    // 头部
    var header = doc.createElement('div');
    header.className = 'sp-header';

    var titleEl = doc.createElement('div');
    titleEl.className = 'sp-title';
    titleEl.textContent = '侧边速览';
    header.appendChild(titleEl);

    var actions = doc.createElement('div');
    actions.className = 'sp-actions';
    actions.appendChild(makeButton('open-tab', '在新标签页打开', SVG_OPEN_TAB));
    actions.appendChild(makeButton('copy', '复制链接', SVG_COPY));
    actions.appendChild(makeButton('close', '关闭预览（Esc）', SVG_CLOSE));
    header.appendChild(actions);
    drawer.appendChild(header);

    // 内容区
    var body = doc.createElement('div');
    body.className = 'sp-body';

    var loadingEl = doc.createElement('div');
    loadingEl.className = 'sp-loading';
    body.appendChild(loadingEl);

    var errorEl = doc.createElement('div');
    errorEl.className = 'sp-error';

    var errorMsg = doc.createElement('div');
    errorMsg.className = 'sp-error-msg';

    var errorSub = doc.createElement('div');
    errorSub.className = 'sp-error-sub';

    var errorActions = doc.createElement('div');
    errorActions.className = 'sp-error-actions';
    var retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.setAttribute('data-act', 'retry'); // SPEC §7 G-02 认可的合法节点标识
    retryBtn.textContent = '重试';
    var openTabBtn = doc.createElement('button');
    openTabBtn.type = 'button';
    openTabBtn.textContent = '在新标签打开';
    errorActions.appendChild(retryBtn);
    errorActions.appendChild(openTabBtn);

    errorEl.appendChild(errorMsg);
    errorEl.appendChild(errorSub);
    errorEl.appendChild(errorActions);
    body.appendChild(errorEl);

    var toastEl = doc.createElement('div');
    toastEl.className = 'sp-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    body.appendChild(toastEl);

    drawer.appendChild(body);
    shadow.appendChild(drawer);

    // 事件绑定（元素级监听随节点销毁而回收；window/document 级在 destroy 里显式摘掉）
    mask.addEventListener('click', this._handleMaskClick);
    actions.addEventListener('click', this._handleActionClick);
    resizer.addEventListener('mousedown', this._handleDragStart);
    titleEl.addEventListener('dblclick', this._handleTitleDblClick);
    retryBtn.addEventListener('click', this._handleRetry);
    openTabBtn.addEventListener('click', this._handleOpenTab);

    // 抽屉内部的 mousedown/click/contextmenu 不往外冒泡：
    // 避免 B 站页面上的全局点击处理器（弹层、快捷键、埋点）被抽屉里的操作误触发。
    // 注意用冒泡阶段（不是捕获）：目标元素自己的处理器先跑，这里只负责拦截"继续往上冒"。
    drawer.addEventListener('mousedown', this._handleIsolation);
    drawer.addEventListener('click', this._handleIsolation);
    drawer.addEventListener('contextmenu', this._handleIsolation);

    doc.documentElement.appendChild(host);

    this._host = host;
    this._shadow = shadow;
    this._mask = mask;
    this._drawer = drawer;
    this._resizer = resizer;
    this._body = body;
    this._titleEl = titleEl;
    this._loadingEl = loadingEl;
    this._errorEl = errorEl;
    this._errorMsg = errorMsg;
    this._errorSub = errorSub;
    this._toastEl = toastEl;
    this._mounted = true;

    // 全局监听：Esc（捕获阶段，优先于 B 站自己的处理器）、窗口尺寸、history。
    // popstate 只有在 DOM 建好后才需要（首次 open 之后才会有我们自己的记录）。
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._handleKeyDown, true);
      window.addEventListener('resize', this._handleResize);
      window.addEventListener('popstate', this._handlePopState);
    }

    return true;
  };

  /** 样式来源：options.css > 页面里刻意提供的 <style id="sidepeek-core-css"> > 内嵌副本。 */
  SidePeekDrawer.prototype._resolveCss = function () {
    if (typeof this._opts.css === 'string' && this._opts.css.length > 20) return this._opts.css;
    if (typeof document !== 'undefined') {
      var provided = document.getElementById('sidepeek-core-css');
      if (provided && provided.textContent && provided.textContent.length > 200) return provided.textContent;
    }
    return CSS_TEXT;
  };

  // ── iframe 生命周期 ─────────────────────────────────────────────────────

  SidePeekDrawer.prototype._createFrame = function () {
    var frame = document.createElement('iframe');
    frame.className = 'sp-frame';
    frame.setAttribute('title', 'SidePeek 预览内容');

    // ⚠️ 安全命门：sandbox 只在创建这一刻设置一次，此后没有任何代码路径会修改它。
    // 被移除/放宽 → B 站 frame-buster 立刻生效，用户整页被顶走（已在真实页面复现过）。
    frame.setAttribute('sandbox', this._sandbox);

    // allow 是另一套（Permissions Policy）机制：只放行播放器需要的，和顶层导航无关。
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    frame.setAttribute('allowfullscreen', '');

    frame.addEventListener('load', this._handleFrameLoad);
    frame.addEventListener('error', this._handleFrameError);
    return frame;
  };

  SidePeekDrawer.prototype._removeFrame = function () {
    var frame = this._frame;
    this._frame = null;
    this._frameReady = false;
    if (this._sandboxObserver) {
      this._sandboxObserver.disconnect();
      this._sandboxObserver = null;
    }
    if (!frame) return;
    frame.removeEventListener('load', this._handleFrameLoad);
    frame.removeEventListener('error', this._handleFrameError);
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  };

  /**
   * 盯住 sandbox 属性：一旦被页面脚本/其他扩展改写或移除，立刻恢复。
   * 这不违反"不得动态改写 sandbox"——它正是为了阻止别的代码改写。
   * 恢复后属性值与期望一致，观察器下一次回调不会再触发，不存在循环。
   */
  SidePeekDrawer.prototype._guardSandbox = function () {
    if (this._sandboxObserver) {
      this._sandboxObserver.disconnect();
      this._sandboxObserver = null;
    }
    if (!this._frame || typeof MutationObserver === 'undefined') return;

    var self = this;
    var expected = this._sandbox;
    this._sandboxObserver = new MutationObserver(function () {
      if (!self._frame || self._destroyed) return;
      var actual = self._frame.getAttribute('sandbox');
      if (actual === expected) return;
      warn('检测到 iframe sandbox 被外部改动（' + actual + '），已恢复为内置组合');
      self._frame.setAttribute('sandbox', expected);
    });
    this._sandboxObserver.observe(this._frame, { attributes: true, attributeFilter: ['sandbox'] });
  };

  /**
   * 加载 URL。
   * @param {string} url 绝对 URL
   * @param {boolean} force 强制重建 iframe（重试时用：同一个 src 重复赋值浏览器不会重新请求）
   */
  SidePeekDrawer.prototype._load = function (url, force) {
    var self = this;

    // 当前承载的 URL 在这里统一落库：标题解析、复制链接、在新标签打开、重试都依赖它。
    this._url = url;

    this._hideError();
    this._clearLoadTimer();
    this._loadToken += 1;
    var token = this._loadToken;

    var currentSrc = this._frame ? this._frame.getAttribute('src') : null;
    var needNewFrame = force || !this._frame || currentSrc !== url;

    if (needNewFrame) {
      // 为什么"换 URL 时重建 iframe 节点"而不是 `iframe.src = url`：
      //   给一个已经存在的 iframe 换 src，会在浏览器的 joint session history 里追加一条
      //   **子帧历史记录**；之后 history.back() / history.forward() 会先被这条子帧记录吃掉，
      //   I-10「后退关闭抽屉 / 前进重新打开」就失效（已实测：换 src 后 forward 回不到 #sidepeek 条目；
      //   重建节点则 history.length 不变、back/forward 行为正确）。
      //   对外行为与 I-08 完全一致：抽屉保持展开、仅换内容、不重播入场动画。
      if (this._frame) this._removeFrame();
      this._frame = this._createFrame();
      this._body.insertBefore(this._frame, this._body.firstChild);
      this._frame.setAttribute('src', url);
      this._frameReady = false;
      this._showLoading(true);
      this._guardSandbox();
    } else if (this._frameReady) {
      // 同一个地址又 open 了一次（例如用户重复点了同一个视频）：不重载、不报错
      this._showLoading(false);
      return;
    }

    // 超时兜底：8s 没有 load 信号，大概率是被目标站拒绝嵌入或网络挂了 → 给错误态 + 重试
    this._loadTimer = setTimeout(function () {
      if (self._destroyed || token !== self._loadToken) return;
      self._showError(
        '页面未能加载',
        '8 秒内没有收到加载完成信号。可能是网络较慢，也可能是目标页面不允许被嵌入到 iframe 中。'
      );
    }, LOAD_TIMEOUT_MS);
  };

  SidePeekDrawer.prototype._handleFrameLoad = function () {
    // 关闭后把 iframe 置 about:blank 也触发 load，这种"内部清理"不算加载成功
    if (!this._open) return;
    this._frameReady = true;
    this._clearLoadTimer();
    this._showLoading(false);
    this._hideError();
  };

  SidePeekDrawer.prototype._handleFrameError = function () {
    if (!this._open) return;
    this._showError('页面加载失败', '抽屉里的页面加载出错了，可以点重试，或直接在新标签打开。');
  };

  SidePeekDrawer.prototype._showLoading = function (visible) {
    if (!this._loadingEl) return;
    if (visible) this._loadingEl.classList.add('sp-visible');
    else this._loadingEl.classList.remove('sp-visible');
  };

  SidePeekDrawer.prototype._showError = function (message, detail) {
    this._clearLoadTimer();
    this._showLoading(false);
    if (!this._errorEl) return;
    if (this._errorMsg) this._errorMsg.textContent = message || '页面未能加载';
    if (this._errorSub) this._errorSub.textContent = detail || this._url || '';
    this._errorEl.classList.add('sp-visible');
  };

  SidePeekDrawer.prototype._hideError = function () {
    if (this._errorEl) this._errorEl.classList.remove('sp-visible');
  };

  SidePeekDrawer.prototype._handleRetry = function () {
    if (!this._url) return;
    this._hideError();
    this._load(this._url, true);
  };

  // ── 标题 ────────────────────────────────────────────────────────────────

  SidePeekDrawer.prototype._setTitle = function (text) {
    var value = text == null ? '' : String(text).replace(/\s+/g, ' ').trim();
    this._titleText = value;
    if (!this._titleEl) return;
    this._titleEl.textContent = value || '侧边速览';
    this._titleEl.setAttribute('title', value || '');
  };

  /**
   * 异步标题解析。
   * 只有"抽屉仍打开 + 当前 URL 没换人 + 这次解析没被后续 open 作废"三个条件同时成立才写标题，
   * 否则会出现 A 视频的标题盖在 B 视频上的串台 bug。
   */
  SidePeekDrawer.prototype._resolveTitle = function (url) {
    var self = this;
    this._titleToken += 1;
    var token = this._titleToken;

    var pending;
    try {
      pending = this._opts.resolveTitle(url);
    } catch (error) {
      warn('resolveTitle 同步抛错，保留临时标题', error);
      return;
    }
    if (!pending || !isFn(pending.then)) return;

    pending.then(
      function (title) {
        if (self._destroyed || token !== self._titleToken) return;
        if (!self._open || self._url !== url) return;
        if (title == null || !String(title).trim()) return;
        self._setTitle(title);
      },
      function () {
        // 标题只是锦上添花：拿不到就继续用链接文字，不打扰用户
      }
    );
  };

  // ── 公开 API ────────────────────────────────────────────────────────────

  SidePeekDrawer.prototype.open = function (url, options) {
    if (this._destroyed) throw new Error('[SidePeek] 该实例已 destroy()，请重新创建');
    if (!url) return this;
    options = options || {};

    var target = this._absoluteUrl(url);
    if (!target) {
      warn('open() 收到无法解析的 URL：', url);
      return this;
    }

    // I-15 兜底：顶层已经就是这个页面就不开（适配层也会先判一次，这里是双保险，防止自我嵌套）。
    if (this._isSameAsTopPage(target)) return this;

    // 适配层可以拒绝承载（例如点到了站外链接）
    if (isFn(this._opts.isPeekableUrl) && this._safeCall('isPeekableUrl', [target], true) === false) return this;

    if (!this._ensureDom()) return this;

    var wasOpen = this._open;
    this._open = true;
    this._historyToken += 1;

    if (!wasOpen) {
      // 记住打开前的焦点，关闭时还回去（Esc 关闭后键盘操作不至于丢上下文）
      this._prevFocus = document.activeElement;

      this._renderWidth();
      this._host.setAttribute('data-open', 'true');
      this._drawer.setAttribute('aria-hidden', 'false');

      // 关键动画细节：先让"折叠态"完成一次样式计算，再挂 .sp-open，
      // 浏览器才会把它当成状态变化并跑过渡；否则元素一出生就是展开态，动画直接被跳过。
      this._forceReflow();
      this._drawer.classList.add('sp-open');

      this._pushHistory(target);

      // 把焦点交给抽屉，保证 Esc 立刻可用（用户一旦点进 iframe，焦点进子文档，Esc 收不到 —— 已知限制）
      if (this._opts.autoFocus) this._focusDrawer();
    } else {
      // I-08：已展开时只换内容，绝不重播入场动画（不加/不减 .sp-open）
      this._syncHistory(target);
    }

    // 换页时先清旧标题，避免"内容已是 B、标题还写着 A"
    this._titleToken += 1;
    if (options.title != null) this._setTitle(options.title);
    else this._setTitle('');

    // 若关闭时挂过 about:blank 定时器（停声音用的），这里撤掉，保持 iframe 现状
    this._cancelUnload();

    this._load(target, false);

    // 适配层给了 resolveTitle 就异步补真实标题；resolve 时若已切走/已关闭则丢弃
    if (isFn(this._opts.resolveTitle)) this._resolveTitle(target);

    this._safeCall('onOpen', [target]);
    return this;
  };

  SidePeekDrawer.prototype.close = function () {
    if (this._destroyed || !this._open) return this;

    // SPEC §3.3 明文要求：历史里有我们的记录就走 history.back()，由 popstate 统一收起。
    // 这里绝对不直接改 DOM —— back() 里再改一次就是双写，状态机会打架（后退两次、残影）。
    if (this._hasPeekHistory()) {
      if (this._closePending) return this; // 连点 X / Esc 只发一次 back()
      this._closePending = true;
      var token = this._historyToken;
      var self = this;

      try {
        history.back();
      } catch (error) {
        this._closePending = false;
        warn('history.back() 不可用，改为直接收起抽屉', error);
        this._hide();
        return this;
      }

      // G-10 兜底：万一 popstate 没来（history 被别的脚本清了 / back() 被子帧历史吃掉），
      // 300ms 后强制收起，绝不能卡在展开态让用户关不掉抽屉。
      this._closeGuard = setTimeout(function () {
        self._closeGuard = null;
        if (self._destroyed || token !== self._historyToken) return;
        if (!self._open) return;
        // 还在我们自己的历史条目上，说明这次 back() 没有真正退出 sidepeek 状态：
        // 把这条记录原地替换回原页面 URL，避免地址栏残留 #sidepeek=（SPEC §3.3 的硬要求）。
        self._cleanHistoryEntry();
        self._hide();
      }, HISTORY_CLOSE_GUARD_MS);
      return this;
    }

    this._hide();
    return this;
  };

  SidePeekDrawer.prototype.toggle = function (url, options) {
    if (this._open) {
      this.close();
      return this;
    }
    return this.open(url, options);
  };

  SidePeekDrawer.prototype.isOpen = function () {
    return this._open;
  };

  SidePeekDrawer.prototype.setWidth = function (px) {
    var width = Number(px);
    if (!isFinite(width)) return this;
    this._width = width; // 记"想要的宽度"，窗口变化时用它重新 clamp
    this._renderWidth();
    return this;
  };

  SidePeekDrawer.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._open = false;
    this._historyToken += 1;

    // 拖拽中 destroy：document 上的 mousemove/mouseup 必须一起摘掉，否则会留幽灵监听
    this._endDrag(false);

    this._clearLoadTimer();
    if (this._closeGuard) {
      clearTimeout(this._closeGuard);
      this._closeGuard = null;
    }
    this._cancelUnload();
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    if (this._sandboxObserver) {
      this._sandboxObserver.disconnect();
      this._sandboxObserver = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._handleKeyDown, true);
      window.removeEventListener('resize', this._handleResize);
      window.removeEventListener('popstate', this._handlePopState);
    }

    this._removeFrame();

    if (this._host && this._host.parentNode) this._host.parentNode.removeChild(this._host);

    // 元素级监听器随节点一起被回收；会造成泄漏的只有 window/document 上的，上面已全部摘掉。
    this._host = null;
    this._shadow = null;
    this._mask = null;
    this._drawer = null;
    this._resizer = null;
    this._body = null;
    this._titleEl = null;
    this._loadingEl = null;
    this._errorEl = null;
    this._errorMsg = null;
    this._errorSub = null;
    this._toastEl = null;
    this._mounted = false;
  };

  // ── History 状态机 ──────────────────────────────────────────────────────

  /**
   * 打开时压栈。地址栏变成 <当前URL去hash>#sidepeek=<encodeURIComponent(url)>：
   * 对用户来说像"跳转了"，但顶层文档没换，原页面滚动位置/搜索结果完整保留（I-10 的前提）。
   */
  SidePeekDrawer.prototype._pushHistory = function (url) {
    if (typeof history === 'undefined' || !history.pushState) return;
    try {
      // 当前 state 已经是我们的（典型：用户按"前进"回到抽屉），不要再压第二条，
      // 否则后退一次只回一层，抽屉关不掉。
      if (isPeekState(history.state)) {
        this._replaceHistory(url);
        return;
      }
      history.pushState({ __sidepeek: 1, url: url }, '', this._peekHashUrl(url));
    } catch (error) {
      warn('pushState 失败（抽屉仍可用，但浏览器后退不会关闭它）', error);
    }
  };

  /** 已打开时切换视频（I-08）：更新 state 里的 url 与地址栏 hash，但不新增历史记录。 */
  SidePeekDrawer.prototype._syncHistory = function (url) {
    if (typeof history === 'undefined' || !history.replaceState) return;
    if (!isPeekState(history.state)) {
      this._pushHistory(url);
      return;
    }
    this._replaceHistory(url);
  };

  SidePeekDrawer.prototype._replaceHistory = function (url) {
    try {
      history.replaceState({ __sidepeek: 1, url: url }, '', this._peekHashUrl(url));
    } catch (error) {
      warn('replaceState 失败', error);
    }
  };

  SidePeekDrawer.prototype._peekHashUrl = function (url) {
    var base = typeof location !== 'undefined' && location.href ? stripHash(location.href) : '';
    return base + '#sidepeek=' + encodeURIComponent(url);
  };

  SidePeekDrawer.prototype._hasPeekHistory = function () {
    try {
      return isPeekState(history.state);
    } catch (error) {
      return false;
    }
  };

  /**
   * 兜底清理：把当前仍带 #sidepeek 的历史条目原地替换回原页面 URL。
   * 只在 G-10 兜底路径（history.back() 没生效、popstate 没来）里使用；
   * 正常关闭路径走 back() + popstate，不会执行到这里，因此不会出现"既 back 又 replaceState"的双写。
   */
  SidePeekDrawer.prototype._cleanHistoryEntry = function () {
    try {
      if (typeof history === 'undefined' || !history.replaceState) return;
      if (!isPeekState(history.state)) return;
      history.replaceState(null, '', typeof location !== 'undefined' ? stripHash(location.href) : '');
    } catch (error) {
      warn('清理 #sidepeek 历史条目失败', error);
    }
  };

  /**
   * popstate 是唯一的"收起权威"：
   *  - state 里有 __sidepeek → 打开 / 切换（浏览器「前进」回到抽屉也走这里）
   *  - 否则 → 立即收起（用户按了后退，或主动关闭触发的 back() 落地）
   * 这里绝不能再调 back()，否则就是死循环。
   */
  SidePeekDrawer.prototype._handlePopState = function (event) {
    var state = event ? event.state : null;

    this._historyToken += 1; // 让上一轮 close 的兜底定时器失效
    this._closePending = false;
    if (this._closeGuard) {
      clearTimeout(this._closeGuard);
      this._closeGuard = null;
    }

    if (isPeekState(state) && state.url) {
      // open() 内部会发现 history.state 已是我们的，所以不会重复 pushState
      this.open(state.url);
      return;
    }

    this._hide();
  };

  // ── 收起（内部，不再碰 history） ────────────────────────────────────────

  SidePeekDrawer.prototype._hide = function () {
    if (!this._open) return;

    this._open = false;
    this._historyToken += 1;
    this._closePending = false;
    if (this._closeGuard) {
      clearTimeout(this._closeGuard);
      this._closeGuard = null;
    }
    this._clearLoadTimer();
    this._loadToken += 1; // 让还没回来的超时/回调失效
    this._titleToken += 1; // 取消未完成的标题解析
    this._hideError();
    this._showLoading(false);

    if (this._drawer) {
      this._drawer.classList.remove('sp-open'); // 触发 translateX(0) → translateX(100%) 过渡
      this._drawer.setAttribute('aria-hidden', 'true');
      this._drawer.removeAttribute('data-fullscreen');
      this._fullscreen = false;
    }
    if (this._host) this._host.removeAttribute('data-open'); // 遮罩淡出，同时让出 pointer-events
    if (this._toastEl) this._toastEl.classList.remove('sp-visible');

    this._restoreFocus();
    this._scheduleUnload();
    this._safeCall('onClose', [this._url]);
  };

  SidePeekDrawer.prototype._scheduleUnload = function () {
    var self = this;
    this._cancelUnload();
    this._unloadTimer = setTimeout(function () {
      self._unloadTimer = null;
      if (self._destroyed || self._open) return;

      // 为什么要"移除节点"而不是 iframe.src = 'about:blank'：
      //  1) 跨源 iframe 拿不到 contentWindow，移除节点是唯一能可靠停掉媒体播放的办法
      //     （否则用户关了抽屉，视频声音还在后台响）；
      //  2) 给 iframe 换 src 会产生一条**子帧联合历史记录**，导致浏览器「前进」时
      //     先落在那条子帧记录上、而不是回到我们的 #sidepeek 记录 —— I-10 会失效。
      //     移除节点不触发任何导航，不会多出历史条目；下次 open 会重新创建 iframe。
      // 等收起动画（320ms）放完再移除，避免看到一块黑底往外滑。
      self._removeFrame();
    }, CLOSE_UNLOAD_DELAY_MS);
  };

  SidePeekDrawer.prototype._cancelUnload = function () {
    if (this._unloadTimer) {
      clearTimeout(this._unloadTimer);
      this._unloadTimer = null;
    }
  };

  // ── 事件处理 ────────────────────────────────────────────────────────────

  SidePeekDrawer.prototype._handleKeyDown = function (event) {
    if (!this._open || !event) return;
    var key = event.key;
    if (key !== 'Escape' && key !== 'Esc' && event.keyCode !== 27) return;

    // 抽屉开着时 Esc 属于抽屉：不再让 B 站页面同时处理（避免它顺手关掉自己的弹层/退出全屏）
    event.stopPropagation();
    this.close();
  };

  SidePeekDrawer.prototype._handleMaskClick = function (event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    // I-04：只有真正点到遮罩才算"点外面"（处理器只挂在 mask 上，点抽屉不会进来）
    this.close();
  };

  SidePeekDrawer.prototype._handleIsolation = function (event) {
    // 只拦"继续往外冒"，目标元素自己的处理器已经执行完了
    if (event && event.stopPropagation) event.stopPropagation();
  };

  SidePeekDrawer.prototype._handleActionClick = function (event) {
    if (!event) return;

    // 用 composedPath 而不是 event.target：Shadow DOM 内的按钮也能稳定认出来
    var path = isFn(event.composedPath) ? event.composedPath() : [];
    var act = null;
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.getAttribute) {
        var value = node.getAttribute('data-act');
        if (value) {
          act = value;
          break;
        }
      }
    }
    if (!act) return;

    event.preventDefault();
    event.stopPropagation();

    if (act === 'close') this.close();
    else if (act === 'copy') this._copyUrl();
    else if (act === 'open-tab') this._handleOpenTab();
  };

  SidePeekDrawer.prototype._handleTitleDblClick = function (event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this._toggleFullscreen();
  };

  SidePeekDrawer.prototype._toggleFullscreen = function () {
    if (!this._drawer) return;
    this._fullscreen = !this._fullscreen;
    if (this._fullscreen) this._drawer.setAttribute('data-fullscreen', 'true');
    else this._drawer.removeAttribute('data-fullscreen');
    // 全屏时 CSS 的 width:100vw !important 压过内联宽度；在这里重算一次，退出全屏立刻回到原宽度
    this._renderWidth();
  };

  SidePeekDrawer.prototype._handleOpenTab = function () {
    if (!this._url) return;
    // core 不碰 chrome.*；window.open 在 content script 里同样可用。
    // 先拿到窗口引用再把 opener 置空，防止新标签反向操作当前页。
    var win = null;
    try {
      win = window.open(this._url, '_blank');
    } catch (error) {
      warn('window.open 失败', error);
    }
    if (win) {
      try {
        win.opener = null;
      } catch (error) {
        /* 跨源时可能不允许，忽略即可 */
      }
    } else {
      this._toast('新标签被浏览器拦截了');
    }
  };

  SidePeekDrawer.prototype._copyUrl = function () {
    var self = this;
    var url = this._url;
    if (!url) return;

    var fallback = function () {
      if (self._legacyCopy(url)) self._toast('链接已复制');
      else self._toast('复制失败，可点「在新标签打开」');
    };

    if (typeof navigator !== 'undefined' && navigator.clipboard && isFn(navigator.clipboard.writeText)) {
      try {
        navigator.clipboard.writeText(url).then(
          function () {
            self._toast('链接已复制');
          },
          fallback
        );
        return;
      } catch (error) {
        fallback();
        return;
      }
    }
    fallback();
  };

  SidePeekDrawer.prototype._legacyCopy = function (text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      var container = document.body || document.documentElement;
      container.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      container.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  };

  SidePeekDrawer.prototype._toast = function (message) {
    if (!this._toastEl) return;
    var self = this;
    this._toastEl.textContent = message;
    this._toastEl.classList.add('sp-visible');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () {
      self._toastTimer = null;
      if (self._toastEl) self._toastEl.classList.remove('sp-visible');
    }, 1600);
  };

  SidePeekDrawer.prototype._handleResize = function () {
    if (!this._mounted || this._destroyed) return;
    // 只重算"当前该显示多宽"，不覆盖用户想要的宽度：窗口拉大后还能回到原来的宽度
    this._renderWidth();
  };

  // ── 拖拽改宽（I-07） ────────────────────────────────────────────────────

  SidePeekDrawer.prototype._handleDragStart = function (event) {
    if (!event || event.button !== 0) return;
    if (!this._drawer) return;

    event.preventDefault();
    event.stopPropagation();

    var rect = this._drawer.getBoundingClientRect();
    this._drag = {
      startX: event.clientX,
      startWidth: rect.width || this._appliedWidth
    };
    if (this._resizer) this._resizer.classList.add('sp-dragging');

    if (typeof document !== 'undefined') {
      document.addEventListener('mousemove', this._handleDragMove, true);
      document.addEventListener('mouseup', this._handleDragEnd, true);
      // 拖拽期间全局换光标 + 禁止选中文字；原值存起来，松手/销毁时还原（不污染 B 站页面）
      this._savedRootStyle = {
        cursor: document.documentElement.style.cursor,
        userSelect: document.documentElement.style.userSelect
      };
      document.documentElement.style.cursor = 'ew-resize';
      document.documentElement.style.userSelect = 'none';
    }
  };

  SidePeekDrawer.prototype._handleDragMove = function (event) {
    if (!this._drag) return;
    // 抽屉右边缘贴齐视口右侧，所以鼠标向左移 = 变宽
    var next = this._drag.startWidth + (this._drag.startX - event.clientX);
    this._width = this._clampWidth(next);
    this._renderWidth();
  };

  SidePeekDrawer.prototype._handleDragEnd = function () {
    if (!this._drag) return;
    var applied = this._appliedWidth;
    this._endDrag(false); // 先摘监听、还原样式
    // 持久化交给适配层（core 不碰 chrome.storage）
    if (applied > 0 && isFn(this._opts.persistWidth)) this._safeCall('persistWidth', [applied]);
  };

  SidePeekDrawer.prototype._endDrag = function (persist) {
    if (!this._drag) return;
    this._drag = null;

    if (typeof document !== 'undefined') {
      document.removeEventListener('mousemove', this._handleDragMove, true);
      document.removeEventListener('mouseup', this._handleDragEnd, true);
      if (this._savedRootStyle) {
        document.documentElement.style.cursor = this._savedRootStyle.cursor;
        document.documentElement.style.userSelect = this._savedRootStyle.userSelect;
        this._savedRootStyle = null;
      }
    }
    if (this._resizer) this._resizer.classList.remove('sp-dragging');
    if (persist && this._appliedWidth > 0 && isFn(this._opts.persistWidth)) {
      this._safeCall('persistWidth', [this._appliedWidth]);
    }
  };

  // ── 宽度计算 ────────────────────────────────────────────────────────────

  SidePeekDrawer.prototype._desiredWidth = function () {
    if (this._width != null) return this._width;
    if (this._opts.defaultWidth != null) return this._opts.defaultWidth;
    return viewportWidth() * this._opts.widthRatio;
  };

  SidePeekDrawer.prototype._clampWidth = function (px) {
    var vw = viewportWidth();

    // G-05（SPEC §7）固定公式：hi = min(maxWidthRatio*vw, vw-48)；lo = min(minWidth, hi)。
    // 为什么不能直接 clamp(minWidth, maxWidthRatio*vw)：视口 < 467px 时
    // maxWidthRatio*vw 会小于 minWidth，区间反转，抽屉要么溢出视口、要么把遮罩全盖住点不到。
    // 减去 48px 是硬约束：抽屉左侧任何时候都至少留 48px 可点遮罩，否则窄屏关不掉。
    var hi = Math.min(this._opts.maxWidthRatio * vw, vw - MIN_MASK_GUTTER);
    var lo = Math.min(this._opts.minWidth, hi); // lo <= hi 恒成立
    if (hi < 1) {
      // 视口窄到连 48px 留白都放不下（理论边界）：退化为 1px，绝不允许出现负宽度
      hi = 1;
      lo = 1;
    }

    var value = Number(px);
    if (!isFinite(value)) value = lo;
    return Math.round(clampNumber(value, lo, hi));
  };

  SidePeekDrawer.prototype._renderWidth = function () {
    if (!this._mounted || !this._drawer) return 0;
    var px = this._clampWidth(this._desiredWidth());
    this._appliedWidth = px;
    this._drawer.style.width = px + 'px';
    if (this._resizer) this._resizer.setAttribute('aria-valuenow', String(px));
    return px;
  };

  /** 强制一次样式/布局计算，让后续的 class 变化被浏览器识别为"状态变化"从而触发过渡。 */
  SidePeekDrawer.prototype._forceReflow = function () {
    if (!this._drawer) return;
    // 读取布局属性即可触发 reflow
    void this._drawer.offsetWidth;
  };

  // ── 杂项 ────────────────────────────────────────────────────────────────

  SidePeekDrawer.prototype._absoluteUrl = function (url) {
    try {
      var base = typeof location !== 'undefined' && location.href ? location.href : undefined;
      return new URL(String(url), base).href;
    } catch (error) {
      return null;
    }
  };

  /**
   * I-15 兜底判断：目标 URL 与顶层当前页面是否"同一个页面"。
   * 忽略 hash；同路径且目标没带业务 query（只有 spm_id_from 之类跟踪参数时宁可当作同一页）
   * 也算同一页，避免在视频页点自己的卡片形成自我嵌套。
   */
  SidePeekDrawer.prototype._isSameAsTopPage = function (url) {
    if (typeof location === 'undefined' || !location.href) return false;

    var current = trimTrailingSlash(stripHash(location.href));
    var target = trimTrailingSlash(stripHash(url));
    if (current === target) return true;

    try {
      var a = new URL(current);
      var b = new URL(target);
      if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
      return b.search === '' || b.search === a.search;
    } catch (error) {
      return false;
    }
  };

  SidePeekDrawer.prototype._focusDrawer = function () {
    if (!this._drawer) return;
    try {
      this._drawer.focus({ preventScroll: true });
    } catch (error) {
      try {
        this._drawer.focus();
      } catch (error2) {
        /* 极端环境下 focus 不被允许，忽略 */
      }
    }
  };

  SidePeekDrawer.prototype._restoreFocus = function () {
    var previous = this._prevFocus;
    this._prevFocus = null;
    if (!previous || !isFn(previous.focus)) return;
    if (previous.isConnected === false) return;
    try {
      previous.focus({ preventScroll: true });
    } catch (error) {
      try {
        previous.focus();
      } catch (error2) {
        /* 忽略 */
      }
    }
  };

  /** 调用适配层回调，但绝不把适配层的异常炸到我们的状态机里。 */
  SidePeekDrawer.prototype._safeCall = function (name, args, fallback) {
    var fn = this._opts[name];
    if (!isFn(fn)) return fallback;
    try {
      return fn.apply(null, args || []);
    } catch (error) {
      warn('回调 ' + name + ' 抛错（已隔离，不影响抽屉）', error);
      return fallback;
    }
  };

  SidePeekDrawer.prototype._clearLoadTimer = function () {
    if (this._loadTimer) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
  };

  // ── 静态信息（便于适配层/评审/测试断言） ────────────────────────────────

  Object.freeze(FORBIDDEN_SANDBOX_TOKENS);
  Object.freeze(DEFAULTS);

  SidePeekDrawer.VERSION = VERSION;
  SidePeekDrawer.SANDBOX = SANDBOX;
  SidePeekDrawer.FORBIDDEN_SANDBOX_TOKENS = FORBIDDEN_SANDBOX_TOKENS;
  SidePeekDrawer.DEFAULT_OPTIONS = DEFAULTS;
  SidePeekDrawer.CSS_TEXT = CSS_TEXT;

  // ── 挂全局 ──────────────────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    window.SidePeekDrawer = SidePeekDrawer;
  }
  // 仅为 node 单测 require 方便；浏览器里没有 module，走 window 那条。
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = SidePeekDrawer;
  }
})();
