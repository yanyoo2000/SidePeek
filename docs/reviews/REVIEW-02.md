# SidePeek 代码评审 · REVIEW-02（W4-2 返工复审）

- 评审人：reviewer
- 复审对象：commit `89c7034`（Lead 所述）中的返工改动，重点为 `src/core/peek-drawer.js`、`src/core/peek-drawer.css`、`src/content.js`、`scripts/check-css-sync.mjs`、`tests/unit/peek-drawer.test.js`（新增）、`tests/integration/real-extension-check.mjs`、`docs/SPEC.md` §8
- 判据：`docs/SPEC.md`（含 §8 评审裁决）、`docs/TECH-FINDINGS.md`、`docs/PRD.md`、`docs/TASKS.md`
- 方法：逐行静态复审 + 状态机/时序推演 + 只读命令验证；**未改 src/，未执行 git**

本轮只读验证结果：

```
npm test    → tests 78 / pass 78 / fail 0；CSS in sync (6678 bytes)
node --check → 5 个文件（core / content / background / check-css-sync / peek-drawer.test）全部通过
T7 证据     → docs/qa-assets/real-extension-report.json：total=18 / passed=18 / failed=[]
              文件 mtime 03:33:36 晚于 core 改动 03:29:40（证据相对源码是新的）
              （T7 本轮未重跑：脚本要独占一个 Chrome + 调试端口，QA 正在用同一台机器做验收，
               故按报告内容 + mtime + 脚本断言逐条交叉核对，不重复占用环境）
```

> 结论：**PASS**
> 剩余条数：**0 BLOCKER / 0 MAJOR / 12 MINOR**（全部为「不阻塞合并」的精度、测试口径与文档登记类问题）。

---

## 0. 先更正 REVIEW-01 中两条不成立的结论（不再重复）

| REVIEW-01 主张 | 复核结论 |
|---|---|
| M-01 后半段「`real-extension-check.mjs` 只跑同源首页、缺跨源 search 场景」 | **撤回**。当前脚本 `tests/integration/real-extension-check.mjs:448-449` 跑 C（首页，同源）与 D（`search.bilibili.com` → `www`，**跨源**）两个场景，D-3 就是反劫持断言；报告 checks 为 `A,B,C-1..C-8,D-1..D-8`、`total=18 passed=18`。我评审时读到的是脚本重跑前的旧版本。 |
| 「`real-extension-report.json` 含 C-2 FAIL，是过期证据」 | **撤回**。该文件已被 T7 定稿重跑覆盖为 18/18 全绿，可作当前验收依据；SPEC §8.3 已记录此更正。 |

另外说明：REVIEW-01 的「M-01 后半段」不成立**不影响** M-01 主体（core 零单测）的成立性——本轮已用 `tests/unit/peek-drawer.test.js` 补齐。

---

## 1. 闭环验证（逐条对照 REVIEW-01 的 BLOCKER / MAJOR）

