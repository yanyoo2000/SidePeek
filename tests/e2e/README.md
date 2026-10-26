# SidePeek E2E（浏览器内注入式验收）

这里放的是 **QA 侧**的验收工具，不属于扩展运行时。目标：在没有「已加载的未打包扩展」的环境里
（例如只能驱动已运行浏览器的 Chrome DevTools MCP），用**等价方式**在真实 B 站页面上验证
`peek-drawer.js` + `content.js` 的行为。

> 真机加载扩展的验证不在这里，见 `tests/integration/real-extension-check.mjs`（T7）。
> 两者互补：这里测**交互与动效**，T7 测**扩展是否装得上**（manifest / 路径 / 权限）。

## 为什么不能直接「注入三个文件」就完事

1. `content.js` 在 `typeof chrome === 'undefined'` 时会直接不初始化 → 必须伪造 `chrome.*`
   （`chrome-shim.js`）。
2. `content.js` 只执行一次（`window.__SIDEPEEK_LOADED__`），页面刷新/导航后要重新注入。
3. MCP 的 `take_screenshot(filePath)` / `evaluate_script(sourcePath)` 受宿主机文件沙箱限制
   （`not within any of the configured workspace roots`），因此：
   - 注入包用**本机 HTTP** 暴露（`serve-bundle.mjs`），页面里 `fetch` + `new Function(code)()`；
   - 截图用 Win32 抓窗口（`capture-window.ps1`），顺带把**地址栏**拍进去 ——
     地址栏就是「顶层 URL 未被 frame-buster 劫持」的直接证据。

## 文件

| 文件 | 作用 |
|---|---|
| `chrome-shim.js` | 伪造 `chrome.runtime.{id,lastError,sendMessage,onMessage,getURL}` 与 `chrome.storage.local/sync`；`PEEK_TITLE` 由页面内 `fetch` + 解析 `<title>` 模拟（对齐 `src/background.js` 的清洗规则） |
| `page-helpers.js` | 页面内探针 `window.__SP_E2E__`：`state()` 一次性读出抽屉状态（Shadow DOM 计算样式、mask、iframe sandbox、history、宽度），`clickVideoLink / clickAt / clickAction / clickMask / dragWidth / sampleTransform / hitTest` 用合成事件模拟用户操作 |
| `build-initscript.mjs` | 按 `content_scripts` 真实顺序拼注入包：`chrome-shim → peek-drawer → content → page-helpers`；自带契约自检（防止拼错顺序），输出 `dist/sidepeek-e2e-bundle.js` + `manifest.json`（逐文件 sha256） |
| `serve-bundle.mjs` | 只读 `dist/` 的 127.0.0.1 微型 HTTP 服务，带 CORS + `Access-Control-Allow-Private-Network`（https 页面访问 localhost 必需） |
| `capture-window.ps1` | 抓浏览器窗口 PNG（`PrintWindow`，失败自动回退「置前 + 屏幕抓取」），默认缩放到 1600 px 宽 |
| `dist/`（生成物，已在 `.gitignore`） | 注入包与 manifest |

## 三步跑起来

```powershell
# 1. 生成注入包（源码改动后必须重跑，否则测的是旧代码）
cd D:\yan-github-code\SidePeek
node tests/e2e/build-initscript.mjs
#   → tests/e2e/dist/sidepeek-e2e-bundle.js
#   → tests/e2e/dist/sidepeek-e2e-bundle.manifest.json（记下 sha256，写进验收报告基线）

# 2. 起包服务（后台跑着，别关）
node tests/e2e/serve-bundle.mjs --port 8899
#   READY 后可在浏览器里访问 http://127.0.0.1:8899/sidepeek-e2e-bundle.js

# 3. 截图（窗口标题子串匹配，Windows）
pwsh -NoProfile -File tests/e2e/capture-window.ps1 -Title '哔哩哔哩' -Out docs/qa-assets/01.png
```

## 在浏览器里注入

### 方式 A：MCP `evaluate_script`（推荐，最省事）

