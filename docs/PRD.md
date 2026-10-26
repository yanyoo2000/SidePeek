# SidePeek 产品需求文档（PRD v0.1）

| 项 | 值 |
|---|---|
| 文档版本 | v0.1（首个可执行版本） |
| 作者 | analyst |
| 依据 | `docs/SPEC.md`（接口契约 v0.1）、`docs/TECH-FINDINGS.md`（真机实测结论） |
| 状态 | 待 Lead 确认（第 6 节有 10 条契约缺口需 Lead 拍板，不擅自改契约） |
| 适用范围 | 扩展 v0.1.0，Chrome MV3，仅 `*.bilibili.com` |

标注约定：**【实测】**＝TECH-FINDINGS 已在真实 B 站页面验证；**【推断】**＝基于平台规范/经验的合理推断，须由 QA 验证；**【待定】**＝契约空格，本文给出建议但不擅自决定。

---

## 1. 产品定位与目标用户

**一句话**：点视频不再丢页面 —— 右侧溜一眼，看完就关。

SidePeek 是一个 Chrome 扩展，在 B 站任意页面点击视频链接时**不跳转**，而是从右侧滑出抽屉，抽屉内嵌完整视频页（可播放、可弹幕、可评论）；关闭后原页面滚动位置、搜索结果、筛选条件、播放进度全部原样保留。

### 1.1 目标用户

| 画像 | 特征 | 核心诉求 |
|---|---|---|
| **A. 首页淘片党**（主要） | 每天开 B 站首页刷推荐，10 个视频点开 7 个，只有 1-2 个看完 | 快速判断"值不值得看"，不牺牲首页推荐流的位置 |
| **B. 搜索研究者**（次要） | 用关键词/教程检索，需横向比对多个结果 | 连续试看多个结果，搜索词/页码/筛选不丢 |
| **C. 视频页顺藤摸瓜者**（次要） | 在看 A 视频时点右侧相关推荐 | 判断 B 是否更值得看，不丢 A 的进度与评论区位置 |

### 1.2 反目标用户（v0.1 不服务）

- 想把 B 站视频下载/离线保存的用户（不做，不申请多余权限）
- 想在非 B 站站点使用（不做，见第 5 节非目标）
- 想多开多个抽屉并列对比（不做，单实例）

---

## 2. 三个核心使用场景

### S1 首页刷推荐（P0）

- **现状痛点**：首页推荐流位置靠前端状态维持，点开视频必须整页跳转；用浏览器后退回来时，推荐流常被重新请求、位置漂移（列表重排/自动归位到顶部），刚才看到第几屏全丢了。用户实际行为退化成"开一堆新标签页，最后全部关掉"。
- **SidePeek 之后**：点卡片 → 右侧 320ms 滑出抽屉，视频直接在抽屉里播放判断；不满意关掉，首页仍在原位置、原列表、原滚动条。
- **成功标准**（可测）：
  1. 单次"打开→判断→关闭"全程 **≤ 3 次点击、≤ 8 秒**；
  2. 关闭后 `window.scrollY` 与打开前**误差 0px**（QA 用脚本断言）；
  3. 关闭后页面导航条目数不变（`performance.getEntriesByType('navigation').length === 1`），即**没有整页重载**；
  4. 顶层 URL 在抽屉打开期间**不被改写**为视频页（`location.href` 只在 hash 段变化）【实测结论 3/6】。

### S2 搜索结果浏览与横向比对（P0）

- **现状痛点**：搜索结果页是独立 SPA 状态（关键词、页码、排序、时长筛选）。点开结果跳转后回退，筛选条件经常丢失，必须重新搜索一次。
- **SidePeek 之后**：命中结果的链接**从 `search.bilibili.com`（跨源）** 打开，抽屉正常加载视频页（靠 sandbox 抑制 frame-buster【实测结论 1 / 用例 #4→#6】），关闭后搜索状态零损失；可连续点第 2、第 3 个结果，抽屉只换内容不重播动画。
- **成功标准**：
  1. 抽屉打开 10 秒内顶层 URL 的 **origin 保持 `https://search.bilibili.com`**，无整页跳走【实测路径】；
  2. 连续切换 3 个结果，**入场动画只播放 1 次**（QA 用 `transitionend` 计数或录屏判定）；
  3. 关闭后搜索关键词与页码文本与打开前一致；
  4. 抽屉内播放器、弹幕层、评论区、右侧推荐均渲染【实测结论 1 用例 #7】。

### S3 视频页看相关推荐（P1）

- **现状痛点**：当前视频在播，点相关推荐就离开，回来要靠历史记录或重新找，播放进度丢失，评论楼层丢失。
- **SidePeek 之后**：相关推荐在抽屉里开，原视频暂停/继续由用户决定，关掉抽屉即回到原视频页原位置。
- **成功标准**：
  1. 抽屉打开后原页面 `video.currentTime` 不被重置（若原视频在播放，允许其继续播放；SidePeek 不主动暂停 —— 见 G-11 待定）；
  2. 关闭后原页面滚动位置与打开前一致；
  3. 当前页 URL 与目标链接是同一视频时**不打开**（I-15），无"抽屉套娃"。

---

## 3. 交互链路与状态机

### 3.1 主链路图（点击 → 动画 → 加载 → 关闭/切换）