| 条目 | 状态 | 证据与判断 |
|---|---|---|
| **B-01** 拖拽跨 iframe | **CLOSED** | 四条路径齐备，详见 §2.1。残余精度问题见 N-01/N-02/N-03（MINOR）。 |
| **M-01** core 零单测 + 集成脚本 | **CLOSED** | `tests/unit/peek-drawer.test.js`（930 行，require 真实 core + fake DOM/History）覆盖 sandbox 净化/History 状态机/M-04 标题/惰性焦点/残留自愈/拖拽/destroy 监听净计数；`package.json:11-12` 增加 `test:real` / `test:all`，`manifest.test.js:108-110` 有护栏；跨源 D 场景已存在（见 §0）。测试有效性评估见 §2.5。 |
| **M-02** 关闭态 Tab 可聚焦 | **CLOSED（有 1 条登记待补）** | `peek-drawer.js:664-673` 创建即 `inert`；`1018-1019` 展开前摘除；`1283-1290` 收起时先 `_restoreFocus()` 再 `aria-hidden`+`inert`；`aria-modal` 已删除且有注释说明原因（`672`）。单测 `489-530` 断言开/关两态。合同登记缺口见 N-11。 |
| **M-03** F5 残留自愈 | **CLOSED** | `healHistoryResidue()`（`526-537`）只在「hash 含 `#sidepeek=` 或 `history.state.__sidepeek`」时 `replaceState` 去 hash；构造期调用（`608-609`）；单测 `686-715` 双向验证（有残留清理一次 / 无残留不碰 history）。误伤面见 §2.3 与 N-06。 |
| **M-04** 前进重开标题 | **CLOSED** | `open()` 改为 `onOpen`（`1048`）在 `_resolveTitle`（`1049`）之前；单测 `623-680` 用「与 content.js 同语义」的 resolveTitle（首行即 `activeUrl !== url` 早退）复现前进重开并断言标题回填。竞态分析见 §2.4。 |
| **M-05** 暗色 token（PRD I-19） | **CLOSED（书面豁免）** | SPEC §8.2 已记录豁免；死 token `--sp-width` 已从 CSS 与 CSS_TEXT 双向删除（`peek-drawer.css:47-49` 注释 + `width: 62vw` 首帧兜底），全仓 grep 无 `var(--sp-` 残留。 |
| P-03/05/06/07/08/09/13/15/16/17a/b | **CLOSED** | P-03：`_isSameAsTopPage` 改为「仅完全相同」（`1649-1660`）+ 单测 `823-839`；P-05：`open()` 入口复位 `_closePending`/清 guard（`984-990`）+ 单测 `841-868`；P-06：删除 `_resolveCss` 与 `options.css`，样式只来自 `CSS_TEXT`（`650-656`）+ 单测 `870-889`；P-07：`normalizeSandboxTokens` 小写化 + guard 同口径比较（`450-506`、`839-842`）+ 单测 `467-473`；P-08：`finally` 移除 textarea（`1440-1458`）+ 单测 `891-906`；P-09：`document.fullscreenElement` 放行（`content.js:560-562`）+ 单测；P-13：http→https 归一（`content.js:95-119`、`146-148`）+ 单测；P-15：脚本增加反引号/`${`/首尾边界校验（`check-css-sync.mjs:55-70`）+ 单测 `924-930`；P-16：core↔content SANDBOX 一致性断言（单测 `912-918`，路径正则部分见 N-09）；P-17a/b：`_endDrag()` 去参数（`1558`）、`TOAST_DURATION_MS` 命名（`59`）。 |
| P-04/10/14/17c | **CLOSED（书面豁免）** | SPEC §8.2 有裁决；代码确认未被「实现一半」：拖拽条仍无 tabindex/方向键（P-14，`676-682`）、content 无去抖（P-10，`534-539`）、Esc 仍 `stopPropagation` 且注释已改准确（P-17c，`1328-1331`）、joint history 仍依赖 G-10 兜底（P-04，`1257-1312`）。 |
| P-12 | **CLOSED** | SPEC §8.4 补白：`.sp-toast` / `.sp-error-sub` / `.sp-error-actions` / 错误态按钮为合法附加节点。 |
| 真机证据（§0 更正项） | **CLOSED** | T7 报告 18/18，含跨源 D-3；`docs/T7-REAL-EXTENSION.md` 有完整记录。 |

---

## 2. 按 Lead 指定重点的逐项复核

### 2.1 B-01：四种收尾路径 × 三种时序

代码路径枚举：

| 触发 | 入口 | 还原动作 | 判定 |
|---|---|---|---|
| 正常 mouseup | `_handleDragEnd`（`1546-1552`） | `_endDrag` → 摘 document 监听、还原 cursor/user-select、`frame.style.pointerEvents=''`、persistWidth | ✔ |
| mouseup 丢失（释放到窗口外 / 事件被吞） | `_handleDragMove` 的 `event.buttons === 0` 分支（`1518-1523`） | `_endDrag()` 同上（**但少一次 persist，见 N-02**） | ✔（收尾成立） |
| 窗口失焦（Alt+Tab） | `window 'blur' → _handleDragEnd`（注册 `777-782`、解绑 `1140`） | 同正常 mouseup（含 persist） | ✔ |
| 拖拽中关闭（Esc / X / 遮罩 / 程序化 / destroy） | `_hide()`（`1267-1268`）与 `destroy()`（`1118-1119`） | `_endDrag()` | ✔ |

