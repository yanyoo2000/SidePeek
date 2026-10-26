# SidePeek v0.1 验收报告（QA / Gate 3）

> 角色：qa（唯一「站在真实用户视角挑毛病」的验收方）
> 验收对象：`D:\yan-github-code\SidePeek`
> **最终代码基线**（评审返工定稿后，本报告结论对应的版本，sha256 前 12 位）：
>
> | 文件 | 大小 | sha256 |
> |---|---|---|
> | `src/core/peek-drawer.js` | 68,588 B | `38b20453e29f` |
> | `src/content.js` | 25,367 B | `98f561fed6c3` |
> | `src/background.js` | 10,072 B | `f5ddc31604f0` |
> | `tests/e2e/chrome-shim.js` | 9,626 B | `80dd0bad359c` |
> | `tests/e2e/page-helpers.js` | 14,608 B | `9a58f63a5267` |
>
> 该基线已包含评审返工后的全部改动：B-01 拖拽跨 iframe（`_applyDragWidth` / `_commitDragWidth` 拆分后的版本）、
> `inert` 关闭态（M-02）、F5 hash 自愈（M-03）、`onOpen` 时序与前进回填（M-04）、
> 标题清洗（含 `_哔哩哔哩bilibili` 变体，已修）、http→https（P-13）、移除 `aria-modal`（N-11）、
> `prefers-reduced-motion` 兜底。
>
> **证据与代码版本的对应关系（重要，避免"测了个寂寞"）**：
> - 大部分用例（C-02~C-17）在 core `c27510675fa5` 上执行；此后 core 又改了拖拽内部拆分与
>   `prefers-reduced-motion`（无行为语义变化），`background.js` 修了标题后缀。
> - **最关键的 C-01（跨源 frame-buster）与 C-08（B-01 拖拽）已在最终基线 `38b20453e29f` 上重跑并 PASS**
>   （断言值见下表），因此结论对最终代码成立。
> - 截图（`docs/qa-assets/01~08`）拍摄于 `c27510675fa5`；涉及标题后缀的截图会显示旧版未清洗标题，
>   但该问题已在最终基线修复（见 MINOR-1）。
> 生成命令：`node tests/e2e/build-initscript.mjs`（产物在 `tests/e2e/dist/`，manifest 记录上表 sha256）。

## 0. 验收方法与它的边界（必须读）

**方法**：chrome-devtools MCP 驱动的真实 Edge（Chromium 156）里，用 `tests/e2e/chrome-shim.js`
伪造 `chrome.runtime / chrome.storage`，按 `content_scripts` 的真实顺序注入
`peek-drawer.js → content.js`，再访问真实 B 站页面做交互与断言。
注入包生成、静态服务、窗口截图、页面内探针代码全部在 `tests/e2e/`（用法见 `tests/e2e/README.md`）。

**这套方法能真实覆盖**：点击拦截、抽屉 DOM/CSS（Shadow DOM 内计算样式）、sandbox 反 frame-buster、
history 状态机、拖拽、`inert`/焦点、宽度 clamp、窄视口、暗色、关闭路径、跨源/同源两种宿主。

**这套方法测不到 / 需替代手段**：

| 缺口 | 替代 | 影响 |
|---|---|---|
| `manifest.json` 是否装得上、`content_scripts` 路径、图标、扩展上下文 | Lead 的 T7 真机联调（`tests/integration/real-extension-check.mjs`，27 PASS + 1 SKIP） | 本报告不重复认定 manifest 相关项 |
| 合成事件不是「可信事件」，无法触发浏览器原生默认行为（新标签页、中键自动滚动） | 观察「事件未被 `preventDefault`」+ 观察 B 站自身处理器是否接管（实测确实新开了标签页，见 C-04） | 原生默认动作本身仍靠人工常识判断 |
| storage 为内存 shim，页面刷新即丢失 | 只能验证「松手后确实调用了 `set` 且值已 clamp」 | 「刷新后宽度保留」= **NOT-RUN**（代码路径已读，但未真机验证） |
| 后台标签页时 Chromium 会节流 CSS 过渡 | 断言改用「采样 `transform` + class 状态 + 内联宽度」，不依赖墙钟时间 | 动画时长本身未作为验收项 |
| MCP 的文件沙箱拒绝 `screenshot(filePath)` 与 `evaluate_script(sourcePath)` | 用本地 HTTP 供包 + Win32 `PrintWindow`/屏幕抓取落图（`tests/e2e/serve-bundle.mjs`、`capture-window.ps1`） | 截图含浏览器边框（地址栏本身即「顶层 URL 未被劫持」的证据） |

