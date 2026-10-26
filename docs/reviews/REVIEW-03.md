# SidePeek 代码评审 · REVIEW-03（W4-3 最终确认）

- 评审人：reviewer
- 确认对象：commit `e78e300`（Lead 所述）；N 系列返工 + Gate 3 证据 + 「前进重开」争议裁决
- 判据：`docs/SPEC.md`（含 §8 裁决）、`docs/PRD.md`、`docs/TASKS.md`、REVIEW-01/02 的未闭环项
- 方法：逐行复核 + 只读命令 + 证据交叉验证（含对 T7 截图做像素测量、对 B 站页面 inline script 做只读抓取）
- 约束遵守：**未改 `src/`，未执行 git**

只读验证：

```
npm test     → tests 87 / pass 87 / fail 0；CSS in sync (6678 bytes)
node --check → src/core/peek-drawer.js、src/content.js、src/background.js、scripts/check-css-sync.mjs、
               tests/unit/peek-drawer.test.js 全部通过
bundle 新鲜度 → tests/e2e/dist/sidepeek-e2e-bundle.manifest.json 记录
               core 68588B / sha256 38b20453e29f…、content 25367B / 98f561fed6c3…
               与仓库当前源码实测 sha256 完全一致（e2e 测的是最终代码，非旧快照）
T7 报告      → total=28 / passed=28 / failed=[]（mtime 04:11，晚于 core 03:54）
```

> **结论：CHANGES-REQUESTED（仅关卡证据与文档，产品代码 `src/` 无需改动）**
> 剩余：**1 项证据关卡必修（D-10 判据假阳性）+ 6 项 MINOR（文档/证据口径）**。
> N 系列 10 项全部闭环。修掉 D-10 判据并重跑（约 3 分钟）+ 同步 3 处文档后即可打 tag。

---

## 0. 一句话结论（关于 Lead 的裁决请求）

**Lead 的处理方向（三分支 + 已知限制）是对的，但当前 PASS 分支的判据有 bug，`D-10` 的 4/4 全绿是假阳性；「真实扩展与 harness 结论相反」不成立。** 证据显示 search 页在真实扩展下同样没有重开（详见 §3）。产品代码不需要改，需要改的是 T7 的「重开」判据 + 三处文档表述，然后重跑一次 T7。

---

## 1. N 系列闭环验证（10/10 CLOSED）

