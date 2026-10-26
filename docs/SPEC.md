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

---

## 7. 契约裁决记录（Lead，v0.1.1）

analyst 在 `docs/PRD.md` 第 6 节提出 G-01~G-14 共 14 条契约缺口。以下为**最终裁决**，与本文档正文冲突时以本节为准。

| 编号 | 裁决 | 说明 |
|---|---|---|
| G-01 CSS 通道 | **已由 dev-core 以「CSS 内联进 JS」解决，不引入 WAR、不引入构建** | `peek-drawer.js` 内的 `CSS_TEXT` 是唯一真源，`peek-drawer.css` 是人类可读副本。必须由 `scripts/check-css-sync.mjs` 做逐字比对防止漂移，命令纳入 `npm test`。**不批准** `web_accessible_resources`。 |
| G-02 错误态 DOM | **采纳**。3.1 的 DOM 树补充灰态节点 | 合法节点：`.sp-loading`、`.sp-error`、`button[data-act="retry"]`。revIewer 不得再以「结构偏离」判定。 |
| G-03 标题职责 | **唯一入口 = core**。适配层只实现 `resolveTitle`，**不得**旁路直接改 DOM | 现状已符合，保持。 |
| G-04 切换时 history | **采纳 replaceState** | 已打开状态下切视频 → `replaceState`，保证「后退一次即关闭抽屉」。 |
| G-05 窄屏 clamp 反转 | **采纳**，公式固定为：`hi = min(maxWidthRatio*vw, vw-48)`；`lo = min(minWidth, hi)` | 保证 `lo <= hi` 恒成立；抽屉左侧永远至少留 48px 可点遮罩。 |
| G-06 关闭后停音频 | **采纳**。关闭过渡结束后把 `iframe.src` 置 `about:blank`（约 350ms 后） | 否则抽屉关了视频还在响，是体验硬伤。下次打开重新加载，可接受。 |
| G-07 存储域 | **`chrome.storage.local`**，key `sidepeek.width` | 不给跨设备同步（小屏上宽度会异常）。QA 的 shim 必须实现 `local`。 |
| G-08 复制链接 | **采纳回退链**：`navigator.clipboard.writeText` → 失败则 `textarea + execCommand('copy')` → 再失败提示用户手动复制 | 无焦点/非安全上下文时会抛 `NotAllowedError`。 |
| G-09 非 video 路径白名单 | **先保留** `bangumi/play`、`cheese/play`、`list`，但标注为 best-effort | 已实测可嵌入的只有 `/video/`。QA 必须对这三类各抽测一次 framability；**若某类触发 frame-buster，直接从白名单删掉**，不要试图绕过。 |
| G-10 back() 卡死 | **采纳 300ms 兜底**：调用 `history.back()` 后若 300ms 仍未收起，强制收起 | 防止 popstate 未触发时抽屉卡在展开态。 |
| G-11 打开时暂停原视频 | **不做**（v0.1 非目标） | 原页面视频继续播放是可接受的并存行为。 |
| G-12 预热宿主 | **不做** | 首次打开 ~350ms 动画已覆盖创建开销。 |
| G-13 8s 超时 | **保持 8s** | 弱网下 2.5s P50 已达标，8s 判失败合理。 |
| G-14 `m.bilibili.com` | **不纳入** | 移动站无抽屉交互意义，且布局差异大。 |

### 补充：真机联调闸门

analyst 指出现有流程缺少「真实 Chrome 加载已解压扩展」的验证环节，而 initScript 注入式 E2E **无法发现 manifest / 文件路径类问题**（G-01 就是典型）。因此新增闸门：

**T7 真机联调（Lead 负责）**：用独立 user-data-dir 启动一个带 `--load-extension=<SidePeek 目录>` 与 `--remote-debugging-port` 的真实 Chrome，
通过 CDP 断言：
1. `chrome://extensions` 中扩展无加载错误
2. 打开 B 站页面后 content script 已注入（`window.__SIDEPEEK_LOADED__` 为真）
3. 抽屉样式已生效（取 `#sidepeek-host` 的 shadowRoot 内 computedStyle 非默认值）
4. 点击视频链接后顶层 URL 未变（frame-buster 被挡住）
5. 截图留证

只有 T7 通过，才允许打 tag 与推送最终版。

### 补充裁决（G-06 / I-08 的偏离，Lead 事后批准）

dev-core 在实现过程中发现 `iframe.src` 变更会污染 **joint session history**（子帧历史条目），
直接导致 I-10「后退关闭 / 前进重开」失效（实测 `history.length` 3→4，`back()` 被子帧条目吃掉）。
因此做了两处偏离字面契约的实现，**Lead 予以批准**，理由是二者都服务于同一个目标：保住 I-10。

| 项 | 裁决 | 理由 |
|---|---|---|
| G-06 停音频 | **改为「关闭过渡结束后移除 iframe 节点」**，不用 `src='about:blank'` | 两者都能销毁 browsing context 停掉声音；但 `about:blank` 会往 joint session history 追加子帧条目，破坏 I-10。**以 I-10 为准**。代价：再次打开需重新加载（已在 G-06 取舍内）。 |
| I-08 切 URL | **改为「重建 iframe 节点」**，不改 `src` | 对外行为与契约完全一致（抽屉保持展开、只换内容、不重播入场动画），但 `history.length` 全程不变，I-10 恢复正常。 |

**后续约束**：任何再动 iframe 生命周期的改动，必须回归验证 I-10（后退关闭 + 前进重开）与
`history.length` 不增长，否则视为回归。