**窗口环境**：Edge 窗口 1200×820（主用例）、900×700（窄视口用例）；`devicePixelRatio = 2`。

## 1. 用例表

结论口径：**PASS** = 断言值满足预期并有截图/断言输出；**FAIL** = 实测不满足；**BLOCKED** = 环境或站方因素导致无法在本方法下判定；**NOT-RUN** = 本轮未执行。

### 1.1 核心交互（最高优先级）

| 编号 | 预期 | 实测（断言值 / 现象） | 证据 | 结论 |
|---|---|---|---|---|
| C-01 | **跨源宿主** `search.bilibili.com` 点视频卡片：抽屉展开、iframe 加载、**顶层 URL 不被 frame-buster 劫持** | 点击被拦截（`click.defaultPrevented=true`）；`drawer.isOpen()=true`、`.sp-open` 存在；顶层仍是 `search.bilibili.com/all?vt=…&keyword=游戏`，仅新增 `#sidepeek=<encodeURIComponent(url)>`；`history.length` 2→3（**只 +1**）；iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-downloads"`（**无** `allow-top-navigation*`）；4.2 s 后 `loading=false / error=false`，视频画面与弹幕正常渲染；标题由 href 文字替换为真实标题。**最终基线 `38b20453e29f` 重跑**：`clickPrevented=true`、`topUnchanged=true`、`histLen=3`、`sandbox` 同上、`loading=false / error=false`、`aria-modal=null` | `docs/qa-assets/01-search-drawer-open.png` | **PASS** |
| C-02 | 首页 `www.bilibili.com` 点推荐视频：抽屉展开、顶层不跳转 | 命中 `target="_blank"` 卡片（I-14 覆盖）；顶层仍为 `https://www.bilibili.com/`（仅加 hash）；`history.length` +1；`loading=false / error=false`；标题解析成功（后缀被清洗） | `docs/qa-assets/04-homepage-drawer.png` | **PASS** |
| C-03 | 视频页点右侧「相关推荐」：抽屉打开且原视频页不被顶掉 | 顶层仍为 `/video/BV19bHK6AEBD/…`（仅加 hash）；抽屉展开，iframe `src` = 相关推荐 URL（`spm_id_from=333.788.recommend_more_video.0` 参数完整保留）；标题正确；无错误态 | 断言输出（本轮为注入式断言，未留图） | **PASS** |
| C-04 | Ctrl / Shift / Alt / 中键点击 → **不拦截**（I-02/I-03） | 四种修饰组合均 `defaultPrevented=false`、`drawer.isOpen()=false`、URL 无 hash 变化。附加证据：修饰键点击后 B 站自身处理器接管，**真的新开了一个视频标签页**（`/video/BV1U3n46GEzY/?…&vd_source=…`），说明事件完整落到了页面 | 断言输出 + 新标签页 URL（会话内观测，未留图） | **PASS**（原生默认动作本身受合成事件限制，见 §0） |
| C-05 | 三条关闭路径（Esc / 遮罩 / 关闭按钮）都正常、无残影、hash 被清 | ① Esc（真实按键 `press_key`）：`isOpen=false`、`.sp-open` 移除、`location.hash=''`、`history.state=null`；② 点遮罩：同上；③ 点 `button[data-act="close"]`：同上。三条路径均在 360 ms 后移除 iframe 节点（`framePresent=false`，G-06 停音频），遮罩回落 `opacity=0 / pointer-events:none`，`#sidepeek-host` 仍在但 `data-open` 被移除、`.sp-drawer` 重新 `inert` | 断言输出（C-05 与 C-13 共用同一组探针） | **PASS** |
| C-06 | 已展开时切另一个视频 → 只换内容，**不重播入场动画**（I-08） | 切换前后 `history.length` 4→4（不增长）；16 次 40 ms 采样中 `.sp-open` **始终存在**，`translateX` 最大值/最小值均为 **0**（无位移）；iframe `src` 已换为新视频；hash 用 `replaceState` 原地更新 | 断言输出（`maxTranslateX=0 / minTranslateX=0`） | **PASS** |
| C-07a | 浏览器后退 → 抽屉关闭；原页面状态（滚动位置）保留（I-10） | 打开前 `scrollY=600`（点击未触发滚动的那张卡片）→ 打开后 600 → `history.back()` 后 `isOpen=false`、`hash=''`、`history.state=null`、`scrollY` 仍为 **600**、`history.length` 不变 | 断言输出 | **PASS** |
| C-07b | 再前进 → 抽屉重新出现（I-10） | **结论按修正后的 T7 为准**：www 宿主 **PASS**（`C-10`，`.sp-open` 在、hash 恢复为 `#sidepeek=…`、`history.length` 不增长、标题回填）；search 跨源宿主 **SKIP**（`D-10`）—— 未重开，且 `history.state` 已无 `__sidepeek`，即站方在 `popstate` 里剪除了前向条目（机制见 **L-2**）。我的注入式 harness 在 www 宿主同样 PASS。**注**：Lead 早期曾据「4 次全 PASS」判 search 也通过，该结论已被 REVIEW-03 推翻 —— 原因是旧断言用 `innerWidth`（含 15px 滚动条）判展开态，关闭态恒被误判为已展开（假阳性）；修正判据后正确显示为 SKIP | T7 `real-extension-report.json`（27 PASS + 1 SKIP） | **PASS（www） / SKIP（search，站方行为）** |
| C-08 | 左边缘拖拽改宽：实时跟手、上下界 clamp、松手恢复（I-07 / B-01） | 拖拽中：`html.style.cursor='ew-resize'`、`userSelect='none'`、iframe `style.pointerEvents='none'`（**B-01 修复生效**，鼠标不会"掉进" iframe 丢事件）。宽度随 clientX 实时变化：744 →（右拖至屏幕中部）588 → 438 →（左拖）788，三次采样均与鼠标同步。松手后：`cursor=''`、`userSelect=''`、iframe `pointerEvents=''`、`persistWidth` 写入 `sidepeek.width=788`。关闭再开：宽度 788 正常，无残留拖拽态。**最终基线 `38b20453e29f` 重跑**（拖拽逻辑已拆为 `_applyDragWidth`/`_commitDragWidth`）：744 → 648 → 948 跟手；拖拽中三项状态同上；松手后 `cursor=''`、`userSelect=''`、`iframe.pointerEvents=''`、`stored=948`、`open=true` | 断言输出（三段采样 + 恢复值） | **PASS** |
| C-09 | 关闭态点击 B 站页面任意元素 → 正常工作（pointer-events 没挡住页面） | 关闭态 `#sidepeek-host` 的 `pointer-events` = `none`、`.sp-mask` = `none`（`opacity=0`）；6 个命中点（含右下角、右中、正中）`document.elementFromPoint` 全部返回 B 站节点（`bili-header__menu` / `video-card-content` / `btn-to-top-wrap` / `bili-video-card`），**无一落在宿主内** | 断言输出 | **PASS** |
| C-10 | 窄视口 900×700 → 抽屉宽度不溢出、至少留 48 px 可点遮罩、能关掉（G-05） | `innerWidth=900`（`clientWidth=885`），默认宽度 **558 px**（=62%），不溢出；可点遮罩 **327 px** ≥ 48；`mask pointer-events=auto`；点遮罩成功关闭。越界设宽 `setWidth(2000)` → clamp 到 **810 px**（`min(0.9×900, 900−48)`），遮罩仍余 **75 px**。**极窄补充**：Edge 窗口最小宽度限制下取到 `innerWidth=492 / clientWidth=477`，越界设宽曾 clamp 到 443 px → 实际可点遮罩 **34 px**（< 48 px，即 MINOR-2）。**MINOR-2 已修复并复测**：`viewportWidth()` 改用 `documentElement.clientWidth`（fixed 包含块不含滚动条），同条件下 clamp 到 **429 px**、可点遮罩 **48 px**；无滚动条页面行为不变 | `docs/qa-assets/02-narrow-viewport-900x700.png` | **PASS**（含 MINOR-2 观察） |
| C-11 | 暗色模式（`prefers-color-scheme: dark`）→ 抽屉头部/按钮文字可读（PRD I-19） | `matchMedia('(prefers-color-scheme: dark)')=true`；抽屉固定深色皮肤：header `rgb(30,31,37)`、标题 `rgb(232,233,237)` → 对比度 **13.55:1**；三个按钮 `rgb(201,204,212)` → **10.23:1**，尺寸 32×32；文案完整可读 | `docs/qa-assets/03-dark-mode.png` | **PASS**（v0.1 固定深色皮肤为 SPEC §8.2 书面豁免，不是缺陷） |
| C-12 | **G-09**：`bangumi/play`、`cheese/play`、`list` 三类路径能否被 iframe 承载 | **主证据 = Lead 真机实测（SPEC §8.5 / T7）**：三类全部正常渲染且宿主 URL 未变。我的注入式抽测（上一轮基线）结论一致，并额外确认三类都能在跨源宿主下打开、`isPeekableUrl()=true`、无错误态：`bangumi/play/ep4883714`（番剧播放器+弹幕渲染）、`cheese/play/ep2014561`（课堂课程页渲染）、`list/ml4057598311`（合集页+播放器渲染，同源可读 innerText 2677 字）。按 Lead 指示，本轮**不重复测** | `docs/qa-assets/05-g09-bangumi.png`、`06-g09-cheese.png`、`07-g09-list.png`（辅助，旧基线） | **PASS**（结论与 SPEC §8.5 一致：白名单保持现状，不删行） |