```
[用户点击视频链接]
        │  捕获阶段 click @document，t≈0ms
        ▼
   ┌─ 拦截判定 ──────────────────────────────────────┐
   │ 非左键 / 有修饰键 / URL 不匹配 / 与当前页同一视频  │──否──▶ 放行（浏览器默认行为，I-02/03/15）
   └──────────────────────────────────────────────────┘
        │ 是
        ▼  t≈0–2ms（同步块，预算 < 16ms）
   history.pushState({__sidepeek:1,url}, '', 当前URL去hash + '#sidepeek=' + enc(url))
        │
        ▼  t≈2–16ms          state = OPENING
   挂载 #sidepeek-host（仅首次）→ iframe.src = url → 显示 .sp-loading → rAF×2 后加 .is-open
        │
        ▼  t=0–320ms         state = LOADING
   transform: translateX(100%) → translateX(0)（transform 过渡，不用 width）
   mask: opacity 0 → .32
        │
        ├─ iframe `load` 触发（150ms–2.5s，视网络）──▶ state = READY，隐藏 loading，出现失败重试倒计时停止
        ├─ resolveTitle 返回（≤3s）─────────────────▶ 仅当 iframe 仍指向同一 URL 时替换标题
        └─ 8s 仍无 load ─────────────────────────────▶ state = ERROR，显示错误态 + 重试按钮
        ▼
   state = READY → 用户在 iframe 内播放/弹幕/评论
        │
        ├─ 再点另一个视频链接 ──▶ state = SWITCHING（≤50ms）：仅改 iframe.src + 显示 loading，
        │                                          不重播入场动画（I-08）
        ├─ 点 X / Esc / 点遮罩 ─▶ history.back() ──▶ popstate ──▶ state = CLOSING
        └─ 浏览器后退键 ────────▶ popstate（state 无 __sidepeek）──▶ state = CLOSING
        ▼  t=0–320ms
   反向动画 translateX(0) → translateX(100%)，mask 淡出
        ▼  t≈320ms（+缓冲 20ms） state = CLOSING 收尾
   iframe.src = 'about:blank'（卸载内容，停止后台播放/释放内存，I-16）
   清理 loading/error 态、清空标题、焦点归还触发链接 ---▶ state = IDLE
```

**状态机集合**：`IDLE` / `OPENING` / `LOADING` / `READY` / `SWITCHING` / `CLOSING` / `ERROR`。
约束：同一时刻只有一个状态；`open()` 在 `OPENING/LOADING/READY/SWITCHING` 中调用 → 等同 `SWITCHING`；在 `CLOSING` 中调用 → 先取消收尾计时器再进入 `OPENING`（不重播动画则由 I-21 去重规则决定）。

### 3.2 时长与性能预算

| 阶段 | 预算 | 观测方法 | 超标降级 |
|---|---|---|---|
| 拦截判定 + pushState | ≤ 16ms（一帧） | Performance 面板 Long Task | 逻辑本身为纯字符串/正则，风险低 |
| 宿主挂载 + iframe 创建 | ≤ 16ms（仅首次） | 计时打点 | 首次挂载改到 `document_idle` 预热（见 G-12 待定） |
| 入场动画 | 固定 320ms（`.32s cubic-bezier(.32,.72,0,1)`） | `transitionend` | — |
| loading → READY | 目标 ≤ 2.5s（P50），8s 判失败 | iframe load 时间戳 | 8s 显示错误 + 重试 |
| 切换视频 | ≤ 50ms 起效（视觉反馈），内容视网络 | 打点 | 显示 loading 骨架 |
| 关闭动画 → DOM 可弃 | ≤ 320ms + 20ms | `transitionend` | 350ms 定时器兜底强制收尾 |
| 关闭态对页面影响 | **0**：不挡点击、不改布局、不占用滚动条 | `document.elementFromPoint` 断言 | — |

设计原则（避免"动画期间卡顿"）：动画开始**立即**设置 `iframe.src`（让网络请求与动画并行，用户感知更快）；不套用 NGA 的"动画完成后才 assign URL"策略（那是为旧设备规避重排，本项目用 transform 不触发重排）。

### 3.3 滚动锁定策略（决策：**不锁 body 滚动**）

- 不修改 `body/html` 的 `overflow`、不加 `overflow:hidden`：避免滚动条消失导致的页面横向抖动（I-13 要求原页面不缩放不变形），也避免与 B 站 SPA 的样式管理冲突。
- 遮罩 `position:fixed; inset:0; pointer-events:auto` 天然吞掉落在遮罩上的滚轮/点击，因此**鼠标滚轮在抽屉打开期间不会滚动原页面**（等效锁定，且零副作用）。
- 已知残留：键盘滚动（Space/PageDown/方向键）作用于顶层文档时仍可滚动原页面；抽屉打开期间不做键盘拦截（避免与 B 站快捷键、iframe 内快捷键冲突）。列为已知限制 L-03。
- 关闭后滚动位置必然保留（因为从未改动），满足 S1 成功标准 2。

---

## 4. 逐条交互规格

### 4.1 SPEC I-01 ~ I-15 扩展（编号与 SPEC 保持一致）

> "验收方法"列可直接抄进 QA 用例；`→` 表示操作步骤。

