/**
 * src/background.js 单元测试（node --test，零依赖）
 *
 * A. 纯函数：标题清洗 / HTML 实体解码 / <title> 提取 / URL 白名单。
 * B. 消息入口：用假 chrome.runtime + 假 fetch 验证 PEEK_TITLE 的完整链路
 *    （含 MV3 异步响应必须 return true、失败一律降级为 null 不得抛错）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.join(__dirname, '..', '..', 'src', 'background.js');
const BACKGROUND_CODE = fs.readFileSync(BACKGROUND_PATH, 'utf8');

// vm 沙箱里 new 出来的对象原型属于另一个 realm，deepStrictEqual 会因原型不同判负；
// 比较前统一 JSON 归一化。
const normalize = (value) => JSON.parse(JSON.stringify(value));

function createQuietConsole() {
  return { warn() {}, log() {}, error: console.error };
}

/* ================================================================== *
 * A. 纯函数
 * ================================================================== */

function loadPureApi() {
  const sandbox = {
    console: createQuietConsole(),
    URL,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_CODE, sandbox, { filename: 'src/background.js' });
  assert.ok(sandbox.__SIDEPEEK_TEST_BG__, 'background.js 应导出 globalThis.__SIDEPEEK_TEST_BG__');
  return sandbox.__SIDEPEEK_TEST_BG__;
}

const api = loadPureApi();

