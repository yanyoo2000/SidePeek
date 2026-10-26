/**
 * SidePeek E2E —— chrome.* API shim（仅用于浏览器内注入式验收，不参与打包）
 * ---------------------------------------------------------------------------
 * 为什么需要它：
 *   MCP / CDP 无法把一个「未打包的 MV3 扩展」加载进受控浏览器，因此 E2E 采用等价替代：
 *   把 src/core/peek-drawer.js + src/content.js 直接注入页面，并用本文件伪造扩展 API。
 *
 * 它模拟的是真实扩展里 content script 能看到的那几个 API（以 src/content.js 的实际判断为准）：
 *   - chrome.runtime.id                      —— 扩展上下文存在性
 *   - chrome.runtime.lastError               —— 必须可读（content.js 会读，避免 Unchecked runtime.lastError）
 *   - chrome.runtime.sendMessage(msg, cb)    —— 模拟 background 抓标题（fetch + 解析 <title>）
 *   - chrome.runtime.getURL(p)               —— 恒等
 *   - chrome.runtime.onMessage               —— background 侧的监听接口（本 shim 不注册 background，
 *                                               直接内联 sendMessage 的逻辑，见下方 fetchTitle）
 *   - chrome.storage.local.get/set/remove    —— SPEC §7 G-07 指定用 local（不是 sync）
 *   - chrome.storage.sync                    —— 指向同一份内存，兼容旧探针/防御性代码
 *
 * 与真实扩展的三点已知差异（写进 docs/QA.md 的「已知限制」，不要当缺陷）：
 *   1. 没有 background 线程，标题由页面主世界 fetch 抓取：跨源（search.bilibili.com 内嵌
 *      www.bilibili.com）时会被 CORS 拦下 → 退回链接文字当临时标题，这与真实扩展的降级路径一致；
 *      同源（www.bilibili.com 内嵌视频页）时能真正拿到 <title>，可验证标题替换。
 *   2. storage 是内存态，页面刷新/顶层导航后丢失 → 无法验证「刷新后宽度保留」，只能验证
 *      「松手后确实调用了 storage.set 且值已 clamp」。
 *   3. window.chrome 被覆盖为主世界对象（真实扩展里 content script 跑在隔离世界，
 *      页面不可见）。这里用 Object.create(原 chrome) 继承，尽量不破坏 B 站的原生探测。
 */
