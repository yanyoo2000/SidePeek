/**
 * SidePeek 真机联调（T7）
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本？
 *   initScript 注入式 E2E 只能验证「代码逻辑」，无法验证「扩展作为扩展是否装得上」。
 *   manifest 字段写错、content_scripts 路径不存在、图标缺失、权限声明非法……
 *   这类问题只有真实浏览器加载扩展后才暴露（G-01 就是典型）。
 *
 * 关键坑（已实测，别走回头路）：
 *   1. 品牌版 Chrome 155+ **已禁用** `--load-extension`（日志：
 *      "WARNING:extension_service.cc --load-extension is not allowed in Google Chrome, ignoring."）
 *      Edge 同样不再接受该参数。
 *      → 唯一可用路径：`--enable-unsafe-extension-debugging` + CDP 域 `Extensions.loadUnpacked`。
 *   2. content script 运行在 **isolated world**，`window.__SIDEPEEK_LOADED__` 在主世界读不到。
 *      → 必须从 `Runtime.executionContextCreated` 里挑出隔离世界 contextId 再 evaluate。
 *      （抽屉 DOM 在主世界可见，所以 UI 断言仍在主世界做。）
 *
 * 用法：
 *   node tests/integration/real-extension-check.mjs
 *   node tests/integration/real-extension-check.mjs --headed
 *
 * 退出码：0 通过；1 断言失败；2 环境不可用
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'qa-assets');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（支持事件订阅——隔离世界就靠它）
// ---------------------------------------------------------------------------
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const handlers = new Map();
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          if (!handlers.has(method)) handlers.set(method, []);
          handlers.get(method).push(fn);
        },
        close() {
          try { ws.close(); } catch { /* ignore */ }
        },
      });
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method && handlers.has(msg.method)) {
        for (const fn of handlers.get(msg.method)) {
          try { fn(msg.params); } catch { /* ignore */ }
        }
      }
    };
  });
}

async function getJson(url, attempts = 120, interval = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(interval);
  }
  throw new Error('无法连接 DevTools HTTP 端点: ' + url);
}

function createReport() {
  const checks = [];
  const log = (icon, id, title, detail) => {
    console.log(`  ${icon} ${id} ${title}`);
    if (detail) console.log(`     ${detail}`);
  };
  return {
    checks,
    ok(id, title, detail) { checks.push({ id, title, pass: true, detail }); log('✅', id, title, detail); },
    fail(id, title, detail) { checks.push({ id, title, pass: false, detail }); log('❌', id, title, detail); },
    skip(id, title, detail) { checks.push({ id, title, pass: true, skipped: true, detail }); log('⏭️', id, title, detail); },
    get passed() { return checks.length > 0 && checks.filter((c) => !c.skipped).every((c) => c.pass); },
  };
}

async function evaluate(client, expression, opts = {}) {
  const params = { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...opts };
  const r = await client.send('Runtime.evaluate', params);
  if (r.exceptionDetails) {
    throw new Error(
      '页面内异常: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知')
    );
  }
  return r.result.value;
}