关键推演（Lead 点名的三种时序）：

1. **拖窄**：`_handleDragStart` 已把当前 iframe 设为 `pointer-events:none`（`1495-1500`），因此指针越过抽屉左缘后事件目标仍是顶层文档里的 `.sp-body`/`.sp-drawer`，`document` 上的捕获监听（`1503-1504`）持续收到 `mousemove`/`mouseup` —— 变窄方向不再断链。
2. **mouseup 丢失**：即使真的丢失，下一次无按键 `mousemove` 会因 `buttons === 0` 收尾；`window blur` 兜第二层；`_handleDragEnd` 被多路径调用且幂等（`_endDrag` 先清 rAF、再判 `_drag`，`1558-1564`）。
3. **关闭中途**：`close()` → `history.back()` → `popstate` → `_hide()` → `_endDrag()`；若 popstate 被吃掉，走 300ms guard（`1076-1084`）→ 同样 `_hide()`；`history.back()` 抛错路径也走 `_hide()`（`1065-1072`）。三条关闭落点都会收尾拖拽。

「pointerEvents 未还原」路径排查：全仓只有 `_handleDragStart:1500` 写入 `'none'`，只有 `_endDrag:1568` 写回 `''`；`_endDrag` 被 `_handleDragEnd` / `_handleDragMove` / `_hide` / `destroy` 四路调用且幂等，**不存在遗留残留 `none` 的路径**。唯一缺口反向：拖拽期间若 iframe 被重建（`_load:866-879`）新节点不会重新置 `none`（漏置而非残留，见 N-03，防御性）。

结论：B-01 的四条修复路径成立，未发现新泄漏；残余为「精度」（N-01）与「兜底路径不落盘」（N-02）两个 MINOR。

### 2.2 M-02：`inert` + `aria-hidden` 组合与 `_restoreFocus` 顺序

- 展开：`aria-hidden="false"`（`1017`）→ 摘 `inert`（`1019`）→ reflow → `.sp-open` → `_focusDrawer()`（`1029`）。先后正确，焦点不会撞上 inert。
- 收起：`_restoreFocus()`（`1286`）→ `aria-hidden="true"`（`1288`）→ `inert`（`1289`）。**先把焦点还回页面再设隐藏**，方向正确，与 `_restoreFocus` 不打架（`_prevFocus` 在 open 前捕获，必然在抽屉外）。
- axe：关闭态抽屉子树整体 `inert`（不可聚焦、不入 AT 树）+ `aria-hidden`，`aria-hidden-focus` 不应再触发；`aria-modal` 已移除（`672` 注释说明「无焦点陷阱就不声明模态」），所以也不会出现「声明模态却可逃逸」。
- 残余边角（N-04）：当 `_prevFocus` 是 `<body>` 这类不可聚焦元素时，`previous.focus()` 是 no-op，焦点可能仍在抽屉内，此时先设 `aria-hidden` 仍可能触发 Chrome 的 "Blocked aria-hidden ... descendant retained focus"。把 `inert` 提到 `aria-hidden` 之前即可彻底消除（inert 会同步 blur）。
- 需真机确认（非缺陷）：`inert` 在 Shadow DOM 内、对 iframe 子文档的键盘可达性，Chrome 155 按规范应成立，但请 QA 在「键盘 Tab 序列」用例里实测（关闭态 Tab 不得落进抽屉/iframe）。

### 2.3 M-03：自愈是否可能误伤 B 站 SPA

