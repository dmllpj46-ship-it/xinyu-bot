# PLAN.md — 实施计划

> 目标：从空仓库到**一个能在本机跑起来、危机路径可靠、界面暖心**的陪练 Bot。
> 原则：**安全层先于功能层；能跑通一条端到端路径，比堆五个半成品功能重要。**

---

## 0. 现状盘点（2026-10-25 已完成的前置验证）

| 事项 | 状态 | 证据 |
|---|---|---|
| 仓库 | 空目录，无 git | `ls` 为空 |
| Python | 3.13.14 可用 | `envs/default` |
| Mercury 3 连通 | ✅ | `/chat/completions` 返回 `OK` |
| Mercury 3 工具调用 | ✅ | 返回 `get_crisis_hotline` 的 `tool_calls`，含 `strict:true` |
| Mercury 3 流式 | ✅ 块式 | 4 chunk / 2 tool_call delta |
| Mercury 3 reasoning | ✅ | `completion_tokens_details.reasoning_tokens: 30` |
| AnySearch | ✅ | 中文查询返回 Mayo Clinic 等结果 |
| `openai-agents` | 最新 0.24.0，未安装 | `pip index versions` |
| UI 组件底座 | ✅ 已定 + 样张完成 | daisyUI 5.7.50 子集 + `web/preview.html` |

**结论：所有外部依赖都已打通，剩下的是工程活。** 无未知阻塞项。

---

## 1. 里程碑总览

| 阶段 | 内容 | 交付物 | 完成标志 |
|---|---|---|---|
| **P0** | 骨架与配置 | 目录、`.env`、`requirements.txt`、`config.py` | `uvicorn` 起得来，`/health` 返回 ok |
| **P1** | 知识库 | `knowledge/` 10 篇 md + `data/kb_index.json` | `kb_search("睡不着")` 能命中睡眠篇 |
| **P2** | Agent 与工具 | `agent.py` + 3 个工具 | CLI 里能多轮对话并触发工具 |
| **P3** | 安全层 | `safety/` + guardrails | 危机 5 例全部正确分流，红线 0 泄漏 |
| **P4** | Web UI | `web/` 三件套 + SSE | 浏览器里流式对话，暖色视觉达标 |
| **P5** | 联调验收 | `smoke_test.py`、`tests/`、验收清单 | 全部验收项 ✅ |
| **P6** | 增强（可选） | 见 §8 | 不影响 v1 交付 |
| **P7** | Cloudflare Workers 部署 | `worker/`、`wrangler.jsonc`、`scripts/build-kb.mjs` | `wrangler dev` 全链路通过，`npm test` 绿，可 `wrangler deploy` |

依赖关系：`P0 → P1 → P2 → P3 → P4 → P5`，然后 `P5 → P7`。P3 可与 P4 并行（接口已定）。P7 是**运行时迁移**，不新增业务能力。

---

## 2. P0 — 骨架与配置

**任务**

1. `python -m venv .venv`，写 `requirements.txt`：
   ```
   openai-agents==0.24.0
   fastapi>=0.115
   uvicorn[standard]>=0.32
   python-dotenv>=1.0
   pydantic-settings>=2.5
   httpx>=0.27
   pytest>=8.3
   pytest-asyncio>=0.24
   ```
2. `.env`（真实值，已 gitignore）+ `.env.example`（占位）。字段见 README §6。
3. `.gitignore`：`.venv/`、`.env`、`__pycache__/`、`data/*.json`、`*.log`。
4. `app/config.py`：`Settings(BaseSettings)`，字段校验，`get_settings()` 带 `lru_cache`。
5. `app/main.py`：`GET /health`、`GET /` 返回 `web/index.html`、静态挂载 `/static`。
6. `git init` + 首次提交。

**验收**

- [ ] `curl http://127.0.0.1:8000/health` → `{"ok":true,"model":"mercury-3"}`
- [ ] `git status` 里没有 `.env`
- [ ] 缺 `INCEPTION_API_KEY` 时启动即报**可读**错误，不是 KeyError 堆栈

---

## 3. P1 — 本地知识库（10 篇）

**为什么是这 10 篇**：覆盖「用户最常带来的 5 类困扰」+「3 类必须转介」+「沟通方法」+「伦理边界」+「速查」。
每篇都能独立被检索命中，不做大而全的教科书。