```js
// tool: evaluate_script, format: "function"
async () => {
  const res = await fetch('http://127.0.0.1:8899/sidepeek-e2e-bundle.js', { cache: 'no-store' });
  (new Function(await res.text()))();
  await new Promise(r => setTimeout(r, 500)); // 等 content.js 的 storage 回调建好 drawer
  return { extReady: !!window.__SIDEPEEK_EXT__, state: window.__SP_E2E__.state() };
}
```

### 方式 B：`navigate_page` 的 `initScript`

在页面脚本执行前注入（时序更接近真实 content script），但需要把 100 KB 级脚本内联进工具参数：

```js
// 从 dist 读出字符串后整个塞进 initScript 参数（不推荐手写）
```

### 注入成功的判据

```js
window.__SIDEPEEK_CHROME_SHIM__ === true   // shim 装上了
window.SidePeekDrawer                       // core 加载成功（typeof === 'function'）
window.__SIDEPEEK_EXT__.getDrawer()         // content.js 初始化完成（drawer 已构造）
window.__SIDEPEEK_EXT__.isPeekableUrl(url)  // 白名单判定
window.__SP_E2E__.state()                   // 全量状态探针
```

`__SIDEPEEK_EXT__` 是 `content.js` 里自带的**只读调试探针**（不属于契约），E2E 靠它拿实例。

## 探针 API（`window.__SP_E2E__`）

| API | 返回 | 典型断言 |
|---|---|---|
| `state()` | 抽屉全量快照：`logicalOpen` / `drawerOpenClass` / `drawerRect` / `drawerTransform` / `maskPointerEvents` / `maskOpacity` / `hostPointerEvents` / `frame:{src,sandbox,allow}` / `title` / `loadingVisible` / `errorVisible` / `location:{href,hash,state,historyLength,scrollY}` | 打开、关闭、无残影、sandbox、hash 清理 |
| `hitTest(points?)` | 每个点 `elementFromPoint` 结果 + 是否落在宿主内 | 关闭态点击穿透（用例 9） |
| `findVideoLink(pattern?)` | 第一个匹配的视频 `<a>`（滚到视口中央） | 找可点卡片 |
| `clickAt(x,y,mods?)` | 合成 mousedown/mouseup/click，返回 `defaultPrevented` 与命中元素 | 修饰键不拦截（`{ctrlKey:true}`）、中键（`{button:1}`） |
| `clickVideoLink(pattern?)` | 找到并点击第一个卡片，返回点击前后 URL | 用例 1/2/3 |
| `clickAction('close'\|'copy'\|'open-tab')` | 点 Shadow DOM 里的头部按钮（MCP 的 uid 点不到 Shadow DOM） | 关闭路径 |
| `clickMask()` | 点遮罩 | 关闭路径 + 遮罩可点 |
| `dragWidth(toX, steps?)` | 拖左边缘改宽，返回每一步宽度、clamp 后宽度、`storedWidth`、cursor/userSelect 恢复情况 | 用例 8 / B-01 |
| `sampleTransform(ms, interval)` | 采样 `.sp-drawer` 的 class 与 computed transform | 用例 6（切换不重播动画：`translateX` 应恒为 0） |
| `q(sel)` / `rectOf(el)` | Shadow DOM 查询 / getBoundingClientRect 简写 | 定制断言 |

> 所有点击都是**合成事件**（`isTrusted=false`）：足以验证「我们的捕获处理器拦没拦、`preventDefault` 有没有生效、
> 抽屉状态对不对」，但**不会触发浏览器原生默认动作**（如中键自动滚动/新标签）。
> 需要原生行为的用例，请用真机 T7 或人工复核。

## 推荐验收顺序（与 docs/QA.md 的用例编号对应）