- 触发面严格受限：只在 `location.hash` 命中 `#sidepeek=` **或** `history.state.__sidepeek` 时动作（`529-531`）；B 站自己的 state/路由不使用该标记，正常页面零改动。单测 `704-715` 专门断言「无残留时 replaceState 一次都不调用」。
- 状态改法最小：只 `replaceState`（不 `pushState`、不触发 `popstate`），只去掉 hash；异常全部吞掉并 warn（`533-536`），不会抛进 B 站页面。
- 其它触发路径：只有构造函数（`608-609`）——这是**必要设计**：content 在页面加载时就构建抽屉（`content.js:614-637`），所以 F5 后无需用户点击就会自愈；若放到 `open()` 里则 F5 场景永远不执行。代价是单页内出现第二个实例时会误清当前抽屉的记账（N-06 给出零成本加固）。
- 时序风险：heal 发生在 `document_idle` + storage 回调（≤800ms）之后。若 B 站在这之前做了 `pushState` 且丢了 hash，则 heal 自然 no-op（残留已被 B 站覆盖，可接受）；不存在「清理到别人条目」的路径。

### 2.4 M-04：`onOpen` 提前是否引入标题竞态

- 适配层 `onOpen` 是同步写 `activeUrl`（`content.js:598-600`），`resolveTitle` 的第一道防串台依赖它（`content.js:459`）。`open()` 现在保证「先 onOpen 后 resolveTitle」，所以**前进重开路径**上 `activeUrl` 一定已就位。
- 竞态边界仍由三重 token 兜住：`_titleToken`（`open()` 每次 +1，`1036`；`_resolveTitle` 再 +1，`952`）、`_url !== url` 丢弃（`967`）、`_open` 判定（`967`）。旧请求无法覆盖新标题。
- 若适配层 `onOpen` 抛错：`_safeCall` 隔离（`1692-1701`），`activeUrl` 未更新 → `resolveTitle` 返回 null → 保留临时标题，退化为旧行为，不会崩。
- 单测用与 content 同语义的 resolveTitle 复现了这条链路（`623-680`），不是只测 core 自己。

### 2.5 新增单测是否「测了个寂寞」

结论：**不是假绿**，是真的在跑行为断言：

- 直接 `require('src/core/peek-drawer.js')` 跑真实实现，fake 的只是 DOM/BOM/History；断言对象是行为（sandbox 属性、inert 状态、history.length、`_drag` 状态、cursor 还原、监听净计数），不是「我调用了我自己的 mock」。
- 反向验证（删掉修复后哪条会红）：撤掉 `inert` → `510/523` 红；恢复 `aria-modal` → `512` 红；撤掉 iframe 命中开关 → `738` 红；撤掉 buttons 兜底 → `762` 红；撤掉 blur → `768/771` 红；撤掉 `_hide` 收尾 → `777` 红；改回双写 back → `579/588` 红；撤掉 healer → `695` 红；M-04 换回旧顺序 → `674/675` 红；`_resolveCss` 回归 → `884` 红；textarea 不清理 → `901` 红。
- 监听泄漏断言口径正确：`removeEventListener` 即使未命中也会计 -1，计数非零（含负数）即失败，不会漏报「摘错 capture 标记」。
- 覆盖缺口（N-07/N-08）：`MutationObserver` 被显式删除（`358-360`），所以 **sandbox 守护的「被外部改写后恢复」没有自动化断言**；`History` 是自研 fake（`249-294`），**无法模拟真实 joint session history 的子帧条目**，因此「`_load` 若回归成改 `src`」这类真实浏览器才能暴露的问题，单测仍会绿。

### 2.6 豁免项没有被「实现一半」

| 豁免项 | 复核 |
|---|---|
| M-05 暗色 token | 无 `prefers-color-scheme` 片段、无 token 体系残留；`--sp-width` 已彻底删除（CSS `47-49` 注释、JS `112` 注释，全仓无 `var(--sp-`）。 |
| P-04 joint history | 代码未改（继续依赖 G-10 兜底 + `_scheduleUnload` 移除节点），没有半套「循环 back」实现。 |
| P-10 去抖 | content 仍是「命中即 open」，无死代码/半成品去抖。 |
| P-14 键盘拖拽 | resizer 仍无 tabindex / 方向键，与豁免一致。 |
| P-17-c | 保留 `stopPropagation`，注释已改成准确表述（`1328-1331`），不是「改了但没改干净」。 |
| **M-02 附带删除 `aria-modal`** | 代码一致（全局无 `aria-modal`），但 **PRD I-20 仍写 `aria-modal="true"`，SPEC §8 未记录该偏离** → N-11。 |