| # | 文件 | 核心内容 | 主要来源 |
|---|---|---|---|
| 00 | `00-index.md` | 目录 + 每篇适用/不适用一句话 + 检索关键词 | 自撰 |
| 01 | `01-who-dwm-压力管理五技能.md` | 着陆、解套、践行价值观、保持友善、留有空间；每技能配 1 个 ≤5 分钟练习 | WHO《压力之下，择要事为之》 |
| 02 | `02-cbt-认知重构与行为实验.md` | 认知三角、自动思维识别、七栏思维记录、认知歪曲清单、行为实验 | Beck / CBT 标准手册 |
| 03 | `03-焦虑-惊恐-躯体症状.md` | 焦虑 vs 危险的区分、惊恐发作应对（生理性叹气、5-4-3-2-1）、回避的代价 | NICE NG113 / CCI 自助材料 |
| 04 | `04-抑郁-行为激活.md` | 情绪-行为循环、活动分级、小步启动、快感缺失的处理 | NICE NG222 / BA 手册 |
| 05 | `05-睡眠-节律-躯体调节.md` | 刺激控制、睡眠限制、睡前反刍处理、咖啡因/屏幕、运动剂量 | CBT-I 核心组件 |
| 06 | `06-危机识别与安全计划.md` | 风险信号分层、直问技巧、Stanley-Brown 安全计划六步、热线使用 | mhGAP / Stanley & Brown |
| 07 | `07-沟通-共情-动机式访谈.md` | 反映式倾听、OARS、不评判、改变语句的引出、避免的 12 种回应 | Miller & Rollnick |
| 08 | `08-伦理边界与转介标准.md` | 能力边界、保密例外、转介阈值（症状时长/功能损害/风险）、如何说"你该去看医生" | 精神卫生法 / 伦理守则 |
| 09 | `09-常见提问速查.md` | "我是不是抑郁了""要不要吃药""怎么跟家人说""咨询太贵"等 15 条标准答法 | 自撰（对照 01–08） |

**任务**

1. 按 AGENTS.md §6 的格式写 10 篇，每篇 1200–2500 字，`##` 小节 200–600 字。
2. `scripts/ingest_kb.py`：
   - 按 `##` 切块，块内保留 `# 篇名` 作为上下文前缀
   - 中文分词用「字 bigram + 关键词表」即可（不引 jieba，降低依赖）
   - 输出 `data/kb_index.json`：`{chunk_id, doc, heading, text, tokens}`
3. `app/tools/kb_search.py`：BM25（k1=1.5, b=0.75），top-4，返回带 `【篇名 › 小节】` 前缀的纯文本，总长 ≤1200 字。
4. 检索自测：准备 20 条真实问法（口语化、带情绪），要求 **top-3 命中率 ≥ 80%**。

**验收**

- [ ] `python scripts\ingest_kb.py` 产出 ≥ 40 个 chunk
- [ ] 20 条自测问法中 ≥16 条 top-3 命中正确篇目
- [ ] 每篇都有 `> 来源` 和 `## 转介信号`
- [ ] `kb_search` 在无命中时返回"知识库无直接相关内容"，而不是硬凑

---

## 4. P2 — Agent 与工具

**任务**

1. `app/prompts/system.md`，结构固定为五段（Mercury 3 官方建议：人格 → 工具/知识 → 任务 → 格式 → 约束）：
   ```
   <role>       你是谁：陪练，不是医生。语气：短句、具体、不评判。
   <knowledge>  什么时候先调 kb_search；什么时候调 web_search（只查资源/政策）
   <method>     每轮结构：① 接住情绪（1句）② 一个澄清问题 ③ 最多一个可做的动作
   <format>     默认 ≤180 字；不用列表轰炸；不用 emoji（危机态绝对不用）
   <limits>     复述 R1–R8 红线
   ```
2. `app/agent.py`：
   - `build_model()` 按 AGENTS.md §3
   - `Agent(name="心屿", instructions=<system.md>, model=..., tools=[...])`
   - `TOOLS = [kb_search, web_search, crisis_resources]`
   - `Session` 用 SDK 的内存 session，`max_turns=20`；`Runner.run_streamed()` 供 SSE 用
3. `app/tools/web_search.py`：AnySearch `/search`，`tag=general.web`，`timeout=8`，取 top-4 只留 title+snippet+url，加"以下为网络结果，仅供参考"前缀。
4. `app/tools/crisis.py`：
   - `HOTLINES` 常量表（12356 / 120 / 110 / 010-82951332）
   - `@function_tool crisis_resources(region: str = "全国")` → 返回固定文案
   - 另导出 `build_safety_plan_template()` 供危机态注入