| ID | 触发条件 | 预期行为 | 边界情况 / 失败态 | 验收方法 |
|---|---|---|---|---|
| **I-01** | 左键点击 `a[href]`，URL 命中视频路由（见 4.3），无修饰键，`event.button===0` | `preventDefault()+stopPropagation()+stopImmediatePropagation()`；抽屉右滑展开 320ms；iframe 加载该 URL；顶层 URL 仅 hash 段变化 | 链接 `href` 为空/javascript:/非 http(s) → 放行；`new URL()` 抛错 → try/catch 放行；拖拽链接（`event.detail===0` 或目标为 `img` 拖拽）→ 不拦截 | 首页点卡片：抽屉出现、`location.pathname` 不变、`location.hash` 以 `#sidepeek=` 开头 |
| **I-02** | Ctrl/Cmd/Shift/Alt + 左键点击 | **完全不拦截**，浏览器默认（新标签/新窗口）行为；不 pushState、不开抽屉 | Alt+点击在 Linux/Windows 部分版本会触发下载，交给浏览器，不干预 | 按住 Ctrl 点卡片 → 新标签打开且本页无抽屉、hash 无变化 |
| **I-03** | 鼠标中键点击 | 不拦截：中键走 `auxclick` 默认行为（后台新标签），代码**不得**监听 `auxclick/mousedown` 做拦截 | 由于 `click` 只对主键触发，本项天然满足，但需确认无 mousedown 拦截逻辑 | 中键点卡片 → 后台新标签打开，页面无抽屉 |
| **I-04** | 点击遮罩（抽屉左侧可见条带 + 抽屉本身之外的区域） | 关闭：若 `history.state?.__sidepeek` 为真 → `history.back()`，由 popstate 统一收起；否则直接收起 | 遮罩上按下但拖到抽屉上松开 → 视为取消，不关闭；连点两次遮罩 → 第二次为幂等 no-op | 点左侧灰区 → 抽屉滑出消失、hash 清空、页面无残影 |
| **I-05** | 抽屉打开状态按 Esc（顶层文档有焦点） | 同 I-04 的关闭路径 | 焦点在 iframe 内时顶层收不到 keydown → Esc 无效（已知限制 L-01）；焦点在输入框内也应关闭（不做白名单） | 点抽屉头部后按 Esc → 关闭；点 iframe 内播放器后按 Esc → 预期不关闭（记录为限制） |
| **I-06** | 点击头部 `button[data-act="close"]` | 同 I-04 关闭路径 | 关闭动画期间重复点击 → 幂等；关闭按钮在 `CLOSING` 中禁用（`aria-disabled`）防抖 | 点 X → 320ms 内收起；快速连点 3 次无异常 |
| **I-07** | 按住左键在左边缘 6px 区域拖动 | 实时跟随（`mousemove` 节流到 rAF）；`clamp(desired, minWidth, maxWidthRatio*vw)`；松手触发一次 `persistWidth(px)` | 越界：拖动到屏幕外 → clamp 到边界；拖动中窗口 resize → 重新 clamp；拖动中按 Esc → 结束拖动且不回退宽度；双击边缘 → 不做全屏（避免与 I-12 冲突） | 拖到最左停在 `maxWidthRatio*vw`；拖到最右停在 `minWidth`；刷新后宽度保持 |
| **I-08** | 抽屉已打开（READY）时再点另一个视频链接 | 保持展开，仅切换 `iframe.src`；**不重播入场动画**（不重新加 `.is-open`）；显示 loading 直到新页 load | 新 URL 与当前 iframe 相同的 URL → 完全 no-op（不重载、不闪 loading）；两次点击间隔 < 300ms 且 URL 不同 → 只以最后一次为准（去抖，I-21） | 连点两个视频：抽屉位置不动、无横向位移、只有内容区闪烁 loading |
| **I-09** | 点击抽屉 iframe 内部的站内链接 | 在 iframe 内部导航（加载到 iframe 内），顶层不跳转、不重开抽屉、不 pushState | 目标是 `target="_blank"` → 由浏览器开新标签（sandbox `allow-popups` 支持）；目标被 frame-buster 拒绝 → 在 iframe 内显示浏览器错误页（已知限制 L-02） | iframe 内点相关推荐 → 抽屉内容换页、顶层 URL/history 不变 |
| **I-10** | 浏览器后退键（抽屉打开时） | popstate 收到 state 无 `__sidepeek` → 立即收起抽屉；原页面滚动位置保留 | 连续快速后退两次 → 第一次收起，第二次交由 B 站 SPA 处理；若用户手动改了 hash 导致 popstate 但抽屉本就关闭 → 安全 no-op；前进键回到 `__sidepeek` 条目 → 重新打开并加载 `state.url` | 打开抽屉 → 记录 `scrollY` → Alt+← → 抽屉消失、`scrollY` 不变；Alt+→ → 抽屉重新出现 |
| **I-11** | 刷新页面（F5） | 抽屉不自动恢复；宽度设置保留（从 `chrome.storage.local` 读取） | 刷新后 `history.state.__sidepeek` 可能仍存在（浏览器保留 history state）→ 必须按 I-27 清理 hash 与 state，且**不得**据此自动打开 | 打开抽屉 → F5 → 无抽屉、无 `#sidepeek=` 残留；拖宽后刷新 → 宽度仍是上次值 |
| **I-12** | 双击抽屉头部标题区 | 全屏化切换：宽度变为 `vw`（占满视口），再双击还原；不写 storage（`persistWidth` 不触发） | 全屏态下拖动左边缘 → 退出全屏后按拖动结果设置宽度；全屏态下切换视频 → 保持全屏；窄屏（<640px）双击 → 全屏与默认宽度差异小，仍允许（不特判） | 双击标题 → 抽屉占满整屏；再双击 → 恢复原宽度；期间 `chrome.storage` 不变 |
| **I-13** | 抽屉展开期间 | 原页面不缩放、不变形、不被挤压（纯覆盖层，不设 `margin-right` / 不改 `body` 宽度 / 不加 `transform:scale`） | 原页面若本就有滚动条，滚动条保持可见（不隐藏），因为不改 overflow | 打开前后 `document.body.getBoundingClientRect()` 与 `window.innerWidth` 不变 |
| **I-14** | 点击带 `target="_blank"` 的视频卡片链接 | 同样拦截（B 站卡片绝大多数带此属性） | `rel="noopener"`/`noreferrer` 不影响判定；链接内嵌 `<span>/<img>` 子元素被点中 → 通过 `composedPath()` 向上找到 `a` | 首页点卡片（DOM 确认 `target="_blank"`）→ 抽屉打开、无新标签页产生 |
| **I-15** | 目标链接与当前页是同一视频 | **不打开抽屉**、不拦截（放行默认行为或直接忽略） | 判定口径见 4.3「同一视频」定义：`pathname` + `p` 参数一致即视为同一（忽略 `spm_id_from`/`vd_source`/`share_source` 等噪声参数）；同一 BV 不同分 P → 视为不同视频，**允许**打开 | 当前页 `BV1xx` 点指向 `BV1xx` 的链接 → 无抽屉；点 `BV1xx?p=2` → 打开 |

