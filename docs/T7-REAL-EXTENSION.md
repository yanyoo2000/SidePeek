# T7 真机联调报告：真实 Chrome 加载未打包扩展

> 负责人：Lead　｜　执行脚本：`tests/integration/real-extension-check.mjs`
> 结论：**18/18 断言全部通过，可以发布。**

## 1. 为什么必须做这一步

`initScript` 注入式 E2E 只能验证「代码逻辑」，**验证不了「扩展作为扩展能不能装上」**：

- `manifest.json` 字段非法 / `content_scripts` 路径不存在 / 图标尺寸不对 / 权限声明被拒
- 文件没被打包进去（`.gitignore` 误伤、大小写不一致）
- content script 在**隔离世界**的运行情况

这些问题在注入式测试里全部隐形。G-01（CSS 没有通道进 Shadow DOM）就是典型：注入式测试永远绿，真机却是无样式裸 DOM。

## 2. 踩到的第一个坑：品牌版 Chrome 已禁用 `--load-extension`

第一版脚本按常规做法用 `--load-extension=<目录>` 启动，结果扩展根本没装上。
从 Chrome 自己的 stderr 日志里找到根因：

```
WARNING:chrome\browser\extensions\extension_service.cc:423]
  --load-extension is not allowed in Google Chrome, ignoring.
WARNING:chrome\browser\extensions\extension_service.cc:445]
  --disable-extensions-except is not allowed in Google Chrome, ignoring.
```

**品牌版 Google Chrome 155 已彻底拒绝 `--load-extension`**（安全策略，非本机配置问题）。
实测 Edge 156 同样策略，也无法用该参数装扩展。

### 可用替代路径（已实测）

唯一可用方式是 Chrome 官方给自动化留的后门：

```bash
chrome.exe --enable-unsafe-extension-debugging --remote-debugging-port=<port> --user-data-dir=<临时目录>
```

然后用 CDP 的 **`Extensions` 域**加载：

```js
// 连 browser 级别的 webSocketDebuggerUrl
await client.send('Extensions.loadUnpacked', { path: 'D:\\yan-github-code\\SidePeek' });
// → { id: "joidkfbkmankcklnlfgmjcmblbmckfnf" }
```

脚本已按此实现，`headless=new` 与有头模式都可用。

## 3. 踩到的第二个坑：content script 在隔离世界

`window.__SIDEPEEK_LOADED__` 由 content script 设置，但它运行在 **isolated world**，
主世界的 `Runtime.evaluate` 读不到这个变量 —— 第一版脚本据此误判「content script 未注入」。

正确做法：订阅 `Runtime.executionContextCreated`，挑出 `auxData.type === 'isolated'`
且 `origin` 以 `chrome-extension://` 开头的 context，用它的 `contextId` 求值。
（抽屉 DOM 在主世界可见，所以 UI 断言仍在主世界做。）

## 4. 断言结果（18/18 PASS）

| 编号 | 断言 | 结果 |
|---|---|---|
| A | 扩展成功加载（`Extensions.loadUnpacked` 返回 id） | ✅ `joidkfbkmankcklnlfgmjcmblbmckfnf` |
| B | background service worker 注册为 `src/background.js`（manifest 解析通过） | ✅ |
| C-1 | 首页：content script 已注入（隔离世界可见） | ✅ |
| C-2 | 首页：点击视频链接后抽屉从右侧展开 | ✅ |
| C-3 | 首页：顶层文档未被 frame-buster 劫持 | ✅ |
| C-4 | 首页：Shadow DOM 内 CSS 生效（`position:fixed` + 阴影） | ✅ |
| C-5 | 首页：iframe sandbox 组合正确（含 `allow-same-origin`、**无** `allow-top-navigation`） | ✅ |
| C-6 | 首页：iframe 已加载视频页 | ✅ `BV1Jcnd6kEQ3` |
| C-7 | 首页：pointer-events 分层正确（宿主 `none` / 抽屉 `auto`） | ✅ |
| C-8 | 首页：Esc 可关闭抽屉 | ✅ |
| D-1 | 搜索页（**跨源**）：content script 已注入 | ✅ |
| D-2 | 搜索页：点击后抽屉展开 | ✅ |
| D-3 | 搜索页：**顶层文档未被劫持**（跨源 frame-buster 场景） | ✅ |
| D-4 | 搜索页：CSS 生效 | ✅ |
| D-5 | 搜索页：sandbox 组合正确 | ✅ |
| D-6 | 搜索页：iframe 已加载视频页 | ✅ `BV1U3n46GEzY` |
| D-7 | 搜索页：pointer-events 分层正确 | ✅ |
| D-8 | 搜索页：Esc 可关闭抽屉 | ✅ |

**其中 D-3 是整个项目最关键的断言**：`search.bilibili.com` 内嵌 `www.bilibili.com` 视频页属于跨源，
项目立项时实测该场景会被 B 站的 frame-buster 把整个页面顶走；扩展装上后该场景稳定不再被劫持。

### 关于 URL 判据的一个说明

断言 C-3 / D-3 比较的是 `location.href` **去掉 hash 后的部分**。
原因是抽屉打开时扩展会按设计主动追加 `#sidepeek=<encoded-url>` 做历史记账，
这是 SPEC §3.3 的既定行为；真正的 frame-buster 会改变 origin / pathname / search。

## 5. 证据

- 截图：[real-extension-c.png](qa-assets/real-extension-c.png)（首页场景）、[real-extension-d.png](qa-assets/real-extension-d.png)（搜索页跨源场景）
- 机器可读报告：[real-extension-report.json](qa-assets/real-extension-report.json)
- 复现命令：

```bash
node tests/integration/real-extension-check.mjs            # headless 优先，失败回落有头
node tests/integration/real-extension-check.mjs --headed
```

退出码 0 = 全绿。脚本会自建临时 `--user-data-dir` 并在结束时清理，不污染日常浏览器配置。

## 6. 复现脚本的健壮性处理

B 站首页有自动轮播与懒加载，「测量元素坐标」到「真正点击」之间元素会移位，
导致点击落空、用例偶发失败（实际踩到过一次）。脚本因此做了：

1. 逐个候选链接尝试（最多 8 个）
2. `scrollIntoView` 后等待 450ms 让布局稳定
3. 用 `document.elementFromPoint(x, y)` **校验点击点确实命中目标链接**，否则换下一个候选
4. 才派发真实 `Input.dispatchMouseEvent`（而非 `element.click()`，更接近真人）

## 7. 遗留说明

- 本脚本验证的是**扩展装载 + 核心交互链路**，不替代 `qa` 的完整用例矩阵（拖拽、后退/前进、暗色、窄屏等见 `docs/QA.md`）。
- 真机联调在 `headless=new` 下通过；有头模式亦通过（首轮两种模式均 18/18）。
