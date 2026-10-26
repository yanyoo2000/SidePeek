#!/usr/bin/env node
/**
 * SidePeek E2E 注入包生成器
 * ---------------------------------------------------------------------------
 * 为什么需要「拼一个大字符串」：
 *   Chrome DevTools MCP / CDP 只能驱动「已经在跑的浏览器」，无法把未打包的 MV3 扩展
 *   --load-extension 装进去（这就是 SPEC §7 里 T7 真机联调必须单独做一遍的原因）。
 *   因此 UI/交互类验收改用等价方案：把扩展里真正会跑的三块代码按 content_scripts
 *   的顺序注入页面，再访问真实 B 站页面点击验证。
 *
 *   Manifest 里 content_scripts 的 js 顺序是：
 *       src/core/peek-drawer.js  →  src/content.js
 *   本脚本在这两块前面加 chrome.* shim（扩展 API 由浏览器提供，页面里没有，必须伪造），
 *   后面追加测试探针（只读状态 + 合成用户操作），顺序与原扩展保持一致。
 *
 * 产物：一个纯 IIFE 脚本，可直接作为
 *   - navigate_page 的 initScript（在页面脚本前执行，最接近真实 content script 时序）
 *   - evaluate_script / playwright addInitScript 的注入源
 * 使用方式见 tests/e2e/README.md。
 *
 * 用法：
 *   node tests/e2e/build-initscript.mjs                 # 生成到 tests/e2e/dist/sidepeek-e2e-bundle.js
 *   node tests/e2e/build-initscript.mjs --print-sizes   # 只打印各段大小，不落盘
 *   node tests/e2e/build-initscript.mjs --out <path>    # 自定义输出路径
 *   node tests/e2e/build-initscript.mjs --stdout        # 输出到 stdout（供管道使用）
 *
 * 退出码：0 成功；1 源文件缺失/校验失败。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** content_scripts 的真实加载顺序 + 测试侧补充。 */
export const BUNDLE_PARTS = [
  {
    id: 'chrome-shim',
    file: 'tests/e2e/chrome-shim.js',
    note: '伪造 chrome.runtime / chrome.storage（真实扩展由浏览器提供）',
    required: true
  },
  {
    id: 'peek-drawer',
    file: 'src/core/peek-drawer.js',
    note: 'dev-core 核心：抽屉 DOM / 动效 / history 状态机',
    required: true
  },
  {
    id: 'content',
    file: 'src/content.js',
    note: '适配层：链接拦截 / 标题 / 宽度持久化',
    required: true
  },
  {
    id: 'page-helpers',
    file: 'tests/e2e/page-helpers.js',
    note: '测试探针：读抽屉状态、合成点击/拖拽（不含任何产品逻辑）',
    required: true
  }
];

export const DEFAULT_OUT = path.join(__dirname, 'dist', 'sidepeek-e2e-bundle.js');

const BANNER = `/* ==========================================================================
 * SidePeek E2E 注入包（自动生成，请勿手改）
 * 生成命令：node tests/e2e/build-initscript.mjs
 * 组成：chrome-shim → peek-drawer → content → page-helpers
 * 用途：MCP/CDP 无法加载未打包扩展时，等价地把 content script 注入真实 B 站页面
 * ========================================================================== */
`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 读取并校验各段源码。任一必需文件缺失直接抛错，避免生成「半边」注入包。 */
export function readParts() {
  const parts = [];
  for (const part of BUNDLE_PARTS) {
    const absolute = path.join(REPO_ROOT, part.file);
    if (!existsSync(absolute)) {
      if (part.required) throw new Error(`缺少源文件：${part.file}`);
      continue;
    }
    const code = readFileSync(absolute, 'utf8');
    if (!code.trim()) throw new Error(`源文件为空：${part.file}`);
    parts.push({ ...part, absolute, code, bytes: Buffer.byteLength(code, 'utf8'), sha256: sha256(code) });
  }
  return parts;
}

