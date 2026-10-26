# SidePeek 技术前提（已实测验证）

> 本文档由 Lead 在真实 B 站页面上实测得出，是全体成员的技术基线。
> **不要凭直觉推翻这里的结论**；若要推翻，必须先给出可复现的实测反例。

## 参考实现：NGA 的右侧抽屉

NGA 论坛通过 `js_iframeRead.js` 实现了「点击帖子 → 右侧滑出内容 → 地址栏伪装成真实跳转」。
其结构只有三层，全部动态创建：

```
固定定位遮罩 div (z-index 6)      ← 半透明黑，折叠态盖住抽屉
固定定位抽屉 div (z-index 5)      ← position:fixed; right:0; width:展开宽
  └─ 单个 <iframe>               ← 反复复用，切换帖子只改 src
```

关键手法：

1. **捕获阶段劫持点击**：`document.body.addEventListener('click', fn, true)`，
   命中 `/read.php`、`/nuke.php` 链接就 `preventDefault + stopPropagation`，改由抽屉加载。
2. **动效只改宽度**：`transition: width 0.5s`，折叠宽 vs 展开宽两个数值。
3. **History 记账**：加载完成后
   `history.replaceState({from:'ifr', url, purl, til}, title, 主页面URL + '#ifr:/read.php?tid=xxx')`，
   监听 `popstate` 还原抽屉。**这是抽屉能表现成真跳转的原因**。
4. 展开动画走完（delay 550ms）才真正 `assign` URL，避免动画期间卡顿。
5. 在 iframe 内部，普通链接被改写为 `target="_parent"`，只有 `read.php` 链接保留（可继续在抽屉内翻页）。

## 本项目移植到 B 站的实测结论

Lead 已用 Chrome DevTools 在真实页面上逐条验证：

| # | 测试 | 结果 |
|---|---|---|
| 1 | 视频页响应头 `X-Frame-Options` | **无** |
| 2 | 视频页响应头 `Content-Security-Policy`（强制） | **无**（仅有 `-Report-Only`，不拦截） |
| 3 | 顶层 `www.bilibili.com` 页面内嵌 `www.bilibili.com/video/BVxxx` | ✅ 正常加载，10 秒内顶层 URL 未被改写 |
| 4 | 顶层 `search.bilibili.com` 页面内嵌 `www.bilibili.com/video/BVxxx` | ❌ **顶层被劫持**，整页跳到视频页 |
| 5 | 在 #4 基础上加 `referrerpolicy="no-referrer"` | ❌ 仍然被劫持（说明与 Referer 无关） |
| 6 | 在 #4 基础上加限制性 `sandbox`（**不含 `allow-top-navigation`**） | ✅ **成功拦截**，且播放器 / 弹幕 / 评论区 / 推荐列表全部正常渲染 |
| 7 | 沙箱内视频能否正常播放/渲染 | ✅ 截图确认：标题、播放器、弹幕层、右侧推荐、评论输入框齐全 |

### 结论 1：必须使用 sandbox iframe

B 站视频页存在**跨源 frame-buster**（推测判定条件为「能否访问 top」或 `ancestorOrigins`，
但无论如何 `referrerpolicy` 无效）。唯一稳定的规避手段是限制性 sandbox：

```html
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads">
```

- **绝对不要**加 `allow-top-navigation` / `allow-top-navigation-by-user-activation`，
  否则 frame-buster 重新生效，用户会被整页弹走。
- `allow-same-origin` 必须保留，否则 iframe 变成不透明源，B 站登录态/Cookie 读取会异常。
- 顶层若与 iframe 同源（如 `www.bilibili.com` 页面内嵌 `www.bilibili.com` 视频），
  sandbox 同样适用且无副作用 —— **统一对所有页面使用 `all_frames: false`**，
  让顶层脚本只出现在最外层文档。

### 结论 2：不需要 declarativeNetRequest

既然响应头本就没有 XFO/CSP，**不需要用 DNR 去改写响应头**。
权限清单可以保持最小：`storage` + `host_permissions`（B 站域），不申请 `declarativeNetRequest`。

### 结论 3：跨源导致无法读取 iframe 标题

抽屉需要显示视频标题，但跨源 iframe 的 `contentDocument` 不可读。
方案：由 **background service worker** 用 `host_permissions` 去 `fetch(视频URL)` 并正则解析 `<title>`，
通过 `chrome.runtime.sendMessage` 回传给 content script。
退化方案：先用链接本身的文字作为临时标题，解析成功后替换。

### 结论 4：不要试图在 iframe 内部劫持点击

content script 设 `all_frames: false`，只在最外层文档运行。
用户在抽屉里继续点链接时，由 iframe **自己**在内部导航（表现与 NGA 一致：抽屉内容换页，抽屉不重开）。
若在子框架也注入，会出现「抽屉里再弹抽屉」的套娃，属于明确的 bug。

## 验收时如何复现 E2E 测试

MCP 只能驱动一个**已在运行**的浏览器，无法通过 CDP 加载未打包扩展。因此 E2E 采用等价替代：

用 `navigate_page` 的 `initScript` 参数，在页面脚本执行前注入一个 chrome API shim +
`src/core/peek-drawer.js` + `src/content.js`，然后 navigate 到真实 B 站页面点击验证。
shim 需要覆盖：`chrome.runtime.sendMessage`、`chrome.runtime.onMessage`、`chrome.storage.sync.get/set`、
`chrome.runtime.id`。

这能真实覆盖：链接拦截、抽屉 DOM/动效、sandbox 反劫持、Esc/遮罩关闭、resize、history 回退。
唯一无法覆盖的是 `manifest.json` 的加载校验 —— 该部分用 JSON Schema 静态校验替代。