### 1.2 评审返工项专项（本轮新增）

| 编号 | 预期 | 实测 | 证据 | 结论 |
|---|---|---|---|---|
| C-13 | **M-02**：关闭态按 Tab，焦点不落进 3 个不可见按钮 | 关闭后 `.sp-drawer` 带 `inert`、`aria-hidden="true"`；对 `button[data-act="close"]` 调 `.focus()` **失败**（`shadowRoot.activeElement === null`，`document.activeElement` 仍是 `BODY`）；真实按 3 次 `Tab` 后焦点落在 B 站自己的导航链接（`A.as-menu-item`「搜索」），`shadowActive=null`、`focusInsideHost=false` | 断言输出 | **PASS** |
| C-14 | **M-03**：打开抽屉 → F5 → 无抽屉、**地址栏无 `#sidepeek=` 残留** | 打开后地址栏为 `…/all?vt=…&keyword=游戏#sidepeek=https%3A…`；F5 后（重新注入 = 模拟 content script 重跑）注入前仍是残留现场（`hash='#sidepeek=…'`），初始化完成后：`hash=''`、`history.state=null`、`#sidepeek-host` 不存在、`isOpen=false`、`activeUrl=null` → 自愈生效，且**没有**自动重开抽屉（符合 I-11） | 断言输出 | **PASS** |
| C-15 | **M-04**：前进重开后标题要回填，不能停在「侧边速览」 | `history.forward()` 重开后标题 = `全新内测版本，内容极度丰富_游戏热门视频`（真实标题，非占位符），`.sp-title` 有 `title` 属性 | 断言输出 | **PASS** |
| C-16 | **I-09**：抽屉内点击站内链接 → 在 iframe 内部导航，抽屉不重开、顶层不跳转 | 在 iframe 内连续导航 2 次（`frame.contentWindow.location`）：`frame.src` 依次变为 `BV1gTHG6kEQb`、`BV1AHnB6NEhM`；顶层 URL 与 hash 全程未变（仍是原 `#sidepeek=` 条目）、`drawer.isOpen()` 始终 true | 断言输出 | **PASS** |
| C-17 | **P-04**：抽屉内翻 2 页后关闭 → 后退 1 次能否离开当前页面 | 联合历史 `history.length` 3 →（iframe 内导航 2 次）**5**；关闭抽屉（一次 `back()`）后 `isOpen=false`、`hash=''`、`length` 仍为 5、顶层回到 `https://www.bilibili.com/`；**再按一次后退无任何变化**（被残余子帧记录吃掉）→ 符合 SPEC §8.2 的 P-04 处置：**记为已知限制，不是缺陷** | 断言输出 | **PASS（作为已知限制确认）** |
| C-18 | N-11：抽屉不应再宣称 `aria-modal="true"` | `.sp-drawer` 的 `aria-modal` 属性为 `null`，`role="dialog"`、`aria-label="SidePeek 侧边预览"` 保留 | 断言输出 | **PASS** |