/** 关键契约自检：拼错顺序/误删文件时在这里就失败，而不是等浏览器里出现莫名白屏。 */
function validate(parts) {
  const byId = Object.fromEntries(parts.map((p) => [p.id, p]));
  const errors = [];

  if (!/window\.SidePeekDrawer\s*=/.test(byId['peek-drawer'].code)) {
    errors.push('peek-drawer.js 没有把构造函数挂到 window.SidePeekDrawer');
  }
  if (!/__SIDEPEEK_LOADED__/.test(byId.content.code)) {
    errors.push('content.js 缺少 __SIDEPEEK_LOADED__ 幂等标记（注入路径可能已变）');
  }
  if (!/chrome\.runtime\.sendMessage/.test(byId['chrome-shim'].code)) {
    errors.push('chrome-shim.js 没有实现 chrome.runtime.sendMessage');
  }
  if (!/chrome\.storage\.local/.test(byId.content.code)) {
    errors.push('content.js 不再使用 chrome.storage.local（SPEC §7 G-07 要求 local）');
  }
  if (!/data-act/.test(byId['page-helpers'].code)) {
    errors.push('page-helpers.js 与抽屉的 data-act 结构不再匹配');
  }
  if (errors.length) throw new Error('注入包自检失败：\n  - ' + errors.join('\n  - '));
  return errors;
}

/** 生成可直接注入的完整脚本字符串。 */
export function buildInitScript() {
  const parts = readParts();
  validate(parts);

  const sections = parts.map(
    (p) =>
      `/* ── [${p.id}] ${p.file} (${p.bytes} B, sha256=${p.sha256.slice(0, 12)}…) ── */\n` +
      `;(function () {\n${p.code}\n})();\n`
  );

  return BANNER + sections.join('\n');
}

/** 生成一份元信息，README/QA 报告里可以引用，便于判断「跑的是哪一版源码」。 */
export function buildManifest(parts) {
  return {
    generator: 'tests/e2e/build-initscript.mjs',
    parts: parts.map((p) => ({ id: p.id, file: p.file, bytes: p.bytes, sha256: p.sha256 })),
    generatedAt: new Date().toISOString()
  };
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] || null;
  };

  if (flag('--help') || flag('-h')) {
    console.log(`SidePeek E2E 注入包生成器

  node tests/e2e/build-initscript.mjs                 → 生成 ${path.relative(REPO_ROOT, DEFAULT_OUT)}
  node tests/e2e/build-initscript.mjs --out <file>    → 指定输出文件
  node tests/e2e/build-initscript.mjs --stdout        → 输出到 stdout
  node tests/e2e/build-initscript.mjs --print-sizes   → 只打印各段大小（不落盘）
  node tests/e2e/build-initscript.mjs --help
`);
    return 0;
  }

  const parts = readParts();
  validate(parts);

  const bundle = buildInitScript();
  const manifest = buildManifest(parts);

  console.log('SidePeek E2E 注入包组成：');
  for (const part of parts) {
    console.log(`  ${part.id.padEnd(14)} ${part.file.padEnd(36)} ${String(part.bytes).padStart(7)} B  ${part.sha256.slice(0, 12)}…`);
    console.log(`  ${' '.repeat(14)} ${part.note}`);
  }
  console.log(`  合计 ${Buffer.byteLength(bundle, 'utf8')} B（含分隔注释）`);

  if (flag('--print-sizes')) return 0;

  if (flag('--stdout')) {
    process.stdout.write(bundle);
    return 0;
  }

  const out = valueOf('--out') ? path.resolve(process.cwd(), valueOf('--out')) : DEFAULT_OUT;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, bundle, 'utf8');
  const manifestOut = out.replace(/\.js$/, '') + '.manifest.json';
  writeFileSync(manifestOut, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`\n已写入：${out}`);
  console.log(`已写入：${manifestOut}`);
  console.log('\n下一步：把该文件作为 navigate_page 的 initScript 注入（或 evaluate_script 的 sourcePath）。');
  console.log('详见 tests/e2e/README.md');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv);
  } catch (err) {
    console.error('[build-initscript] ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}
