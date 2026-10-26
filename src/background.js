/**
 * SidePeek - background service worker
 *
 * 唯一的职责：收到 content script 的 PEEK_TITLE 请求后，用 host_permissions
 * 去 fetch B 站视频页，解析 <title>，把干净的标题回传。
 *
 * 为什么这一层必须存在（而不是在 content 里读 iframe 的 document）：
 *   抽屉里的 iframe 与顶层页面跨源（例如 search.bilibili.com 内嵌 www.bilibili.com），
 *   contentDocument 读不到（TECH-FINDINGS 结论 3）。
 *
 * 为什么不申请 declarativeNetRequest：
 *   B 站视频页响应头本来就没有 XFO / 强制 CSP，不需要改写响应头（TECH-FINDINGS 结论 2）。
 *   权限清单保持最小：storage + B 站域 host_permissions。
 *
 * 该文件是可直接 <script> 加载的 IIFE（MV3 service worker 用 classic 模式，
 * 不用 ESM），纯函数同时挂到 globalThis 方便 node --test 验证。
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 纯函数区：不依赖 chrome / fetch，可在 node --test 里直接验证       *
   * ------------------------------------------------------------------ */

  var TITLE_FETCH_TIMEOUT_MS = 3000;
  var MAX_HTML_BYTES = 512 * 1024;

  // 与 content.js / docs/SPEC.md 第 4.1 节保持一致：只认这些视频页路径。
  var PEEK_PATH_RE =
    /^\/(video\/(BV[0-9A-Za-z]{10}|av\d+)|bangumi\/play\/(ep|ss)\d+|cheese\/play\/(ep|ss)\d+|list\/(ml|pl)\d+)/;

  var TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

  // 只解码标题里实际会出现的常见实体，避免引入完整 HTML 解析器（零依赖）。
  var NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ensp: '\u2002',
    emsp: '\u2003',
    mdash: '\u2014',
    ndash: '\u2013',
    hellip: '\u2026',
    middot: '\u00b7',
    bull: '\u2022',
    ldquo: '\u201c',
    rdquo: '\u201d',
    lsquo: '\u2018',
    rsquo: '\u2019',
    laquo: '\u00ab',
    raquo: '\u00bb',
    copy: '\u00a9',
    reg: '\u00ae',
    trade: '\u2122',
    times: '\u00d7',
    divide: '\u00f7',
    deg: '\u00b0',
    plusmn: '\u00b1',
    prime: '\u2032',
    Prime: '\u2033',
    yen: '\u00a5',
    pound: '\u00a3',
    euro: '\u20ac',
    larr: '\u2190',
    rarr: '\u2192',
    uarr: '\u2191',
    darr: '\u2193'
  };

  /**
   * 解码 HTML 实体（命名 + 十进制 + 十六进制）。
   * 只认带分号的标准写法：标题里的 "AT&T" 不能被误伤成 "AT&T"。
   */
  function decodeHtmlEntities(input) {
    if (typeof input !== 'string' || input.indexOf('&') === -1) return input;
    return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (match, body) {
      if (body.charAt(0) === '#') {
        var isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (!isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch (err) {
          return match;
        }
      }
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
        return NAMED_ENTITIES[body];
      }
      // 大小写不敏感兜底：&AMP; / &Nbsp; 这类写法也能解
      var lower = body.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) {
        return NAMED_ENTITIES[lower];
      }
      return match;
    });
  }

  /**
   * B 站标题尾巴的清洗规则。顺序很重要：长而具体的规则在前，
   * 否则 "标题_哔哩哔哩_bilibili" 可能只被清掉一半。
   */
  var TITLE_SUFFIX_PATTERNS = [
    // 老版站点尾巴：「标题 - 哔哩哔哩 (゜-゜)つロ 干杯~-bilibili」
    /\s*(?:[-_|–—]\s*)?哔哩哔哩\s*[（(]\s*゜\s*[–—-]?\s*゜\s*[)）]\s*つ\s*ロ\s*干杯\s*[~～]\s*[-_]?\s*bilibili\s*$/i,
    // 视频页最常见的尾巴：「标题_哔哩哔哩_bilibili」
    /\s*(?:[-_|–—]\s*)?哔哩哔哩\s*_\s*bilibili\s*$/i,
    // 「标题 - 哔哩哔哩」
    /\s*[-_|–—]\s*哔哩哔哩\s*$/i,
    // 「标题_哔哩哔哩」
    /\s*_\s*哔哩哔哩\s*$/i,
    // 「标题_bilibili」
    /\s*_\s*bilibili\s*$/i,
    // 「标题 - bilibili」
    /\s*[-_|–—]\s*bilibili\s*$/i
  ];

  /**
   * 把 <title> 里的原始字符串清洗成可展示的标题。
   * 失败（非字符串 / 清洗后为空）返回 null，交给 content 继续用链接文字兜底。
   */
  function cleanBilibiliTitle(rawTitle) {
    if (typeof rawTitle !== 'string') return null;
    var title = rawTitle.replace(/<[^>]*>/g, ' ');
    title = decodeHtmlEntities(title);
    title = title.replace(/[\s\u00a0]+/g, ' ').trim();

    // 反复应用直到稳定：既处理 "标题_哔哩哔哩_bilibili" 这种叠加尾巴，
    // 也避免只清一层就停下。
    var previous;
    do {
      previous = title;
      for (var i = 0; i < TITLE_SUFFIX_PATTERNS.length; i++) {
        title = title.replace(TITLE_SUFFIX_PATTERNS[i], '').trim();
      }
    } while (title && title !== previous);

    return title || null;
  }

  /** 从 HTML 里取第一个 <title> 并清洗。 */
  function extractTitleFromHtml(html) {
    if (typeof html !== 'string' || !html) return null;
    var match = TITLE_RE.exec(html);
    if (!match) return null;
    return cleanBilibiliTitle(match[1]);
  }

  /** 只允许替 B 站视频页抓标题：拒绝任何其他 URL，避免把 background 当成任意代理。 */
  function isAllowedTitleUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    var url;
    try {
      url = new URL(rawUrl);
    } catch (err) {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    var host = url.hostname.toLowerCase();
    // 不要用 endsWith('bilibili.com')：'evilbilibili.com' 也会通过。
    if (host !== 'bilibili.com' && host.slice(-13) !== '.bilibili.com') return false;
    return PEEK_PATH_RE.test(url.pathname);
  }

  /**
   * 读取响应体，最多 MAX_HTML_BYTES。
   * 标题在 <head> 里，读到 </title> 就提前收手，不要为了一行标题下载整页 HTML。
   */
  async function readBodyLimited(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      var text = await response.text();
      return text.slice(0, maxBytes);
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var parts = [];
    var total = 0;
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        total += step.value.byteLength;
        parts.push(decoder.decode(step.value, { stream: true }));
        if (/<\/title>/i.test(parts.join(''))) break;
        if (total >= maxBytes) break;
      }
      parts.push(decoder.decode());
    } finally {
      try {
        await reader.cancel();
      } catch (err) {
        /* 取消读取失败无所谓，标题已经拿到或已经放弃 */
      }
    }
    return parts.join('');
  }

  /** fetch 页面并提取标题；任何失败（网络、超时、状态码、解析）都只返回 null。 */
  async function fetchTitle(url) {
    if (!isAllowedTitleUrl(url)) return null;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = setTimeout(function () {
        controller.abort();
      }, TITLE_FETCH_TIMEOUT_MS);
    }
    try {
      var response = await fetch(url, {
        // 带登录态：番剧 / 部分地区 / 大会员内容的服务端渲染标题才准确
        credentials: 'include',
        redirect: 'follow',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: controller ? controller.signal : undefined
      });
      if (!response || !response.ok) return null;
      var html = await readBodyLimited(response, MAX_HTML_BYTES);
      return extractTitleFromHtml(html);
    } catch (err) {
      // 超时 abort / DNS / 403 / 解析错 —— 统一降级，绝不把异常抛回 content script。
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ *
   * 测试导出：node --test 通过 vm 加载本文件后读取这些纯函数            *
   * ------------------------------------------------------------------ */

  if (typeof globalThis !== 'undefined') {
    globalThis.__SIDEPEEK_TEST_BG__ = {
      decodeHtmlEntities: decodeHtmlEntities,
      cleanBilibiliTitle: cleanBilibiliTitle,
      extractTitleFromHtml: extractTitleFromHtml,
      isAllowedTitleUrl: isAllowedTitleUrl,
      PEEK_PATH_RE: PEEK_PATH_RE
    };
  }

  // 非扩展环境（node 单测）：纯函数已导出，不注册消息监听。
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

  /* ------------------------------------------------------------------ *
   * 消息入口                                                           *
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'PEEK_TITLE') return undefined;

    fetchTitle(message.url).then(function (title) {
      try {
        sendResponse({ title: title || null });
      } catch (err) {
        // content script 已经离开（切页 / 关抽屉），通道关闭，忽略即可
      }
    });

    // 异步响应必须 return true，否则 MV3 会立刻关闭消息通道，
    // content 那边的回调永远等不到标题。
    return true;
  });
})();
