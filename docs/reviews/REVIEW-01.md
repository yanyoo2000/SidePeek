# SidePeek 代码评审 · REVIEW-01（W4-1 合并前关卡）

- 评审人：reviewer
- 评审对象：`src/core/peek-drawer.js`、`src/core/peek-drawer.css`、`scripts/check-css-sync.mjs`、`src/content.js`、`src/background.js`、`manifest.json`、`package.json`、`tests/unit/*.test.js`
- 判据：`docs/SPEC.md`（含 §7 契约裁决记录）、`docs/TECH-FINDINGS.md`、`docs/PRD.md`（I-01~I-30 补充判据）、`docs/TASKS.md`（W1-x / W2-x 验收标准）
- 方法：逐行静态走查 + 手工状态机推演 + 只读命令验证
  - `npm test` → **54 pass / 0 fail**，`CSS in sync (6306 bytes)`
  - `node --check` → 4 个 JS/MJS 文件全部通过
  - 全程未修改 `src/`，未执行 git 命令

> 结论先行：**CHANGES-REQUESTED**（1 个 BLOCKER、5 个 MAJOR、17 个 MINOR）。
> SPEC §7 批准的两处偏离（G-06「关闭后移除 iframe 节点」、I-08「切 URL 重建 iframe 节点」）已按裁决实现，**不计入缺陷**（见第 5 节第 6 条）。

---

## 1. 问题总览

| 级别 | 数量 | 编号 |
|---|---|---|
| BLOCKER | 1 | B-01 |
| MAJOR | 5 | M-01 ~ M-05 |
| MINOR | 17 | P-01 ~ P-17 |

---

## 2. BLOCKER（必须修复后才能合并）

### B-01 拖拽改宽期间未对 iframe 设置 `pointer-events:none`：拖窄中断、mouseup 丢失、根元素 cursor/user-select 残留

- **位置**：
  - `src/core/peek-drawer.js:1412-1422`（`_handleDragStart` 只在 `document` 上加 `mousemove/mouseup`）
  - `src/core/peek-drawer.js:1425-1431`（`_handleDragMove` 只看 `this._drag`，**没有 `event.buttons` 校验**）
  - `src/core/peek-drawer.js:1433-1439`、`1441-1458`（`_handleDragEnd` / `_endDrag`：清理依赖 mouseup 真正到达）
  - `src/core/peek-drawer.css:180-186`（`.sp-frame` 无任何拖拽态规则）；对应内嵌副本 `src/core/peek-drawer.js:244-250`
- **问题**：W1-5 验收标准与 PRD I-24 都明确要求「拖拽期间 iframe `pointer-events:none`」（TASKS.md:43、R7 见 TASKS.md:157），代码里完全没有。当前只有 `.sp-drawer`/`.sp-mask` 的 pointer-events 分层，iframe 在抽屉展开态是可命中的。
- **为什么是问题**（推演链）：
  1. 拖拽条只有 6px，且贴抽屉左缘；**向右拖（变窄）时**，抽屉左缘会跟随光标右移。每次 `mousemove` 更新后光标恰好落在拖拽条起点，但命中测试发生在更新之前：只要一次指针位移 > 6px（正常速度的拖拽普遍如此），光标就已经落在抽屉内部的 iframe 上。
  2. 跨文档事件不会冒泡到父文档，`document` 上捕获阶段的 `mousemove`/`mouseup` **收不到** → 宽度不再跟随（拖窄方向失灵），且 `mouseup` 丢失 → `_handleDragEnd`/`_endDrag` 不执行。
  3. 后果被 `_handleDragMove` 缺少 `event.buttons === 0` 早退进一步放大：mouseup 丢失后，用户**单纯移动鼠标**（未按键）仍会持续改写 `this._width` 并重设宽度；`document.documentElement.style.cursor='ew-resize'` 与 `user-select:none` 会一直留在 B 站页面上，直到用户下次在顶层页面点击（那时才会收到 mouseup 收尾）。
  4. 这直接违反 I-07（实时跟随）与 SPEC §3.1「不污染宿主页面」的承诺；PRD I-07 边界还要求「拖动中按 Esc → 结束拖动」，而 `_hide()`（`peek-drawer.js:1189-1217`）同样没有调用 `_endDrag`，拖拽态会跨关闭存活。