### 4.2 新增交互规格（I-16 ~ I-30，源自需求分析）

| ID | 触发条件 | 预期行为 | 边界情况 / 失败态 | 验收方法 |
|---|---|---|---|---|
| **I-16** | 抽屉关闭动画结束 | 将 `iframe.src` 置为 `about:blank`，清空 loading/error/标题；**必须停止后台音频** | 关闭瞬间 iframe 内视频仍在播 → 320ms 后静音；重开同一 URL 会重新加载（可接受的代价） | 抽屉内播放视频 → 关闭 → 音频在 0.4s 内消失；任务管理器无残留媒体进程 |
| **I-17** | 抽屉打开期间滚动原页面 | 鼠标滚轮不滚动原页面（遮罩吞事件），滚动位置不变；键盘滚动视为已知限制 L-03 | 触摸板双指滚动等价于滚轮 → 同样被遮罩吞掉 | 打开抽屉 → 滚轮滚 500px → 关闭 → `scrollY` 与打开前一致 |
| **I-18** | 视口宽度 < 约 467px（`minWidth/maxWidthRatio` 区间反转） | 宽度公式：`w = clamp(desired, lo, hi)`，其中 `hi = min(maxWidthRatio*vw, vw-48)`、`lo = min(minWidth, hi)`；保证**抽屉右侧不留缝、左侧至少保留 48px 遮罩可点** | 极端 320px 视口：`hi=272`、`lo=272`，抽屉占 85%，仍可点左侧关闭 | `emulate` 500×700 与 320×640：抽屉不溢出、左侧可点、关闭按钮可见 |
| **I-19** | 系统/浏览器为暗色（`prefers-color-scheme: dark`） | Shadow DOM 内部经媒体查询切换 token：头部背景 `#18191c`、文字 `#e3e5e7`、分隔线 `#2f3134`、按钮 hover `rgba(255,255,255,.08)`；iframe 内容跟随 B 站自身主题（不干预） | 混合态（系统暗 / B 站亮）属正常，不做"跟随 B 站主题"检测（无可信信号，见非目标） | `emulate colorScheme: dark` → 头部标题/按钮在深色背景上清晰可读（对比度 ≥ 4.5:1） |
| **I-20** | 抽屉打开 / 关闭 | `role="dialog" aria-modal="true" aria-label="SidePeek 视频预览"`；打开后焦点移到关闭按钮（或抽屉容器）；关闭后焦点归还触发它的链接；三个按钮均有 `aria-label` 中文名；`Esc` 可关；`focus-visible` 有可见轮廓 | 触发链接在后续 SPA 重渲染中被移除 → 焦点归还退化为 `document.body.focus()`，不抛错 | 键盘 Tab 可依次到三个按钮并有轮廓；打开后 `document.activeElement` 位于 shadow root 内 |
| **I-21** | 300ms 内连续点击不同视频 / 重复打开同一 URL | 同 URL 打开 → 幂等 no-op（不重载 iframe、不重播动画）；不同 URL → 只处理最后一个（去抖 300ms）；`open()` 在 `CLOSING` 中调用 → 取消收尾计时器并按"已打开"路径切换 | 去抖窗口内最后一次点击的链接已被移除出 DOM → 用事件时刻解析出的 URL 字符串，不回调 DOM | 快速点 3 个卡片 → 抽屉只加载最后一个、无动画抖动、无 3 次 loading 闪烁 |
| **I-22** | B 站 SPA 自身发生前进导航（其 `pushState` 改变了 `history.state`） | 抽屉**不**监听/劫持 `pushState`（避免破坏 B 站路由）；防御规则：每次 `popstate` 若 `state.__sidepeek` 缺失 → 收起；若 `state.__sidepeek` 为真但 `location.hash` 不含 `#sidepeek=` → 判定标记被覆盖 → 主动收起并 `replaceState` 清理 | 抽屉打开时 B 站自动连播/跳转 → 表现为抽屉保持打开、内容不跟随（已知限制 L-04） | 抽屉打开 → 页面内触发一次 B 站前进导航（点站内非视频链接）→ 不出现"抽屉与 URL 不一致"的僵死态 |
| **I-23** | 原页面处于全屏（`document.fullscreenElement`）时点击视频链接 | 抽屉存在于 `body`，而全屏元素独占 top layer → 抽屉**不可见**。前置于判定：检测到全屏时不拦截，放行默认跳转（避免"点了没反应"） | 若用户坚持要抽屉：先退出全屏再点（写入 USAGE 的 FAQ） | 视频页按 F 全屏 → 点相关推荐 → 浏览器默认跳转（无静默无响应） |
| **I-24** | 拖拽调宽进行中 | 拖拽期间 `.sp-body iframe` 设 `pointer-events:none`（否则鼠标移到 iframe 上后 `mousemove` 被 iframe 吞掉，拖动中断）；宿主加 `user-select:none`；松手恢复 | 拖拽中鼠标离开窗口再回来 → 以最后一次 `mousemove` 为准；拖拽中窗口失焦（`blur`）→ 视为松手并持久化 | 从边缘一路拖到屏幕最左（途经 iframe）→ 宽度持续跟随、不中断 |
| **I-25** | 点击 `button[data-act="copy"]` | `navigator.clipboard.writeText(url)`；成功后按钮短暂显示"已复制"（1.2s，`aria-live="polite"` 播报） | Chrome 要求文档处于聚焦状态，可能抛 `NotAllowedError` → 回退链：①`document.execCommand('copy')` + 临时 textarea ②仍失败则用一个小输入框展示 URL 并全选，提示手动复制；**不得**静默吞异常 | 点复制 → 剪贴板内容 === 当前抽屉 URL；把 document 失焦后再点 → 出现回退提示且不报未捕获错误 |
| **I-26** | 标题回填 | 单一入口：核心 `open()` 只在 header 先显示临时标题，随后调用注入的 `resolveTitle(url)`；只有 `resolveTitle` 返回且 iframe 当前 URL 仍等于该 url 时才替换；换页后到达的旧请求结果**必须丢弃** | `resolveTitle` 返回 `null`/超时 → 保留临时标题，无错误 UI；标题含 HTML/实体 → 用 `textContent` 写入（禁止 `innerHTML`）；超长 → CSS 省略号，同时 `title` 属性给全文 | 打开 A 后立即切 B：B 的标题不会被 A 的迟到结果覆盖 |
| **I-27** | 页面加载时发现 `location.hash` 含 `#sidepeek=` 或 `history.state.__sidepeek` | 不自动打开；用 `history.replaceState(null, '', 去掉 hash 的当前 URL)` 清理残留（不触发 popstate、不影响 B 站路由） | 清理失败（异常）→ 忽略即可，不抛错；清理后按 I-10 后退仍能回到打开前的页面 | 打开抽屉 → F5 → 地址栏无 `#sidepeek=`；再按后退 → 正常离开当前页或回上一页 |
| **I-28** | iframe 加载失败：`onerror` 或 8s 内无 `load` | 显示错误态：图标 + "加载失败，可能是网络波动" + 「重试」按钮（重试＝把 iframe.src 重新设为当前 URL 并重置计时）；头部标题保持临时值 | 跨源下无法读取 iframe 内容判断成功与否，`onerror` 仅覆盖网络层失败，**超时是主判据**；B 站返回的 404/错误页会正常触发 `load`，故显示为"已加载"（可接受） | 断网（`emulate Offline`）后打开 → 8s 后出现错误态；恢复网络点重试 → 内容加载成功 |
| **I-29** | iframe 内有焦点时按 Esc | 顶层收不到键盘事件，抽屉不关闭（浏览器安全边界，无法跨文档捕获） | 缓解：关闭按钮常驻可见；不移除遮罩点击路径 | 点 iframe 内播放器后按 Esc → 抽屉保持（记录为 L-01，不算缺陷） |
| **I-30** | 双击标题全屏化（细化 I-12） | 双击标题 → `setWidth(vw)` + 标记 `is-full`；再双击 → 恢复 `prevWidth`；全屏态下不写 storage；切换到别的视频保持全屏 | 若用户在全屏态拖边缘 → 退出 `is-full` 标记并按拖动结果写 storage | 双击→拖边缘→双击：宽度状态自洽无跳变 |