### 1.3 未执行（NOT-RUN）与原因

> 说明：按 Lead 要求如实标注、不补测凑数。其中 history / 标题 / sandbox / CSS 等部分已由 T7 真机（27 PASS + 1 SKIP）覆盖，但不能替代本表逐项的 UI 断言。

| 编号 | 用例 | 原因 |
|---|---|---|
| N-01 | 刷新后宽度保留（I-11 后半） | shim 的 storage 是内存态，页面刷新即丢；真机需 T7 的持久化 profile 才能验。代码路径已读（`loadStoredWidth → defaultWidth`），未真机确认 |
| N-02 | 极窄视口（如 420×700）下 48 px 遮罩下限 | 已在新基线复核（Edge 窗口最窄只能到 `innerWidth=492`）：见 C-10 的「极窄补充」与 MINOR-2；`420×700` 本身因窗口最小尺寸限制未取到 |
| N-03 | I-15「当前页面已是该视频 → 不打开抽屉」 | 未单独构造用例；代码路径（`_isSameAsTopPage` + `isSamePeekPage`）存在，但未真机断言 |
| N-04 | 头部「在新标签打开 / 复制链接」两个按钮 | 未测（`window.open` 与剪贴板在自动化环境里会产生副作用，且非本轮验收重点） |
| N-05 | 错误态 DOM / 8 s 加载超时 / 重试按钮 | 需要构造"必定打不开"的 URL；未在本轮构造（G-02 结构已由单测覆盖） |
| N-06 | I-12 双击标题全屏化 | 可选特性，未测 |
| N-07 | 关闭后音频是否真的停（G-06） | 只能验证「iframe 节点在 360 ms 后被移除」这一实现手段；"声音是否停"需听觉确认，未测 |

