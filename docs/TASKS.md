# SidePeek 开发任务分解（WBS v0.1）

> 配套文档：`docs/PRD.md`（行为规格与验收口径）、`docs/SPEC.md`（接口契约）、`docs/TECH-FINDINGS.md`（技术基线）。
> 本表是唯一排期依据：**编号在 PR/评审/QA 报告里直接引用**。

## 0. 角色与约定

| 角色 | 成员 | 写作用域（互斥） |
|---|---|---|
| core | dev-core | `src/core/peek-drawer.js`、`src/core/peek-drawer.css` |
| ext | dev-ext | `manifest.json`、`src/content.js`、`src/background.js`、`icons/`、`package.json`、`tests/unit/` |
| review | reviewer | `docs/reviews/`（只读代码，不改 src） |
| qa | qa | `tests/e2e/`、`docs/QA.md`、`docs/qa-assets/` |
| lead | lead | `README.md`、`docs/`、git 操作、契约决策 |
| analyst | analyst | `docs/PRD.md`、`docs/TASKS.md` |

复杂度：**S** ≈ 0.5 天，**M** ≈ 1 天，**L** ≈ 2 天（单人净投入，含自测）。
状态栏：`待办 / 进行中 / 完成 / 阻塞`。
**硬规则**：任何涉及 `docs/SPEC.md` 的改动只能由 Lead 落地；dev 遇到歧义按 PRD 第 6 节先行记录，不擅自改契约。

---

## 1. 阶段 0：契约与文档冻结（Gate 0）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W0-1 | 技术可行性实测与契约制定 | lead | — | L | `docs/SPEC.md`、`docs/TECH-FINDINGS.md` | sandbox 反 frame-buster 在跨源场景实测通过 |
| W0-2 | PRD / WBS 产出 | analyst | W0-1 | M | `docs/PRD.md`、`docs/TASKS.md` | I-01~I-30 全覆盖，每条有验收方法 |
| W0-3 | **契约缺口裁决**（PRD 第 6 节 G-01~G-10） | lead | W0-2 | S | SPEC 修订增量 | P0 的 G-01/G-02/G-03 有结论并回写 SPEC；结论同步 core/ext |

> ⚠️ W0-3 是并行开发的**前置闸门**：G-01（CSS 进 Shadow DOM 的通道）与 G-03（标题唯一入口）不裁决，core/ext 会各写一套，必然返工。

---

## 2. 阶段 1：核心抽屉引擎（core 泳道，与阶段 2 并行）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W1-1 | 宿主 + Shadow DOM 骨架 + 样式装配 | core | W0-3 | M | `peek-drawer.js/.css` | `#sidepeek-host` 为 `fixed;inset:0;pointer-events:none`；关闭态 `document.elementFromPoint` 命中 B 站元素；样式不泄漏到宿主页（宿主页 `getComputedStyle` 无 `sp-` 污染）；按 G-01 结论装配 CSS |
| W1-2 | open/close/toggle/isOpen + 入场/收起动画 | core | W1-1 | M | 同上 | 320ms transform 过渡（无 width 过渡）；rAF×2 后才加 `.is-open`（否则首帧无动画）；状态机 IDLE/OPENING/CLOSING 正确；关闭走 350ms 兜底计时器（G-10） |
| W1-3 | iframe 生命周期：loading / load / error / 8s 超时 / 重试 / 关闭卸载 | core | W1-2 | M | 同上 | I-28 全通：断网 8s 出错误态、重试可恢复；I-16：关闭 320ms 后 `iframe.src==='about:blank'`，无后台音频 |
| W1-4 | History 状态机（pushState / replaceState / popstate / back） | core | W1-2 | L | 同上 | 打开→后退一次即关闭；关闭后 hash 清空、B 站路由不坏；切换视频按 G-04 结论走 replaceState；无 popstate 双写、无死循环；快速连按后退 3 次无异常 |
| W1-5 | 左边缘拖拽改宽 + clamp + persistWidth | core | W1-2 | M | 同上 | 实时跟随（rAF 节流）；clamp 用 I-18 公式（含 `vw<467` 区间反转）；拖拽期间 iframe `pointer-events:none`（I-24）；松手只回调一次 `persistWidth`；拖拽中被 `blur` 视为松手 |
| W1-6 | 头部三动作：新标签打开 / 复制链接 / 关闭 | core | W1-2 | S | 同上 | 新标签用 `target="_blank" rel="noopener"`；复制成功有"已复制"反馈，失败走 I-25 回退链且不吞异常；关闭遵循 I-06 幂等 |
| W1-7 | 标题 / 可访问性 / 暗色 / 窄屏 / 双击全屏 | core | W1-2、W0-3(G-03) | M | 同上 | I-19（暗色 token）、I-20（role/aria/focus 归还）、I-26（标题竞态：换页后丢弃迟到结果）、I-30（双击全屏不写 storage）、I-12 |
| W1-8 | destroy / 幂等 / 性能收尾 | core | W1-3~W1-7 | S | 同上 | 重复 `destroy()` 安全；`document`/`window` 监听器全部解绑（用监听器计数或 patch 验证）；无内存泄漏（重复开关 50 次 DOM 节点数稳定）；代码零 `chrome.*`、零 ESM |