test('cleanBilibiliTitle: 去掉 B 站各种标题尾巴', () => {
  const cases = [
    // 视频页最常见的 `标题_哔哩哔哩_bilibili`
    ['【原创】某个视频_哔哩哔哩_bilibili', '【原创】某个视频'],
    // `标题 - 哔哩哔哩`
    ['某个视频 - 哔哩哔哩', '某个视频'],
    // `标题_哔哩哔哩`
    ['某个视频_哔哩哔哩', '某个视频'],
    // `标题_bilibili`
    ['某个视频_bilibili', '某个视频'],
    // 番剧/合集：中间还夹着分类名
    ['某个番剧 第一话_番剧_bilibili', '某个番剧 第一话_番剧'],
    // 老版站点尾巴
    ['某个视频 - 哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '某个视频'],
    // 尾巴前后有空白
    ['  某个视频  _哔哩哔哩_bilibili  ', '某个视频']
  ];
  for (const [input, expected] of cases) {
    assert.equal(api.cleanBilibiliTitle(input), expected, `输入：${input}`);
  }
});

test('cleanBilibiliTitle: 站名本身不算标题（首页/栏目页）→ null', () => {
  assert.equal(api.cleanBilibiliTitle('哔哩哔哩 (゜-゜)つロ 干杯~-bilibili'), null);
  assert.equal(api.cleanBilibiliTitle('哔哩哔哩_bilibili'), null);
});

test('cleanBilibiliTitle: 「_哔哩哔哩bilibili」中段下划线缺失变体（T7 真机回归）', () => {
  // 本次缺陷：真实标题中间没有第二个下划线，旧规则漏清洗（真机截图里用户可见）
  assert.equal(
    api.cleanBilibiliTitle('【绝区零】先导演示 | 挽昼_哔哩哔哩bilibili'),
    '【绝区零】先导演示 | 挽昼'
  );
  // 原有形态防回归
  assert.equal(
    api.cleanBilibiliTitle('【官方 MV】Never Gonna Give You Up - Rick Astley_哔哩哔哩_bilibili'),
    '【官方 MV】Never Gonna Give You Up - Rick Astley'
  );
  // 反例：后缀不在结尾 → 不得清洗
  assert.equal(
    api.cleanBilibiliTitle('聊聊哔哩哔哩bilibili的推荐算法'),
    '聊聊哔哩哔哩bilibili的推荐算法'
  );
  // 反例：整条标题就是后缀，清洗后为空 → null（上层走临时标题兜底）
  assert.equal(api.cleanBilibiliTitle('哔哩哔哩bilibili'), null);
  assert.equal(api.cleanBilibiliTitle('_哔哩哔哩bilibili'), null);
});

test('cleanBilibiliTitle: 普通标题原样保留 / 非法输入 → null', () => {
  assert.equal(api.cleanBilibiliTitle('某个视频'), '某个视频');
  assert.equal(api.cleanBilibiliTitle('AT&T 的视频'), 'AT&T 的视频');
  assert.equal(api.cleanBilibiliTitle(''), null);
  assert.equal(api.cleanBilibiliTitle('   '), null);
  assert.equal(api.cleanBilibiliTitle(null), null);
  assert.equal(api.cleanBilibiliTitle(undefined), null);
  assert.equal(api.cleanBilibiliTitle(123), null);
});

test('cleanBilibiliTitle: 折叠换行与多空格', () => {
  assert.equal(api.cleanBilibiliTitle('某个\n  视频_哔哩哔哩_bilibili'), '某个 视频');
});

test('decodeHtmlEntities: 命名实体 / 十进制 / 十六进制 / 未知实体保留', () => {
  assert.equal(api.decodeHtmlEntities('A &amp; B'), 'A & B');
  assert.equal(api.decodeHtmlEntities('&lt;标签&gt; &quot;引号&quot; &apos;单引号&apos;'), '<标签> "引号" \'单引号\'');
  assert.equal(api.decodeHtmlEntities('&#20320;&#22909;'), '你好');
  assert.equal(api.decodeHtmlEntities('&#x4F60;&#x597D;'), '你好');
  assert.equal(api.decodeHtmlEntities('&mdash;&hellip;&nbsp;'), '\u2014\u2026\u00a0');
  // 没有分号的不解，避免误伤 "AT&T"
  assert.equal(api.decodeHtmlEntities('AT&T'), 'AT&T');
  // 未知实体原样保留
  assert.equal(api.decodeHtmlEntities('&notarealentity;'), '&notarealentity;');
  // 非法码点原样保留、不抛错
  assert.equal(api.decodeHtmlEntities('&#xFFFFFFF;'), '&#xFFFFFFF;');
  assert.equal(api.decodeHtmlEntities('没有实体'), '没有实体');
  assert.equal(api.decodeHtmlEntities(null), null);
});

test('extractTitleFromHtml: 取第一个 <title>，清洗 + 解码实体', () => {
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<title data-x="1">【测试】A &amp; B 视频_哔哩哔哩_bilibili</title>' +
    '</head><body><title>不该取这个</title></body></html>';
  assert.equal(api.extractTitleFromHtml(html), '【测试】A & B 视频');
});

test('extractTitleFromHtml: 无 title / 空输入 / 非字符串 → null', () => {
  assert.equal(api.extractTitleFromHtml('<html><head></head><body></body></html>'), null);
  assert.equal(api.extractTitleFromHtml('<title></title>'), null);
  assert.equal(api.extractTitleFromHtml(''), null);
  assert.equal(api.extractTitleFromHtml(null), null);
  assert.equal(api.extractTitleFromHtml(undefined), null);
});

test('isAllowedTitleUrl: 只放行 B 站视频页', () => {
  const allowed = [
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.999',
    'https://www.bilibili.com/video/av170001?p=2',
    'https://www.bilibili.com/bangumi/play/ep123456',
    'https://m.bilibili.com/video/BV1xx411c7mD',
    'http://www.bilibili.com/video/BV1xx411c7mD'
  ];
  for (const url of allowed) {
    assert.equal(api.isAllowedTitleUrl(url), true, `应放行：${url}`);
  }

  const rejected = [
    'https://www.bilibili.com/',
    'https://space.bilibili.com/123',
    'https://www.bilibili.com/read/cv123',
    'https://evilbilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com.evil.com/video/BV1xx411c7mD',
    'https://example.com/video/BV1xx411c7mD',
    'file:///C:/secret.html',
    'javascript:alert(1)',
    '',
    null
  ];
  for (const url of rejected) {
    assert.equal(api.isAllowedTitleUrl(url), false, `应拒绝：${String(url)}`);
  }
});

/* ================================================================== *
 * B. 消息入口链路（假 chrome.runtime + 假 fetch）
 * ================================================================== */

function bootBackground(options = {}) {
  const state = { listener: null, fetchCalls: [] };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          state.listener = fn;
        }
      }
    }
  };

  const sandbox = {
    console: createQuietConsole(),
    URL,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    chrome,
    fetch: async (url, init) => {
      state.fetchCalls.push({ url, init });
      if (typeof options.fetchImpl === 'function') return options.fetchImpl(url, init);
      return {
        ok: true,
        text: async () => '<html><head><title>某个视频_哔哩哔哩_bilibili</title></head></html>'
      };
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_CODE, sandbox, { filename: 'src/background.js' });
  return { sandbox, state, chrome };
}

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIDEO_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';