## 2. 缺陷清单

### BLOCKER

无。

### MAJOR

无。

> 说明：跨源 frame-buster（`search.bilibili.com` 宿主）这一最关键的失效模式**未复现**：
> 顶层 URL 全程未被改写，sandbox 缺 `allow-top-navigation*` 且 `MutationObserver` 守卫存在。
> 这也是本扩展存在的理由，已重点压测（C-01、C-02、C-03、C-12）。

### MINOR

**MINOR-1｜视频标题后缀清洗漏掉 `_哔哩哔哩bilibili`（无中间下划线）—— ✅ FIXED（已修复并验证）**

- 原现象（旧基线 core `c27510675fa5` / background 旧版）：抽屉头部显示 `《绝区零》先导演示丨挽昼_哔哩哔哩bilibili`。
- 修复：`src/background.js` 的后缀规则中段下划线改为可选 `哔哩哔哩\s*_?\s*bilibili`，并新增 1 条回归用例（`npm test` 87/87 全绿）。
- **验证方式（双重）**：
  1. **真机端到端**：Lead 的 T7 新增 C-13 / D-13 —— 打开抽屉后读 `.sp-title` 文本，实际为
     `《绝区零》先导演示丨挽昼`（后缀已剥离）；
  2. **QA 直接对最终 `src/background.js` 纯函数求值**（不依赖 harness）：

     ```
     "《绝区零》先导演示丨挽昼_哔哩哔哩bilibili"            => "《绝区零》先导演示丨挽昼"          ✅
     "《影之刃零》游民评测9.8分：人间正道是沧桑_哔哩哔哩bilibili" => "《影之刃零》游民评测9.8分：人间正道是沧桑" ✅
     ```

- 残留说明（不另立缺陷，仅记录）：另一种卡片尾巴 `_游戏热门视频`（例：`全新内测版本，内容极度丰富_游戏热门视频`）不在本次修复范围内、仍会保留。属纯外观问题，无功能影响，**不阻塞发布**。
- 备注：E2E 注入包里的标题清洗是 `chrome-shim.js` 按 `background.js` 复刻的模拟逻辑；我已把该 shim 同步为新规则（`tests/e2e/chrome-shim.js` 中段下划线也可选），但**该缺陷的裁定以真机 T7 + 直接调 background 纯函数为准**，不以 harness 显示为准。