---

## 3. 阶段 2：扩展外壳与适配层（ext 泳道，与阶段 1 并行）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W2-1 | `manifest.json`（MV3 最小权限） | ext | W0-3 | S | `manifest.json` | `permissions:["storage"]`、`host_permissions:["*://*.bilibili.com/*"]`、`all_frames:false`、`run_at:"document_idle"`、`js:["src/core/peek-drawer.js","src/content.js"]`；无 tabs/webRequest/DNR/`<all_urls>`；按 G-01 结论决定是否加 `web_accessible_resources`；`node -e` 或 JSON Schema 校验通过 |
| W2-2 | 工程骨架：`package.json` + `node --test` 可跑 | ext | — | S | `package.json` | `npm test` 退出码 0（哪怕只有 1 条占位用例）；无打包器、无运行时依赖 |
| W2-3 | URL 识别纯函数 + 单测 | ext | W2-2 | S | `src/content.js`（导出可测函数）、`tests/unit/*.test.js` | 正例 ≥ 6（BV/av/bangumi ep·ss/cheese/list/带 query）、反例 ≥ 6（首页、动态、番剧索引、`bilibili.com.evil.com`、`javascript:`、空 href）；同一视频判定（pathname+p）用例通过 |
| W2-4 | 点击拦截（捕获阶段 + composedPath） | ext | W2-1、W2-3 | M | `src/content.js` | `click @document` 捕获；`button!==0` 或修饰键放行；`target="_blank"` 照常拦截（I-14）；`new URL` 异常放行；`stopImmediatePropagation` 作用域仅命中分支（不吞播放器/点赞/弹幕按钮）；I-15 同一视频不打开；I-21 300ms 去抖 |
| W2-5 | 标题链路：临时候选 + `resolveTitle` 实现 | ext | W2-3、W0-3(G-03) | M | `src/content.js` | 临时标题优先级：`textContent`（分行过滤时长/播放量噪声行，取最长行，截 80 字）→ `title` 属性 → 内层 `img[alt]` → `aria-label` → "视频"；`resolveTitle` = `sendMessage` + 拿到结果后清洗；**不旁路改 DOM**；超时 3s 返回 `null` |
| W2-6 | `background.js`：`PEEK_TITLE` 抓标题 | ext | W2-1、W2-5 | M | `src/background.js` | 用 `host_permissions` fetch；3s `AbortController` 超时；正则取 `<title>`；清洗尾部" - 哔哩哔哩"/"_哔哩哔哩_bilibili"；基本 HTML 实体解码；任何异常→`sendMessage` 回 `null`（绝不 throw 回 content）；单测覆盖清洗函数 ≥ 8 例 |
| W2-7 | 宽度持久化 `chrome.storage.local` | ext | W2-4 | S | `src/content.js` | key `sidepeek.width`；启动读一次传 `defaultWidth`；`persistWidth` 写入；读取失败/非法值（NaN/负/超范围）回落默认；**用 local 不用 sync**（G-07） |
| W2-8 | 图标 4 尺寸 PNG | ext | — | S | `icons/*.png` | 16/32/48/128 均存在且尺寸正确（用 Pillow 读回校验）；manifest 引用路径正确；深色圆角底 + 白色图形，16px 下可辨识 |
| W2-9 | 幂等注入保护 | ext | W2-4 | S | `src/content.js` | 重复执行脚本不重复初始化（`globalThis.__SIDEPEEK_BOOTED__` 守卫）；单例`drawer` 复用；不抛错 |
| W2-10 | 标题清洗纯函数 + 单测 | ext | W2-5 | S | `tests/unit/*.test.js` | 覆盖：正常标题、含 `&amp;` 等实体、含全角空格/换行、含" - 哔哩哔哩"后缀、仅剩空串→返回 null |

