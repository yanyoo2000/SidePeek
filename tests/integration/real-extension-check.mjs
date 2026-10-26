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
      const clicked = await clickSomeVideoLink();
      if (!clicked.ok) {
        report.fail(prefix + '-2', `${name}：无法稳定点击到视频链接`, clicked.reason || '');
        return;
      }

      // B-3：抽屉展开
      try {
        await waitFor(async () => {
          return await evaluate(
            page,
            `(() => {
              const host = document.getElementById('sidepeek-host');
              if (!host || !host.shadowRoot) return false;
              const d = host.shadowRoot.querySelector('.sp-drawer');
              if (!d) return false;
              const r = d.getBoundingClientRect();
              return r.width > 200 && r.left < window.innerWidth - 10;
            })()`
          );
        }, { timeout: 15000, label: prefix + ' 抽屉展开' });
        report.ok(prefix + '-2', `${name}：点击后抽屉从右侧展开`);
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

      // B-8：Esc 关闭（焦点需在顶层文档）
      try {
        await page.send('Runtime.evaluate', { expression: 'document.body.focus(); void 0' });
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await waitFor(async () => {
          return await evaluate(page, `(() => {
            const host = document.getElementById('sidepeek-host');
            if (!host || !host.shadowRoot) return true;
            const d = host.shadowRoot.querySelector('.sp-drawer');
            if (!d) return true;
            return d.getBoundingClientRect().left >= window.innerWidth - 20;
          })()`);
        }, { timeout: 8000, label: prefix + ' Esc 关闭' });
        report.ok(prefix + '-8', `${name}：Esc 可关闭抽屉`);
      } catch (e) {
        report.fail(prefix + '-8', `${name}：Esc 未能关闭抽屉`, e.message);
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
    passed: report.checks.filter((c) => c.pass).length,
    failed: report.checks.filter((c) => !c.pass).map((c) => c.id + ' ' + c.title),
    checks: report.checks,
  };
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(path.join(ARTIFACT_DIR, 'real-extension-report.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n============ 真机联调结果 ============');
  console.log('浏览器: ' + summary.browser);
  console.log('扩展 ID: ' + (summary.extensionId || '(未取到)'));
  console.log(`通过: ${summary.passed}/${summary.total}`);
  if (summary.failed.length) {
    console.log('失败项:');
    summary.failed.forEach((f) => console.log('  - ' + f));
  }
  console.log('报告: docs/qa-assets/real-extension-report.json');
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常: ' + (e?.stack || e)); process.exit(1); });
