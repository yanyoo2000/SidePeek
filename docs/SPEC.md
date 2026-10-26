# SidePeek 接口契约与交互规格（v0.1，Lead 制定）

> 这是 `dev-core` 与 `dev-extension` 并行开发的**唯一契约**。
> 任何一方想改契约，先向 Lead 提出，不要私自改动对方依赖的签名。

## 1. 产品定义

**SidePeek** 是一个 Chrome MV3 扩展：在 B 站任意页面点击视频链接时，**不跳转**，
而是从右侧滑出一个抽屉，抽屉内嵌完整视频页（可播放、可弹幕、可评论）。
关闭抽屉后原页面状态（滚动位置、搜索结果）完全保留。

命名与定位：

- 仓库名 / 扩展名：`SidePeek`
- 副标题：`侧边抽屉速览`
- 一句话：**点视频不再丢页面 —— 右侧溜一眼，看完就关。**

## 2. 目录结构（写死，不要改）

```
SidePeek/
├── manifest.json               # dev-extension
├── src/
│   ├── core/
│   │   ├── peek-drawer.js      # dev-core：零依赖核心，不含任何 chrome.* API
│   │   └── peek-drawer.css     # dev-core：注入到 Shadow DOM 内的样式
│   ├── content.js              # dev-extension：B 站适配层 + 链接拦截
│   └── background.js           # dev-extension：标题抓取
├── icons/                      # dev-extension：16/32/48/128 PNG
├── tests/
│   ├── unit/                   # dev-extension：node 纯函数单测
│   └── e2e/                    # qa：浏览器验收脚本
├── docs/
└── README.md
```

核心文件必须是**可直接 `<script>` 加载的 IIFE 全局**（不要用 ESM `import`），
因为 content script 不走打包器。

## 3. 核心对外接口

`src/core/peek-drawer.js` 暴露全局构造函数 `window.SidePeekDrawer`。

```js
const drawer = new SidePeekDrawer({
  // ---- 样式与尺寸 ----
  zIndex: 2147483000,        // 抽屉整体层级，必须远高于 B 站任何元素
  widthRatio: 0.62,          // 展开宽度 = 视口宽 * widthRatio
  minWidth: 420,             // px 下限
  maxWidthRatio: 0.9,        // 视口宽比例上限
  defaultWidth: null,        // px，若提供则优先于 widthRatio（用于恢复上次宽度）

  sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads',

  // ---- 由适配层注入的能力（核心不碰 chrome.*） ----
  isPeekableUrl: (url) => true,       // 是否允许被抽屉承载
  resolveTitle: async (url) => null,  // 返回 Promise<string|null>，失败返回 null 即可
  persistWidth: (px) => {},           // 拖动结束后回调，适配层负责存 storage
  onOpen: (url) => {},
  onClose: () => {},
});

drawer.open(url, { title });  // 打开并在必要时换页；已打开时仅切换 iframe src
drawer.close();               // 收起（带过渡），不销毁 DOM
drawer.toggle(url, opts);
drawer.isOpen();              // boolean
drawer.setWidth(px);          // 手动设定宽度（会被 clamp）
drawer.destroy();             // 移除 DOM 与所有监听
```

### 3.1 DOM 结构（Shadow DOM 隔离，禁止污染宿主页面样式）

```
#sidepeek-host (position:fixed; inset:0; pointer-events:none; z-index:...)
└─ #shadow-root
   ├─ .sp-mask        (半透明遮罩，pointer-events:auto)
   └─ .sp-drawer      (position:fixed; top:0; right:0; height:100%; transform 过渡)
      ├─ .sp-resizer  (左边缘 6px 拖拽区)
      ├─ .sp-header
      │   ├─ .sp-title   (标题，超长省略号)
      │   └─ .sp-actions
      │       ├─ button[data-act="open-tab"]   打开原页面（新标签）
      │       ├─ button[data-act="copy"]       复制链接
      │       └─ button[data-act="close"]      关闭
      └─ .sp-body
          └─ iframe.sp-frame (宽高 100%，border:none)
```

- 抽屉必须使用 `transform: translateX(100%)` 折叠、`translateX(0)` 展开，
  `transition: transform .32s cubic-bezier(.32,.72,0,1)`。**不要用 width 过渡**（NGA 用宽度会触发布局重排，卡顿）。
- 宿主元素用 `pointer-events:none`，只有 mask 和 drawer 自己 `pointer-events:auto`，
  保证关闭状态下完全不挡 B 站页面点击。
- 抽屉外框加 `box-shadow: -8px 0 32px rgba(0,0,0,.24)`。

### 3.2 交互规格（逐条验收）