---

## 4. 阶段 3：联调（core × ext，Gate 1）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W3-1 | 装配联调：core options ← ext 注入 | core + ext | W1-8、W2-9 | M | 无新增文件 | `isPeekableUrl`、`resolveTitle`、`persistWidth`、`defaultWidth`、`cssHref`(若 G-01 选 A) 全部接通；`chrome.*` 只出现在 content/background |
| W3-2 | 真实 Chrome 加载已解压扩展自测 3 场景 | core + ext | W3-1 | M | 自测记录（写入 task 汇报） | 首页/搜索页/视频页各 1 次：抽屉打开、iframe 正常、顶层不被劫持、关闭后页面状态保留；**这条必须在真实扩展下过，不能只用 E2E 内联注入** |

---

## 5. 阶段 4：代码评审（Gate 2，合并前必须通过）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W4-1 | 全量静态评审 | review | W3-2 | M | `docs/reviews/REVIEW-01.md` | 覆盖 SPEC 一致性、最小权限、sandbox 字符串完整性、XSS（`innerHTML` 拼接外部串）、history 状态机、事件副作用、监听器泄漏、魔法数字、a11y；每条含 `文件:行号`、问题、原因、修复建议；结论 PASS / CHANGES-REQUESTED |
| W4-2 | 缺陷修复与复审 | core / ext | W4-1 | M | 修复提交 + 复审记录 | BLOCKER 全部闭环；MAJOR 闭环或 Lead 书面豁免；复审结论 PASS |

---

## 6. 阶段 5：验收（Gate 3）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W5-1 | E2E 注入脚手架（chrome API shim + initScript） | qa | W4-2 | M | `tests/e2e/` | shim 覆盖 `runtime.sendMessage/onMessage/id`、`storage.local.get/set`（**同时覆盖 sync**，G-07）、`runtime.getURL`；可一键生成 initScript；B 站页面加载后无 shim 报错 |
| W5-2 | 必测用例 1-11（PRD 第 8 节 / task-5 清单） | qa | W5-1 | L | `docs/qa-assets/*.png` | 每条用例有断言或截图证据；关键项 #1/#2/#7/#9 必须 PASS |
| W5-3 | 补充用例：I-16~I-30 + G-09 framability 抽测 | qa | W5-2 | M | 同上 | bangumi/cheese/list 各 1 条 framability 结论（PASS/FAIL 写清现象）；暗色、窄屏 500×700 与 320×640、断网错误态、拖拽跨 iframe、后台音频停止 |
| W5-4 | `docs/QA.md` 验收报告 | qa | W5-2、W5-3 | S | `docs/QA.md` | 用例表（编号/预期/实测/证据/结论）+ 缺陷清单（按严重度，含复现步骤）+ 总体结论；FAIL 项已通知对应 dev |