- **修复建议**（三处一起改，任何一处漏掉都还有残余）：
  1. `_handleDragStart` 里给当前 iframe 关掉命中：`this._frame && (this._frame.style.pointerEvents = 'none')`；`_endDrag` 里恢复 `''`（不要硬编码 `auto`）。等价的替代是拖拽期给 `.sp-body` 盖一层透明 overlay（z-index 高于 iframe）；`setPointerCapture` 可作为候选但需先验证指针跨 iframe 时是否仍重定向，不保险。
  2. `_handleDragMove` 开头加 `if (event.buttons === 0) { this._endDrag(false); return; }`，作为 mouseup 丢失的兜底。
  3. `window.addEventListener('blur', this._handleDragEnd)`（W1-5「拖拽中被 blur 视为松手」）+ `_hide()`/`destroy()` 里调 `_endDrag(false)`；顺便把 `mousemove` 节流到 rAF（W1-5）。
- **验证要求**：QA 用例（W5-3 已列「拖拽跨 iframe」）必须覆盖「按住左缘向右快速拖到屏幕中部再松手」，断言：宽度跟手、松手后 `documentElement.style.cursor === ''`、`userSelect === ''`、再开抽屉宽度正常。若 QA 真机复现不成立，可降级为 MAJOR，但 W1-5/I-24 的实现项缺失本身仍需补。

---

## 3. MAJOR（必须修复或由 Lead 书面豁免）

### M-01 风险最高的核心引擎零单测；真机脚本只覆盖同源首页，缺 TECH-FINDINGS 结论 1 的跨源关键场景

- **位置**：`tests/unit/` 下只有 `content.test.js` / `background.test.js` / `manifest.test.js`，**没有 `peek-drawer*.test.js`**；`package.json:8` 的 `npm test` 只跑 `tests/unit/*.test.js` + CSS 同步；`tests/integration/real-extension-check.mjs:407-411` 只跑 `https://www.bilibili.com/`（同源）一个场景
- **问题**：1605 行的 `peek-drawer.js` 承载了 History 状态机、sandbox 守护、拖拽、destroy 全部高风险逻辑，却没有任何自动化断言。W1-8 验收要求「`document`/`window` 监听器全部解绑（用监听器计数或 patch 验证）」「重复开关 50 次 DOM 节点数稳定」，当前无任何证据。
- **为什么是问题**：DoD（SPEC §6.2）要求「有对应的验收证据」；TASKS.md:125 把 W1-4（History）列为最大风险点。现在 history 只能靠人工读代码和（尚不存在的）QA 用例兜底，一旦后续改动（批准文档已明确要求任何 iframe 生命周期改动都必须回归 I-10）就会静默回归。另外 TECH-FINDINGS 结论 1 的核心场景是 **search.bilibili.com 内嵌 www 视频页被 frame-buster 顶走**，当前真机脚本只测首页（同源），最关键的反劫持场景没有自动化覆盖。
- **修复建议**：
  1. 新增 `tests/unit/peek-drawer.test.js`（沿用现有 vm + 最小 stub 风格）：断言 `SidePeekDrawer.SANDBOX` 恰好不含 `allow-top-navigation*`；`sanitizeSandbox` 过滤 `allow-top-navigation` 并在缺 `allow-scripts/allow-same-origin` 时回退；popstate 状态转移（peek→open、非 peek→hide、无二次 back）；`_hide` 后不再有 loading/error、`onClose` 只调一次；destroy 后 `addEventListener/removeEventListener` 计数归零（patch document/window）。
  2. `real-extension-check.mjs` 追加 `https://search.bilibili.com/all?keyword=...` 场景（TECH-FINDINGS 用例 4/6 的复现条件），断言顶层 origin+path+search 不变。
  3. 把集成脚本接进 `npm test`（或单独的 `npm run test:real` 并在 DoD 里注明「合并前必须跑」），否则它永远不会被执行。

### M-02 关闭态抽屉仍可用 Tab 聚焦（aria-hidden 子树含可聚焦元素），且 `aria-modal` 无焦点陷阱