### 4.3 链接识别口径（与 SPEC 4.1 对齐，补充判定细节）

1. 解析：`new URL(a.href, location.href)`，失败或协议非 `http:`/`https:` → 放行。
2. 域名：`hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')`（覆盖 `www`/`search`/`m`）。
3. 路径（SPEC 已冻结，不改）：
   `/^\/(video\/(BV[0-9A-Za-z]{10}|av\d+)|bangumi\/play\/(ep|ss)\d+|cheese\/play\/(ep|ss)\d+|list\/(ml|pl)\d+)/`
   → **【待定 G-09】** 实测只覆盖过 `/video/BV...`（TECH-FINDINGS 用例 3/4/7）。`bangumi`/`cheese`/`list` 的可嵌入性未验证。
4. 参数：`search` 与 `hash` **原样保留**交给 iframe（B 站靠 `?p=2`、`?vd_source=` 等区分内容）。
5. 同一视频（I-15）：比较 `pathname` + `p` 参数（缺省 `p=1`），忽略其余参数与 hash。
6. 命中后 URL 归一：直接用 `a.href` 的绝对 URL，不做参数删改。

---

## 5. 非目标（v0.2 之前明确不做）

| # | 不做 | 原因 |
|---|---|---|
| N1 | 非 B 站站点支持（YouTube/知乎/NGA…） | 需逐站验证 frame 策略，且要扩 `host_permissions`，违背最小权限 |
| N2 | 申请 `tabs`/`webRequest`/`declarativeNetRequest`/`<all_urls>` | TECH-FINDINGS 结论 2：响应头无 XFO/CSP，无需 DNR；扩大攻击面会被评审打回 |
| N3 | 去掉或放宽 iframe `sandbox`（如加 `allow-top-navigation*`） | TECH-FINDINGS 结论 1：sandbox 是抑制 frame-buster 的唯一手段，去掉即整页被弹走 |
| N4 | 在 iframe 内部注入 content script（`all_frames: true`） | TECH-FINDINGS 结论 4：会产生"抽屉套娃" |
| N5 | 多抽屉/抽屉栈/拖拽排序 | 单实例足够；多实例带来 history 与内存复杂度 |
| N6 | 弹窗（popup UI）/选项页/右键菜单/自定义快捷键 | v0.1 无需配置项，宽度靠拖拽记忆即可 |
| N7 | 记忆上次播放的视频、恢复抽屉内容（I-11 反向） | 意外弹层是更差的体验 |
| N8 | 主动暂停/继续原页面视频、跨抽屉与主页面的播放联动 | 无可靠跨源控制手段（同源时也不稳定），交给用户 |
| N9 | 跟随 B 站站内主题（亮/暗按钮）切换 | 无稳定可信信号；改为跟随 `prefers-color-scheme`（I-19） |
| N10 | 视频下载、去广告、解锁区域限制、破解登录墙 | 法律与合规风险，且需多余权限 |
| N11 | i18n 多语言、埋点统计、云端同步宽度（`storage.sync`） | v0.1 精简；`sync` 会让小屏设备宽度异常（SPEC 4.4） |
| N12 | Firefox/Edge 商店上架、自动更新分发 | 先做 Chrome 本地加载版 |
| N13 | 修复"iframe 内 Esc 无效"（I-29）、"抽屉内后续导航的标题不更新" | 受浏览器安全边界限制，写入已知限制 |
| N14 | 视觉自定义（颜色/圆角/位置改左侧） | 无配置 UI，保持单一形态 |