| 项 | 判定 | 证据 |
|---|---|---|
| **N-01** rAF 松手前 flush | **CLOSED** | `_commitDragWidth()`（`peek-drawer.js:1571-1584`）在取消 pending rAF 前同步 `_applyDragWidth()`；`_handleDragEnd` 统一走它（`1587-1589`）。单测 `peek-drawer.test.js:889-909` 断言「flush 前 `_appliedWidth===600` → 松手后 `===800`、`persist===[800]`」——真的在断言补算结果，不是只断言「调用了方法」。 |
| **N-02** buttons===0 兜底补 persist | **CLOSED** | `_handleDragMove` 的 `buttons===0` 分支改为 `_commitDragWidth()`（`1538-1541`）。单测 `911-931` 断言 `_drag===null` + `persist===[800]` + cursor/pointerEvents 复原。 |
| **N-03** 拖拽中重建 iframe 补关命中 | **CLOSED** | `_load` rebuild 分支 `if (this._drag) this._frame.style.pointerEvents='none'`（`892`）。单测 `933-956` 断言新旧 frame 不同、新节点 `pointerEvents==='none'`、拖拽态不被打断、松手后恢复。 |
| **N-04** inert 提到 aria-hidden 之前 | **CLOSED** | `_hide` 顺序 `_restoreFocus() → inert → aria-hidden`（`1299-1307`）。单测 `958-984` 用 spy 断言真实调用序列 `['restore-focus','attr:inert','attr:aria-hidden']`。 |
| **N-04b** 焦点不可归还时显式 blur | **CLOSED** | `_restoreFocus` 末尾检测 `shadowRoot.activeElement / document.activeElement(gp host)`，仍在抽屉内则 `blur()`（`1728-1745`）。单测 `986-1010` 覆盖 body.focus no-op 场景，断言 blur 恰好 1 次。真机 QA 侧 console 0 条 `Blocked aria-hidden`（Lead 提供，与代码路径一致）。 |
| **N-05** `minimum_chrome_version: "102"` | **CLOSED** | `manifest.json` 已含该字段；`manifest.test.js:37-41` 断言存在、可解析、`>=102`。README 已知限制 #5 也向用户说明了 102+ 需求。 |
| **N-06** M-03 自愈 once 护栏 | **CLOSED** | 模块级 `historyResidueHealed`（`526`，`536-538` 早退），并暴露 `__resetHistoryHealGuardForTest()`（`1780-1782`，注释说明仅测试用）。单测 `747-777` 断言「第二实例不得清掉活条目」；M-03 两条原用例（`714-745`）用重置钩子保证仍真实自愈（非空转）。 |
| **N-07** `_guardSandbox` 补测试 | **CLOSED** | 单测 `783-814`：先断言 observer 的 target 与 `attributeFilter:['sandbox']`，再断言**恢复结果**——加 `allow-top-navigation` → 恢复；`Allow-Top-Navigation` 大小写变体 → 恢复；整属性 removeAttribute → 恢复。注：Lead 消息里说的「正常值不反复写」并未被显式断言（该点由 `849-856` 的早退（`853`）实现保证），属表述略超前，不影响闭环。 |
| **N-09** 路径正则跨文件一致性 | **CLOSED** | `peek-drawer.test.js:1178-1226`：vm 分别加载 content / background，用 **23 条路径语料**（video/av/bangumi/cheese/list 正例 + `/video/`、`BV123`、`read`、`search`、`space` 反例）逐条断言两侧判定一致，并额外抽查关键正/反例——是行为等价断言，不是字符串相等。 |
| **N-10** 删除 `options.css` 过期描述 | **CLOSED** | `peek-drawer.js:13-17` 已改为「样式唯一来源就是内嵌 CSS_TEXT，不接受宿主页面或 options.css 注入」；全仓无 `_resolveCss`/`sidepeek-core-css` 读取逻辑。`check-css-sync` 仍绿。 |

附（不在 N 系列但本轮新改动）：`background.js` 标题后缀 `哔哩哔哩bilibili`（中段无下划线）变体已修（`background.js:109-112`，中段下划线改为 `_?`），`background.test.js:76-95` 有回归用例（含「后缀不在结尾不得清洗」反例），`npm test` 87 全绿。

---

## 2. 证据链独立核验（除 D-10 外均成立）