| 编号 | 行为 | 规格 |
|---|---|---|
| I-01 | 点击视频链接 | 拦截默认跳转，抽屉右滑展开并加载该链接 |
| I-02 | 按住 Ctrl/Cmd/Shift/Alt 点击 | **不拦截**，保持浏览器默认新标签行为 |
| I-03 | 鼠标中键点击 | 不拦截 |
| I-04 | 遮罩点击 | 关闭抽屉 |
| I-05 | Esc | 关闭抽屉 |
| I-06 | 关闭按钮 | 关闭抽屉 |
| I-07 | 左边缘拖动 | 实时改宽度，clamp 到 [minWidth, maxWidthRatio*视口]，松手持久化 |
| I-08 | 抽屉已打开时再点另一个视频 | 抽屉保持展开，仅切换 iframe，**不重播入场动画** |
| I-09 | 抽屉内点击站内链接 | 在 iframe 内部导航（抽屉不重开、顶层不跳转） |
| I-10 | 浏览器后退 | 关闭抽屉并恢复原页面；再前进可重新打开 |
| I-11 | 刷新页面 | 抽屉不自动恢复（避免意外弹层），但宽度设置保留 |
| I-12 | 双击标题 | 全屏化切换（占满视口，再双击还原）—— 可选，做不到可留 TODO |
| I-13 | 抽屉展开时 | 原页面**不缩放、不变形**，不被挤压（纯覆盖层） |
| I-14 | `target="_blank"` 的视频卡片链接 | 同样拦截（B 站卡片绝大多数带此属性，必须处理） |
| I-15 | 当前页面已是该视频 | 不打开抽屉（避免自我嵌套） |

### 3.3 History 规格（最关键、最容易做坏）

- 打开抽屉时：`history.pushState({ __sidepeek: 1, url }, '', <当前URL去掉hash> + '#sidepeek=' + encodeURIComponent(url))`
- 监听 `popstate`：
  - `event.state?.__sidepeek` → 打开抽屉并加载对应 url
  - 否则 → 立即收起抽屉
- 主动关闭（点 X / Esc / 遮罩）：若 `history.state?.__sidepeek` 为真则调用 `history.back()`，
  由 `popstate` 统一收起；**不要**既 `back()` 又直接改 DOM，否则状态会错乱。
- **风险提示**：B 站是 SPA，自己也在用 History API。必须保证
  「关闭抽屉后，地址栏 hash 被清掉、B 站路由状态未被破坏」。
  这是 QA 的重点验收项（见 I-10）。

## 4. 适配层规格（`src/content.js`）

### 4.1 链接识别

命中即视为「视频页」，需要拦截。用 `URL` 解析后判断 `hostname.endsWith('bilibili.com')`：

```js
/^\/(video\/(BV[0-9A-Za-z]{10}|av\d+)|bangumi\/play\/(ep|ss)\d+|cheese\/play\/(ep|ss)\d+|list\/(ml|pl)\d+)/
```

注意：B 站链接常带 `?spm_id_from=...&vd_source=...` 等参数，**必须保留参数**原样交给 iframe。

### 4.2 事件拦截

- `document.addEventListener('click', handler, true)`（捕获阶段）
- 用 `event.composedPath()` 找到最近的 `<a href>`（兼容 Shadow DOM 内部点击）
- 命中则 `preventDefault() + stopPropagation() + stopImmediatePropagation()`
- 只处理 `event.button === 0` 且无修饰键的点击
- **必须在 `stopImmediatePropagation` 前判断**，不要粗暴拦截所有点击，
  否则会破坏 B 站自己的播放器控件、点赞、弹幕开关等交互

### 4.3 标题

1. 立即用 `<a>` 的 `textContent` 去掉首尾空白作为临时标题
2. 并行 `chrome.runtime.sendMessage({type:'PEEK_TITLE', url})`
3. 收到结果后若抽屉仍显示同一 URL 则替换标题

### 4.4 宽度持久化

`chrome.storage.local`，key: `sidepeek.width`。启动时读取一次传给 `defaultWidth`。
（用 `local` 而非 `sync`，避免跨设备同步导致宽度在小屏上异常。）

## 5. 权限与 manifest 约束

```json
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "host_permissions": ["*://*.bilibili.com/*"],
  "content_scripts": [{
    "matches": ["*://*.bilibili.com/*"],
    "js": ["src/core/peek-drawer.js", "src/content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }]
}
```

- **不得**申请 `tabs`、`webRequest`、`declarativeNetRequest`、`<all_urls>`。
  申请了就是在扩大攻击面，评审会直接打回。
- `all_frames` 必须为 `false`（见 TECH-FINDINGS 结论 4）。

## 6. 完成定义（Definition of Done）

一个功能算完成，必须同时满足：

1. 代码在 `D:\yan-github-code\SidePeek` 下，且在契约规定的文件里
2. 有对应的验收证据（单元测试通过 / E2E 截图 / 手写复现步骤）
3. reviewer 无「阻塞级」意见
4. 已由 Lead 提交到 git，并有清晰 commit message
