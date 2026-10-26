/**
 * manifest.json 静态校验（node --test）
 *
 * 扩展无法在 node 里真正加载，这里用静态断言守住 docs/SPEC.md 第 5 节的最小权限约束：
 * 任何一条挂掉都意味着评审会直接打回，所以放在单测里当护栏。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(ROOT, 'manifest.json');

const raw = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    assert.equal(buffer[i], signature[i], `${filePath} 不是合法 PNG`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('manifest: MV3 基础字段', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'SidePeek');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);
});

test('manifest: 权限最小化（只 storage + B 站 host_permissions）', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['*://*.bilibili.com/*']);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
});

test('manifest: 禁止 tabs / webRequest / declarativeNetRequest / <all_urls>', () => {
  const forbidden = ['tabs', 'webRequest', 'declarativeNetRequest', '<all_urls>', 'background.scripts'];
  for (const token of forbidden) {
    assert.equal(raw.includes(token), false, `manifest 不得出现 ${token}`);
  }
});

test('manifest: content_scripts 注入顺序 / 时机 / all_frames', () => {
  const scripts = manifest.content_scripts;
  assert.equal(Array.isArray(scripts), true);
  assert.equal(scripts.length, 1);

  const entry = scripts[0];
  assert.deepEqual(entry.matches, ['*://*.bilibili.com/*']);
  // 顺序写死：core 必须先于适配层，content.js 依赖 window.SidePeekDrawer
  assert.deepEqual(entry.js, ['src/core/peek-drawer.js', 'src/content.js']);
  assert.equal(entry.run_at, 'document_idle');
  assert.equal(entry.all_frames, false);
});

test('manifest: background 是 MV3 service worker', () => {
  assert.equal(typeof manifest.background, 'object');
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(manifest.background.type, undefined, 'background 用 classic worker，不需要 type:module');
});

test('manifest: 引用的文件真实存在（icons / content / background）', () => {
  for (const file of ['src/content.js', 'src/background.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} 不存在`);
  }

  const iconSizes = { 16: 16, 32: 32, 48: 48, 128: 128 };
  for (const [size, expected] of Object.entries(iconSizes)) {
    const iconPath = path.join(ROOT, manifest.icons[size]);
    assert.equal(fs.existsSync(iconPath), true, `icons/${size}.png 不存在`);
    const actual = readPngSize(iconPath);
    assert.deepEqual(actual, { width: expected, height: expected });
  }

  // action 的 default_icon 也应指向真实文件
  for (const iconPath of Object.values(manifest.action.default_icon)) {
    assert.equal(fs.existsSync(path.join(ROOT, iconPath)), true, `${iconPath} 不存在`);
  }
});

test('跨角色：manifest 引用的 core 脚本存在（依赖 dev-core 交付）', (t) => {
  const corePath = path.join(ROOT, 'src', 'core', 'peek-drawer.js');
  if (!fs.existsSync(corePath)) {
    t.skip('src/core/peek-drawer.js 尚未交付（dev-core 并行开发中），交付后此断言应通过');
    return;
  }
  assert.ok(fs.statSync(corePath).size > 0, 'src/core/peek-drawer.js 不应为空文件');
});

test('package.json: 只用 node --test 跑单测 + CSS 防漂移检查，不引入打包器/测试框架', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  // Node 24 的 --test 只接受文件/glob，不接受目录，所以脚本用 glob 形式
  assert.match(pkg.scripts.test, /^node --test .*tests\/unit/);
  assert.match(pkg.scripts['test:unit'], /^node --test .*tests\/unit/);
  // G-01 裁决：CSS 防漂移检查必须纳入 npm test（脚本由 dev-core 提供）
  assert.equal(pkg.scripts['test:css'], 'node scripts/check-css-sync.mjs');
  assert.match(pkg.scripts.test, /scripts\/check-css-sync\.mjs/);
  // T7 真机联调脚本入口（脚本由 Lead 提供，tests/integration/ 不归本任务改）
  assert.equal(pkg.scripts['test:real'], 'node tests/integration/real-extension-check.mjs');
  assert.equal(pkg.scripts['test:all'], 'npm test && npm run test:real');
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.dependencies, undefined);
});