---

## 6. 契约缺口（只报告，不擅改 SPEC；请 Lead 决策）

> 以下每条都会影响两名以上开发者的并行产出，**未经 Lead 决策不要单方面在代码里自选一种**。
> 优先级：P0＝不决策会直接导致成品不可用或返工；P1＝影响一致性/健壮性；P2＝记录即可。

### G-01【P0】`peek-drawer.css` 进入 Shadow DOM 的通道缺失

- 现象：SPEC 3.1 要求样式注入 Shadow DOM，目录里也冻结了 `src/core/peek-drawer.css`；但 SPEC 第 5 节的 manifest 清单**没有 `web_accessible_resources`**，核心又禁止碰 `chrome.*`。于是 `<link rel="stylesheet" href="chrome-extension://…">` 这条路在真实扩展里缺一环。
- 影响：**E2E 用 initScript 内联文件的方式永远测不出来**（QA 会 PASS，装到浏览器里却是无样式的裸 DOM）。这是"最后一公里"级别的漏。
- 建议（二选一，推荐 A）：
  - **A.** manifest 增加最小范围 `web_accessible_resources: [{resources:["src/core/peek-drawer.css"], matches:["*://*.bilibili.com/*"]}]`；核心 options 增加 `cssHref?: string`（由适配层传 `chrome.runtime.getURL(...)`），核心只负责在该 href 存在时插入 `<link>`。WAR 不是权限，只是允许 B 站页面读取这一个 css，风险可忽略。
  - **B.** 核心在 JS 内置样式字符串（`<style>` 注入），`peek-drawer.css` 降级为"人类可读副本"——须接受双份漂移风险，并在评审里加"css 与 js 内字符串一致"检查项。
- 涉及：`src/core/peek-drawer.js`（options）、`src/content.js`、`manifest.json`、`docs/SPEC.md` 第 3 节。

### G-02【P0】DOM 契约缺 loading / error 层

- 现象：task-2 硬性要求"加载失败显示错误态 + 重试"，README/QA 也会验；但 SPEC 3.1 的 DOM 树只有 mask / drawer / header / body>iframe，没有 `.sp-loading`、`.sp-error` 的位置与命名。
- 影响：dev-core 自创命名 → reviewer 按 SPEC 判"结构偏离"→ 无谓返工。
- 建议：SPEC 3.1 补
  `.sp-body > .sp-loading` 与 `.sp-body > .sp-error`（含 `button[data-act="retry"]`），并声明二者与 iframe 同级、仅覆盖在 iframe 之上。

### G-03【P0】标题职责在核心与适配层之间重叠

- 现象：SPEC 3 的核心 options 有 `resolveTitle(url)`；SPEC 4.3 又写"content.js 自己 `sendMessage` 并在收到后若抽屉仍显示同一 URL 则替换标题"。两处都在管标题替换 → 谁写 DOM？竞态怎么去重？
- 影响：双写导致标题闪烁、迟到的旧标题覆盖新标题（I-26 直接挂）。
- 建议：**唯一入口为核心**。适配层只把 `resolveTitle` 实现为 `sendMessage` + 清洗，不旁路改 DOM；核心在 `await` 后校验"iframe 当前 url === 请求 url"才落字。SPEC 4.3 改为"适配层实现 resolveTitle"，删掉"若抽屉仍显示同一 URL 则替换"的表述。

### G-04【P1】"已打开时再点另一个视频"的 history 策略未定义

- 现象：SPEC 3.3 只说打开时 `pushState`。I-08 的切换场景没说清是再 push 一条、还是 `replaceState` 改现有条目、还是不动 history。
- 影响：决定后退键语义：连点 3 个视频后按一次后退，是回上一个视频还是直接关抽屉？
- 建议：切换时用 `history.replaceState({__sidepeek:1,url:新url}, '', …#sidepeek=enc(新url))`（保持历史干净、后退一次即关闭抽屉），与"抽屉＝一次预览会话"的直觉一致；并把这条写进 SPEC 3.3。

### G-05【P1】窄屏下 clamp 区间可能反转

