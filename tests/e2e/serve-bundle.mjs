#!/usr/bin/env node
/**
 * SidePeek E2E —— 注入包微型 HTTP 服务
 * ---------------------------------------------------------------------------
 * 为什么需要它：
 *   MCP / CDP 的 evaluate_script(sourcePath) 受宿主机文件沙箱限制（只能读工作区根内的文件），
 *   而 navigate_page(initScript) 需要把整个注入包内联进工具参数（约 100 KB，不可复用、不可审阅）。
 *   把 build-initscript.mjs 的产物用本机 HTTP 暴露出来，页面里一次 fetch + 执行即可，
 *   既不占用工具参数，也让注入内容完全来自仓库源码（可复核 sha256）。
 *
 * 安全边界（只在验收机上用，不要长期跑）：
 *   - 只监听 127.0.0.1，不监听 0.0.0.0
 *   - 只读 tests/e2e/dist/ 下的文件，路径做归一化，禁止 ../ 穿越
 *   - 因为 B 站页面是 https，访问 http://127.0.0.1 会触发 Chrome 的 Private Network Access
 *     预检，所以必须回 Access-Control-Allow-Private-Network: true
 *
 * 用法：
 *   node tests/e2e/serve-bundle.mjs                 # 默认 127.0.0.1:8899
 *   node tests/e2e/serve-bundle.mjs --port 9000
 *   node tests/e2e/serve-bundle.mjs --port 8899 --quiet
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg !== -1 ? args[portArg + 1] : process.env.SIDEPEEK_E2E_PORT || 8899);
const HOST = '127.0.0.1';
const QUIET = args.includes('--quiet');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Chrome Private Network Access：公网页面请求 127.0.0.1 时必须允许
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
    ...(extra || {})
  };
}

function log(...args) {
  if (!QUIET) console.log('[serve-bundle]', ...args);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, corsHeaders());
    res.end('method not allowed');
    return;
  }

  // 路径归一化 + 目录穿越防护
  const requested = decodeURIComponent(url.pathname);
  const resolved = path.resolve(DIST_DIR, '.' + requested);
  if (!resolved.startsWith(DIST_DIR + path.sep) && resolved !== DIST_DIR) {
    res.writeHead(403, corsHeaders());
    res.end('forbidden');
    return;
  }

  let filePath = resolved;
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.txt');
  if (!existsSync(filePath)) {
    res.writeHead(404, corsHeaders());
    res.end('not found: ' + requested);
    return;
  }

  const body = readFileSync(filePath);
  res.writeHead(200, corsHeaders({
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': body.length
  }));
  if (req.method === 'HEAD') res.end();
  else res.end(body);

  log(`${req.method} ${requested} → ${res.statusCode} ${body.length} B`);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`bundle: http://${HOST}:${PORT}/sidepeek-e2e-bundle.js`);
  console.log('[serve-bundle] READY');
});

server.on('error', (err) => {
  console.error('[serve-bundle] 启动失败：', err.message);
  process.exitCode = 1;
});