- **位置**：`src/core/peek-drawer.js:606-612`（`aria-hidden="true"` 常驻、`tabindex=-1`）、`1205-1211`（`_hide` 只移除 `.sp-open` / `data-open`，节点保留）、`src/core/peek-drawer.css:42-62`（只 `transform: translateX(100%)` + `pointer-events:none`，**没有 `visibility`/`inert`**）
- **问题**：抽屉关闭后只是被平移到视口外，`aria-hidden="true"` 只影响辅助技术，不改变 Tab 序列。三个头部按钮（以及关闭后 360ms 内尚存的 iframe）仍在 tabbable 集合里。
- **为什么是问题**：axe 规则 `aria-hidden-focus` 明确违规；键盘用户在 B 站页面按 Tab，会依次落进三个不可见的按钮，焦点"消失"且按 Enter 会触发复制/关闭等动作（`_url` 还在，复制会静默成功、toast 在视口外）。`aria-modal="true"`（609 行）承诺模态语义，但没有焦点陷阱，键盘可自由跑回被遮罩盖住的页面，两者自相矛盾。W1-7 验收项 I-20 要求「键盘 Tab 可依次到三个按钮并有轮廓」，当前只在展开态成立。
- **修复建议**：收起时给 `.sp-drawer` 加 `inert`（Chrome 102+，同时移除 aria-hidden 或保留均可），展开时移除；或 CSS 加 `visibility:hidden` + `transition: visibility 0s linear .32s`（展开态 `visibility:visible`）。若要严格模态，再补一个焦点陷阱（Tab 在抽屉内循环）。同时把 `_hide` 顺序改为「先 `_restoreFocus()` 再把焦点子树置为 inert」，避免在焦点仍在按钮上时设置 `aria-hidden`（Chrome 会打 "Blocked aria-hidden ... descendant retained focus" 警告）。

### M-03 F5 刷新后 `#sidepeek=` 与 `history.state.__sidepeek` 残留未清理（PRD I-27 未实现，PRD I-11 验收方法必然 FAIL）

- **位置**：`src/content.js:526-551`（`start()` 只读宽度、装 click 监听，从不检查 hash/state）、`src/core/peek-drawer.js:1101-1114`（`_pushHistory` 发现 `history.state` 已是 peek 时走 `_replaceHistory`，不再新增条目）
- **问题**：抽屉打开时 `pushState` 把地址栏改成 `...#sidepeek=<url>`；F5 刷新后 URL 与 `history.state` 都被浏览器保留，但 `_open=false`（I-11 正确：不自动恢复），于是地址栏**永久挂着一个 `#sidepeek=上次视频` 的 hash**，历史栈里也留着一条带 `__sidepeek` 的条目。
- **为什么是问题**：PRD I-11 的验收方法第 2 步是「打开抽屉 → F5 → 无抽屉、**无 `#sidepeek=` 残留**」，PRD I-27 明确要求加载时用 `replaceState` 清理；按现状 QA 必挂。副作用还包括：刷新后首次 `open()` 因 `history.state` 仍是 peek 而走 `replaceState`（不新增条目），使「后退一次关闭」语义与刷新前不一致，并可能让一次 `back()` 只是原地清 hash 而看不到页面切换。
- **修复建议**：`content.js` 的 `start()` 里（或更早的 `document_start` 钩子）加一次自愈：
  ```js
  try {
    var hasResidue = /#sidepeek=/.test(location.hash) ||
      (history.state && history.state.__sidepeek);
    if (hasResidue) history.replaceState(null, '', location.href.split('#')[0]);
  } catch (err) { /* 静默：清理失败也不能影响页面 */ }
  ```
  并补一条单测（假 `location.hash` / `history.state` 断言只 replace 一次、异常不抛）。

### M-04 浏览器「前进」重新打开抽屉时标题不回填（`activeUrl` 时序 bug，I-10 / PRD I-26）

