/**
 * SidePeek 真机联调（T7）
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本？
 *   initScript 注入式 E2E 只能验证「代码逻辑」，无法验证「扩展作为扩展是否装得上」。
 *   manifest 字段写错、content_scripts 路径不存在、图标缺失、CSP 冲突……
 *   这类问题只有真实 Chrome 用 --load-extension 加载后才暴露。
 *   G-01（CSS 无通道进 Shadow DOM）正是这类问题，注入式测试天然测不出来。
 *
 * 做法：
 *   1. 用独立 user-data-dir 启动真实 Chrome，--load-extension 指向仓库根目录
 *   2. 通过 CDP 断言扩展注入、样式生效、sandbox 属性正确、frame-buster 被挡住
 *   3. 截图留证
 *
 * 用法：
 *   node tests/integration/real-extension-check.mjs            # 自动 headless → headed 回退
 *   node tests/integration/real-extension-check.mjs --headed   # 直接可见窗口
 *   node tests/integration/real-extension-check.mjs --headless # 只跑 headless
 *
 * 退出码：0 全部通过；1 有断言失败；2 环境不可用（找不到 Chrome 等）
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'qa-assets');
const PORT = Number(process.env.SIDEPEEK_CDP_PORT || 9333);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（Node 24 自带 WHATWG WebSocket，无需 ws 依赖）
// ---------------------------------------------------------------------------
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error('CDP 连接超时: ' + wsUrl)), 15000);

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
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败: ' + wsUrl));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
  });
}

async function getJson(url, attempts = 120, interval = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(interval);
  }
  throw new Error('无法连接 DevTools HTTP 端点: ' + url);
}

async function evaluate(client, expression, { userGesture = true } = {}) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (r.exceptionDetails) {
    const desc =
      r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常';
    throw new Error('页面内执行异常: ' + desc);
  }
  return r.result.value;
}

/** 轮询直到 expression 返回真值，超时抛错 */
async function waitFor(client, expression, { timeout = 20000, interval = 300, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(client, expression);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时(${timeout}ms) ${label}: 最后一次结果 = ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
function createReport() {
  const checks = [];
  return {
    checks,
    ok(id, title, detail) {
      checks.push({ id, title, pass: true, detail });
      console.log(`  ✅ ${id} ${title}`);
      if (detail) console.log(`     ${detail}`);
    },
    fail(id, title, detail) {
      checks.push({ id, title, pass: false, detail });
      console.log(`  ❌ ${id} ${title}`);
      if (detail) console.log(`     ${detail}`);
    },
    get passed() {
      return checks.length > 0 && checks.every((c) => c.pass);
    },
  };
}

// ---------------------------------------------------------------------------
// 单轮：启动浏览器 → 断言 → 关闭
// ---------------------------------------------------------------------------
async function runRound({ browserPath, headless }) {
  const report = createReport();
  const profileDir = path.join(
    tmpdir(),
    'sidepeek-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  );
  mkdirSync(profileDir, { recursive: true });

  const args = [
    '--load-extension=' + REPO_ROOT,
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,900',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');

  console.log(`\n启动浏览器（${headless ? 'headless=new' : 'headed'}）：${browserPath}`);
  const proc = spawn(browserPath, args, { stdio: 'ignore', detached: false });

  let client = null;
  const browserInfo = { headless };

  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    browserInfo.browser = version['Browser'];

    // --- 找一个 page target ---
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('找不到 page target');

    client = await connectCdp(pageTarget.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // ---------------------------------------------------------------
    // 断言 A：扩展 Service Worker 已注册（说明 manifest 解析成功）
    // ---------------------------------------------------------------
    let swFound = null;
    for (let i = 0; i < 20 && !swFound; i++) {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      swFound = list.find(
        (t) =>
          (t.type === 'service_worker' || t.type === 'background_page') &&
          /^chrome-extension:\/\/[a-p]{32}\//.test(t.url || '')
      );
      if (!swFound) await sleep(500);
    }
    if (swFound) {
      browserInfo.extensionId = (swFound.url.match(/^chrome-extension:\/\/([a-p]{32})\//) || [])[1];
      report.ok('A', '扩展已加载且 background service worker 已注册', swFound.url);
    } else {
      report.fail(
        'A',
        '扩展未能加载（manifest 解析失败或 background 注册失败）',
        '未在 /json/list 中发现 chrome-extension:// 的 service_worker target'
      );
    }

    // ---------------------------------------------------------------
    // 场景 1：www.bilibili.com 首页（同源场景）
    // ---------------------------------------------------------------
    async function testScenario({ name, url, checkIdPrefix }) {
      console.log(`\n[场景] ${name} — ${url}`);
      await client.send('Page.navigate', { url });
      await sleep(1500);

      // content script 注入
      let injected = false;
      try {
        await waitFor(client, 'typeof window.__SIDEPEEK_LOADED__ !== "undefined"', {
          timeout: 25000,
          label: checkIdPrefix + ' content script 注入',
        });
        injected = true;
      } catch (e) {
        report.fail(checkIdPrefix + '-1', `${name}：content script 未注入`, e.message);
      }
      if (!injected) return false;
      report.ok(checkIdPrefix + '-1', `${name}：content script 已注入`, '__SIDEPEEK_LOADED__ 已定义');

      const before = await evaluate(client, 'location.href');
      const linkInfo = await evaluate(
        client,
        /* js */ `(() => {
          const a = document.querySelector('a[href*="/video/BV"]');
          if (!a) return { found: false };
          a.scrollIntoView({ block: 'center' });
          return { found: true, href: a.href, text: (a.textContent || '').trim().slice(0, 60) };
        })()`
      );
      if (!linkInfo || !linkInfo.found) {
        report.fail(checkIdPrefix + '-2', `${name}：页面内找不到视频链接`, '跳过后续点击断言');
        return false;
      }

      // 真实点击（走 Input.dispatchMouseEvent，比 element.click() 更接近真人）
      const rect = await evaluate(
        client,
        `(() => {
          const a = document.querySelector('a[href*="/video/BV"]');
          const r = a.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        })()`
      );
      await sleep(300);
      if (rect.w > 0 && rect.h > 0) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: rect.x,
          y: rect.y,
          button: 'none',
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: rect.x,
          y: rect.y,
          button: 'left',
          clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: rect.x,
          y: rect.y,
          button: 'left',
          clickCount: 1,
        });
      }

      // 抽屉应当展开
      let opened = false;
      try {
        await waitFor(
          client,
          `(() => {
            const host = document.getElementById('sidepeek-host');
            if (!host || !host.shadowRoot) return false;
            const d = host.shadowRoot.querySelector('.sp-drawer');
            if (!d) return false;
            const r = d.getBoundingClientRect();
            return r.width > 200 && r.left < window.innerWidth - 10;
          })()`,
          { timeout: 15000, label: checkIdPrefix + ' 抽屉展开' }
        );
        opened = true;
      } catch (e) {
        report.fail(checkIdPrefix + '-2', `${name}：点击后抽屉未展开`, e.message);
      }
      if (!opened) return false;
      report.ok(checkIdPrefix + '-2', `${name}：点击视频链接后抽屉从右侧展开`);

      // 关键：顶层 URL 不能被 frame-buster 顶走
      await sleep(4000);
      const after = await evaluate(client, 'location.href');
      if (after === before) {
        report.ok(checkIdPrefix + '-3', `${name}：顶层 URL 未被劫持（frame-buster 已被 sandbox 挡住）`, after);
      } else {
        report.fail(
          checkIdPrefix + '-3',
          `${name}：顶层 URL 被改写，frame-buster 未被挡住`,
          `before=${before} after=${after}`
        );
      }

      // 样式是否真的生效（容器必须有非默认样式）
      const styleInfo = await evaluate(
        client,
        `(() => {
          const host = document.getElementById('sidepeek-host');
          const d = host.shadowRoot.querySelector('.sp-drawer');
          const cs = getComputedStyle(d);
          const frame = host.shadowRoot.querySelector('iframe');
          return {
            position: cs.position,
            zIndex: cs.zIndex,
            boxShadow: cs.boxShadow,
            transition: cs.transition,
            sandbox: frame ? frame.getAttribute('sandbox') : null,
            frameSrc: frame ? frame.src : null,
            frameRect: frame ? frame.getBoundingClientRect().toJSON() : null
          };
        })()`
      );
      const styleOk =
        styleInfo &&
        styleInfo.position === 'fixed' &&
        styleInfo.sandbox &&
        styleInfo.frameSrc &&
        styleInfo.frameSrc.includes('/video/');
      if (styleOk) {
        report.ok(
          checkIdPrefix + '-4',
          `${name}：Shadow DOM 样式生效且 iframe 已加载视频页`,
          `position=${styleInfo.position} zIndex=${styleInfo.zIndex} src=${styleInfo.frameSrc.slice(0, 70)}`
        );
      } else {
        report.fail(
          checkIdPrefix + '-4',
          `${name}：样式或 iframe 异常（CSS 可能未进 Shadow DOM）`,
          JSON.stringify(styleInfo)
        );
      }

      // sandbox 必须恰好缺 allow-top-navigation
      const sb = styleInfo?.sandbox || '';
      const tokens = sb.split(/\s+/).filter(Boolean);
      const banned = tokens.filter((t) => t.startsWith('allow-top-navigation'));
      const needed = ['allow-scripts', 'allow-same-origin'];
      const missing = needed.filter((t) => !tokens.includes(t));
      if (banned.length === 0 && missing.length === 0) {
        report.ok(checkIdPrefix + '-5', `${name}：iframe sandbox 组合正确`, sb);
      } else {
        report.fail(
          checkIdPrefix + '-5',
          `${name}：iframe sandbox 组合错误`,
          `多出=${JSON.stringify(banned)} 缺少=${JSON.stringify(missing)} 实际="${sb}"`
        );
      }

      return true;
    }

    await testScenario({
      name: '同源场景（首页）',
      url: 'https://www.bilibili.com/',
      checkIdPrefix: 'B',
    });

    // 截图留证
    try {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(
        ARTIFACT_DIR,
        `real-extension-${headless ? 'headless' : 'headed'}.png`
      );
      mkdirSync(ARTIFACT_DIR, { recursive: true });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      browserInfo.screenshot = file;
    } catch (e) {
      console.log('  ⚠️ 截图失败: ' + e.message);
    }

    // 关闭浏览器
    try {
      const versionClient = await connectCdp(version.webSocketDebuggerUrl);
      await versionClient.send('Browser.close');
      versionClient.close();
    } catch {
      /* ignore */
    }
    return { report, browserInfo };
  } finally {
    try {
      client?.close();
    } catch {
      /* ignore */
    }
    await sleep(500);
    try {
      if (!proc.killed) proc.kill();
    } catch {
      /* ignore */
    }
    // 清理临时 profile（Chrome 可能仍占用，失败忽略）
    await sleep(800);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const arg = process.argv[2] || '';
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('❌ 找不到 Chrome/Edge 可执行文件，可通过 CHROME_PATH 环境变量指定');
    process.exit(2);
  }
  console.log('浏览器: ' + browserPath);
  console.log('扩展目录: ' + REPO_ROOT);

  if (!existsSync(path.join(REPO_ROOT, 'manifest.json'))) {
    console.error('❌ 仓库根目录没有 manifest.json，无法作为扩展加载');
    process.exit(2);
  }

  const modes =
    arg === '--headed' ? [false] : arg === '--headless' ? [true] : [true, false];

  let lastResult = null;
  for (const headless of modes) {
    try {
      lastResult = await runRound({ browserPath, headless });
      if (lastResult.report.passed) break;
      console.log('\n⚠️ 本轮有失败项，' + (modes.length > 1 ? '尝试下一种模式…' : '结束'));
    } catch (e) {
      console.error(`\n❌ ${headless ? 'headless' : 'headed'} 模式执行异常: ${e.message}`);
      lastResult = null;
    }
    // 端口未释放时等一会儿
    await sleep(1500);
  }

  if (!lastResult) {
    console.error('\n❌ 两种模式都未能完成验证');
    process.exit(1);
  }

  const { report, browserInfo } = lastResult;
  const summary = {
    browser: browserInfo.browser,
    extensionId: browserInfo.extensionId || null,
    headless: browserInfo.headless,
    screenshot: browserInfo.screenshot || null,
    total: report.checks.length,
    passed: report.checks.filter((c) => c.pass).length,
    failed: report.checks.filter((c) => !c.pass).map((c) => c.id + ' ' + c.title),
    checks: report.checks,
  };

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    path.join(ARTIFACT_DIR, 'real-extension-report.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  console.log('\n================ 真机联调结果 ================');
  console.log(`浏览器: ${summary.browser}`);
  console.log(`扩展 ID: ${summary.extensionId || '(未取到)'}`);
  console.log(`通过: ${summary.passed}/${summary.total}`);
  if (summary.failed.length) {
    console.log('失败项:');
    summary.failed.forEach((f) => console.log('  - ' + f));
  }
  console.log('报告: docs/qa-assets/real-extension-report.json');
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常: ' + (e?.stack || e));
  process.exit(1);
});