---

## 3. 本轮新发现（全部 MINOR，不阻塞合并）

### 拖拽精度（B-01 的残留细节）

- **N-01 `_handleDragEnd` 取消 pending rAF 前没有应用最后一次位置，松手会「回弹」一帧**
  位置：`src/core/peek-drawer.js:1546-1552`（`_handleDragEnd` 直接 `_endDrag()`）、`1558-1562`（`_endDrag` 取消 rAF）。
  问题：mousemove 被节流到 rAF，`mouseup` 与最后一次 `mousemove` 常在同一帧；此时 `_handleDragEnd` 先 `_endDrag()` 会把未执行的 rAF 取消，最后一次位移既不进 `_appliedWidth`、也不进 `persistWidth`。
  为什么是问题：快速拖拽时一帧 ≈ 8~16px，用户会看到松手瞬间宽度轻微回弹，且落盘宽度与视觉略差；I-07 要求「实时跟随 + 松手持久化」。
  修复：`_handleDragEnd` 在 `_endDrag()` 之前补 `if (this._dragRaf) this._applyDragWidth();`（或在 `_endDrag` 里先 flush 再 cancel），并加一条断言「最后位置已生效」的单测。

- **N-02 `buttons === 0` 兜底收尾时不回调 `persistWidth`**
  位置：`src/core/peek-drawer.js:1518-1523`。
  问题：该分支调 `_endDrag()`（不持久化），而正常 mouseup 调 `_handleDragEnd()`（持久化）。
  为什么是问题：这正是「mouseup 丢失」场景——收尾正确但用户最后一次调宽没落盘，刷新后又回到旧宽度，与 I-07「松手持久化」不一致。
  修复：该分支改调 `this._handleDragEnd()`（它内部读 `_appliedWidth` 并 persist，且幂等），与正常路径统一。

- **N-03 拖拽期间 iframe 被重建时，新 iframe 不会重新关闭命中（防御性）**
  位置：`src/core/peek-drawer.js:866-879`（`_load` 的 rebuild 分支）与 `1495-1500`。
  问题：`pointer-events:none` 只写在 `_handleDragStart` 当下那个 iframe 上；若拖拽期间发生 `_load` 重建（可达路径很窄：拖拽中触发 popstate 前进到 peek 条目 → `open()` → 换 URL 走 rebuild），新 iframe 恢复默认命中，拖窄又会断链。
  为什么是问题：概率低但属于 B-01 的同类缺陷，且修法只有一行。
  修复：`_load` 新建 frame 后加 `if (this._drag) this._frame.style.pointerEvents = 'none';`（或抽一个 `_applyFrameHitTest()` 在 start/load 两处调用）。

### 焦点 / 可访问性

- **N-04 `_hide` 中 `aria-hidden` 先于 `inert`，`_restoreFocus` 失效时仍可能触发 Chrome "Blocked aria-hidden"**
  位置：`src/core/peek-drawer.js:1283-1290`；`_restoreFocus` `1675-1689`。
  问题：`_prevFocus` 若是 `<body>` 等不可聚焦元素，`previous.focus()` 是 no-op，焦点仍在抽屉内时执行 `aria-hidden="true"` → Chrome 会拦截该属性（并警告），关闭态可能仍暴露给 AT。
  为什么是问题：M-02 的目标就是「关闭态彻底不可达」，这条边角会让目标在少数路径上打折。
  修复：把 `inert` 提到 `aria-hidden` 之前（inert 会同步 blur，之后设 aria-hidden 就不会有焦点冲突）；或在 `_restoreFocus` 失败时显式 `document.body.focus()` 兜底。