test('PEEK_TITLE: 抓取并回传清洗后的标题，且异步响应返回 true', async () => {
  const booted = bootBackground();
  assert.equal(typeof booted.state.listener, 'function', '应注册 runtime.onMessage 监听');

  let response;
  const returned = booted.state.listener(
    { type: 'PEEK_TITLE', url: VIDEO_URL },
    { tab: { id: 1 } },
    (payload) => {
      response = payload;
    }
  );

  assert.equal(returned, true, 'MV3 异步响应必须 return true');
  await wait();

  assert.deepEqual(normalize(response), { title: '某个视频' });
  assert.equal(booted.state.fetchCalls.length, 1);
  assert.equal(booted.state.fetchCalls[0].url, VIDEO_URL);
  assert.equal(booted.state.fetchCalls[0].init.credentials, 'include');
});

test('PEEK_TITLE: 非白名单 URL 不发请求，直接返回 null 标题', async () => {
  const booted = bootBackground();
  let response;
  booted.state.listener({ type: 'PEEK_TITLE', url: 'https://example.com/' }, {}, (payload) => {
    response = payload;
  });
  await wait();
  assert.deepEqual(normalize(response), { title: null });
  assert.equal(booted.state.fetchCalls.length, 0);
});

test('PEEK_TITLE: fetch 抛错 / 非 2xx / 无 title 一律降级为 null，不抛错', async () => {
  const scenarios = [
    async () => {
      throw new Error('network down');
    },
    async () => ({ ok: false, text: async () => '' }),
    async () => ({ ok: true, text: async () => '<html><head></head><body>没有标题</body></html>' }),
    async () => ({ ok: true, text: async () => '<title>哔哩哔哩_bilibili</title>' })
  ];

  for (const fetchImpl of scenarios) {
    const booted = bootBackground({ fetchImpl });
    let response;
    booted.state.listener({ type: 'PEEK_TITLE', url: VIDEO_URL }, {}, (payload) => {
      response = payload;
    });
    await wait();
    assert.deepEqual(normalize(response), { title: null });
  }
});

test('非 PEEK_TITLE 消息一律忽略（不调用 fetch）', async () => {
  const booted = bootBackground();
  let called = false;
  const returned = booted.state.listener({ type: 'OTHER' }, {}, () => {
    called = true;
  });
  assert.equal(returned, undefined);
  await wait(5);
  assert.equal(called, false);
  assert.equal(booted.state.fetchCalls.length, 0);
});

test('background.js 在 node 环境（无 chrome）加载不抛错', () => {
  const sandbox = { console: createQuietConsole(), URL, TextDecoder, AbortController };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(BACKGROUND_CODE, sandbox, { filename: 'src/background.js' }));
  assert.ok(sandbox.__SIDEPEEK_TEST_BG__);
});
