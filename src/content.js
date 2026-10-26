/**
 * SidePeek - B 站适配层（content script）
 *
 * 职责边界（契约见 docs/SPEC.md 第 3、4 节）：
 *   1. 捕获阶段拦截 B 站视频链接点击，交给 window.SidePeekDrawer 承载；
 *   2. 向 background 请求真实标题（跨源 iframe 读不到 document，见 TECH-FINDINGS 结论 3）；
 *   3. 宽度持久化（chrome.storage.local，key: sidepeek.width）。
 *
 * 抽屉本身的 DOM / 动画 / 历史栈全部由 dev-core 的 src/core/peek-drawer.js 负责，
 * 本文件不创建抽屉 DOM，也不修改 src/core/ 的任何代码。
 *
 * 本文件是可直接 <script> 加载的 IIFE。纯函数挂在 globalThis.__SIDEPEEK_TEST__
 * 上供 node --test 验证；在 node 里跑时因为没有 window/document/chrome 会自动跳过初始化。
 */
(function () {
  'use strict';

  /* ================================================================== *
   * 0. 常量
   * ================================================================== */

  // ── 路径白名单（G-09）──────────────────────────────────────────────────
  // 按类型拆开，是为了让「收窄」只发生在一个地方：删掉下面任意一行，matchPeekUrl /
  // isPeekableUrl / peekIdentity 会同时不再命中该类路径（唯一收窄点）。
  //
  // 实测状态（docs/TECH-FINDINGS.md + SPEC §7 G-09）：
  //   - /video/...        ✅ 唯一经实测确认可嵌入的路径（XFO/CSP 均无，sandbox 可挡 frame-buster）
  //   - /bangumi/play/... ⚠️ best-effort，未经实测。若 QA 实测出现 frame-buster
  //                          （顶层页面被弹走），直接从下表删掉该行，不要试图绕过。
  //   - /cheese/play/...  ⚠️ best-effort，同上
  //   - /list/...         ⚠️ best-effort，同上
  var PEEK_PATH_PATTERNS = [
    { type: 'video', pattern: /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/ },
    { type: 'bangumi', pattern: /^\/bangumi\/play\/(ep|ss)\d+/, bestEffort: true },
    { type: 'cheese', pattern: /^\/cheese\/play\/(ep|ss)\d+/, bestEffort: true },
    { type: 'list', pattern: /^\/list\/(ml|pl)\d+/, bestEffort: true }
  ];

  /** 路径是否命中视频页白名单：命中返回类型（video/bangumi/cheese/list），否则 null。 */
  function classifyPeekPath(pathname) {
    var path = String(pathname || '');
    for (var i = 0; i < PEEK_PATH_PATTERNS.length; i++) {
      if (PEEK_PATH_PATTERNS[i].pattern.test(path)) return PEEK_PATH_PATTERNS[i].type;
    }
    return null;
  }

  var STORAGE_KEY_WIDTH = 'sidepeek.width';
  var WIDTH_RATIO = 0.62;
  var MIN_WIDTH = 420;
  var MAX_WIDTH_RATIO = 0.9;
  var MIN_MASK_GUTTER = 48; // G-05：抽屉左侧至少留 48px 可点遮罩，避免窄屏关不掉
  var Z_INDEX = 2147483000;
  var TEMP_TITLE_MAX_LEN = 80; // W2-5 / P-01：临时标题截断长度
  var TITLE_TIMEOUT_MS = 3000; // W2-5：3s 内拿不到真实标题就保留临时标题（与 background 一致）
  var INIT_TIMEOUT_MS = 800;

  // 反 frame-buster 的唯一手段（TECH-FINDINGS 结论 1）。
  // 绝对不要往这个字符串里加 allow-top-navigation / allow-top-navigation-by-user-activation，
  // 否则 B 站视频页会把整个顶层页面弹走，抽屉直接失效。
  var SANDBOX =
    'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads';

  /* ================================================================== *
   * 1. 纯函数区（无 chrome / 无真实 DOM，可被 node --test 直接验证）
   * ================================================================== */

  function toUrl(href, base) {
    if (typeof href !== 'string' || href.length === 0) return null;
    try {
      return base ? new URL(href, base) : new URL(href);
    } catch (err) {
      return null;
    }
  }

  /**
   * hostname 必须是 bilibili.com 本身或其子域。
   * 不要写成 hostname.endsWith('bilibili.com')：那样 evilbilibili.com 也会被当成 B 站。
   */
  function isBilibiliHost(hostname) {
    var host = String(hostname || '').toLowerCase();
    return host === 'bilibili.com' || host.slice(-13) === '.bilibili.com';
  }

  /**
   * 判断 href 是否指向可被抽屉承载的 B 站视频页。
   * 命中返回「完整 URL」字符串（query 原样保留），否则返回 null。
   * target="_blank" 的卡片链接同样命中 —— 我们只关心 href，不关心 target（I-14）。
   *
   * P-13：命中 http:// 时统一升级为 https:// 再返回。https 顶层页面里内嵌
   * http 子页属于混合内容，Chrome 会直接拦掉，抽屉只会空等 8s 变成错误态。
   * B 站 http/https 是同一份内容，升级不改变语义，且 path/query/hash 全部保留。
   */
  function matchPeekUrl(href, base) {
    var url = toUrl(href, base);
    if (!url) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!isBilibiliHost(url.hostname)) return null;
    // 唯一收窄点：是否允许被抽屉承载只看 classifyPeekPath（白名单见 PEEK_PATH_PATTERNS）
    if (classifyPeekPath(url.pathname) === null) return null;
    var peekUrl = toHttpsUrl(url);
    if (!peekUrl) return null;
    // 必须保留 ?spm_id_from=...&vd_source=...&p=... 等全部参数，否则 B 站统计/分P会异常。
    return peekUrl.href;
  }

  /** http → https（path/query/hash 原样保留）；已经是 https 或无法升级时返回 null。 */
  function toHttpsUrl(url) {
    if (!url) return null;
    if (url.protocol === 'https:') return url;
    if (url.protocol !== 'http:') return null;
    try {
      url.protocol = 'https:';
      return url;
    } catch (err) {
      return null;
    }
  }

  /**
   * 是否允许被抽屉承载。
   * G-09：这里是内容的唯一收窄点 —— 白名单在 PEEK_PATH_PATTERNS，QA 实测某类路径
   * 触发 frame-buster 时，删掉对应白名单行即可，不需要改这里的判断逻辑。
   */
  function isPeekableUrl(url) {
    return matchPeekUrl(url, undefined) !== null;
  }

  function normalizePathname(pathname) {
    var value = String(pathname || '').replace(/\/+$/, '');
    return value || '/';
  }

  /**
   * 「同一个页面」的归一化身份：origin + pathname + 分P。
   * 刻意忽略 spm_id_from / vd_source 这类追踪参数 —— B 站卡片链接几乎都带它们，
   * 若按完整 href 比较，当前视频页里点「自己的标题」也会被当成新页面打开（违反 I-15）。
   * 但 p（分P）会真正改变页面内容，必须参与比较。
   */
  function peekIdentity(href, base) {
    var url = toUrl(href, base);
    if (!url) return null;
    if (!isBilibiliHost(url.hostname)) return null;
    if (classifyPeekPath(url.pathname) === null) return null;
    // P-13 的 https 归一化同样作用于「同页判定」，否则 http 链接会被当成另一个页面。
    var peekUrl = toHttpsUrl(url);
    if (!peekUrl) return null;
    var page = peekUrl.searchParams.get('p') || '1';
    return (
      peekUrl.protocol + '//' + peekUrl.hostname + normalizePathname(peekUrl.pathname) + '?p=' + page
    );
  }

  function isSamePeekPage(targetHref, currentHref) {
    var target = peekIdentity(targetHref);
    var current = peekIdentity(currentHref);
    return target !== null && current !== null && target === current;
  }

  /**
   * 宽度 clamp。优先级：视口上限 > minWidth。
   * 极端窄视口（maxWidth < minWidth）时宁可小于 minWidth，也不能让抽屉溢出屏幕（QA 用例 10）。
   * 非法输入返回 null，调用方回落到 widthRatio。
   */
  function clampWidth(px, minWidth, maxWidth) {
    var value = typeof px === 'number' ? px : parseFloat(px);
    if (!isFinite(value)) return null;

    var low = typeof minWidth === 'number' && isFinite(minWidth) ? minWidth : 0;
    var high = typeof maxWidth === 'number' && isFinite(maxWidth) ? Math.max(0, maxWidth) : low;
    if (low > high) low = high; // 视口上限优先，保证不溢出屏幕
    return Math.round(Math.min(Math.max(value, low), high));
  }

  /**
   * 宽度上下界（SPEC §7 G-05 裁决，公式写死）：
   *   hi = min(maxWidthRatio * vw, vw - 48)
   *   lo = min(minWidth, hi)
   * 保证 lo <= hi 恒成立，且抽屉左侧永远留 48px 遮罩可点（窄屏也能关掉）。
   */
  function computeWidthBounds(viewportWidth, minWidth, maxWidthRatio, gutter) {
    var viewport =
      typeof viewportWidth === 'number' && isFinite(viewportWidth) && viewportWidth > 0
        ? viewportWidth
        : 1280;
    var gutterPx = typeof gutter === 'number' && isFinite(gutter) && gutter > 0 ? gutter : 0;
    var max = Math.floor(Math.min(viewport * maxWidthRatio, viewport - gutterPx));
    if (!isFinite(max) || max < 0) max = 0;
    var min = Math.min(minWidth, max);
    return { min: min, max: max };
  }

  /** 普通文本化：去标签、折叠空白、截断。用于链接文字当临时标题。 */
  function normalizeTitleText(raw, maxLen) {
    var limit = typeof maxLen === 'number' && maxLen > 0 ? maxLen : TEMP_TITLE_MAX_LEN;
    var text = typeof raw === 'string' ? raw : '';
    text = text.replace(/<[^>]*>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > limit) text = text.slice(0, limit).trim();
    return text;
  }

  /* ---------- 临时标题噪声过滤（W2-5 / P-01） ---------- */

  // B 站卡片 textContent 常是「标题 12:34 1.2万播放」这种拼接串。
  // 真实标题回来前（≤3s）头部不能显示这些噪声，所以按行/分隔符拆开后过滤。
  var TITLE_NOISE_PATTERNS = [
    /^\d{1,2}:\d{2}(?::\d{2})?$/, // 纯时长：12:34 / 1:02:03
    /^\d+(?:\.\d+)?万?$/, // 纯数字/播放量：1234 / 12.3万
    /^\d+(?:\.\d+)?万?\s*次?(?:播放|弹幕|点赞|投币|收藏|评论|观看|粉丝)$/, // 12.3万播放
    /^(?:播放|弹幕|点赞|投币|收藏|评论|观看|粉丝|人看过)\s*\d+(?:\.\d+)?万?$/, // 播放 12.3万
    /^(?:播放|弹幕|点赞|投币|收藏|评论|观看|粉丝|人看过)$/ // 裸的统计词
  ];

  /** 这一小段文本是不是纯噪声（时长 / 播放量 / xx播放）。 */
  function isNoiseTitleText(raw) {
    var text = String(raw || '').trim();
    if (!text) return true;
    for (var i = 0; i < TITLE_NOISE_PATTERNS.length; i++) {
      if (TITLE_NOISE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /**
   * 从 textContent 里挑临时标题（W2-5 / P-01）：
   *   1. 按换行 + 常见分隔符（| ｜ · •）拆成若干行；
   *   2. 每行按空白切词，从**行尾**剥掉纯时长/播放量等噪声词
   *      （不在中间乱删，避免误伤标题里本身带数字的内容）；
   *   3. 过滤空行与噪声行，取剩余最长的一行；
   *   4. 截断到 80 字。
   * 纯函数，便于单测。
   */
  function pickTempTitleFromText(rawText) {
    var text = typeof rawText === 'string' ? rawText : '';
    if (!text) return '';

    var lines = text.replace(/\r\n?/g, '\n').split(/[\n|｜·•]+/);
    var best = '';

    for (var i = 0; i < lines.length; i++) {
      var tokens = lines[i].trim().split(/\s+/);
      while (tokens.length > 0 && isNoiseTitleText(tokens[tokens.length - 1])) tokens.pop();
      var candidate = normalizeTitleText(tokens.join(' '), TEMP_TITLE_MAX_LEN);
      if (!candidate || isNoiseTitleText(candidate)) continue;
      if (candidate.length > best.length) best = candidate;
    }

    return best;
  }

  function getAttr(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    try {
      return node.getAttribute(name);
    } catch (err) {
      return null;
    }
  }

  var CONTROL_TAGS = {
    BUTTON: true,
    INPUT: true,
    SELECT: true,
    TEXTAREA: true,
    OPTION: true,
    LABEL: true
  };

  function isControlNode(node, tagName) {
    if (CONTROL_TAGS[tagName] === true) return true;
    if (getAttr(node, 'role') === 'button') return true;
    if (getAttr(node, 'contenteditable') === 'true') return true;
    return false;
  }

  /**
   * 从 composedPath() 里找「最近的可拦截 <a href>」。
   * 从点击目标往上走：
   *   - 先遇到 <a href> → 可以拦截；
   *   - 先遇到按钮/输入框等控件 → 说明用户点的是卡片上的「稍后再看」之类控件
   *     （虽然它外面也套着视频链接），此时不拦截，避免破坏 B 站自己的交互。
   * 纯函数：只依赖节点上的 nodeType/tagName/getAttribute，方便单测用假节点验证。
   */
  function scanPathForAnchor(nodes) {
    if (!nodes || typeof nodes.length !== 'number') return null;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || node.nodeType !== 1) continue; // 只关心元素节点
      var tagName = String(node.tagName || '').toUpperCase();
      if (tagName === 'A') {
        if (getAttr(node, 'href')) return node;
        continue; // 无 href 的锚点只是占位，继续往上找
      }
      if (isControlNode(node, tagName)) return null;
    }
    return null;
  }

  /** 点击是否发生在抽屉自己的 Shadow DOM 里（抽屉内的交互不该被当成 B 站链接拦截）。 */
  function isFromDrawerHost(nodes) {
    if (!nodes || typeof nodes.length !== 'number') return false;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node && node.nodeType === 1 && node.id === 'sidepeek-host') return true;
    }
    return false;
  }

  /**
   * 临时标题（W2-5 / P-01 优先级）：
   *   1. textContent：分行过滤噪声、取最长行、截 80 字；
   *   2. 兜底 img[alt]（B 站图片卡片链接常常只有图，alt 就是标题）；
   *   3. aria-label；
   *   4. title 属性；
   *   5. 最终兜底「视频」，避免头部空标题。
   */
  function extractTempTitle(anchor) {
    if (!anchor) return '';
    var fromText = pickTempTitleFromText(anchor.textContent);
    if (fromText) return fromText;

    var imageAlt = pickImageAlt(anchor);
    if (imageAlt) return imageAlt;

    var ariaLabel = normalizeTitleText(getAttr(anchor, 'aria-label'), TEMP_TITLE_MAX_LEN);
    if (ariaLabel) return ariaLabel;

    var titleAttr = normalizeTitleText(getAttr(anchor, 'title'), TEMP_TITLE_MAX_LEN);
    if (titleAttr) return titleAttr;

    return '视频';
  }

  /** 内层图片的 alt（B 站图片卡片链接通常只包一个 <img alt="标题">）。 */
  function pickImageAlt(anchor) {
    if (typeof anchor.querySelector !== 'function') return '';
    var image = null;
    try {
      image = anchor.querySelector('img[alt]');
    } catch (err) {
      image = null;
    }
    if (!image) return '';
    return normalizeTitleText(getAttr(image, 'alt'), TEMP_TITLE_MAX_LEN);
  }

  /* ================================================================== *
   * 2. 测试导出 & 运行环境探测
   * ================================================================== */

  if (typeof globalThis !== 'undefined') {
    globalThis.__SIDEPEEK_TEST__ = {
      PEEK_PATH_PATTERNS: PEEK_PATH_PATTERNS,
      classifyPeekPath: classifyPeekPath,
      matchPeekUrl: matchPeekUrl,
      isPeekableUrl: isPeekableUrl,
      peekIdentity: peekIdentity,
      isSamePeekPage: isSamePeekPage,
      clampWidth: clampWidth,
      computeWidthBounds: computeWidthBounds,
      normalizeTitleText: normalizeTitleText,
      isNoiseTitleText: isNoiseTitleText,
      pickTempTitleFromText: pickTempTitleFromText,
      scanPathForAnchor: scanPathForAnchor,
      isFromDrawerHost: isFromDrawerHost,
      extractTempTitle: extractTempTitle
    };
  }

  // node 单测环境：纯函数已导出，不初始化抽屉。
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof chrome === 'undefined') {
    return;
  }

  // 幂等保护：扩展被重复注入（或开发时手动再注入）时只初始化一次。
  if (window.__SIDEPEEK_LOADED__) return;
  window.__SIDEPEEK_LOADED__ = true;

  /* ================================================================== *
   * 3. 运行时状态
   * ================================================================== */

  var drawer = null;
  var activeUrl = null; // 抽屉当前展示的 URL（自己也记一份，用于标题防串台）
  var titleCache = Object.create(null); // url -> Promise<title|null>
  var initStarted = false;

  function widthBounds() {
    var viewport =
      window.innerWidth ||
      (document.documentElement && document.documentElement.clientWidth) ||
      1280;
    return computeWidthBounds(viewport, MIN_WIDTH, MAX_WIDTH_RATIO, MIN_MASK_GUTTER);
  }

  function hasChromeApi() {
    return typeof chrome !== 'undefined' && chrome !== null && typeof chrome === 'object';
  }

  /* ================================================================== *
   * 4. 标题：content → background
   * ================================================================== */

  /**
   * 向 background 要真实标题。
   * 任何失败（超时 / 无扩展上下文 / background 返回 null）都 resolve(null)，
   * 绝不 reject —— 标题只是锦上添花，不能影响抽屉打开。
   */
  function requestRealTitle(url) {
    return new Promise(function (resolve) {
      var runtime = hasChromeApi() ? chrome.runtime : null;
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        resolve(null);
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, TITLE_TIMEOUT_MS);

      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }

      try {
        runtime.sendMessage({ type: 'PEEK_TITLE', url: url }, function (response) {
          // 扩展被重载后 sendMessage 会走 lastError，必须读一下，
          // 否则控制台会报 "Unchecked runtime.lastError"。
          var lastError = runtime.lastError;
          if (lastError) {
            finish(null);
            return;
          }
          var title = response && typeof response.title === 'string' ? response.title.trim() : '';
          finish(title || null);
        });
      } catch (err) {
        // Extension context invalidated（扩展被更新/卸载）时不能把异常抛给 B 站页面
        finish(null);
      }
    });
  }

  /**
   * core 的 resolveTitle 契约（SPEC 第 3 节）：
   * 返回 Promise<string|null>，core 在抽屉仍打开且 URL 未变时会用它替换临时标题。
   * 这里额外做两道防串台：请求期间用户切了视频 / 关了抽屉，就返回 null。
   */
  function resolveTitle(url) {
    if (typeof url !== 'string' || url.length === 0) return Promise.resolve(null);
    if (activeUrl !== url) return Promise.resolve(null);
    if (titleCache[url]) return titleCache[url];

    var pending = requestRealTitle(url)
      .then(function (title) {
        if (!title) return null;
        if (activeUrl !== url) return null; // 已经切到别的视频，旧标题不能盖上去
        if (!drawer || !drawer.isOpen()) return null; // 抽屉已关闭，没人需要这个标题了
        return title;
      })
      .then(function (title) {
        if (!title) delete titleCache[url]; // 失败不缓存，下次打开同一条还能重试
        return title;
      });

    titleCache[url] = pending;
    return pending;
  }

  /* ================================================================== *
   * 5. 宽度持久化：chrome.storage.local
   * ================================================================== */

  /** 读取上次宽度；storage 异常或超时都回落 null（用 widthRatio 默认值）。 */
  function loadStoredWidth(done) {
    var finished = false;
    function finish(value) {
      if (finished) return;
      finished = true;
      done(value);
    }

    if (!hasChromeApi() || !chrome.storage || !chrome.storage.local) {
      finish(null);
      return;
    }

    // storage 极端情况下不回包也要把抽屉装起来，不能让 B 站页面点了没反应。
    setTimeout(function () {
      finish(null);
    }, INIT_TIMEOUT_MS);

    try {
      chrome.storage.local.get(STORAGE_KEY_WIDTH, function (result) {
        var lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          finish(null);
          return;
        }
        finish(result ? result[STORAGE_KEY_WIDTH] : null);
      });
    } catch (err) {
      finish(null);
    }
  }

  /** core 拖拽松手后的回调：clamp 后落盘。存不上也不影响使用。 */
  function persistWidth(px) {
    var bounds = widthBounds();
    var clamped = clampWidth(px, bounds.min, bounds.max);
    if (clamped === null) return;
    if (!hasChromeApi() || !chrome.storage || !chrome.storage.local) return;
    try {
      var payload = {};
      payload[STORAGE_KEY_WIDTH] = clamped;
      chrome.storage.local.set(payload);
    } catch (err) {
      /* 静默失败：只是记不住宽度，不影响抽屉功能 */
    }
  }

  /* ================================================================== *
   * 6. 点击拦截（捕获阶段委托）
   * ================================================================== */

  function openPeek(url, anchor) {
    if (!drawer) return;
    activeUrl = url;
    var title = extractTempTitle(anchor);
    drawer.open(url, title ? { title: title } : undefined);
  }

  function onClickCapture(event) {
    if (!drawer) return;
    if (event.defaultPrevented) return; // B 站自己已经处理过这次点击
    if (event.button !== 0) return; // 中键/右键不拦（I-03）
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; // I-02

    var path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (isFromDrawerHost(path)) return;

    var anchor = scanPathForAnchor(path);
    if (!anchor) return;

    // target="_blank" 的卡片链接照样命中（I-14）：我们只看 href。
    var url = matchPeekUrl(getAttr(anchor, 'href'), window.location.href);
    if (!url) return;

    // I-15：当前页面已经是这个视频，不做自我嵌套。
    if (isSamePeekPage(url, window.location.href)) return;

    // P-09 / PRD I-23：原页面处于全屏时，抽屉宿主不在 top layer，会被全屏元素完全盖住 ——
    // 此时拦截等于"点了没反应"。放行浏览器默认跳转，绝不静默吞掉点击。
    if (document.fullscreenElement) return;

    // 确认是视频链接后才吞事件：不能粗暴拦截所有点击，
    // 否则会破坏播放器控件、点赞、弹幕开关等 B 站自有交互。
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    openPeek(url, anchor);
  }

  /* ================================================================== *
   * 7. 初始化
   * ================================================================== */

  function buildDrawer(storedWidth) {
    if (typeof window.SidePeekDrawer !== 'function') {
      // core 没注入成功：宁可完全不接管点击（B 站页面保持原样），
      // 也不要拦截了点击却打不开抽屉。
      console.warn(
        '[SidePeek] window.SidePeekDrawer 不存在，适配层不接管点击。请确认 src/core/peek-drawer.js 已注入。'
      );
      return null;
    }

    var bounds = widthBounds();
    var options = {
      zIndex: Z_INDEX,
      widthRatio: WIDTH_RATIO,
      minWidth: MIN_WIDTH,
      maxWidthRatio: MAX_WIDTH_RATIO,
      defaultWidth: clampWidth(storedWidth, bounds.min, bounds.max), // null 时 core 回落到 widthRatio
      sandbox: SANDBOX, // 反 frame-buster；见文件头注释
      isPeekableUrl: isPeekableUrl,
      resolveTitle: resolveTitle,
      persistWidth: persistWidth,
      onOpen: function (url) {
        activeUrl = typeof url === 'string' && url ? url : activeUrl;
      },
      onClose: function () {
        activeUrl = null;
      }
    };

    try {
      return new window.SidePeekDrawer(options);
    } catch (err) {
      console.warn('[SidePeek] 抽屉初始化失败，适配层不接管点击：', err);
      return null;
    }
  }

  function start() {
    if (initStarted) return;
    initStarted = true;

    loadStoredWidth(function (storedWidth) {
      if (drawer) return;
      drawer = buildDrawer(storedWidth);
      if (!drawer) return;

      // 只装一次；handler 对非视频链接会立刻 return，对 B 站页面零影响。
      document.addEventListener('click', onClickCapture, true);

      // 只读调试探针：便于 QA / E2E shim 拿到实例，不属于契约的一部分。
      window.__SIDEPEEK_EXT__ = {
        getDrawer: function () {
          return drawer;
        },
        getActiveUrl: function () {
          return activeUrl;
        },
        isPeekableUrl: isPeekableUrl
      };
    });
  }

  start();
})();