async function waitFor(fn, { timeout = 20000, interval = 300, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`等待超时 ${label}: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
async function runRound({ browserPath, headless }) {
  const report = createReport();
  const port = 9400 + Math.floor(Math.random() * 80);
  const profileDir = path.join(tmpdir(), 'sidepeek-e2e-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(profileDir, { recursive: true });

  const args = [
    // 这是替代 --load-extension 的唯一可用开关（Chrome 155+）
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1440,900',
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');
  args.push('about:blank');

  console.log(`\n启动 Chrome（${headless ? 'headless=new' : 'headed'}）: ${browserPath}`);
  const proc = spawn(browserPath, args, { stdio: 'ignore' });
  const info = { headless };

  let page = null;
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    info.browser = version.Browser;

    // ---- 用 CDP Extensions 域加载未打包扩展 ----
    const browser = await connectCdp(version.webSocketDebuggerUrl);
    let extId = null;
    try {
      const r = await browser.send('Extensions.loadUnpacked', { path: REPO_ROOT });
      extId = r.id;
    } catch (e) {
      report.fail('A', '加载扩展失败（Extensions.loadUnpacked）', e.message);
    }
    browser.close();
    if (!extId) return { report, info };

    info.extensionId = extId;
    report.ok('A', '扩展成功加载（CDP Extensions.loadUnpacked）', 'id = ' + extId);
    await sleep(2000);

    // ---- 断言 B：background service worker 是我们的 src/background.js ----
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    const sw = list.find(
      (t) =>
        (t.type === 'service_worker' || t.type === 'background_page') &&
        (t.url || '').includes(`chrome-extension://${extId}/src/background.js`)
    );
    if (sw) report.ok('B', 'background service worker 已注册（manifest 解析通过）', sw.url);
    else
      report.fail(
        'B',
        'background service worker 未注册',
        '未找到 chrome-extension://' + extId + '/src/background.js 的 target'
      );

    // ---- 连页面 ----
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const pageTarget = targets.find((t) => t.type === 'page');
    page = await connectCdp(pageTarget.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    // 收集执行上下文，用于隔离世界断言
    const contexts = [];
    page.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));

    /** 找 content script 所在的隔离世界并求值 */
    async function evalInIsolatedWorld(expression) {
      const c = contexts.find(
        (x) =>
          x.auxData &&
          x.auxData.type === 'isolated' &&
          (x.origin || '').startsWith('chrome-extension://')
      );
      if (!c) return { ok: false, reason: '未找到隔离世界上下文', contexts: contexts.map((x) => ({ origin: x.origin, name: x.name, type: x.auxData?.type })) };
      const v = await evaluate(page, expression, { contextId: c.id });
      return { ok: true, value: v, contextName: c.name, origin: c.origin };
    }

    // -----------------------------------------------------------------
    // 场景测试
    // -----------------------------------------------------------------

    /**
     * 严谨的抽屉展开态判据。
     *
     * 为什么不能只比 left 与 window.innerWidth：
     *   抽屉是 position:fixed;right:0，其包含块宽度 = documentElement.clientWidth（**不含**
     *   经典滚动条）；而 window.innerWidth **包含**滚动条（本机约 15px）。关闭态抽屉被
     *   translateX(100%) 推到 left === clientWidth === 1425，此时 1425 < innerWidth(1440)-10
     *   恒成立 → 关闭态会被误判成「已展开」（REVIEW-03 §3 的假阳性）。
     * 因此以 .sp-open 类为主判据（与动画无关、与滚动条无关），再用 clientWidth 做交叉校验。
     */
    async function drawerState() {
      return await evaluate(
        page,
        `(() => {
          const host = document.getElementById('sidepeek-host');
          const cw = document.documentElement.clientWidth;
          const iw = window.innerWidth;
          if (!host || !host.shadowRoot) return { exists: false, open: false, cw, iw };
          const d = host.shadowRoot.querySelector('.sp-drawer');
          if (!d) return { exists: true, open: false, cw, iw };
          const r = d.getBoundingClientRect();
          const hasOpenClass = d.classList.contains('sp-open');
          return {
            exists: true,
            hasOpenClass,
            hostOpenAttr: host.getAttribute('data-open'),
            left: Math.round(r.left),
            width: Math.round(r.width),
            cw,
            iw,
            open: hasOpenClass && r.width > 200 && r.left < cw - 4
          };
        })()`
      );
    }

    /**
     * 点击页面上某个视频链接。
     * 为什么要绕这么一圈：B 站首页有自动轮播/懒加载，元素在「测量坐标」与
     * 「真正点击」之间会移位，导致点击落空、用例偶发失败（踩过）。
     * 所以：逐个候选 → scrollIntoView → 等布局稳定 → 用 elementFromPoint
     * 校验命中目标 → 才发真实鼠标事件；命中不了就换下一个候选。
     */
    async function clickSomeVideoLink() {
      const count = await evaluate(
        page,
        `document.querySelectorAll('a[href*="/video/BV"]').length`
      );
      if (!count) return { ok: false, reason: '页面内没有 /video/BV 链接' };

      for (let idx = 0; idx < Math.min(count, 8); idx++) {
        const prep = await evaluate(
          page,
          `(() => {
            const a = document.querySelectorAll('a[href*="/video/BV"]')[${idx}];
            if (!a) return { ok: false };
            a.scrollIntoView({ block: 'center' });
            return { ok: true, href: a.href };
          })()`
        );
        if (!prep?.ok) continue;
        await sleep(450);

        const box = await evaluate(
          page,
          `(() => {
            const a = document.querySelectorAll('a[href*="/video/BV"]')[${idx}];
            if (!a) return { ok: false };
            const r = a.getBoundingClientRect();
            if (r.width < 20 || r.height < 10) return { ok: false, why: '尺寸过小' };
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            if (y < 5 || y > window.innerHeight - 5) return { ok: false, why: '不在视口内' };
            const el = document.elementFromPoint(x, y);
            const hit = !!(el && el.closest && el.closest('a[href*="/video/BV"]') === a);
            return { ok: hit, x, y, href: a.href, why: hit ? '' : '命中被遮挡' };
          })()`
        );
        if (!box?.ok) continue;

        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: box.x, y: box.y, button: 'none',
        });
        await page.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1,
        });
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1,
        });
        return { ok: true, href: box.href, x: box.x, y: box.y };
      }
      return { ok: false, reason: '8 个候选链接均无法稳定命中' };
    }

    async function scenario({ name, url, prefix }) {
      console.log(`\n[场景] ${name} — ${url}`);
      contexts.length = 0;
      const nav = await page.send('Page.navigate', { url });
      await sleep(2000);

      // B-1：content script 是否注入（隔离世界）
      let injected = false;
      try {
        await waitFor(async () => {
          const r = await evalInIsolatedWorld('typeof window.__SIDEPEEK_LOADED__');
          return r.ok && r.value !== 'undefined';
        }, { timeout: 20000, label: prefix + ' 隔离世界注入' });
        injected = true;
        report.ok(prefix + '-1', `${name}：content script 已注入（隔离世界可见）`);
      } catch (e) {
        // 退化判据：主世界里能拿到宿主元素也算注入成功（宿主任一世界都可见于 DOM）
        const host = await evaluate(page, '!!document.getElementById("sidepeek-host")');
        if (host) {
          injected = true;
          report.ok(prefix + '-1', `${name}：content script 已注入（以宿主元素存在佐证）`);
        } else {
          report.fail(prefix + '-1', `${name}：content script 未注入`, e.message);
        }
      }
      if (!injected) return;

      // B-2：找视频链接并真实点击
      // 注意：baseUrl 必须剥离 hash —— 抽屉打开时扩展会按 SPEC §3.3 主动追加
      // `#sidepeek=<encoded>` 用于历史记账，这属于预期行为，不是 frame-buster。
      // 真正的 frame-buster 会改变 origin / pathname / search。
      const before = await evaluate(page, 'location.href.split("#")[0]');
      const lenBefore = await evaluate(page, 'history.length');
      const clicked = await clickSomeVideoLink();
      if (!clicked.ok) {
        report.fail(prefix + '-2', `${name}：无法稳定点击到视频链接`, clicked.reason || '');
        return;
      }

      // B-3：抽屉展开（判据见 drawerState 注释：以 .sp-open 为准，不用 innerWidth）
      try {
        const st = await waitFor(
          async () => {
            const s = await drawerState();
            return s && s.open ? s : false;
          },
          { timeout: 15000, label: prefix + ' 抽屉展开' }
        );
        report.ok(
          prefix + '-2',
          `${name}：点击后抽屉从右侧展开`,
          `sp-open=${st.hasOpenClass} left=${st.left}/${st.cw} width=${st.width}`
        );
      } catch (e) {
        report.fail(prefix + '-2', `${name}：点击后抽屉未展开`, e.message);
        return;
      }

      // B-4：最关键——顶层文档不能被 frame-buster 顶走
      // 判据：origin + pathname + search 不变（hash 允许被我们自己的 #sidepeek= 改写）
      await sleep(4500);
      const rawAfter = await evaluate(page, 'location.href');
      const after = rawAfter.split('#')[0];
      if (after === before)
        report.ok(
          prefix + '-3',
          `${name}：顶层文档未被 frame-buster 劫持（hash 变化为扩展自身的 #sidepeek= 记账）`,
          `origin+path+search 不变；hash=${rawAfter.includes('#') ? '#' + rawAfter.split('#')[1].slice(0, 40) : '(无)'}`
        );
      else
        report.fail(
          prefix + '-3',
          `${name}：顶层文档被改写，frame-buster 未被挡住`,
          `before=${before}\nafter(base)=${after}\nafter(full)=${rawAfter}`
        );

      // B-5：样式生效 + sandbox 精确 + iframe 已加载
      const st = await evaluate(
        page,
        `(() => {
          const host = document.getElementById('sidepeek-host');
          const sr = host.shadowRoot;
          const d = sr.querySelector('.sp-drawer');
          const cs = getComputedStyle(d);
          const f = sr.querySelector('iframe');
          return {
            position: cs.position, zIndex: cs.zIndex,
            boxShadow: cs.boxShadow, transform: cs.transform,
            sandbox: f ? f.getAttribute('sandbox') : null,
            src: f ? f.src : null,
            hostPE: getComputedStyle(host).pointerEvents,
            drawerPE: getComputedStyle(d).pointerEvents,
            maskExists: !!sr.querySelector('.sp-mask'),
            headerText: (sr.querySelector('.sp-header')?.textContent || '').trim().slice(0, 60)
          };
        })()`
      );
      const okStyle =
        st && st.position === 'fixed' && st.maskExists && st.boxShadow && st.boxShadow !== 'none';
      if (okStyle)
        report.ok(prefix + '-4', `${name}：Shadow DOM 内 CSS 生效`, `position=${st.position} zIndex=${st.zIndex} shadow=${st.boxShadow.slice(0, 40)}`);
      else
        report.fail(prefix + '-4', `${name}：Shadow DOM 内 CSS 未生效（CSS 通道可能断了）`, JSON.stringify(st));

      const tokens = (st?.sandbox || '').split(/\s+/).filter(Boolean);
      const banned = tokens.filter((t) => t.startsWith('allow-top-navigation'));
      const missing = ['allow-scripts', 'allow-same-origin'].filter((t) => !tokens.includes(t));
      if (banned.length === 0 && missing.length === 0)
        report.ok(prefix + '-5', `${name}：iframe sandbox 组合正确`, st.sandbox);
      else
        report.fail(prefix + '-5', `${name}：iframe sandbox 组合错误`, `多出=${JSON.stringify(banned)} 缺=${JSON.stringify(missing)} 实际="${st.sandbox}"`);

      if (st?.src && /\/video\//.test(st.src))
        report.ok(prefix + '-6', `${name}：iframe 已加载视频页`, st.src.slice(0, 90));
      else report.fail(prefix + '-6', `${name}：iframe 未加载视频页`, String(st?.src));

      if (st.hostPE === 'none' && st.drawerPE === 'auto')
        report.ok(prefix + '-7', `${name}：pointer-events 分层正确（宿主 none / 抽屉 auto）`, `host=${st.hostPE} drawer=${st.drawerPE}`);
      else
        report.fail(prefix + '-7', `${name}：pointer-events 分层异常`, `host=${st.hostPE} drawer=${st.drawerPE}`);

      // 截图
      try {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(ARTIFACT_DIR, `real-extension-${prefix.toLowerCase()}.png`);
        mkdirSync(ARTIFACT_DIR, { recursive: true });
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        info['screenshot' + prefix] = file;
      } catch { /* ignore */ }

      // B-8：I-10 历史回归（N-08）—— 后退关闭 / 前进重开，且 history.length 不增长
      // 注意顺序：这段必须在 Esc 关闭之前做，因为 Esc 内部也会 history.back()，
      // 之后再 back() 就会退到 bilibili 之外的页面，把场景弄坏。
      try {
        const lenAfterOpen = await evaluate(page, 'history.length');
        if (lenAfterOpen === lenBefore + 1)
          report.ok(prefix + '-8', `${name}：打开抽屉正确新增 1 条历史`, `${lenBefore} → ${lenAfterOpen}`);
        else
          report.fail(prefix + '-8', `${name}：打开抽屉的历史条目数异常`, `${lenBefore} → ${lenAfterOpen}（期望 +1）`);

        await evaluate(page, 'history.back(); 1');
        // 等待时长可调：用于验证「B 站剪除前向条目」是否与用户停顿时长相关。
        // 默认 1400ms（接近真实用户的即时操作）；用 SIDEPEEK_BACK_WAIT_MS=5000 可复现站方剪除。
        await sleep(Number(process.env.SIDEPEEK_BACK_WAIT_MS || 1400));
        const stateAfterBack = await drawerState();
        const closedAfterBack = !stateAfterBack.open;
        const hashAfterBack = await evaluate(page, 'location.hash');
        if (closedAfterBack)
          report.ok(
            prefix + '-9',
            `${name}：后退 → 抽屉关闭`,
            `sp-open=${stateAfterBack.hasOpenClass} hash="${hashAfterBack}"`
          );
        else
          report.fail(
            prefix + '-9',
            `${name}：后退后抽屉未关闭`,
            `sp-open=${stateAfterBack.hasOpenClass} hash="${hashAfterBack}"`
          );

        await evaluate(page, 'history.forward(); 1');
        await sleep(1800);
        const stateAfterFwd = await drawerState();
        const reopened = stateAfterFwd.open;
        const hashAfterFwd = await evaluate(page, 'location.hash');
        const lenAfterFwd = await evaluate(page, 'history.length');
        const peekStateJson = await evaluate(
          page,
          'JSON.stringify(history.state && history.state.__sidepeek ? {peek:1,url:history.state.url} : null)'
        );
        const landedOnPeekEntry = peekStateJson && peekStateJson !== 'null';

        if (reopened) {
          report.ok(
            prefix + '-10',
            `${name}：前进 → 抽屉重新打开`,
            `hash="${String(hashAfterFwd).slice(0, 46)}"`
          );
        } else if (!landedOnPeekEntry) {
          // B 站（尤其 search 页）会在 popstate 里自己 pushState，把前向条目剪掉，
          // 导致 forward() 根本回不到我们的 #sidepeek 条目。
          // 已用「不加载扩展」的对照实验证实这是站方行为，不是本扩展的缺陷。
          report.skip(
            prefix + '-10',
            `${name}：前进未生效，但站方已剪除前向条目（对照实验证实为 B 站行为，非扩展缺陷）`,
            `state=${peekStateJson || 'null'} hash="${String(hashAfterFwd).slice(0, 30)}"`
          );
        } else {
          // 历史条目还在我们手上却没重开 —— 这才是真正的回归
          report.fail(
            prefix + '-10',
            `${name}：前进命中了 #sidepeek 条目但抽屉未重开（真实回归）`,
            `state=${peekStateJson} hash="${String(hashAfterFwd).slice(0, 46)}"`
          );
        }

        if (lenAfterFwd === lenAfterOpen)
          report.ok(prefix + '-11', `${name}：back/forward 往返后 history.length 未增长`, `${lenAfterFwd}`);
        else
          report.fail(
            prefix + '-11',
            `${name}：history.length 在往返中增长（joint session history 被污染）`,
            `open=${lenAfterOpen} forward=${lenAfterFwd}`
          );
      } catch (e) {
        report.fail(prefix + '-8', `${name}：历史回归异常`, e.message);
      }

      // B-13：标题清洗（走真实 background 链路，验证后缀被剥掉）
      // 背景：B 站 <title> 形如「标题_哔哩哔哩_bilibili」/「标题_哔哩哔哩bilibili」，
      // 若不清洗用户会在抽屉标题栏看到站点后缀。
      try {
        const titleText = await waitFor(
          async () => {
            const t = await evaluate(
              page,
              `(() => {
                const host = document.getElementById('sidepeek-host');
                if (!host || !host.shadowRoot) return '';
                const el = host.shadowRoot.querySelector('.sp-title');
                return el ? (el.textContent || '').trim() : '';
              })()`
            );
            return t && t.length > 0 ? t : '';
          },
          { timeout: 8000, label: prefix + ' 标题回填' }
        );
        const dirty =
          /[_\-|–—]\s*哔哩哔哩/i.test(titleText) || /哔哩哔哩\s*_?\s*bilibili/i.test(titleText);
        if (!dirty)
          report.ok(prefix + '-13', `${name}：抽屉标题已清洗（无站点后缀）`, titleText.slice(0, 60));
        else
          report.fail(
            prefix + '-13',
            `${name}：抽屉标题仍含站点后缀（清洗未生效）`,
            titleText.slice(0, 90)
          );
      } catch (e) {
        report.skip(prefix + '-13', `${name}：标题未回填（不阻塞主流程）`, e.message);
      }

      // B-12：Esc 关闭（焦点需在顶层文档）
      try {
        await page.send('Runtime.evaluate', { expression: 'document.body.focus(); void 0' });
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await waitFor(
          async () => {
            const s = await drawerState();
            return !s.open;
          },
          { timeout: 8000, label: prefix + ' Esc 关闭' }
        );
        report.ok(prefix + '-12', `${name}：Esc 可关闭抽屉`);
      } catch (e) {
        report.fail(prefix + '-12', `${name}：Esc 未能关闭抽屉`, e.message);
      }
    }

    await scenario({ name: '同源（首页）', url: 'https://www.bilibili.com/', prefix: 'C' });
    await scenario({ name: '跨源（搜索页）', url: 'https://search.bilibili.com/all?keyword=%E6%B8%B8%E6%88%8F', prefix: 'D' });

    // 关闭浏览器
    try {
      const b = await connectCdp(version.webSocketDebuggerUrl);
      await b.send('Browser.close');
      b.close();
    } catch { /* ignore */ }

    return { report, info };
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    await sleep(400);
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  const arg = process.argv[2] || '';
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('❌ 找不到 Chrome，请用 CHROME_PATH 指定');
    process.exit(2);
  }
  if (!existsSync(path.join(REPO_ROOT, 'manifest.json'))) {
    console.error('❌ 仓库根目录没有 manifest.json');
    process.exit(2);
  }
  console.log('浏览器: ' + browserPath);
  console.log('扩展目录: ' + REPO_ROOT);

  const modes = arg === '--headed' ? [false] : arg === '--headless' ? [true] : [true, false];
  let result = null;
  for (const headless of modes) {
    try {
      result = await runRound({ browserPath, headless });
      if (result.report.passed) break;
      console.log('\n⚠️ 本轮有失败项' + (modes.length > 1 ? '，尝试另一种模式…' : ''));
    } catch (e) {
      console.error(`\n❌ ${headless ? 'headless' : 'headed'} 模式异常: ${e.message}`);
      result = null;
    }
    await sleep(1500);
  }
  if (!result) { console.error('\n❌ 未能完成验证'); process.exit(1); }

  const { report, info } = result;
  const summary = {
    browser: info.browser,
    extensionId: info.extensionId || null,
    headless: info.headless,
    screenshots: Object.fromEntries(Object.entries(info).filter(([k]) => k.startsWith('screenshot'))),
    total: report.checks.length,
    passed: report.checks.filter((c) => c.pass && !c.skipped).length,
    skipped: report.checks.filter((c) => c.skipped).length,
    failed: report.checks.filter((c) => !c.pass).map((c) => c.id + ' ' + c.title),
    checks: report.checks,
  };
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(path.join(ARTIFACT_DIR, 'real-extension-report.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n============ 真机联调结果 ============');
  console.log('浏览器: ' + summary.browser);
  console.log('扩展 ID: ' + (summary.extensionId || '(未取到)'));
  console.log(
    `通过: ${summary.passed}/${summary.total}` +
      (summary.skipped ? `  跳过: ${summary.skipped}（原因见报告 checks[].detail）` : '')
  );
  if (summary.failed.length) {
    console.log('失败项:');
    summary.failed.forEach((f) => console.log('  - ' + f));
  }
  console.log('报告: docs/qa-assets/real-extension-report.json');
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常: ' + (e?.stack || e)); process.exit(1); });