- 现象：SPEC 只给 `clamp 到 [minWidth, maxWidthRatio*视口]`。当 `vw < minWidth/maxWidthRatio ≈ 467px` 时 `max < min`，clamp 实现不同的人会得到不同结果（有的返回 420 溢出、有的返回 360）。
- 影响：I-18 直接挂；小屏上可能出现抽屉溢出屏幕或关闭按钮不可见。
- 建议：按 I-18 的公式写进 SPEC 3.2（`hi = min(maxWidthRatio*vw, vw-48)`，`lo = min(minWidth, hi)`），保证左侧永远留 48px 可点遮罩。

### G-06【P1】关闭后 iframe 是否卸载未定义

- 现象：SPEC 只写"收起（带过渡），不销毁 DOM"，没说关闭后是否清 `src`。
- 影响：抽屉关了但视频还在后台放声音——用户第一时间会当 bug（I-16）。
- 建议：SPEC 3.2 补"关闭动画结束后 `iframe.src='about:blank'`"，并接受"重开同 URL 需重新加载"。

### G-07【P1】`storage.local` 与 shim 清单不一致

- 现象：SPEC 4.4 用 `chrome.storage.local`；TECH-FINDINGS「验收时如何复现 E2E」里 shim 清单写的是 `chrome.storage.sync.get/set`；task-5 描述里也写 sync。
- 影响：QA 的 shim 只实现 sync → 宽度持久化用例直接 BLOCKED 或假阴性。
- 建议：以 SPEC 4.4 的 `local` 为准，QA shim 同时覆盖 `local` 与 `sync`（两者键空间独立）。

### G-08【P1】复制按钮的权限/聚焦前提未定义

- 现象：SPEC 3.1 列了 `button[data-act="copy"]`，但没写实现路径与失败回退。Chrome 对 `navigator.clipboard.writeText` 要求文档聚焦，内容脚本环境下可能抛 `NotAllowedError`。
- 影响：点了复制没反应、控制台报未捕获异常 → 评审当 XSS/错误处理问题打回。
- 建议：写入 SPEC（或直接采纳 I-25）的回退链与"不得静默吞异常"要求；不需要新增 manifest 权限。

### G-09【P1】正则覆盖范围大于实测覆盖范围

- 现象：TECH-FINDINGS 的 7 条实测全部针对 `/video/BV...`。`bangumi/play/*`、`cheese/play/*`、`list/*` 是否可嵌入、是否有 frame-buster **未验证**。
- 影响：若某个路径被 frame-buster 拒绝，现象是"顶层整页被弹走"——这是我们最怕的失败模式。
- 建议：v0.1 保留全量正则（用户价值大），但 QA 必须补 3 条 framability 抽测（bangumi/cheese/list）；若失败，用已预留的 `isPeekableUrl` 收窄白名单即可（架构上零成本，不用改核心）。

### G-10【P2】关闭按钮 → `history.back()` 的异步窗口期无兜底

- 现象：SPEC 3.3 要求主动关闭走 `history.back()` 并由 popstate 统一收起。但若 `back()` 因为某些原因没有产生 popstate（例如 B 站自己在监听并消费、或 history 长度异常），抽屉会卡在展开态。
- 影响：极低概率的"关不掉"，但对用户是硬故障。
- 建议：核心在 `back()` 后起一个 300ms 兜底计时器，若仍未收到 popstate 则强制走收起流程（幂等，收到 popstate 后也不会双写）；写入 SPEC 3.3。

### 附：其他待定项（不阻塞开发，先记录）

| # | 待定项 | 建议 |
|---|---|---|
| G-11 | 抽屉打开时原视频页若正在播放，是否主动暂停？ | 不主动暂停（同源时技术上可行但会打断用户，且跨源不可控），由用户操作 |
| G-12 | 是否在 `document_idle` 预热宿主 DOM（首次点击更快）？ | v0.1 不预热，首次点击再挂载（避免常驻一个 fixed 图层影响 B 站布局/性能）；若 QA 测得首次首帧 > 100ms 再优化 |
| G-13 | iframe 超时判定 8s 是否太短（弱网 B 站首屏可能 >8s）？ | 保持 8s（task-2 已冻结），但错误态文案写"加载较慢或失败"并提供重试，避免误报观感差 |
| G-14 | `m.bilibili.com` 是否纳入 | 域名规则天然覆盖，但移动版页面嵌桌面版视频页的 framability 未测，QA 抽测一条即可 |

---

## 7. 视觉规格

### 7.1 Token（注入到 Shadow DOM 的 `:host` 变量；亮/暗两套）

| Token | 亮色 | 暗色（`prefers-color-scheme: dark`） | 用途 |
|---|---|---|---|
| `--sp-z` | `2147483000` | 同 | 宿主层级（远高于 B 站任何元素） |
| `--sp-mask` | `rgba(0,0,0,.32)` | `rgba(0,0,0,.48)` | 遮罩 |
| `--sp-bg` | `#ffffff` | `#18191c` | 抽屉底 |
| `--sp-fg` | `#18191c` | `#e3e5e7` | 主文字 |
| `--sp-fg-sub` | `#9499a0` | `#9499a0` | 次级文字/loading 文案 |
| `--sp-line` | `#e3e5e7` | `#2f3134` | 头部下分隔线 |
| `--sp-hover` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.08)` | 按钮 hover |
| `--sp-accent` | `#00aeec` | `#00aeec` | 主按钮/焦点轮廓（B 站品牌蓝） |

### 7.2 尺寸与动效