| 用例 | 关键断言 |
|---|---|
| C-01 跨源宿主（最优先） | 点卡片后 `location.href` 的 origin+pathname 不变、只多 `#sidepeek=`；`history.length` +1；iframe `sandbox` 不含 `allow-top-navigation*`；`loading=false / error=false` |
| C-02 首页同源 | 同上；注意 `target="_blank"` 卡片也要被拦（I-14） |
| C-03 视频页相关推荐 | 顶层仍是被看的视频页 URL |
| C-04 Ctrl/中键 | `defaultPrevented=false`、`isOpen()=false`、无 hash |
| C-05 三条关闭路径 | `hash=''`、`history.state=null`、`framePresent=false`（360 ms 后）、`mask opacity=0 / pointer-events=none` |
| C-06 切换视频 | `sampleTransform` 的 `translateX` 恒 0、`.sp-open` 始终在、`history.length` 不变 |
| C-07 后退/前进 | 后退：`isOpen=false` + `scrollY` 不变；前进：`www` 宿主 `isOpen=true` + 标题回填 |
| C-08 拖拽（B-01） | 拖拽中 iframe `pointerEvents=none`；松手后 `html.style.cursor=''`、`userSelect=''`、iframe `pointerEvents=''`；`sidepeek.width` 已写入 |
| C-09 关闭态穿透 | `hitTest` 全部 `insideHost=false`；`host/mask pointer-events=none` |
| C-10 窄视口 | `drawerWidth <= min(0.9*innerWidth, innerWidth-48)`；遮罩可点且能关 |
| C-11 暗色 | 头部/按钮 `getComputedStyle().color` 与 header 背景对比度（≥4.5:1） |
| C-13 inert/Tab | 关闭态按钮 `.focus()` 后 `shadowRoot.activeElement === null`；真按 Tab 焦点不进宿主 |
| C-14 F5 残留 | 刷新前 hash 有 `#sidepeek=`；重新注入后 `hash=''`、无 host、不自动重开 |
| C-17 P-04 | iframe 内翻 2 页后 `history.length` +2；关闭后多按一次后退无效果（已知限制） |

## 常见坑

- **执行上下文被销毁**：脚本里 `history.back()` 退到 `about:blank`（新标签页的第 0 条）就会销毁上下文。
  避免方式：先确认页面历史足够深，或把 `back/forward` 拆成单独一次调用，别和关键断言塞在同一脚本里。
- **后台标签页 CSS 过渡被节流**：抽屉动画可能"卡在半路"，导致 `maskOpacity`/`transform` 读数停留在中间值。
  断言应基于「采样 `transform` + class + 内联宽度」；必要时先 `select_page` 把页签置前再读。
- **B 站自己也玩 history**：搜索页在每次 `popstate` 里 `history.pushState(null,'',location.href)`，
  会剪掉前向条目（导致 `forward()` 无效），并让 `history.length` 缓慢增长。这是站方行为，
  对照实验：**不加载扩展**、手工 `pushState→back→forward` 同样无效。
- **`elementFromPoint` 对 Shadow DOM 会返回宿主元素**：判断"点到遮罩"要按"命中的是不是 `#sidepeek-host`"来判，
  不能直接比 `.sp-mask`。
- **窗口尺寸会被截图脚本影响**：早期版本用 `SW_RESTORE` 会把最大化的 Edge 窗口还原成小窗
  （改了视口大小，污染后续用例）。现在的脚本只 `SetForegroundWindow`，不改窗口尺寸；
  但**用例之间最好显式 `resize_page`**，别假设窗口大小。
- **同源 vs 跨源**：iframe 是否可读 `contentDocument` 取决于宿主；`www.bilibili.com` 内嵌
  `www.bilibili.com` 可读（可用它测 I-09 / P-04 的 frame 内导航），`search.bilibili.com` 内嵌则不可读。

## 复核「测的是哪一版」

`dist/sidepeek-e2e-bundle.manifest.json` 记录了参与注入的每个文件的 sha256：

```powershell
Get-Content tests/e2e/dist/sidepeek-e2e-bundle.manifest.json | ConvertFrom-Json | ForEach-Object { $_.parts }
# 与 docs/QA.md 顶部记录的基线 sha256 对齐，才能确认报告结论对应当前源码
```

**源码改动后必须重跑 `build-initscript.mjs`**，否则浏览器里跑的是旧代码 —— 这类"测了个寂寞"的坑在
评审返工期间特别容易踩到（本项目的 QA 就因此重跑过一轮）。