- **N-05 `inert` 有浏览器版本下限（Chrome 102+），manifest 未声明**
  位置：`src/core/peek-drawer.js:673`（`inert`）；`manifest.json`（无 `minimum_chrome_version`）。
  问题：Chrome 88~101 支持 MV3 但不支持 `inert`，M-02 的强保证会退化为仅 `aria-hidden`（Tab 仍可落入关闭态抽屉）。
  为什么是问题：声明版本下限既能表达依赖、也能避免低版本用户遇到「焦点跑到看不见的按钮」。
  修复：`manifest.json` 加 `"minimum_chrome_version": "102"`（dev-ext 一行改动）。

### 测试与证据口径

- **N-06 M-03 自愈放在构造函数里，缺少「只执行一次」的模块级护栏**
  位置：`src/core/peek-drawer.js:526-537`、调用点 `608-609`。
  问题：F5 自愈必须发生在「实例化时」而不是 `open()` 时（这点是对的），但实例化即清理意味着同页第二个实例会把**当前正在打开**的抽屉记账（hash + `state.__sidepeek`）清掉，`close()` 会退化成直接 `_hide()` 并留下多余历史条目。
  为什么是问题：当前 content 只建一个实例，属于潜在隐患；一旦将来做「多入口/热重载自愈/QA 手动 new」就会踩到。
  修复：模块级 `var historyHealed = false;` + 首次实例才执行（保留 F5 行为，去掉多实例风险）。

- **N-07 `_guardSandbox` 仍无自动化测试（安全命门的唯一未覆盖分支）**
  位置：`tests/unit/peek-drawer.test.js:358-360`（显式 `delete globalThis.MutationObserver`）；被测实现 `src/core/peek-drawer.js:827-845`。
  问题：M-01 补齐了 core 的大部分风险点，但「sandbox 属性被外部改写/移除后恢复」这条只有实现没有断言；T7 也只断言初始 sandbox 值（C-5/D-5），不覆盖被改写。
  为什么是问题：SPEC 三条硬约束之一，一旦有人改坏了 observer 的 `attributeFilter`/恢复逻辑，所有现有测试仍全绿。
  修复：在 fake 环境里注入一个最小 `MutationObserver`（记录 observe/callback，测试里手动触发回调），断言：被改成 `allow-scripts allow-top-navigation` 后回写为 `SANDBOX`；被 `removeAttribute` 后也恢复；正常值不反复写。

- **N-08 单测的 History 是 fake，I-10 的「joint session history 不增长」无法被单测证伪**
  位置：`tests/unit/peek-drawer.test.js:249-294`（fake history 只在 pushState 时增长）、`623-680`（I-10 断言）；`tests/integration/real-extension-check.mjs:356-372`（只断言地点 URL，不查 history）。
  问题：如果 `_load` 回归成「复用节点改 `src`」，真实浏览器会追加子帧条目、破坏 I-10，但 fake history 看不到子帧条目，单测仍绿；T7 也没有 `history.length` / back-forward 断言。
  为什么是问题：SPEC §7 明确写「任何再动 iframe 生命周期的改动必须回归验证 I-10 与 `history.length` 不增长」，当前这条约束只有注释、没有可执行的回归防线。
  修复：T7 脚本加一条真机断言（open → close → forward 后 `history.length` 不变、且 forward 能重开），或在单测注释里显式标注「本约束仅真机可验，回归时必须跑 T7」。

- **N-09 P-16 只做了 SANDBOX 一致性，路径白名单仍双份无护栏**
  位置：`src/content.js:32-37`（`PEEK_PATH_PATTERNS`）与 `src/background.js:29-30`（`PEEK_PATH_RE`）。
  问题：G-09 的收窄动作是「删掉 content.js 白名单里的一行」，background 的正则不会同步；虽然影响仅限「多抓一个标题」，但正是 REVIEW-01 P-16 提到的漂移面。
  修复：单测里分别加载 content/background 导出的正则，对同一组正反例断言结论一致（或让 background 的允许集直接由 content 的 patterns 文本派生校验）。

- **N-10 文件头注释仍写着已删除的 `options.css`**
  位置：`src/core/peek-drawer.js:15`（「需要主题覆盖时可在构造参数里传 options.css」），但 `DEFAULTS`（`40-53`）与 `_resolveCss` 已按 P-06 删除。
  问题：注释与实现相反，后续维护者会以为存在主题注入通道。
  修复：删除该句，或改成「v0.1 不提供主题覆盖，样式唯一来源是 CSS_TEXT」。