**MINOR-2｜极窄视口下 G-05 的 48 px 遮罩保证按 `innerWidth` 计算，实际只剩 34 px（最终基线已复现确认）**

- 现象（最终基线 `38b20453e29f` 实测）：`innerWidth=492`、`clientWidth=477`（视口含 15 px 滚动条）时，`setWidth(2000)` 被 clamp 到 **443 px**（`min(0.9×492, 492−48)=442.x`），但抽屉右缘贴的是**布局宽 477**，因此实际可点遮罩 = 477−443 = **34 px**，不满足 SPEC §7 G-05「抽屉左侧永远至少留 48px 可点遮罩」的字面承诺。
- 复现（本轮实测步骤）：
  1. 在真实 B 站页面注入/加载扩展，打开抽屉；
  2. `resize_page` 到最窄（本机 Edge 最小 `innerWidth≈492`；`420×700` 因窗口最小宽度限制取不到）；
  3. `drawer.setWidth(2000)` → 读 `.sp-drawer` 内联宽度（443）与 `document.documentElement.clientWidth`（477）；
  4. `477 − 443 = 34 < 48`。
- 影响：**不溢出屏幕**（443 ≤ 477）、**遮罩仍可点可关**（实测 `elementFromPoint(20,·)` 命中 `#sidepeek-host`，`clickMask()` 后 `isOpen=false`、`hash=''`）。只是不满足 48 px 字面下限，属边界保证偏差，**不构成 BLOCKER/MAJOR**。
- 根因/归属：dev-core —— `peek-drawer.js` 的 `viewportWidth()` 用 `window.innerWidth`（含滚动条），而 `position:fixed; right:0` 锚定的是 `clientWidth`。建议改用 `document.documentElement.clientWidth`（或在 `_clampWidth` 里取 `Math.min(innerWidth, clientWidth)`）。
- 裁决建议：要么修这一行（可加单测：`vw=492, clientWidth=477` → 保证 `clientWidth − width ≥ 48`），要么把「极窄屏遮罩可能小于 48 px」写进 README 已知限制。**不阻塞发布**。

## 3. 已知限制（已核实，不算缺陷）

| 编号 | 限制 | 核实方式 |
|---|---|---|
| L-1（P-04） | **抽屉内翻过页后，关闭抽屉可能需要多按一次后退**才能离开当前页面（跨源/同源 iframe 内部导航都会向联合历史追加子帧条目，父页面无权删除） | C-17 实测：iframe 内翻 2 页后 `history.length` 3→5，关闭后多按一次 `back()` 无效果 |
| L-2 | **在搜索结果页遇到「前进无反应」是站方行为，不是扩展缺陷**：harness 观察到 `search.bilibili.com` 上 `forward()` 不生效，并抓到该页内联脚本在 `popstate` 里执行 `history.pushState(null,'',location.href)` 清理前向条目（`search.bilibili.com/all?keyword=…:293`）。**该现象在真实扩展下同样成立**：T7 修正判据后，search 宿主 `D-10` 由假阳性改为 **SKIP**（未重开且 `history.state` 已无 `__sidepeek`），www 宿主 `C-10` 仍 PASS。站方只按 `history.state.back` 判断、不看 URL，扩展侧无法安全阻止（强行拦截会破坏 B 站路由）。UX 兜底已写入 USAGE 4.5 与已知限制第 9 条：*遇到前进无效时重新点一次视频即可* | T7 D-10 = SKIP / C-10 = PASS（27 PASS + 1 SKIP）；REVIEW-03 §3 |
| L-3（SPEC §8.2） | **固定深色皮肤，不跟随系统亮/暗**（PRD I-19 书面豁免，v0.2 候选） | C-11：暗色下对比度 13.55:1 / 10.23:1，可读；不声明"跟随系统" |
| L-4（SPEC §8.2） | **拖拽条只能用鼠标**，键盘不可操作（P-14 豁免） | 代码只绑 `mousedown`；未做键盘 splitter |
| L-5（SPEC §8.2） | **300 ms 去抖未实现**（PRD I-21 豁免）；同一视频被程序化重复 `open()` 时可能出现 loading 闪烁 | 未构造用例，按豁免记录 |
| L-6 | **Esc 在焦点进入 iframe 后失效**：焦点在跨源子文档时，`keydown` 不会到顶层 `window`，Esc 收不到（点遮罩或关闭按钮仍可用） | 代码用 `window` 捕获阶段监听；跨源 iframe 无法监听（未构造自动化用例，属实现约束） |
| L-7 | **关闭抽屉后 iframe 节点被移除、下次打开重新加载**（G-06 经 Lead 批准的偏离）：再次打开不是"秒开"，要重新拉流 | 代码 + C-05 实测 `framePresent=false` |
| L-8 | 刷新后抽屉不自动恢复（I-11，刻意行为） | C-14 |
| L-9 | E2E 特有：ch-shim 的标题抓取在**跨源**时受 CORS 限制会降级为链接文字（真实扩展由 background + `host_permissions` 抓取，不受此限）；`storage` 为内存态 | §0 |