- **e2e bundle 已重建**：bundle manifest 记录的 core 68588B/`38b20453e29f…`、content 25367B/`98f561fed6c3…` 与我对当前源码实测的 sha256 一致 → QA 本轮注入的是修复后代码（REVIEW-02 N-12 的隐患已消除）；`tests/e2e/dist/` 已入 `.gitignore`。
- **QA 基线映射透明**：`docs/QA.md:5-27` 标明「多数用例在 core `c27510675fa5`，最终基线 `38b20453e29f`；C-01（跨源反劫持）与 C-08（B-01 拖拽）已在最终基线上重跑 PASS」。这是可接受的取证方式（行为改动最相关的两条重跑了）。
- **T7 28 项结构对得上**：报告 checks 为 `A,B,C-1..C-13,D-1..D-13`（C-12/C-13 与 D-12/D-13 编号顺序在 JSON 里互换，无实质影响）。
- **Gate ①**（B-01 真机拖拽）：QA C-08 有完整断言值（拖拽中 cursor/userSelect/iframe.pointerEvents 三态；744→588→438→788 跟手；松手三者复原且 `sidepeek.width=788` 落盘），并在最终基线上重跑（744→648→948、stored=948）→ **成立**。
- **Gate ②**（关闭态 Tab）：QA C-13 实测「关闭态对按钮 `.focus()` 失败、`shadowRoot.activeElement===null`、按 3 次 Tab 焦点落在 B 站导航」→ `inert` 在真实 Chromium 中生效，**成立**。
- **Gate ④**：README 13 条已知限制涵盖了 P-04(#8)、M-05(#4)、P-14(#6)、P-10(#7)、Esc(#3)、Chrome 102+(#5)、前进风险(#9) → 基本成立，缺口见 §5 R-02。
- **Gate ⑤**：bundle 已重建且 sha 一致 → **成立**。

---

## 3. 裁决：`search.bilibili.com` 的「前进重开」争议

### 3.1 结论

**当前处理不足以支撑「真机 D-10 通过」的结论**：三分支设计是对的，但 PASS 分支的判据（`reopened`）在带竖向滚动条的页面上**恒为真**，把「站方剪除前向条目、根本没重开」误判成 PASS。修正判据并重跑后，预期 D-10 会变成 **SKIP**（这是设计上允许的结果）。产品代码不用改——站方行为无法从扩展侧安全阻止。

### 3.2 证据链（四条独立证据，互相印证）

1. **判据 bug（静态）**：
   `tests/integration/real-extension-check.mjs:461-470` 用
   `d.getBoundingClientRect().left < window.innerWidth - 10` 判定「抽屉已重开」。
   但抽屉是 `position:fixed; right:0` + `transform:translateX(100%)`：关闭态它的 `left` 等于 **`document.documentElement.clientWidth`**（fixed 的包含块不含经典滚动条），而 `innerWidth` 含滚动条。二者相差 15px > 阈值 10px → 关闭态被判成「重开」。
2. **像素证据（实测）**：对 T7 自己产出的 `docs/qa-assets/real-extension-d.png`（1440×900，headless，`Emulation` 宽 1440）做逐列采样：
   - 抽屉深色头部右缘在 **x=1425**（x=1425..1439 是 15px 的滚动条：track `(44,44,44)` + thumb `(159,159,159)`）；
   - 即 `clientWidth=1425`、`innerWidth=1440`；关闭态 `left=1425`，判据 `1425 < 1430` → **true（假阳性）**。
   - 同图也印证了 QA 的 MINOR-2（innerWidth/clientWidth 差 15px 这一类问题的同源）。
3. **报告自相矛盾（决定性）**：同一份报告里
   - `C-10`（首页，**真**重开）：`pass:true, detail:"hash=\"#sidepeek=https%3A%2F%2Fwww.bilibili.com%2Fvid\""`
   - `D-10`（search，**假**重开）：`pass:true, detail:"hash=\"\""`
   若前进真的回到了 `#sidepeek` 条目，core 的 `_handlePopState → open() → _pushHistory → _replaceHistory`（`peek-drawer.js:1185-1213`）必然把 hash 写回 `#sidepeek=…`（C-10 即为实证）。D-10 的 hash 为空，说明**根本没有重开**，只是判据把它算成了 PASS。
4. **站点机制（外部页面只读抓取，2026-10-27）**：`https://search.bilibili.com/all?keyword=游戏` 的响应 HTML 内含一段 inline script（约第 292/308-316 行）：

   ```js
   window.addEventListener('popstate', function () {
     if (!(history.state && history.state.back)) history.pushState(null, document.title, location.href)
   })
   // 以及首次 click 的 300ms 后：if (!(history.state && history.state.back)) history.pushState(null, document.title, url)
   ```

   即：**只要 back 落点条目的 `history.state` 没有 `.back`，站点就在 popstate 里 pushState，剪掉我们的前向条目**。这与 QA 的对照实验（不加载扩展也复现）以及 D-10 的 `hash=""` 完全一致；也解释了为什么同源首页（无此脚本）C-10 真通过、search 页 D-10 不通过。

> 因此 Lead 表格里「D-10 连续 4 次通过 / 1400·3000·6000ms 三种等待均通过」在这套判据下**必然全绿**（与时间无关，是几何判据恒真），不能作为「真机与 harness 相反」的证据。T7 文档 §8 给出的机制解释（「只改 hash → B 站路由不认为路由变更 → 不剪」）也与站点实际脚本不符：站方 handler 根本不看 URL，只看 `history.state.back`。

### 3.3 那「处理是否足够」？

**设计足够，判据不够。** 具体意见：

1. **修判据（必修，Lead 侧 ~5 行）**：把「重开」判定改成不可被滚动条欺骗的形式，推荐直接用 DOM 状态 + 宽度视口：
   ```js
   return d.classList.contains('sp-open') &&
          d.getBoundingClientRect().left < document.documentElement.clientWidth - 10;
   ```
   （或直接断言 `location.hash.includes('#sidepeek=')` 作为主判据、rect 仅作辅助——重开必然写 hash，C-10 已证明这条路径。）
2. **重跑 T7（~3 分钟）**：预期 `D-10` 从 PASS 变为 **SKIP**（未重开 + `history.state` 已无 `__sidepeek`），`total=28 / passed=27 / skipped=1`、退出码仍 0；`C-10` 应保持 PASS（真重开）。这正是三分支设计想要的语义，**不需要**因此判产品缺陷。
3. **同步文档（必修）**：
   - `docs/T7-REAL-EXTENSION.md:118-141` 「争议与复核」：删除/改写「真机不会剪」的机制解释，改为「站方 popstate handler 在 `state.back` 缺失时 pushState 剪除前向条目；T7 全新 profile 的 D-10 判据修正后为 SKIP；已知限制已记录」。
   - `docs/QA.md:66`（C-07b「以真机结论为准…连续 4 次 PASS」）与 `docs/QA.md:147`（L-2）：按修正后的 T7 结果改写；L-2 的机制描述可补上这段 inline script 条件。
   - `README.md:101` 已知限制 #9 的措辞「真机回归（首页/搜索结果页）未复现」需改为「搜索结果页可能发生（站方脚本剪除前向条目），首页通常正常」。
4. **不需要做的事**（避免过度工程）：
   - 不需要再扫等待时长（机制与时间无关，已排除竞态）；
   - 不需要在 headed 模式重复验证（判据 bug 与 headless 无关，headed 同样有 15px 滚动条）；
   - **不要**尝试在扩展侧阻止站方 popstate 处理器（`stopImmediatePropagation`）或 monkey-patch History —— 那会破坏 B 站自身路由，违反 SPEC「最小侵入」原则；
   - 不需要改 `src/`。

### 3.4 修正后 I-10 的验收是否仍然成立？

成立：I-10 的「前进重开」由 **同源首页** C-10 提供真通过证据（hash + rect 双证），search 跨源宿主以 **SKIP + 已知限制** 记录（站方行为，无法控制）。这与 SPEC/PRD 对「已知限制」的处理一致，不影响 v0.1 发布。

---

## 4. Gate 3 五项逐条状态

| 闸门 | 状态 | 说明 |
|---|---|---|
| ① B-01 真机拖拽 | **PASS** | QA C-08（含最终基线重跑），断言值完整。 |
| ② 关闭态 Tab | **PASS** | QA C-13，`inert` 实测生效。 |
| ③ I-10 真机 back/forward + history.length | **PARTIAL → 需修正** | `history.length`（C-11/D-11）成立、同源 C-10 真通过；但 **D-10 的重开判据假阳性**（§3），修正判据重跑后才能作为证据。 |
| ④ 已知限制成文 | **PARTIAL** | README 13 条基本齐全；但 **USAGE 缺「前进可能被剪除」一条**，且 USAGE 有「左侧永远至少留 48 像素」的错误表述（见 §5 R-02/R-03）。 |
| ⑤ 采证前重建 bundle | **PASS** | bundle sha 与源码一致，`dist/` 已 gitignore。 |

---

## 5. 其余 MINOR（6 条，建议与 §3 一并修）

- **R-01 证据计数过期（多处）**：`docs/QA.md:43` 与 `:181` 仍写 T7「26/26」；`docs/T7-REAL-EXTENSION.md:58` 小节标题仍写「18/18 PASS」而表格已是 28 项；`README.md:115` 仍写「断言 18 项核心链路」。统一为 **28 项**（含修正后的 1 SKIP 时写成「27 PASS + 1 SKIP」），避免读者误判证据规模。
- **R-02 USAGE 缺少「前进可能被剪除」的已知限制**：`README.md:101` 有第 9 条，但用户手册 `docs/USAGE.md:373-388` 的 12 条里没有；而 `USAGE.md:171-176` 又把「用前进重新打开」写成稳定行为。请把 README #9 同步进 USAGE（用户看到的是 USAGE，不是 README）。
- **R-03 QA MINOR-2 既未修也未成文，且 USAGE 与实测矛盾**：QA 实测 `innerWidth=492 / clientWidth=477` 时实际可点遮罩只有 **34px**（`QA.md:130-140`），而 `USAGE.md:185` 写着「左侧永远至少留 48 像素」。二选一：① dev-core 把 `_clampWidth` 的视口基准改为 `document.documentElement.clientWidth`（一行 + 单测，与 G-05 意图一致）；② 在 README/USAGE/QA 的已知限制里写明「极窄窗口 + 滚动条时遮罩可能略小于 48px，但仍可点」。v0.1 建议 ②（改动零风险），但**必须有书面记录**，不能静默留着错误表述。
- **R-04 README 功能承诺与已知限制的措辞冲突**：`README.md:24` 写「再按前进 = 抽屉重新打开」为无条件行为，而 #9 说可能失效。建议 #24 加一句「（搜索结果页等个别页面见已知限制 9）」。
- **R-05 Lead 消息里的 core 哈希与仓库实测不一致**：消息写「core `c27510675fa5`」，而当前源码/最终 bundle 实测为 `38b20453e29f`（`c27510675fa5` 是 QA.md 标注的「多数用例基线」）。发布记录/tag message 请统一用最终基线 `38b20453e29f` 与 `98f561fed6c3`，避免证据对不上代码。
- **R-06 T7 报告缺少 skipped 汇总**：修正后会出现 1 条 SKIP，但 `real-extension-report.json` 只有 `total/passed/failed`，skipped 只在 checks 明细里。建议 summary 增加 `skipped: N`（并在控制台打印），避免未来 SKIP 静默稀释覆盖率；`report.passed` 已正确排除 skipped，无需改判定逻辑。

---

## 6. 必须修清单与结论

**必须修（tag 前，全部 Lead 侧，不改 `src/`）**

1. **T7 D-10「重开」判据**（`tests/integration/real-extension-check.mjs:461-470`）：改用 `.sp-open` 类 + `documentElement.clientWidth`（或 `location.hash` 主判据），重跑 T7，确认 D-10 变为 **SKIP**、C-10 仍 PASS，并更新报告。
2. **文档同步**：T7 文档 §8 的机制解释与「真机相反」结论、`QA.md` C-07b/L-2、`README.md` #9 措辞（§3.3-3）。
3. **USAGE 补已知限制**（R-02）+ **48px 表述修正**（R-03）+ **过期计数统一**（R-01）。

**可以不做（明确不建议）**：改 `src/`；拦截/覆盖站方 popstate；为「前进」加 History 补偿写入；再扫等待时长。

修完后我只需复核两件事即可签字：① 重跑后的 `D-10` 新输出与 `C-10` 对照；② 三处文档的 diff。预计 10 分钟内可完成 W4-3 终审。

---

## 7. 结论

**CHANGES-REQUESTED**

- 产品代码：**无 BLOCKER / 无 MAJOR**；N 系列 10 项全部闭环，`npm test` 87/87、bundle 与源码 sha 一致。
- 关卡证据：**1 项必修**（T7 D-10 判据假阳性 → 修正判据并重跑；这是 §3 争议的真正答案）。
- 文档：6 项 MINOR（其中 R-02/R-03 涉及用户可见的错误表述，建议同批修）。

修正 D-10 判据 + 同步文档并重跑 T7 后，只要 `D-10` 呈现为 SKIP、`C-10` 为 PASS、文档不再宣称「真机与 harness 相反」，即可判 **PASS** 并打 `v0.1.0`。