5. `scripts/smoke_test.py`：不起服务，直接 `Runner.run` 跑 4 条用例并打印工具调用轨迹。

**验收**

- [ ] 连续 5 轮对话上下文不丢
- [ ] 问"最近有什么心理援助政策"能触发 `web_search`
- [ ] 问"我一想到上班就胸闷"能触发 `kb_search` 且命中 03 篇
- [ ] 工具失败（断网/超时）时对话继续，不 500

---

## 5. P3 — 安全层（最高优先级）

### 5.1 危机分级（`safety/lexicon.py` + `input_guard.py`）

| 级别 | 触发 | 处置 |
|---|---|---|
| **L0 无** | 常规压力、情绪低落 | 正常对话 |
| **L1 关注** | "撑不住了""没意义""想消失"（无明确意图） | 正常对话，但**必须**在回复里直问一次意图 + 给 12356 |
| **L2 风险** | 明确自杀/自伤意念、计划、既往尝试、"遗书/告别" | **中断常规流程** → 固定危机回复 + 热线 + 安全计划模板，禁 emoji，`reasoning_effort=medium` |
| **L3 紧急** | 正在实施、已服药/已受伤、时间地点手段明确 | 极简回复：先 120/110，再 12356，再"现在就联系身边的人"，不追问细节 |

词表要求：
- 中文直述 + 口语变体 + 隐喻（"想睡过去不醒""从楼上跳下去""割""药都吃了"）
- 英文（`kill myself` / `suicide` / `end it` / `self-harm`）
- 否定式不误伤（"我不会自杀" → 降级，但保留上下文判断）
- **最终不用 LLM 二次判定**（原计划有，已否）。理由：危机路径每多 500ms 都是代价；
  误报的代价只是"多问一句你现在有没有伤害自己的念头"——这在临床上本来就该问。
  漏报不可逆。所以只用确定性规则，LLM 只留给离线评估脚本复核准确率。

### 5.1.1 危机话术必须是写死的（实测后追加）

Mercury 3 的 API 层会拒答自杀相关内容。所以 L2/L3 **不调模型**，直接走
`app/safety/crisis_script.py`。这条不是优化，是可用性前提——否则最需要说话的场合它一句都说不出来。

### 5.2 输出护栏（`output_guard.py`）

流式场景下**按句缓冲**（遇到 `。！？\n` 才检查），命中即替换该句为安全版本并记日志：

| 模式 | 例 | 处置 |
|---|---|---|
| 诊断 | "你这是抑郁症" | 替换为"这些体验和抑郁的常见表现有重叠，但需要专业评估" |
| 药名+剂量 | "舍曲林 50mg" | 整段替换为"药物相关只有开药医生能决定" |
| 劝阻就医 | "不用看医生" | 删除该句 |
| 电话号码 | 任意 7 位以上数字（非白名单） | 替换为 `12356` |

### 5.3 验收

- [ ] 危机测试集 20 条（L0×5 / L1×5 / L2×7 / L3×3）分级准确率 **≥ 90%**，**L2/L3 漏检 = 0**
- [ ] 否定式误报率 ≤ 10%
- [ ] 输出护栏对 10 条"诱导诊断/诱导开药"的越狱问法，泄漏 **0** 次
- [ ] 危机态回复里必含 `12356`，且号码来自常量表（可用 grep 验证 prompt 里无号码）

---

## 6. P4 — Web UI

**任务**

0. ✅ **（已完成 2026-10-25）组件底座定案 + 视觉样张**
   - 选定 **daisyUI 5.7.50（MIT）**，只取 10 个组件的预编译 CSS，拼成
     `web/vendor/daisyui/daisyui-subset.css`（199 KB / gzip 14 KB），**不引 Tailwind 运行时**
   - 主题在 `caramellatte` 基础上整体改写为暖陶色（`--color-primary: #C0765C` 等）
   - 淘汰项：Deep Chat（Shadow DOM 挡样式、抢请求层）、AI Elements（需 React+构建）、Pico（无聊天组件）
   - 样张后来直接转正成 `web/index.html` + `web/style.css`，不再保留独立的 preview 文件（避免 CSS 双份漂移）
1. `web/index.html`：单页，结构 = 顶部标题栏 / 消息流 / 输入区 / 底部免责小字。
   —— 直接由 `preview.html` 转正，删掉「危机场景示例」分隔条与 `#crisis-only` 截图脚本。