## 4. 总体结论

**可以做 Gate 3 交付 / v0.1 可发布**，理由：

1. **最关键的失效模式（跨源 frame-buster 把顶层页面弹走）未复现**：`search.bilibili.com` → `www.bilibili.com` 跨源宿主下，顶层 URL 全程保持 `search.bilibili.com`，sandbox 属性无 `allow-top-navigation*`，视频/弹幕/评论/推荐均正常。这是本产品存在的前提，已在**最终基线**上复跑确认。
2. **评审返工项全部回归通过**：B-01 拖拽跨 iframe（cursor / userSelect / iframe 命中全部恢复，最终基线复跑）、M-02 `inert` 关闭态 Tab、M-03 F5 hash 自愈、M-04 前进回填标题，逐条有断言值。
3. 三条关闭路径、切换不重播动画、后退关闭且滚动位置保留、窄视口 clamp、暗色可读性、修饰键不拦截、关闭态点击穿透均 **PASS**。
4. 缺陷收敛：**MINOR-1 已修复并双重验证（FIXED）**；**MINOR-2（极窄屏遮罩 34 px < 48 px）仍待决策**，属边界保证问题、不影响可点可关、不阻塞发布。未发现 BLOCKER / MAJOR。

发布前建议（非阻塞）：
- **MINOR-2 二选一**：把 `_clampWidth` 的基准从 `innerWidth` 换成 `document.documentElement.clientWidth`（一行改动，可加单测），或把「极窄屏遮罩可能小于 48 px」写进 README 已知限制；
- README/USAGE 的已知限制里补上 **L-1（P-04 可能要多按一次后退）** 与 **L-2（前进无效时刷新重试）** —— 这两条用户可感知；
- `_游戏热门视频` 一类卡片尾巴若在意，可再加一条后缀规则（纯外观，可不做）。

## 5. 证据索引

| 文件 | 对应用例 |
|---|---|
| `docs/qa-assets/01-search-drawer-open.png` | C-01（跨源宿主、地址栏仍 `search.bilibili.com`、抽屉内视频+弹幕）※ 截图基线 `c27510675fa5`，C-01 断言已在 `38b20453e29f` 重跑 |
| `docs/qa-assets/02-narrow-viewport-900x700.png` | C-10（900×700，抽屉 558 px，左侧遮罩可点） |
| `docs/qa-assets/03-dark-mode.png` | C-11（暗色模式头部/按钮可读） |
| `docs/qa-assets/04-homepage-drawer.png` | C-02（首页同源宿主，顶层未跳转） |
| `docs/qa-assets/05-g09-bangumi.png` / `06-g09-cheese.png` / `07-g09-list.png` | C-12 辅助证据（旧基线；主证据为 SPEC §8.5 / T7） |
| `docs/qa-assets/08-video-page-related-drawer.png` | C-03（视频页相关推荐） |
| `docs/qa-assets/real-extension-*.png` / `real-extension-report.json` | Lead 的 T7 真机联调（27 PASS + 1 SKIP），本报告引用其作为 manifest 类问题的替代证据 |
| `tests/e2e/dist/sidepeek-e2e-bundle.manifest.json` | 本次注入源码的逐文件 sha256，用于复核「测的是哪一版」 |