- **位置**：`src/core/peek-drawer.js:978-984`（`_load()` → `_resolveTitle(target)`（981）→ `_safeCall('onOpen')`（983））；`src/content.js:373-376`（`resolveTitle` 第一行就要求 `activeUrl === url`）；`src/content.js:450-455`（`openPeek` 是唯一在 open 之前设置 `activeUrl` 的地方）、`510-515`（`onOpen/onClose` 维护 `activeUrl`）
- **问题**：正常点击路径由 `openPeek()` 先写 `activeUrl`，所以没问题；但 I-10 的「后退关闭 → 前进重开」路径是 `_handlePopState`（`peek-drawer.js:1178-1181`）直接调 `open(state.url)`，**不经过 `openPeek`**，而 `onClose` 已把 `activeUrl` 置 null。core 又在 `onOpen` **之前**调用 `resolveTitle`，于是 `content.resolveTitle` 在 375 行立即返回 `Promise.resolve(null)`，标题请求根本没发出。随后 `onOpen` 才把 `activeUrl` 补上，但没有任何代码重试 → 抽屉一直显示占位「侧边速览」（`peek-drawer.js:887`），临时标题也因为 `options.title == null` 被清空（973 行）。
- **为什么是问题**：这是 I-10 官方验收路径（PRD I-10：「Alt+→ → 抽屉重新出现」）上的可见缺陷，也违反 PRD I-26「标题回填单一入口」的体验预期。现有单测发现不了：`tests/unit/content.test.js:272-277` 的 FakeDrawer 在 `open()` 内部就调 `options.onOpen(url)`，与真实 core 的调用顺序相反。
- **修复建议**（二选一，推荐 1）：
  1. core：把 `_safeCall('onOpen', [target])` 移到 `_resolveTitle(target)` 之前（`onOpen` 只做通知，不依赖 load 完成，提前安全）。
  2. content：`resolveTitle(url)` 不再依赖 `activeUrl` 做入口判定（改为在通过 `drawer.isOpen()` 后自行 `activeUrl = url`），把串台防护留在 `.then` 里（381 行已有）。
  并补单测：按真实 core 顺序（先 resolveTitle、后 onOpen）复现前进重开，断言标题最终被替换。

### M-05 W1-7 验收项 PRD I-19（暗色 token）未实现，需 Lead 裁决

- **位置**：`src/core/peek-drawer.css:304-323`（只有 `@media (max-width:640px)` 与 `prefers-reduced-motion`，**没有 `prefers-color-scheme`**）；对应内嵌副本 `src/core/peek-drawer.js:368-387`。同时 `--sp-width`（`css:47` / JS `111`）在全仓从未被赋值，是死 token；`--sp-*` 形式的 token 体系也不存在（颜色全部硬编码）
- **问题**：PRD I-19 要求「Shadow DOM 内部经媒体查询切换 token：头部 `#18191c`、文字 `#e3e5e7`、分隔线 `#2f3134`…」，W1-7 把它列为 core 的验收项。当前抽屉是单套硬编码深色（`#1e1f25`/`#17181c`），没有媒体查询、没有 token。
- **为什么是问题**：W4-2 规则是「MAJOR 闭环或 Lead 书面豁免」，这条不落在任何一侧就会被静默忽略；同时 `--sp-width` 死 token 说明样式层曾计划变量化但没落地。
- **修复建议**：要么按 PRD §7.1 把颜色收敛为 `:host` 上的 `--sp-*` 变量 + 两套 `prefers-color-scheme` 覆盖；要么由 Lead 明确裁决「v0.1 不做，I-19 移出 WBS/PRD」并记录在此评审下。默认建议后者（成本/收益比低），但必须书面，不能默认放过。

---

## 4. MINOR（建议修复，可带入下一轮）

> 标注「PRD-only」的项属于 `docs/PRD.md` 的补充规格（非 SPEC v0.1 契约），由 Lead 决定是否纳入本轮；标注「W1-x/W2-x」的项属于 WBS 验收标准。

### 契约 / 行为

