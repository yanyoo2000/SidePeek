/**
 * SidePeek E2E —— 页面内探针 / 操作助手（仅测试用，不属于扩展代码）
 * ---------------------------------------------------------------------------
 * 注入顺序：chrome-shim.js → peek-drawer.js → content.js → 本文件。
 * 本文件只做两件事：
 *   1. 读抽屉状态（Shadow DOM 里的真实 DOM/CSS 值），给断言提供数据；
 *   2. 用合成事件模拟「用户操作」（因为 MCP 无法点到 Shadow DOM 内部、也无法按住修饰键点击），
 *      并把元素是否被遮挡（elementFromPoint）一起记录下来，避免「事件发出去了但点不到」的假 PASS。
 *
 * 所有函数都挂在 window.__SP_E2E__ 上，不做任何全局副作用。
 */
(function () {
  'use strict';

  if (window.__SP_E2E__) return;

  var HOST_ID = 'sidepeek-host';

  function host() {
    return document.getElementById(HOST_ID);
  }

  function shadow() {
    var el = host();
    return el && el.shadowRoot ? el.shadowRoot : null;
  }

  function q(selector) {
    var root = shadow();
    return root ? root.querySelector(selector) : null;
  }

  function drawer() {
    var ext = window.__SIDEPEEK_EXT__;
    return ext && typeof ext.getDrawer === 'function' ? ext.getDrawer() : null;
  }

  function frameInfo() {
    var frame = q('iframe.sp-frame');
    if (!frame) return null;
    var rect = frame.getBoundingClientRect();
    return {
      present: true,
      src: frame.getAttribute('src'),
      sandbox: frame.getAttribute('sandbox'),
      allow: frame.getAttribute('allow'),
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      // 跨源时读不到 contentDocument，这里只记录「能否访问」，用于说明降级路径
      sameOriginReadable: (function () {
        try {
          return !!(frame.contentDocument && frame.contentDocument.location);
        } catch (err) {
          return false;
        }
      })()
    };
  }

  function cs(el, prop) {
    if (!el) return null;
    return getComputedStyle(el)[prop];
  }

  /** 抽屉全量状态快照：断言只需要这一个函数。 */
  function state() {
    var h = host();
    var d = q('.sp-drawer');
    var mask = q('.sp-mask');
    var root = shadow();
    var inst = drawer();
    return {
      // content.js 是否初始化完成（window.__SIDEPEEK_EXT__ 只在 drawer 建好后出现）
      extReady: !!window.__SIDEPEEK_EXT__,
      loadedFlag: !!window.__SIDEPEEK_LOADED__,
      shimInstalled: !!window.__SIDEPEEK_CHROME_SHIM__,
      coreLoaded: typeof window.SidePeekDrawer === 'function',
      coreVersion: window.SidePeekDrawer && window.SidePeekDrawer.VERSION,

      hostAttached: !!h,
      hostParentTag: h && h.parentNode ? h.parentNode.tagName : null,
      hostPointerEvents: cs(h, 'pointerEvents'),
      hostZIndex: cs(h, 'zIndex'),

      shadowRoot: !!root,
      drawerPresent: !!d,
      drawerOpenClass: !!(d && d.classList.contains('sp-open')),
      drawerAriaHidden: d ? d.getAttribute('aria-hidden') : null,
      drawerWidth: d ? cs(d, 'width') : null,
      drawerRect: d ? rectOf(d) : null,
      drawerTransform: d ? cs(d, 'transform') : null,
      drawerRight: d ? cs(d, 'right') : null,
      maskPointerEvents: mask ? cs(mask, 'pointerEvents') : null,
      maskOpacity: mask ? cs(mask, 'opacity') : null,
      hostDataOpen: h ? h.getAttribute('data-open') : null,

      logicalOpen: inst ? inst.isOpen() : null,
      activeUrl: (function () {
        var ext = window.__SIDEPEEK_EXT__;
        return ext && typeof ext.getActiveUrl === 'function' ? ext.getActiveUrl() : null;
      })(),

      title: q('.sp-title') ? q('.sp-title').textContent : null,
      titleTitleAttr: q('.sp-title') ? q('.sp-title').getAttribute('title') : null,
      titleColor: cs(q('.sp-title'), 'color'),
      titleFontSize: cs(q('.sp-title'), 'fontSize'),
      headerBg: cs(q('.sp-header'), 'backgroundColor'),
      actionButtonCount: root ? root.querySelectorAll('.sp-actions button').length : 0,
      actionButtonColors: root
        ? Array.prototype.map.call(root.querySelectorAll('.sp-actions button'), function (btn) {
            return getComputedStyle(btn).color;
          })
        : [],
      loadingVisible: !!(q('.sp-loading') && q('.sp-loading').classList.contains('sp-visible')),
      errorVisible: !!(q('.sp-error') && q('.sp-error').classList.contains('sp-visible')),

      frame: frameInfo(),

      location: {
        href: location.href,
        hash: location.hash,
        state: history.state,
        historyLength: history.length,
        scrollY: Math.round(window.scrollY)
      }
    };
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      left: Math.round(r.left),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  }

  /**
   * 命中测试：在 viewport 里取若干点，看 elementFromPoint 是否落在抽屉宿主内。
   * 关闭态下必须全部落在 B 站页面元素上（用例 9：pointer-events 没挡住页面）。
   */
  function hitTest(points) {
    var list = points || [
      { x: 10, y: 10 },
      { x: 10, y: window.innerHeight - 10 },
      { x: Math.round(window.innerWidth * 0.5), y: Math.round(window.innerHeight * 0.5) },
      { x: window.innerWidth - 40, y: 40 },
      { x: window.innerWidth - 40, y: Math.round(window.innerHeight * 0.5) },
      { x: window.innerWidth - 40, y: window.innerHeight - 40 }
    ];
    return list.map(function (pt) {
      var el = document.elementFromPoint(pt.x, pt.y);
      return {
        x: pt.x,
        y: pt.y,
        tag: el ? el.tagName : null,
        id: el ? el.id : null,
        cls: el && el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        insideHost: !!(el && host() && (el === host() || host().contains(el)))
      };
    });
  }

  /** 找页面上第一个匹配的视频链接（可按正则过滤），滚到可视区并返回信息。 */
  function findVideoLink(pattern) {
    var re = pattern ? new RegExp(pattern) : /^\/(video\/(BV[0-9A-Za-z]{10}|av\d+)|bangumi\/play\/(ep|ss)\d+|cheese\/play\/(ep|ss)\d+|list\/(ml|pl)\d+)/;
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var url;
      try {
        url = new URL(a.getAttribute('href'), location.href);
      } catch (err) {
        continue;
      }
      if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) continue;
      if (!re.test(url.pathname)) continue;
      var rect = a.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;
      a.scrollIntoView({ block: 'center' });
      rect = a.getBoundingClientRect();
      return {
        index: i,
        href: url.href,
        absHref: a.href,
        target: a.getAttribute('target'),
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        rect: rectOf(a),
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      };
    }
    return null;
  }

  /**
   * 合成一次「左键单击」。
   * 用 elementFromPoint 先做命中测试：如果该点被别的东西盖住（例如抽屉还开着），
   * 就把 hitBlocked 标出来，断言时能立刻看出这是假 PASS。
   */
  function clickAt(x, y, modifiers) {
    var mods = modifiers || {};
    var target = document.elementFromPoint(x, y);
    var init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: typeof mods.button === 'number' ? mods.button : 0,
      buttons: mods.buttons === undefined ? 1 : mods.buttons,
      clientX: x,
      clientY: y,
      ctrlKey: !!mods.ctrlKey,
      metaKey: !!mods.metaKey,
      shiftKey: !!mods.shiftKey,
      altKey: !!mods.altKey
    };
    var targetTag = target ? target.tagName : null;
    var insideHost = !!(target && host() && (target === host() || host().contains(target)));
    // 优先在目标元素上派发（与真实点击的事件目标一致）；目标本身在 Shadow DOM 里时
    // 用 shadowRoot 上的元素，事件仍会 composed 到 document。
    var dispatchTarget = target || document.body;
    var md = new MouseEvent('mousedown', init);
    var mu = new MouseEvent('mouseup', init);
    var click = new MouseEvent('click', init);
    dispatchTarget.dispatchEvent(md);
    dispatchTarget.dispatchEvent(mu);
    var notCancelled = dispatchTarget.dispatchEvent(click);
    return {
      targetTag: targetTag,
      targetInHost: insideHost,
      notCancelled: notCancelled,
      defaultPrevented: click.defaultPrevented
    };
  }

  /** 点第一个视频链接（可选过滤正则），返回点击前后 URL 变化与命中信息。 */
  function clickVideoLink(pattern) {
    var link = findVideoLink(pattern);
    if (!link) return { found: false };
    var before = location.href;
    var clickResult = clickAt(link.center.x, link.center.y);
    return {
      found: true,
      link: link,
      click: clickResult,
      urlChanged: location.href !== before,
      before: before,
      after: location.href
    };
  }

  /** 按 data-act 点抽屉头部按钮（Shadow DOM 内，MCP 的 uid 点不到）。 */
  function clickAction(act) {
    var btn = q('.sp-actions button[data-act="' + act + '"]');
    if (!btn) return { found: false };
    var rect = rectOf(btn);
    var ev = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + 5, clientY: rect.top + 5 };
    btn.dispatchEvent(new MouseEvent('mousedown', ev));
    btn.dispatchEvent(new MouseEvent('mouseup', ev));
    var click = new MouseEvent('click', ev);
    btn.dispatchEvent(click);
    return { found: true, defaultPrevented: click.defaultPrevented, rect: rect };
  }

  /** 点遮罩（关闭路径 2）。 */
  function clickMask() {
    var mask = q('.sp-mask');
    if (!mask) return { found: false };
    var rect = rectOf(mask);
    var x = Math.round(rect.left + Math.min(30, rect.width / 4));
    var y = Math.round(rect.top + rect.height / 2);
    var target = document.elementFromPoint(x, y);
    var ev = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: x, clientY: y };
    mask.dispatchEvent(new MouseEvent('mousedown', ev));
    mask.dispatchEvent(new MouseEvent('mouseup', ev));
    var click = new MouseEvent('click', ev);
    mask.dispatchEvent(click);
    return {
      found: true,
      point: { x: x, y: y },
      hitTargetTag: target ? target.tagName : null,
      hitMask: !!(target && (target === mask || mask.contains(target))),
      defaultPrevented: click.defaultPrevented
    };
  }

  /**
   * 拖拽左边缘改宽（I-07）。
   * 用合成事件按 3 段移动，记录每段后的宽度 —— 用于验证「实时跟随」而不是只有终点值。
   */
  function dragWidth(toX, steps) {
    var resizer = q('.sp-resizer');
    if (!resizer) return { found: false };
    var rect = rectOf(resizer);
    var startX = Math.round(rect.left + rect.width / 2);
    var startY = Math.round(rect.top + 120);
    var samples = [];
    var widthBefore = q('.sp-drawer') ? Math.round(q('.sp-drawer').getBoundingClientRect().width) : null;

    function mouse(type, x) {
      var target = type === 'mousedown' ? resizer : document;
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
          clientX: x,
          clientY: startY
        })
      );
    }

    mouse('mousedown', startX);
    var total = steps || 3;
    for (var i = 1; i <= total; i++) {
      var x = startX + ((toX - startX) * i) / total;
      mouse('mousemove', Math.round(x));
      samples.push({ x: Math.round(x), width: Math.round(q('.sp-drawer').getBoundingClientRect().width) });
    }
    mouse('mouseup', toX);

    return {
      found: true,
      startX: startX,
      widthBefore: widthBefore,
      widthAfter: q('.sp-drawer') ? Math.round(q('.sp-drawer').getBoundingClientRect().width) : null,
      samples: samples,
      storedWidth: window.__SIDEPEEK_E2E_STORAGE__ ? window.__SIDEPEEK_E2E_STORAGE__['sidepeek.width'] : undefined,
      inlineWidth: q('.sp-drawer') ? q('.sp-drawer').style.width : null,
      cursorRestored: document.documentElement.style.cursor,
      userSelectRestored: document.documentElement.style.userSelect
    };
  }

  /** 采样抽屉 transform，用于验证 I-08「切换视频不重播入场动画」。 */
  function sampleTransform(durationMs, intervalMs) {
    var d = q('.sp-drawer');
    if (!d) return { found: false };
    var samples = [];
    var total = Math.max(1, Math.round((durationMs || 420) / (intervalMs || 40)));
    return new Promise(function (resolve) {
      var count = 0;
      var timer = setInterval(function () {
        samples.push({
          t: count * (intervalMs || 40),
          cls: d.classList.contains('sp-open'),
          transform: getComputedStyle(d).transform
        });
        count += 1;
        if (count > total) {
          clearInterval(timer);
          resolve({ found: true, samples: samples });
        }
      }, intervalMs || 40);
    });
  }

  function shadowDomInfo() {
    var root = shadow();
    if (!root) return null;
    return {
      childClasses: Array.prototype.map.call(root.children, function (el) {
        return el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '');
      }),
      buttons: Array.prototype.map.call(root.querySelectorAll('button'), function (b) {
        return { act: b.getAttribute('data-act'), label: b.getAttribute('aria-label'), text: b.textContent.trim() };
      }),
      bodyChildren: (function () {
        var body = q('.sp-body');
        return body
          ? Array.prototype.map.call(body.children, function (el) {
              return el.tagName.toLowerCase() + '.' + String(el.className).split(' ').join('.');
            })
          : [];
      })()
    };
  }

  window.__SP_E2E__ = {
    version: '1.0.0',
    state: state,
    hitTest: hitTest,
    findVideoLink: findVideoLink,
    clickAt: clickAt,
    clickVideoLink: clickVideoLink,
    clickAction: clickAction,
    clickMask: clickMask,
    dragWidth: dragWidth,
    sampleTransform: sampleTransform,
    shadowDomInfo: shadowDomInfo,
    q: q,
    rectOf: rectOf
  };
})();