---

## 7. 阶段 6：文档与发布（Gate 4）

| ID | 任务 | 负责人 | 依赖 | 复杂度 | 交付物 | 验收标准 |
|---|---|---|---|---|---|---|
| W6-1 | `README.md` | lead（或指定） | W5-4 | S | `README.md` | 定位一句话、3 条痛点、≤8 条特性、4 步安装、交互速查表、目录结构、已知限制（L-01~L-05 诚实列出）、开发测试命令、License、免责声明 |
| W6-2 | `docs/USAGE.md` 用户说明书 | lead（或指定） | W5-4 | M | `docs/USAGE.md` | 安装、三入口首次使用、完整操作手册、FAQ ≥ 10 条（必须来自真实测试现象）、卸载与清理、版本记录；不写未实现功能 |
| W6-3 | 最终 diff 审查 + 提交 + tag | lead | W6-1、W6-2 | S | git commit / `v0.1.0` | 工作区干净；commit message 清晰；无残留 TODO 进入主分支（已知限制除外） |

---

## 8. 泳道与关键路径

```
时间 →

lead      [W0-1 实测]──[W0-2 PRD]──[W0-3 契约裁决]──────────────────────────[W6-1/2 文档]──[W6-3 tag]
                            │
core      ──────────────────┴─▶ [W1-1]→[W1-2]→┬─[W1-3]
                                               ├─[W1-4]
                                               ├─[W1-5]
                                               ├─[W1-6]
                                               └─[W1-7]→[W1-8]
ext       ──────────────────┬─▶ [W2-1][W2-2][W2-3]→[W2-4]→[W2-5]→[W2-6]
                            └─▶ [W2-7][W2-8][W2-9][W2-10]
                                          │
联调                                 [W3-1]→[W3-2] ──▶ [W4-1 评审]→[W4-2]──▶ [W5-1]→[W5-2]→[W5-3]→[W5-4]
```

**关键路径**：`W0-3 → W1-1 → W1-2 → W1-4(history, L) → W1-7 → W1-8 → W3-2 → W4-1 → W4-2 → W5-2 → W5-4 → W6-3`。
最大风险点在 **W1-4（History 状态机）** 与 **W1-3（iframe 生命周期）**，建议 Lead 在这两项完成后立即安排一次提前评审，不要攒到最后。

**并行约束**：
- core 与 ext 全程并行，唯一交汇点是 `W0-3`（契约）与 `W3-1`（装配）。
- `W4-1` 必须等 core/ext 全部完成（否则评审会漏掉改动）。
- `W5-1` 依赖 W4-2 的 PASS：验收跑的是已修复版本，避免复现旧缺陷。
- 文档（W6-x）必须等 QA 结论，否则会写进未实现的行为。

---

## 9. 里程碑与闸门

| 里程碑 | 判定条件 | 谁签字 |
|---|---|---|
| **M0 契约冻结** | W0-1~W0-3 完成；G-01/G-02/G-03 有结论 | lead |
| **M1 可运行** | W1-8 + W2-9 完成；真实扩展下三场景各跑通 1 次 | lead 抽查 |
| **M2 可合并** | W4-1 无 BLOCKER，W4-2 PASS | reviewer |
| **M3 可发布** | W5-4 结论 PASS；PRD 第 8 节 5 条发布条件全满足 | qa + lead |
| **M4 已发布** | W6-3 完成，`v0.1.0` tag 存在 | lead |

---

## 10. 风险登记