- **P-01 临时标题口径不符 W2-5 / PRD I-26**（`src/content.js:243-265`，常量 `54`）：`extractTempTitle` 直接取整个 `textContent` 折叠空白后截 200 字，没有 W2-5 要求的「分行过滤时长/播放量噪声、取最长行、截 80 字」，也没有 `img[alt]` / `aria-label` 兜底。B 站卡片 textContent 常是「标题 12:34 1.2万播放」这类拼接串，真实标题回来前（最长 4s，`content.js:55`）头部会显示噪声。建议按 W2-5 优先级实现；顺带把 `TITLE_TIMEOUT_MS` 与 W2-5 的 3s 对齐。
- **P-02 事件拦截仍有残余误伤面，需 QA 实测**（`src/content.js:189-226`、`466-483`）：`scanPathForAnchor` 只把 `button/input/select/textarea/option/label`、`role=button`、`contenteditable=true` 判为控件。B 站卡片内以纯 `div/span` + 事件委托实现的控件（如「稍后再看」的某些版本、收藏弹层触发器）若没有 role，会被当成链接点击而整个吞掉（`stopImmediatePropagation`）。代码本身已把 `stopImmediatePropagation` 严格限制在命中分支（478-480），这点是对的；残留下来的只有「控件识别口径」问题。建议 QA 用例 W5-2 #9 覆盖：首页卡片内每个可点控件各点一次，确认无死点。
- **P-03 content 与 core 的「同一页」判定不一致，可能吞掉点击后什么都不发生**（`src/content.js:122-135` vs `src/core/peek-drawer.js:1520-1535`）：content 用 origin+pathname+`p` 判同页（所以当前页是 `?p=2`、目标链接是 `/video/BVxxx`（无 query）时判为**不同页 → 拦截**）；core 的 `_isSameAsTopPage` 对「目标无 search」一律视为同一页 → `open()` 提前 return。结果是：`preventDefault` 已执行、抽屉没开、页面没跳 → 死点。建议删掉 core 的 `b.search === ''` 兜底（I-15 已由 content 判定）或让两侧共用同一判定。属边界场景，但修复成本 1 行。
- **P-04 抽屉内 iframe 站内导航会污染 joint session history，关闭降级到 G-10 兜底**（`src/core/peek-drawer.js:992-1018`、`1189-1217`，`1199`）：I-09 允许在 iframe 内继续点视频（跨源 iframe 内部导航会向联合历史追加子帧条目，这正是 SPEC §7 已记录的 `history.length` 现象）。此后点 X 关闭时 `history.back()` 可能被子帧条目吃掉、顶层收不到 popstate，只能靠 300ms 兜底 `_cleanHistoryEntry()+_hide()` 收起——抽屉能关、hash 能清（这是 G-10 的设计目的，不算缺陷），但联合历史里会多出条目，用户之后可能要按两次后退才离开页面。建议：写入 README/USAGE 的已知限制，并让 QA 用例 I-10 追加「抽屉内翻 2 页后再关闭 → 后退 1 次能否离开当前页面」的实测结论。
- **P-05 `open()` 未复位 `_closePending`，与 `_hide`/`popstate` 不对称**（`src/core/peek-drawer.js:944-946` vs `987-994`、`1172`、`1194`）：`_closePending` 只在 `_handlePopState` 和 `_hide` 里复位。若在 `close()` 发出 `back()` 之后、popstate 落地之前发生 `open()`（当前因遮罩仍吃掉点击而基本不可达，属防御性问题），兜底定时器会因 `_historyToken` 变化而 `return`，`_closePending` 永久停在 `true` → 之后每次 `close()` 都在 993 行提前返回，抽屉再也关不掉。建议在 `open()` 开头加 `this._closePending = false;`（并清 `_closeGuard`），成本极低。
- **P-06 `_resolveCss` 提供了一条「宿主页面 → 扩展 Shadow DOM」的未授权样式通道**（`src/core/peek-drawer.js:726-733`，对应 `DEFAULTS.css` 在 `53` 行）：只要页面上出现 `<style id="sidepeek-core-css">`（>200 字符），抽屉就会用它的内容替代内置 CSS；页面上任何脚本（含 B 站自身、第三方注入广告脚本）都能借此把抽屉改成任意样式（例如隐藏拖拽条、把遮罩做成全透明骗点击）。这不是 XSS（不能执行脚本），但属于不必要的信任通道，而且**当前没有任何调用方使用**（content.js 不传 `css`，也不创建该 style 节点）。建议整段删除，或至少改成显式的白名单来源。
- **P-07 `sanitizeSandbox` 是大小写敏感的，可被大小写变体绕过**（`src/core/peek-drawer.js:447-474`，禁用表 `38`）：按 HTML 规范，`sandbox` 关键字按 ASCII 大小写不敏感匹配，浏览器认 `Allow-Top-Navigation` 为同一 token；而这里用 `indexOf(token)` 精确比较，`Allow-Top-Navigation` 会被原样保留 → 反 frame-buster 被关掉。当前唯一调用方传的是安全常量，属纵深防御缺口（不是现存漏洞）。建议：`token.toLowerCase()` 后再比较与去重，并对 `allow-top-navigation*` 用 `startsWith` 判断；顺便给 `_guardSandbox`（`774-791`）加同样的归一化比较。
- **P-08 `_legacyCopy` 抛错时 textarea 残留在 B 站 body 里**（`src/core/peek-drawer.js:1361-1376`）：`container.removeChild(area)` 在 `execCommand` 之后，若 `select()`/`execCommand` 抛错则被 catch 直接 `return false`，textarea 留在 `document.body`。建议 `try { ... } finally { if (area.parentNode) area.parentNode.removeChild(area); }`。
- **P-09 PRD-only：全屏场景会变成静默死点**（`src/content.js:457-483`，宿主挂载见 `src/core/peek-drawer.js:698`）：PRD I-23 要求「检测到 `document.fullscreenElement` 时不拦截、放行默认跳转」。当前没有该判定；而宿主是 `<html>` 的子节点、不在 top layer，全屏元素会把它完全盖住 → 用户在全屏态点视频链接时，点击被吞、抽屉"打开了但看不见"。建议在 `onClickCapture` 命中后、`preventDefault` 之前加 `if (document.fullscreenElement) return;`。
- **P-10 PRD-only / W2-4：没有 300ms 去抖**（`src/content.js:450-455`，`src/core/peek-drawer.js:798-840`）：PRD I-21、W2-4 验收要求「300ms 内连续点击不同视频只处理最后一个」。当前每次点击都立即 `drawer.open` → 连续点击会连续重建 iframe（`_load` 的 `needNewFrame` 分支）。因抽屉展开后遮罩会吃掉页面点击，实际很难触发，故列 MINOR；若 QA 用键盘/脚本触发，会出现多次 loading 闪烁。
- **P-11 PRD-only：缺少 I-22 的「state 与 hash 一致性」防御**（`src/core/peek-drawer.js:1168-1185`）：`_handlePopState` 只依据 `event.state`，不校验地址栏 hash 是否仍含 `#sidepeek=`。若 B 站 SPA 在我们打开期间 `replaceState` 覆盖了当前条目（自动连播等），会出现「state 与地址栏不一致」的中间态；当前退化结果尚可用（关闭时 `_hasPeekHistory()` 为 false → 直接 `_hide`，不会双写），但会在历史里留下多余条目。建议按 PRD I-22 在 peek 分支加 hash 校验，不一致则 `_hide()` + `_cleanHistoryEntry()`。
- **P-12 契约 DOM 清单未涵盖的附加节点，建议 SPEC 补白**（`src/core/peek-drawer.js:654-678`、`663-665`、`674-678`）：除 §7 G-02 批准的 `.sp-loading/.sp-error/[data-act=retry]` 外，还多了 `.sp-error-sub`、`.sp-error-actions`、错误态里的第二个按钮（无 `data-act`）和 `.sp-toast`。这些是合理实现，但不在 SPEC §3.1/§7 的合法节点清单里，容易在下一轮评审里被反复质疑。建议 Lead 在 SPEC 补一句「允许附加辅助节点（.sp-toast/.sp-error-*）」，或让 dev-core 收敛。
- **P-13 `http://` 视频链接会被混合内容拦截**（`src/content.js:94`）：`matchPeekUrl` 同时接受 http/https，但 B 站页面是 https，在 https 顶层内嵌 `http://www.bilibili.com/video/...` 属混合内容会被 Chrome 拦掉 → 抽屉空 8 秒后报「页面未能加载」。建议只放行 https，或命中 http 时把 URL 规范化为 https 再交给 iframe（顺带更新 `content.test.js:52` 的对应正例）。
- **P-14 拖拽区不是键盘可操作控件**（`src/core/peek-drawer.js:615-621`、`1488-1495`；CSS `86-96`）：`role="separator"` 但没有 `tabindex`、没有方向键处理，`aria-valuemin` 有而 `aria-valuemax` 缺失、`aria-valuenow` 只在 `_renderWidth` 里设置。WAI-ARIA splitter 模式要求可聚焦 + 键盘调宽。建议要么补 `tabindex="0"` + ArrowLeft/ArrowRight 调 20px，要么去掉 `aria-valuemin/valuenow`（半套 ARIA 比没有更容易误导 AT）。