2. `web/style.css`：由 `preview.css` 改名，**第 1 节主题令牌原样保留**；`prefers-color-scheme` 暂不做（暖色浅底是产品识别的一部分）。
3. `web/app.js`：
   - `fetch('/api/chat', {method:'POST'})` + `ReadableStream` 读 SSE
   - **块式补间**：收到大块文本后按 12ms/字逐字吐到 DOM，队列未播完时新块入队（解决 Mercury 块式流式的观感问题）
   - 会话 id 存 `sessionStorage`
   - 危机态：给 `<body>` 加 `.crisis` class（转灰蓝、禁动效、隐藏表情按钮）
   - 首屏空态：4 个"我现在……"入口（压力大 / 睡不着 / 心慌 / 提不起劲），点击填入输入框而非直接发送
4. `app/main.py` 加 `POST /api/chat`：
   - 入参 `{session_id, message}`
   - 先跑 `input_guard` → 分级 → 选 prompt 变体
   - SSE 帧：`event: token` / `event: tool`（显示"正在查阅资料…"）/ `event: done` / `event: error`
5. 移动端：≤480px 时输入区固定底部，消息流 padding 调整。

**验收**

- [ ] 首字到屏 ≤ 2s（本机）
- [ ] 流式过程不跳动、不闪
- [ ] 危机态视觉切换正确（截图对比）
- [ ] 断网时给"网络不稳，稍后再试"，不白屏

---

## 7. P5 — 联调与验收

**端到端 6 条路径，全部手工走一遍并录屏留档：**

1. 普通压力 → 共情 + 一个澄清问题 + 一个动作
2. 焦虑躯体化 → 命中 03 篇 → 给呼吸练习
3. 失眠 → 命中 05 篇 → 给刺激控制
4. 明确自杀意念 → L2 → 危机协议（无 emoji、有热线、有安全计划）
5. "我是不是抑郁症" → 拒绝诊断 + 解释 + 就诊路径
6. "给我开点药" → 拒绝 + 说明边界

**同时：**
- `pytest tests/test_safety.py tests/test_tools.py` 全绿
- `README.md` §4 的命令在干净环境能一次跑通
- 全文 grep 确认：`.py`/`.md` 中无真实 key、无用户样例对话

---

## 8. P6 — 可选增强（v1 之后，按需）

| 项 | 价值 | 成本 | 备注 |
|---|---|---|---|
| 情绪日记（本地 localStorage） | 让用户看到趋势 | 低 | 不落服务端，隐私友好 |
| 语音输入（浏览器 Web Speech） | 降低表达门槛 | 低 | 不引第三方 TTS |
| 多轮"周回顾" | 增强陪伴感 | 中 | 需会话持久化 → 隐私成本上升 |
| 知识库向量化 | 检索更准 | 中 | 需 embedding 服务；当前 BM25 够用 |
| 多模型兜底（Agnes 3.0 Flash） | Mercury 限流时不中断 | 低 | 同一 SDK，换 base_url 即可 |
| 英文版 | — | 中 | 需重写知识库 |

---

## 9. 风险登记册

| # | 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|---|
| R1 | 危机漏检（隐喻、反讽、间接表达） | 中 | **极高** | 正则分级 + L1 也强制直问（不靠模型判断）；上线前人工过 20 例；宁可误报不可漏报 |
| R2 | 输出护栏误杀，回复变得空洞 | 中 | 中 | 护栏只替换命中的**句子**，不整段丢弃；替换文案单独打磨 |
| R3 | Mercury 块式流式导致观感差 | 高 | 低 | 前端补间（P4 已定） |
| R4 | 温度下限 0.5 导致语气不稳 | 中 | 中 | 用 system.md 强约束 + few-shot 示例；每轮固定结构 |
| R5 | `strict` schema 2.8% 失败 | 中 | 中 | 工具层 try/except + 降级话术 |
| R6 | 知识库内容不准确（改写引入偏差） | 中 | 高 | 每篇标来源；改动走 AGENTS §6 格式；关键结论回查原文 |
| R7 | 用户把 Bot 当治疗替代 | 高 | 高 | 首次对话声明 + 每 5 轮一次轻提醒 + 转介阈值硬编码 |
| R8 | 合规风险（对外提供服务） | — | 高 | v1 仅本机自用；对外前单独评估，README §7 已声明 |
| R9 | **模型拒答自杀相关内容**（已发生） | 已确认 | 极高 | L2/L3 不调模型，走写死话术；其他轮次有 `_REFUSAL_FALLBACK` |
| R10 | **双运行时行为漂移**（改了 Python 忘改 TS） | 高 | 极高 | AGENTS §2.3 镜像表 + 两边 safety 测试同源用例；改 `safety/` 的 PR 必须两边都过 |
| R11 | Worker 无状态导致多轮失忆（浏览器刷新） | 高 | 中 | 前端持有 `history`，每轮回传 10 轮；界面上"新的对话"按钮语义清晰；可接受 |
| R12 | 知识库编译进包体，扩容后包变大 | 低 | 中 | 当前 43 KB 无碍；超过 ~50 篇改走 KV/R2（见 README §9.7） |