### 第 8 节 评审裁决（针对 docs/reviews/REVIEW-01.md）

#### 8.1 需修复（已派单，见任务板）

B-01（拖拽跨 iframe）、M-02（关闭态 Tab 可聚焦）、M-03（F5 后 hash 残留）、M-04（前进重开标题不回填）、
M-01（core 零单测 + 集成脚本进 npm test）—— 全部**采纳并修复**。

MINOR 本轮修：P-03（同页判定不一致吞点击）、P-05（`_closePending` 未复位）、P-06（删除未授权样式通道）、
P-07（sandbox 大小写绕过）、P-08（textarea 残留）、P-09（全屏静默死点）、P-13（http 混合内容）、
P-15/P-16（CSS 同步脚本加固 + 跨文件常量一致性）、P-17（死参数/魔法数字）。

**契约变更（N-11）**：`aria-modal` 属性已从抽屉移除。
原因：本实现没有焦点陷阱，宣称 `aria-modal="true"` 会与「键盘可自由跑回被遮罩盖住的页面」自相矛盾。
收起态改用 `inert` + `_restoreFocus()` 保证键盘可达性正确。
因此 PRD I-20 中「`aria-modal="true"`」一条**不再适用**，验收时不得据此判为缺陷；
`role="dialog"` 与 `aria-label` 保留。

#### 8.2 书面豁免（不修，必须记录，不得静默忽略）

| 项 | 裁决 | 理由 |
|---|---|---|
| **M-05 暗色 token（PRD I-19）** | **v0.1 不做，豁免** | 抽屉服务于"看视频"，固定深色皮肤在亮/暗页面下都成立，且与视频播放器的深色语境一致。切换 token 体系的成本/收益比低。**同时要求 dev-core 删掉从未被赋值的死 token `--sp-width`**，避免误导。I-19 从 WBS 移出，改为 v0.2 候选。 |
| **P-04 joint history 多条目** | **记为已知限制** | 跨源 iframe 内部导航必然向联合历史追加子帧条目，父页面无权干预。G-10 兜底已保证"抽屉能关、hash 能清"。写入 README/USAGE 已知限制，QA 追加实测结论。 |
| **P-10 300ms 去抖（PRD I-21）** | **v0.1 不做** | 抽屉展开后遮罩会吃掉页面点击，实际触发路径几乎不存在；纯脚本触发才会看到 loading 闪烁。v0.1.1 候选。 |
| **P-14 拖拽条键盘可操作** | **v0.1 不做** | WAI-ARIA splitter 的完整键盘支持超出首发范围；已知限制里写明"调宽度需要鼠标"。 |
| **P-17-c `stopImmediatePropagation`** | **不采纳** | 改成 `stopImmediatePropagation` 会打断 B 站自身的 Esc 快捷键，弊大于利。保留 `stopPropagation`，把注释措辞改准确即可。 |

#### 8.3 评审中经核实**不成立**的两条

| 评审主张 | 核实结果 |
|---|---|
| M-01「`real-extension-check.mjs` 只跑同源首页，缺跨源 search 场景」 | **不成立**。当前脚本含 C（首页，同源）与 D（search.bilibili.com → www，**跨源**）两个场景。证据：`docs/qa-assets/real-extension-report.json` 中 checks 为 `A,B,C-1..C-8,D-1..D-8`，`total=18 passed=18`。评审时读到的是脚本重跑前的旧报告。 |
| 提醒「real-extension-report.json 含 C-2 FAIL，是过期证据」 | **已修正**。该文件在 T7 定稿重跑后已被覆盖为 18/18 全绿，可作当前验收依据。 |

#### 8.4 契约补白（P-12）

SPEC 3.1 的 DOM 树为**最小必需结构**，实现允许附带以下辅助节点，评审不得据此判为结构偏离：

- `.sp-toast`（操作反馈）
- `.sp-error-sub`、`.sp-error-actions`（错误态说明与操作区）
- 错误态内的重试/打开新标签按钮（重试按钮须带 `data-act="retry"`）

#### 8.5 G-09 实测结论：三类非 video 路径均可嵌入（Lead 真机验证）

G-09 原本是「正则覆盖了 bangumi/cheese/list，但只实测过 `/video/`」的悬空风险。已用真实内容实测完毕：

**方法**：在跨源宿主 `search.bilibili.com` 上同时创建 3 个带限制性 sandbox 的 iframe，
分别指向三类真实链接，等待 14 秒后检查宿主 URL 是否被改写 + 截图确认渲染。

| 路径类型 | 实测 URL | 结果 |
|---|---|---|
| `bangumi/play` | `https://www.bilibili.com/bangumi/play/ss1588` | ✅ 正常渲染（番剧播放器 + 弹幕 + 正片 1/22） |
| `cheese/play` | `https://www.bilibili.com/cheese/play/ep2014561` | ✅ 正常渲染（课堂课程页） |
| `list/ml` | `https://www.bilibili.com/list/ml4057598311` | ✅ 正常渲染（播放列表/合集页 + 播放器） |

**结论**：
1. 三类均**未触发 frame-buster**，宿主 URL 保持不变；
2. 三类页面均真实渲染，不是错误页 —— 因此不存在「白名单放行但实际打不开」的静默死点；
3. **白名单保持现状**，`content.js` 里的 `bestEffort` 标注可以更新为「已实测通过」。

> 注意：这验证的是「能否被 sandbox iframe 承载」。
> 仍不能保证 B 站未来改版后不变，故 `classifyPeekPath` 作为单一收窄点的设计保留。