| 元素 | 规格 |
|---|---|
| 宿主 `#sidepeek-host` | `position:fixed; inset:0; pointer-events:none; z-index:2147483000;` 内部全部走 Shadow DOM |
| `.sp-mask` | `position:absolute; inset:0; background:var(--sp-mask); opacity:0; transition:opacity .2s ease-out;` 打开时 `opacity:1`；仅展开/收起时 `pointer-events:auto` |
| `.sp-drawer` | `position:fixed; top:0; right:0; height:100%;` 宽度由内联 px 决定；`background:var(--sp-bg); border-radius:12px 0 0 12px; box-shadow:-8px 0 32px rgba(0,0,0,.24); overflow:hidden; will-change:transform;` |
| 动效 | `transform: translateX(100%) → translateX(0)`，`transition: transform .32s cubic-bezier(.32,.72,0,1)`；**禁止 transition width/left/right**；`@media (prefers-reduced-motion: reduce){ transition-duration:.01ms }` |
| 宽度默认 | `desired = defaultWidth ?? vw*0.62`；clamp 见 I-18 |
| `.sp-header` | `height:48px; padding:0 8px 0 16px; display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--sp-line)` |
| `.sp-title` | `flex:1; min-width:0; font:500 14px/20px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--sp-fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; user-select:none`（双击区域） |
| `.sp-actions` | `display:flex; gap:4px; flex:none` |
| 按钮 | `width:32px; height:32px; border-radius:8px; border:0; background:transparent; cursor:pointer; display:grid; place-items:center;` hover→`background:var(--sp-hover)`；`focus-visible→outline:2px solid var(--sp-accent); outline-offset:1px` |
| 图标 | 16×16 内联 SVG，`stroke:currentColor; stroke-width:1.5; fill:none`：新标签＝方框+右上箭头；复制＝两个错位矩形；关闭＝X。`aria-label` 分别"在新标签页打开""复制链接""关闭" |
| `.sp-resizer` | `position:absolute; left:0; top:0; bottom:0; width:6px; cursor:col-resize; z-index:2`；hover/拖动时 `background:linear-gradient(90deg,transparent 2px,var(--sp-accent) 2px,var(--sp-accent) 3px,transparent 3px)`（1px 视觉提示，不抢注意力） |
| `.sp-body` | `position:absolute; inset:48px 0 0 0; background:var(--sp-bg)` |
| `iframe.sp-frame` | `width:100%; height:100%; border:0; display:block; background:var(--sp-bg)` |
| `.sp-loading` | 居中竖排：24px 转圈（`border:2px solid var(--sp-line); border-top-color:var(--sp-accent); animation:spin .9s linear infinite`）+ `12px` 文案"正在加载…" |
| `.sp-error` | 居中竖排：32px 图标（感叹号圆环，`--sp-fg-sub`）+ 14px 文案"加载失败，可能是网络波动" + 重试按钮（`height:32px; padding:0 16px; border-radius:8px; background:var(--sp-accent); color:#fff; font-size:13px`） |
| 遮罩最小可点区 | 任意时刻抽屉左侧可见宽度 ≥ 48px（I-18 保证） |
| 层级内部顺序 | `.sp-mask` < `.sp-drawer`（DOM 顺序即可，避免 z-index 互踩） |

### 7.3 视觉验收要点（QA 用）

1. 抽屉滑入时**不得**出现横向滚动条或被挤压的原页面（I-13）；
2. 头部 48px、三按钮均 32×32 且点击热区 ≥ 32px（I-20）；
3. 暗色下标题与背景对比度 ≥ 4.5:1，按钮 hover 可辨识（I-19）；
4. 长标题（≥ 60 字）单行省略、不撑破头部、hover 有全文 tooltip（I-26）；
5. 拖动时边缘有 1px 蓝色提示线，松手消失（I-07/I-24）。

---

## 8. 验收总纲（详见 `docs/QA.md` 与 `docs/TASKS.md`）

**可进入 v0.1.0 发布，必须同时满足**：

1. `docs/TASKS.md` 中所有 P0 条目完成，且每条的验收标准有证据（单测输出/截图/断言日志）；
2. I-01 ~ I-30 全部通过或有 Lead 明确豁免（已知限制 L-01~L-04 记入 USAGE）；
3. `docs/reviews/REVIEW-01.md` 结论为 PASS，无 BLOCKER/MAJOR 未闭环；
4. manifest 静态校验：`permissions` 只有 `["storage"]`，`host_permissions` 只有 B 站域，sandbox 字符串**恰好**缺 `allow-top-navigation*`；
5. 真机（真实 Chrome 加载已解压扩展）跑通 S1/S2/S3 三个场景各 1 次，截图入 `docs/qa-assets/`。

### 已知限制（须写进 README 与 USAGE）

| # | 限制 | 原因 | 缓解 |
|---|---|---|---|
| L-01 | iframe 内有焦点时 Esc 不能关抽屉 | 键盘事件不跨文档冒泡，浏览器安全边界 | 关闭按钮常驻 + 点遮罩可关 |
| L-02 | iframe 内跳到被 frame-buster 拒绝的页面时显示浏览器错误页 | 沙箱内无法再抑制 | 用头部"打开原页面"按钮兜底 |
| L-03 | 抽屉打开时键盘滚动（Space/PageDown）仍会滚动原页面 | 不拦截键盘以避免与 B 站/iframe 快捷键冲突 | 滚轮/触摸板已被遮罩吞掉，主流操作无感 |
| L-04 | 抽屉打开后 B 站自身 SPA 前进导航，抽屉内容不跟随 | 不劫持 History API（避免破坏 B 站路由） | 抽屉内正常浏览不受影响 |
| L-05 | 抽屉内后续导航后，头部标题不更新（仍是首次打开的标题） | 跨源无法读取 iframe 当前 URL/标题 | 可忽略；重开抽屉即正确 |