---

## 10. 明确不做（v1 范围外）

- ❌ 用户注册、账号体系、云端存储
- ❌ 图片/语音输入（Mercury 3 纯文本）
- ❌ 量表自动计分（PHQ-9/GAD-7 可作对话参考，但不做"你的分数是 17 分"）
- ❌ 多 Agent 编排 / handoff（单 Agent + 工具足够）
- ❌ 长期记忆与用户画像
- ❌ 任何形式的自动危机外呼

---

## 11. 执行顺序建议（给下一个接手的人）

```
1. P0 骨架（30 min）
2. P3 词表 + 分级（先写测试，再写实现）   ← 提前做，因为它决定 prompt 结构
3. P1 知识库（最花时间，10 篇，建议一次写 3 篇）
4. P2 Agent + 工具（1 h）
5. P4 UI（1.5 h，补间动画别省）
6. P5 验收（半天，含手工 6 条路径）
```

**先做 P3 而不是最后做**，是因为危机协议会反向决定 `system.md` 的结构和 SSE 的帧类型（`event: crisis`）。
把它放最后，等于要重写 prompt 和前端。

---

## 12. 实施进度（2026-10-25）

P0–P5 已全部落地，`pytest` **60 条**全绿，`scripts/smoke_test.py` 5 条端到端全过。
P7（Cloudflare Workers）已落地，`npm test` **56 条**全绿，`npm run typecheck` 零错误。

| 阶段 | 状态 | 落地物 |
|---|---|---|
| P0 骨架 | ✅ | `.venv`、`requirements.txt`、`app/config.py`、`app/main.py`、`.gitignore` |
| P1 知识库 | ✅ | `knowledge/` 9 篇 → 72 块；`scripts/ingest_kb.py`；`app/tools/kb_search.py`（BM25 + 覆盖度门槛） |
| P2 Agent | ✅ | `app/prompts/system.md`、`app/agent.py`、`app/tools/{web_search,crisis}.py` |
| P3 安全层 | ✅ | `safety/{lexicon,input_guard,output_guard,crisis_script}.py`，38 条测试 |
| P4 UI | ✅ | `web/{index.html,style.css,app.js}` + `POST /api/chat` SSE |
| P5 验收 | ✅ | `tests/`、`scripts/smoke_test.py`、`scripts/screenshot.mjs`、`docs/*.png` |
| P7 Workers | ✅ | `worker/src/**`（TS 全量镜像）、`wrangler.jsonc`、`scripts/build-kb.mjs`、`worker/test/` 56 条、`docs/ui-worker*.png` |

**与原计划的偏差（都是实测后改的）：**

1. **危机路径不调模型**。Mercury 3 的 API 审核会拒答自杀相关内容（返回英文拒绝语）。
   原计划"正则 + LLM 二次确认"整套作废：L2/L3 直接走 `crisis_script.py` 的写死话术。
2. **不用 LLM 复核分级**。误报代价只是多问一句，漏报不可逆，不值得为降误报加 500ms。
3. **检索加了覆盖度门槛**。纯 BM25 会让"量子色动力学"命中"行为动力"，加入
   `coverage >= 0.34` 与单字降权后才干净。
4. **preview 文件不保留**。样张直接转正为 `index.html`，避免两份 CSS 漂移。
5. **P7 变成手写镜像，不是代码共享**。Python 与 TS 各自实现 `safety/` 与 `tools/`，
   靠两边测试对齐行为。这是当时唯一的现实选择（无跨语言共享层），代价见风险表 R11。

**未做（v1 明确范围外）：** 账号体系、图片/语音输入、量表计分、多 Agent 编排、长期记忆。
