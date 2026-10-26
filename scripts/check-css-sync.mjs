#!/usr/bin/env node
/**
 * SidePeek · CSS 防漂移校验
 * ---------------------------------------------------------------------------
 * 背景（SPEC.md §7 G-01 裁决）：
 *   content script 无法同步读取 .css 文件，所以 `peek-drawer.js` 里内嵌了一份
 *   `CSS_TEXT` 字符串注入 Shadow DOM。`src/core/peek-drawer.css` 是同一份内容的
 *   人类可读副本。两份文本一旦漂移，就会出现"改了 CSS 页面却没变"（或反过来）的
 *   幽灵 bug，而单测/E2E 都很难发现。本脚本就是那道闸门。
 *
 * 用法：
 *   node scripts/check-css-sync.mjs
 *
 * 退出码：
 *   0 —— 一致（打印 `CSS in sync (N bytes)`）
 *   1 —— 不一致或读取/解析失败（打印首个差异位置与上下文）
 *
 * 比对规则：统一 CRLF → LF、去掉 BOM、去掉首尾空行后**逐字**比较（不做其他宽松处理，
 * 空白差异也算漂移，因为它同样会改变渲染行为）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILE = path.join(ROOT, 'src', 'core', 'peek-drawer.css');
const JS_FILE = path.join(ROOT, 'src', 'core', 'peek-drawer.js');

/** 统一换行、去 BOM、去首尾空行；其余字符保持原样。 */
function normalize(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\n+/, '')
    .replace(/\s+$/, '');
}

/** 从 peek-drawer.js 里抠出 `var CSS_TEXT = `...`;` 的模板字符串内容。 */
function extractEmbeddedCss(jsSource) {
  const startMarker = 'var CSS_TEXT = `';
  const start = jsSource.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`在 ${path.relative(ROOT, JS_FILE)} 里找不到 "var CSS_TEXT = \`" 定义`);
  }

  const bodyStart = start + startMarker.length;
  const end = jsSource.indexOf('`;', bodyStart);
  if (end === -1) {
    throw new Error(`在 ${path.relative(ROOT, JS_FILE)} 里 CSS_TEXT 的模板字符串没有闭合（找不到 \`;）`);
  }

  return jsSource.slice(bodyStart, end);
}

function describeSnippet(text, index) {
  const from = Math.max(0, index - 60);
  const to = Math.min(text.length, index + 60);
  return JSON.stringify(text.slice(from, to));
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function reportDiff(expected, actual) {
  const max = Math.min(expected.length, actual.length);
  let index = -1;
  for (let i = 0; i < max; i += 1) {
    if (expected[i] !== actual[i]) {
      index = i;
      break;
    }
  }
  if (index === -1) index = max; // 一方是另一方的前缀

  console.error('CSS 不一致：peek-drawer.css 与 peek-drawer.js 里的 CSS_TEXT 已经漂移。');
  console.error(`  首个差异：字符偏移 ${index}（peek-drawer.css 约第 ${lineOf(expected, index)} 行）`);
  console.error(`  peek-drawer.css  此处：...${describeSnippet(expected, index)}...`);
  console.error(`  CSS_TEXT (JS)    此处：...${describeSnippet(actual, index)}...`);
  console.error(`  归一化后长度：css=${expected.length} / js=${actual.length}`);
  console.error('  修复：把两边改一致（以 CSS 文件为准，复制其内容进 CSS_TEXT）。');
}

function main() {
  let cssSource;
  let jsSource;

  try {
    cssSource = readFileSync(CSS_FILE, 'utf8');
  } catch (error) {
    console.error(`读取失败：${CSS_FILE}\n  ${error.message}`);
    return 1;
  }

  try {
    jsSource = readFileSync(JS_FILE, 'utf8');
  } catch (error) {
    console.error(`读取失败：${JS_FILE}\n  ${error.message}`);
    return 1;
  }

  let embedded;
  try {
    embedded = extractEmbeddedCss(jsSource);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const fromCss = normalize(cssSource);
  const fromJs = normalize(embedded);

  if (fromCss !== fromJs) {
    reportDiff(fromCss, fromJs);
    return 1;
  }

  console.log(`CSS in sync (${Buffer.byteLength(fromCss, 'utf8')} bytes)`);
  return 0;
}

// 用 exitCode 而不是 process.exit()：避免 Windows 上管道输出被截断
process.exitCode = main();