(function () {
  'use strict';

  if (window.__SIDEPEEK_CHROME_SHIM__) return;
  window.__SIDEPEEK_CHROME_SHIM__ = true;

  // ── 内存 storage（测试可在注入前用 window.__SIDEPEEK_E2E_SEED__ 预置初值） ──
  var store = {};
  var seed = window.__SIDEPEEK_E2E_SEED__;
  if (seed && typeof seed === 'object') {
    Object.keys(seed).forEach(function (key) {
      store[key] = seed[key];
    });
  }
  window.__SIDEPEEK_E2E_STORAGE__ = store;

  // ── 标题解析：逻辑对齐 src/background.js 的 extractTitleFromHtml ──────────
  var TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
  var TITLE_SUFFIX_PATTERNS = [
    /\s*(?:[-_|–—]\s*)?哔哩哔哩\s*[（(]\s*゜\s*[–—-]?\s*゜\s*[)）]\s*つ\s*ロ\s*干杯\s*[~～]\s*[-_]?\s*bilibili\s*$/i,
    // 与 src/background.js 保持一致：中段下划线可选（实测存在「标题_哔哩哔哩bilibili」变体）
    /\s*(?:[-_|–—]\s*)?哔哩哔哩\s*_?\s*bilibili\s*$/i,
    /\s*[-_|–—]\s*哔哩哔哩\s*$/i,
    /\s*_\s*哔哩哔哩\s*$/i,
    /\s*_\s*bilibili\s*$/i,
    /\s*[-_|–—]\s*bilibili\s*$/i
  ];

  function cleanTitle(raw) {
    if (typeof raw !== 'string') return null;
    var title = raw.replace(/<[^>]*>/g, ' ');
    title = title
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
    title = title.replace(/[\s\u00a0]+/g, ' ').trim();
    var previous;
    do {
      previous = title;
      for (var i = 0; i < TITLE_SUFFIX_PATTERNS.length; i++) {
        title = title.replace(TITLE_SUFFIX_PATTERNS[i], '').trim();
      }
    } while (title && title !== previous);
    return title || null;
  }

  function fetchTitle(url) {
    return new Promise(function (resolve) {
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return resolve(null);
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        resolve(null);
      }, 3000);
      try {
        fetch(url, {
          credentials: 'include',
          redirect: 'follow',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          signal: controller ? controller.signal : undefined
        })
          .then(function (response) {
            if (!response || !response.ok) return null;
            return response.text();
          })
          .then(function (html) {
            var match = html ? TITLE_RE.exec(html) : null;
            resolve(match ? cleanTitle(match[1]) : null);
          })
          .catch(function () {
            // CORS / 网络 / 解析失败：与真实 background 一致，降级返回 null
            resolve(null);
          })
          .then(function () {
            clearTimeout(timer);
          });
      } catch (err) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  // ── 组装 shim（继承页面原有 window.chrome，避免破坏站点自身探测） ─────────
  var realChrome = window.chrome && typeof window.chrome === 'object' ? window.chrome : null;
  var shim = realChrome ? Object.create(realChrome) : {};

  var listeners = [];

  shim.runtime = {
    id: 'sidepeektestsimulatedextensionid',
    lastError: null,
    getURL: function (path) {
      return String(path || '');
    },
    getManifest: function () {
      return { manifest_version: 3, name: 'SidePeek (E2E shim)', version: '0.1.0-e2e' };
    },
    sendMessage: function (message, callback) {
      var respond = typeof callback === 'function' ? callback : function () {};
      if (!message || message.type !== 'PEEK_TITLE' || typeof message.url !== 'string') {
        setTimeout(function () {
          shim.runtime.lastError = null;
          respond(undefined);
        }, 0);
        return;
      }
      fetchTitle(message.url).then(function (title) {
        shim.runtime.lastError = null;
        setTimeout(function () {
          try {
            respond({ title: title || null });
          } catch (err) {
            /* content script 上下文已销毁：真实扩展同样忽略 */
          }
        }, 0);
      });
    },
    onMessage: {
      addListener: function (fn) {
        if (typeof fn === 'function' && listeners.indexOf(fn) === -1) listeners.push(fn);
      },
      removeListener: function (fn) {
        var index = listeners.indexOf(fn);
        if (index !== -1) listeners.splice(index, 1);
      },
      hasListener: function (fn) {
        return listeners.indexOf(fn) !== -1;
      }
    }
  };

  // storage.local 的语义照抄 chrome.storage.local：
  //   get(string | string[] | object | null, cb)  → cb(result)
  //   set(object, cb?)                            → 落盘后 cb
  function getFromStore(keys) {
    var result = {};
    if (keys === null || keys === undefined) {
      Object.keys(store).forEach(function (key) {
        result[key] = store[key];
      });
      return result;
    }
    if (typeof keys === 'string') {
      if (Object.prototype.hasOwnProperty.call(store, keys)) result[keys] = store[keys];
      return result;
    }
    if (Array.isArray(keys)) {
      keys.forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
      });
      return result;
    }
    if (typeof keys === 'object') {
      Object.keys(keys).forEach(function (key) {
        result[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : keys[key];
      });
    }
    return result;
  }

  var localArea = {
    get: function (keys, callback) {
      var result = getFromStore(keys);
      setTimeout(function () {
        shim.runtime.lastError = null;
        if (typeof callback === 'function') callback(result);
      }, 0);
    },
    set: function (items, callback) {
      if (items && typeof items === 'object') {
        Object.keys(items).forEach(function (key) {
          store[key] = items[key];
        });
      }
      setTimeout(function () {
        shim.runtime.lastError = null;
        if (typeof callback === 'function') callback();
      }, 0);
    },
    remove: function (keys, callback) {
      var list = Array.isArray(keys) ? keys : [keys];
      list.forEach(function (key) {
        delete store[key];
      });
      setTimeout(function () {
        if (typeof callback === 'function') callback();
      }, 0);
    },
    clear: function (callback) {
      Object.keys(store).forEach(function (key) {
        delete store[key];
      });
      setTimeout(function () {
        if (typeof callback === 'function') callback();
      }, 0);
    }
  };

  shim.storage = { local: localArea, sync: localArea };

  // 页面若自己定义过 window.chrome（Chrome 一定有），直接定义会抛或静默失败，
  // 用 defineProperty 明确覆盖，并在失败时退化为属性赋值。
  try {
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: shim
    });
  } catch (err) {
    try {
      window.chrome = shim;
    } catch (err2) {
      console.error('[SidePeek E2E] 无法安装 chrome shim：', err2);
    }
  }

  window.__SIDEPEEK_E2E_SHIM__ = shim;
})();