| # | 风险 | 概率 | 影响 | 应对 | 责任 |
|---|---|---|---|---|---|
| R1 | History 状态机把 B 站 SPA 路由搞坏（最坏：整站不可用） | 中 | 高 | W1-4 单独评审；只做最小侵入（push/replace + popstate 监听，绝不包一层 History API）；QA 专项 W5-2 #7 | core / review |
| R2 | 某类 B 站页面 frame-buster 未被 sandbox 抑制（顶层被弹走） | 中 | 高 | QA W5-3 抽测 bangumi/cheese/list/m 域；失败则以 `isPeekableUrl` 收窄白名单（G-09） | qa / ext |
| R3 | CSS 无法进 Shadow DOM（G-01 未裁决） | 高（若不定） | 高 | W0-3 必须先裁决；W3-2 必须在真实扩展里看样式，不能只看 E2E | lead |
| R4 | E2E 内联注入通过、真实扩展失败（样式/权限/路径类问题） | 中 | 高 | W3-2 强制真实扩展自测；QA 报告里标注"E2E 覆盖不到 manifest 校验" | core / ext / qa |
| R5 | 点击拦截吞掉 B 站自身交互（播放器控件/点赞/弹幕开关） | 中 | 中 | `stopImmediatePropagation` 仅限命中分支；QA W5-2 #9 关闭态全页点击回归 | ext |
| R6 | 抽屉关闭后仍有后台音频/内存占用 | 中 | 中 | W1-3 强制 `about:blank`；W5-3 专项验证 | core |
| R7 | 拖拽跨 iframe 中断（经典坑） | 高（若不知） | 中 | W1-5 已写明 `pointer-events:none` 方案；W5-3 一条用例 | core |
| R8 | 契约歧义导致 core/ext 各写一套（标题、history 切换） | 高（若不定） | 中 | W0-3 裁决 G-03/G-04 | lead |
| R9 | 8s 超时在弱网下误报"加载失败" | 中 | 低 | 错误态文案与重试按钮；G-13 记录 | core / qa |
| R10 | 窄屏/暗色未覆盖导致观感差 | 中 | 低 | PRD 视觉规格 + W5-3 用例 | core |

---

## 11. 复杂度汇总

| 角色 | 任务数 | S | M | L | 合计估算 |
|---|---|---|---|---|---|
| core | 8（W1-1~W1-8） | 1 | 6 | 1 | ≈ 5.5 人天 |
| ext | 10（W2-1~W2-10） | 6 | 4 | 0 | ≈ 5.0 人天 |
| review | 2（W4-1~W4-2） | 0 | 2 | 0 | ≈ 2.0 人天 |
| qa | 4（W5-1~W5-4） | 1 | 2 | 1 | ≈ 4.5 人天 |
| lead/analyst | 6（W0-x、W6-x） | 4 | 1 | 1 | ≈ 3.5 人天 |

> 估算仅用于判断先后顺序，不作为交付承诺；core/ext 为并行轨道，墙钟时间约为 `max(core, ext) + 联调 + 评审 + 验收`。

---

## 12. 与既有团队任务的映射

| 本表 WBS | 团队任务 | 说明 |
|---|---|---|
| W0-1 | — | Lead 已完成（SPEC/TECH-FINDINGS 已入库） |
| W0-2 | task-1 | 本文档与 PRD |
| W1-1 ~ W1-8 | task-2 | dev-core 内核任务 |
| W2-1 ~ W2-10 | task-3 | dev-ext 外壳任务 |
| W3-1、W3-2 | task-2/3 完成后由 Lead 组织 | 联调无独立任务卡，建议 Lead 显式安排 |
| W4-1、W4-2 | task-4 | 评审关卡（W4-2 建议在 task-4 内追加一轮复审） |
| W5-1 ~ W5-4 | task-5 | 验收 |
| W6-1、W6-2 | task-6 | 用户文档 |
| W6-3 | — | Lead 独占 git |

**缺口提示**：现有任务卡中**没有显式的 W3-1/W3-2（联调）任务**，而它恰是"E2E 通过但真机失败"的唯一拦截点（风险 R4）。建议 Lead 在 task-2/task-3 完成时插一个联调卡。
