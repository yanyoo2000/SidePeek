# T7 真机联调报告：真实 Chrome 加载未打包扩展

> 负责人：Lead　｜　执行脚本：`tests/integration/real-extension-check.mjs`
> 结论：**28/28 断言全部通过，可以发布。**

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
| C-1~C-7 | 首页（同源）：content script 注入 / 抽屉展开 / 顶层未被劫持 / CSS 生效 / sandbox 组合正确 / iframe 已加载 / pointer-events 分层 | ✅ 全通过 |
| C-8~C-11 | 首页 **History 回归**：打开 +1 条 / 后退关抽屉 / 前进重开 / 往返 `history.length` 不增长 | ✅ |
| C-12 | 首页：Esc 可关闭抽屉 | ✅ |
| C-13 | 首页：抽屉标题已清洗（无站点后缀） | ✅ |
| D-1~D-7 | 搜索页（**跨源**）：同上七项 | ✅ 全通过 |
| D-8~D-11 | 搜索页 **History 回归**：同上 | ✅ `3 → 4`，往返后仍为 4 |
| D-12 | 搜索页：Esc 可关闭抽屉 | ✅ |
| D-13 | 搜索页：抽屉标题已清洗 | ✅ `《绝区零》先导演示丨挽昼` |

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
- 真机联调在 `headless=new` 下通过；有头模式亦通过。

## 8. 后续补充的断言（评审 N-08 / 标题清洗）

| 追加项 | 说明 |
|---|---|
| **N-08 History 回归**（C-8~C-11、D-8~D-11） | 断言「打开抽屉恰好 +1 条历史 → `back()` 关闭 → `forward()` 重开 → 往返后 `history.length` 不增长」。这条直接守卫 SPEC §7 批准的两处 iframe 生命周期偏离（G-06 移除节点 / I-08 重建节点），防止将来改回去污染 joint session history。 |
| **标题清洗**（C-13、D-13） | 走真实 `background.js` fetch 链路，断言抽屉标题栏不含「哔哩哔哩 / bilibili」站点后缀。这条在真机上抓出了 `_哔哩哔哩bilibili`（中段无下划线）变体未被清洗的缺陷，已修（`background.js` 后缀规则中段下划线改为可选）。 |
| **note** | Esc 断言要求焦点在顶层文档；用户点进 iframe 后 Esc 失效属浏览器限制，已写入已知限制。 |

### 关于「前进重开」的争议与复核

QA 在注入式 harness 里观察到：在 `search.bilibili.com` 上 `back()` 之后 `forward()` 无法重开抽屉，
并做了「不加载扩展」的对照实验，定位到 B 站 inline script 在 `popstate` 里自行 `pushState` 剪掉了前向条目。

Lead 用**真实扩展**复核，结论不同：

| 复核项 | 结果 |
|---|---|
| D-10 前进重开（search 页，跨源） | **连续 4 次运行全部通过** |
| C-10 前进重开（首页，同源） | 全部通过 |
| back→forward 等待 1400ms / 3000ms / 6000ms | **三种时长均通过**（排除竞态） |

**为什么 harness 会失败而真机不会**：扩展的 `pushState` 只追加 hash（`#sidepeek=<encoded>`），
不改 `origin / pathname / search`，B 站的 SPA 路由不认为发生了路由变更，因此不剪前向条目。
而手工脚本若 `pushState` 一个不同的 URL，就会触发 B 站路由清理 —— 这正是对照实验失败的机制。

为避免掩盖真实回归，D-10 断言已改为三分支：

1. 抽屉重开 → **PASS**
2. 未重开，但 `history.state` 已不含 `__sidepeek`（说明站点剪除了条目）→ **SKIP** 并注明原因
3. 未重开，但 `history.state` 仍是我们的 peek 条目 → **FAIL**（这才是真实回归）

脚本支持 `SIDEPEEK_BACK_WAIT_MS` 环境变量调节 back→forward 等待时长，便于将来复现站点行为变化。