- **N-11 删除 `aria-modal` 未写入 SPEC（PRD I-20 偏离未登记）**
  位置：`src/core/peek-drawer.js:667-673`；PRD I-20 仍要求 `aria-modal="true"`；SPEC §8.1 只写了「M-02 采纳并修复」，未提 `aria-modal`。
  问题：代码是对的（无焦点陷阱就不该声明模态，`672` 注释已说明），但验收口径没同步——QA 按 PRD I-20 复核会记一条「缺 aria-modal」的缺陷。
  修复：SPEC §8.1 补一行「M-02 同时移除 `aria-modal`（原因：无焦点陷阱）；PRD I-20 相应改为非模态 dialog」，并同步 PRD/QA 用例。

- **N-12 证据口径两个小瑕疵（跨角色提醒，非代码缺陷）**
  1. `tests/e2e/dist/sidepeek-e2e-bundle.js` 是 **03:11 的旧快照**：其 manifest 记录 `peek-drawer.js` 57673 B / `content.js` 21290 B，而当前源码是 65152 B / 25367 B；`tests/e2e/serve-bundle.mjs:84-98` 原样服务 dist、不校验 sha。QA 若直接复用它采集验收证据，测到的是**修复前**的代码 → 必须先 `node tests/e2e/build-initscript.mjs` 重建（dist/ 已被 .gitignore 忽略，不在提交里，属本地状态问题）。
  2. `docs/T7-REAL-EXTENSION.md:69` 的 C-6 记的是 `BV1Jcnd6kEQ3`，而当前 `real-extension-report.json` 的 C-6 是 `BV1BBnb6aEww` —— 说明文档表格来自另一次 run，建议以最终 report 重写表格，避免下次再出现「文档与报告对不上」。

---

## 4. 合并/发布门禁提醒（不是缺陷，但 Gate 3 前必须满足）

1. **B-01 的真机验证**：单测只验证了机制（关命中、兜底、收尾、还原），真正的「hit-test 不再落到 iframe」只能在真实浏览器里证明。QA 必测：从抽屉左缘向右**快速**拖到屏幕中部再松手 → 宽度跟手、松手后 `documentElement.style.cursor/userSelect === ''`、刷新后宽度为新值（这条同时验证 N-01/N-02 的修复效果）。
2. **键盘可达性实测**：关闭态 Tab 不得落进抽屉/iframe（验证 `inert` 在 Shadow DOM 内生效）；关闭时焦点落入 iframe 后按 Tab 应回到页面。
3. **I-10 真机回归**：后退关闭 + 前进重开 + `history.length` 不增长（N-08 的补救）。
4. **已知限制成文**：P-04（iframe 内导航向联合历史追加条目）、P-14（调宽需鼠标）、M-05（无暗色主题切换）必须在 README/USAGE 的「已知限制」里出现（SPEC §8.2 的要求，文档属 W6 范围）。
5. QA 采集 E2E 证据前重建 bundle（N-12）。

---

## 5. 结论

**PASS**

- BLOCKER：0（B-01 已闭环，四条收尾路径 + 三种时序均成立，未引入监听/命中泄漏）
- MAJOR：0（M-01~M-04 已闭环并有可执行证据；M-05 已按 SPEC §8.2 书面豁免）
- MINOR：12 条（N-01 ~ N-12），全部不阻塞合并；建议在 W4-2 之后的 v0.1.1 或 QA 反馈修复轮一并处理。若时间允许，**N-01 / N-02 / N-04 / N-11** 这四条值得在本轮直接修（都是几行改动，且分别影响拖拽手感、宽度持久化、关闭态 a11y 保证、以及 QA 验收口径）。

REVIEW-01 中不属于代码缺陷的两条结论（跨源场景缺失、旧报告 FAIL）已按 SPEC §8.3 撤回，不再计入任何轮次。