### 代码质量 / 健壮性

- **P-15 CSS 双份同步脚本脆弱**（`scripts/check-css-sync.mjs:39-54`）：靠字面量 `var CSS_TEXT = \`` 和「其后第一个 `` `; ``」定位。若有人在模板串里写入反引号或 `${`（会变成运行时插值），或把声明改成 `const`，脚本要么解析错位要么直接抛错；它也不校验模板串里是否存在 `${`。建议加两条断言：`embedded.includes('`')` / `includes('${')` 则 fail，并在 `extractEmbeddedCss` 成功后校验 `jsSource.slice(...)` 首尾就是 `/*` 与 `*/`。当前状态是健康的（`npm test` 已通过，6306 bytes 一致），属加固。
- **P-16 同一份常量/逻辑在三处重复且无跨文件一致性测试**（`src/content.js:32-37`、`61-62`、`142-168`；`src/background.js:29-30`；`src/core/peek-drawer.js:37`、`1468-1486`）：sandbox 串、路径白名单正则、宽度 clamp 各写了两份（content/core；content/background）。任何一处手工改动都可能静默漂移（例如给 core 加一个 sandbox token 而 content 没加，`_load` 用的是 content 传入的 options）。建议在单测里加「`SidePeekDrawer.SANDBOX === content.SANDBOX`」「两边 `PEEK_PATH_PATTERNS` 与 background `PEEK_PATH_RE` 行为一致」的断言（现有 vm 方案可直接加载 core）。
- **P-17 小项汇总**：
  - `_endDrag(persist)` 的 `persist` 形参从未以 `true` 调用（`peek-drawer.js:1441-1458`），持久化逻辑在 `_handleDragEnd` 里重复了一份（`1433-1439`）→ 建议二选一，删掉死参数，避免将来误用导致「一次拖拽 persist 两次」；
  - `_toast` 的 1600ms 是裸魔法数字（`1387`），不像其他常量那样有名字和「为什么」注释，建议提为 `TOAST_DURATION_MS`；
  - `_handleKeyDown` 只 `stopPropagation`（`1252`）却在注释里说「不再让 B 站页面同时处理」——同一节点（window）上的其它监听器仍会执行，措辞与行为不符；若要彻底独占用 `stopImmediatePropagation`（注意会打断 B 站的 Esc 快捷键，需 QA 确认）。

---

## 5. 已核查通过、明确不计入缺陷的项

1. **manifest 最小权限**（`manifest.json:24-33`）：`permissions:["storage"]`、`host_permissions:["*://*.bilibili.com/*"]`、`all_frames:false`、`run_at:document_idle`、`js` 顺序 core→content；无 `tabs/webRequest/declarativeNetRequest/<all_urls>`，无 `web_accessible_resources`。`manifest.test.js:38-69` 有静态护栏。
2. **sandbox 恰好缺 `allow-top-navigation*`**（`peek-drawer.js:37-38`、`744`）：创建时一次性写入；`sanitizeSandbox`（`447-474`）只收紧不放宽；`_guardSandbox`（`774-791`）在属性被外部改写后恢复。全仓无任何移除/放宽它的代码路径（`content.js:61-62` 也传同一串）。守护逻辑自身**不会循环**：恢复后下轮回调 `actual === expected` 早退；`_removeFrame`（`759-762`）与 `destroy`（`1064-1067`）都在节点销毁前 `disconnect`。
3. **History 状态机无双写、无死循环**：打开 `pushState` 一次（`1101-1114`，`state` 已是 peek 时降级 `replaceState` 防止多压一层）；切换 `replaceState`（`1116-1132`）；`popstate` 是唯一收起权威且内部再也不调 `back()`（`1168-1185`）；主动关闭只 `history.back()` + 300ms 兜底（`987-1018`），兜底路径的 `_cleanHistoryEntry`（`1152-1160`）与正常路径互斥，不会「既 back 又 replace」；`pushState` 失败有降级（`1111-1113`）。`location.href` 进 hash 前 `encodeURIComponent`（`1134-1137`）。
4. **XSS 面**：外部标题唯一落点是 `_setTitle` 的 `textContent`（`887`）+ `title` 属性（`888`）；错误文案/副标题/toast 全部 `textContent`（`866`、`867`、`1381`）；唯一 `innerHTML` 是模块内常量 SVG（`482`，`390` 有说明）；无 `eval`/`new Function`/`srcdoc`/`document.write`/`insertAdjacentHTML`。background 解析出的标题同样只走 `textContent` 链。`URL`/`href` 进 iframe 前经 `toUrl` + 域名/协议/路径白名单（`content.js:91-100`）。
5. **destroy 解绑完整**（`1045-1093`）：window 的 `keydown(capture)/resize/popstate`、拖拽期 `document` 的 `mousemove/mouseup`（经 `_endDrag`）、MutationObserver、`_loadTimer/_closeGuard/_unloadTimer/_toastTimer` 四个定时器全部清理；iframe 与宿主节点被移除，元素级监听随节点回收；重复 `destroy()` 安全。`_removeFrame` 先解绑 load/error 再摘节点（`755-767`）。
6. **关闭后停音频 / 切 URL 不增长 history**：按 SPEC §7 批准实现——`_scheduleUnload` 在 360ms 后**移除 iframe 节点**（`1219-1235`），`_load` 换 URL 时**重建节点**（`812-825`），注释写明理由；未使用 `about:blank` 也未复用 `src`。**不是缺陷**。
7. **重入/串台防护**：`_loadToken`（`806`）、`_titleToken`（`898`）、`_historyToken`（`946`）分别让旧超时、旧标题、旧关闭兜底失效；`_handleFrameLoad/Error` 在 `_open=false` 时直接返回（`844`、`852`）。
8. **事件拦截副作用受控**：`preventDefault+stopPropagation+stopImmediatePropagation` 只在「命中视频链接」分支执行（`content.js:478-480`），其余点击直接 return；`event.defaultPrevented` 早退避免与 B 站自处理冲突；抽屉内点击用 `isFromDrawerHost` 排除（`229-236`），抽屉内部再用冒泡阶段 `_handleIsolation` 阻断外泄（`694-696`、`1265-1268`）。
9. **无 `chrome.*` 泄漏进 core**：`peek-drawer.js` 全文只在注释里出现 `chrome.`；IIFE + `window.SidePeekDrawer`（`1598-1600`）+ `module.exports`（`1602-1604`）。
10. **CSS 与 CSS_TEXT 逐字一致**：`npm test` → `CSS in sync (6306 bytes)`；`check-css-sync.mjs` 已纳入 `npm test`（`package.json:8`）。
11. **宽度 clamp 公式符合 G-05**（`peek-drawer.js:1468-1486`、`content.js:158-168`）：`hi=min(maxWidthRatio*vw, vw-48)`、`lo=min(minWidth,hi)`，`lo<=hi` 恒成立，极端视口有 1px 兜底。
12. **`role/aria`、Esc、焦点归还的基本面到位**：`role=dialog/aria-modal/aria-label`、遮罩 `aria-hidden`、按钮 `aria-label`+`title`、`focus-visible` 轮廓、打开抢焦点（`1537-1548`）、关闭归还（`1550-1564`，含 `isConnected` 判定）；`prefers-reduced-motion` 有降级。
13. **测试与文档证据**：54 条单测覆盖 URL 判定/宽度/标题清洗/实体解码/消息链路/manifest；`node --check` 全通过。

> 附：`docs/qa-assets/real-extension-report.json` 是**早期**真机报告（结构与当前 `tests/integration/real-extension-check.mjs` 输出字段不一致：它用 `screenshots.screenshotD`，当前脚本写 `screenshot`），其中 `C-2 同源（首页）：点击后抽屉未展开` 为 FAIL。该证据已过期，**不能作为当前版本的验收依据**，建议 QA 在修复后重跑并覆盖跨源搜索页场景，以本报告 M-01 的第 2 条为准。

---

## 6. 结论

**CHANGES-REQUESTED**

必须先修的条目：

1. **B-01**（拖拽跨 iframe，W1-5/I-24 实现缺失 + mouseup 丢失后的连带污染）—— 这是唯一 BLOCKER，修完由 QA 按 W5-3「拖拽跨 iframe」真机复验。
2. **M-01 ~ M-05**：按 W4-2 规则，逐条「修复完成」或由 Lead 给出书面豁免并记录在本文件下。其中：
   - M-02（a11y 焦点）、M-03（F5 hash 残留）、M-04（前进重开标题）建议本轮必修，改动都很小；
   - M-01（核心单测 + 跨源真机场景）是 DoD 的硬证据要求；
   - M-05 是 WBS 验收项缺失，必须由 Lead 明确裁决，不能默认放过。
3. MINOR 中建议**本轮顺手修**（成本 1~5 行、直接风险）：**P-03**（死点）、**P-05**（`_closePending` 复位）、**P-06**（删除未授权样式通道）、**P-07**（sandbox 大小写归一化）、**P-08**（textarea 泄漏）、**P-13**（http 归一化）。其余可在下一轮（W4-2 复审或 v0.1.1）处理；其中 PRD-only 项（**P-09 / P-10 / P-11**）与契约补白项（**P-12**）需 Lead 决定是否纳入本轮范围。

修复完成后请提交复审；复审只需覆盖本条 BLOCKER/MAJOR 的闭环证据 + 回归 `npm test`、`_load`/iframe 生命周期相关路径的 I-10 回归（SPEC §7「后续约束」）。
