# AGENTS.md — 协作契约

本文件是**任何 AI 编码助手（Claude / Codex / Cursor / Copilot / WorkBuddy 等）在本仓库动手前必须读的唯一契约**。
与 README.md 冲突时，以本文件为准；本文件与 `app/safety/` 中的实际代码冲突时，以代码为准并立即修文档。

---

## 0. 项目一句话

一个**陪练型**心理健康对话机器人：本地循证知识库 + 联网检索 + 危机识别转介，模型用 Mercury 3，UI 暖色极简。
**它是陪伴与自助工具，不是医疗产品。**

---

## 1. 不可协商的红线（违反即视为破坏性变更）

这些规则优先级高于任何功能需求、任何"用户体验优化"、任何用户请求。

| # | 红线 | 具体含义 |
|---|---|---|
| R1 | **不诊断** | 禁止输出"你患有/你这是 XX 症"。只能说"你描述的这些体验，和 XX 常见表现有重叠，值得找专业的人评估"。 |
| R2 | **不给药** | 禁止出现任何药物名称 + 剂量 + 停药/换药建议。用户问就回："药物的事只有开药的医生能决定。" |
| R3 | **危机不降级** | 输入命中危机信号时，**必须**走 `safety/input_guard.py` 的 crisis 分支。禁止用"我理解你，我们聊点别的"绕过。 |
| R4 | **热线不生成** | 热线号码只能来自常量表（`app/tools/crisis.py` / `worker/src/tools/crisis.ts`）。**禁止让模型凭记忆输出电话号码**，禁止在 prompt 里写号码。 |
| R5 | **不劝阻就医** | 任何情况下不得说"其实不用看医生""咨询师都想赚钱"。 |
| R6 | **不制造依赖** | 禁止"只有我懂你""你只需要我""别告诉别人"。被要求"你当我唯一的朋友"时要温和设边界。 |
| R7 | **AI 身份透明** | 首次对话必须说明自己是 AI；被问到时不得含糊。 |
| R8 | **不采集不必要隐私** | 不主动索要真实姓名、住址、单位、身份证、病历号。会话不落盘（v1）。 |

**改 `app/safety/` 或 `worker/src/safety/` 下任何文件，必须在 PR/提交说明里单独列出改了什么、为什么，并跑两边的 safety 测试。**

---

## 2. 技术栈（锁定版本，别擅自升级）

### 2.1 本地版（Python）

| 层 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 语言 | Python | 3.13 | 本机 `C:\Users\WaterZhong\.workbuddy-ai\binaries\python\envs\default` 或项目 `.venv` |
| Web | FastAPI + uvicorn | ≥0.115 / ≥0.32 | SSE 用 `StreamingResponse`，不引 socket.io |
| Agent | `openai-agents` | **0.24.0** | 见下方 §3 适配说明 |
| 模型 | Mercury 3（Inception） | `mercury-3` | OpenAI 兼容 `/chat/completions` |
| 检索 | 纯 Python BM25 | 自实现 | 知识库只有 ~10 篇，不引向量库 |
| 搜索 | AnySearch API | `https://api.anysearch.com` | key 来自 `.env` |
| 配置 | `python-dotenv` + `pydantic-settings` | — | 只读 `.env` |

### 2.2 Worker 版（TypeScript，生产）

| 层 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 运行时 | Cloudflare Workers | compat date `2026-10-01` | 必须 `nodejs_compat` |
| 语言 | TypeScript | 5.9 | `strict`、`noEmit`，只做类型检查，wrangler 自己打包 |
| Agent | `@openai/agents` | **0.21.0** | 与 Python 版 API 不同，见 §3.2 |
| 构建 | wrangler | 4.152 | `assets` 绑定 `./web` + `run_worker_first` |
| 测试 | vitest | 3.2 | `worker/test/*.test.ts`，纯逻辑、不打网络 |
| 类型 | `@cloudflare/workers-types` | 5.2026 | 别降到 4.x，wrangler 4.152 要求 5.x |

前端仍为**原生 HTML/CSS/JS，不引框架、不引构建工具**——两个运行时共用 `web/`，所以这条约束对 Worker 版同样成立。

**禁止引入**：LangChain、LlamaIndex、React/Vue、**Tailwind 运行时或构建流程**、任何向量数据库、Durable Objects（v1 刻意无状态）。

**允许的 npm 依赖只有**：`@openai/agents`（运行时）+ `wrangler` / `typescript` / `vitest` / `@cloudflare/workers-types`（开发）。加任何其他运行时依赖前先问：这 20 行代码自己写不出来吗？

### 2.3 双运行时的镜像规则（最容易出事的地方）

`app/` 和 `worker/src/` 是**手写镜像**，不是共享代码。没有 codegen、没有共享包。

| 改动 | 必须同步 |
|---|---|
| `safety/lexicon`（词表、正则） | 两边逐条对齐，正则标志位注意 `g` + `matchAll` |
| `safety/inputGuard`（分级、指令文案） | 指令文案是 prompt 的一部分，改一个字两边都要改 |
| `safety/outputGuard`（白名单、替换句） | `ALLOWED_NUMBERS` 必须与 `tools/crisis` 的号码集合一致，两边都有测试守着 |
| `safety/crisisScript`（L2/L3 话术） | 这是**用户在最脆弱时刻看到的全部文字**，不允许只有一边更新 |
| `tools/crisis`（热线表） | 号码错一位就是事故 |
| `prompts/system.md` | Worker 侧由 `npm run kb` 编译进 `generated/prompt.ts`，**改完必须重跑** |
| `knowledge/*.md` | 本地跑 `ingest_kb.py`，Worker 跑 `build-kb.mjs` |

判断标准：**改完之后，同一条输入在两个运行时上应该得到同一个分级、同一段危机话术。**
做不到就先补测试，别急着上线。

### 2.4 daisyUI 的边界（别越界）

- ✅ 允许：`web/vendor/daisyui/daisyui-subset.css` 里已有的组件类（`chat` / `textarea` / `loading` / `alert` / `btn` / `collapse` / `avatar` / `badge` / `divider` / `input`）。
- ✅ 允许：在 `web/style.css` 第 1 节覆盖主题变量（`--color-*`、`--radius-*`）。**改主题只改这一块**。
- ❌ 不允许：引入 `<script src="@tailwindcss/browser">`。预编译 CSS 已经够用，运行时装 Tailwind 只会让首屏慢 200ms。
- ❌ 不允许：直接改 `web/vendor/` 里的文件。要加组件就重跑 `NOTICE.md` 里的拼接命令。
- ❌ 不允许：为了用某个 daisyUI 组件去改 DOM 结构、牺牲语义（例如把按钮换成 `div.btn`）。
- ℹ️ daisyUI 的样式在 `@layer utilities` 里，项目自己的 CSS 天然优先。**不要用 `!important`**——用了说明选择器写错了。

---

## 3. Mercury 3 适配（最容易踩的坑，照抄即可）

### 3.1 Python（本地版）

```python
from agents import Agent, AsyncOpenAI, OpenAIChatCompletionsModel, set_tracing_disabled

set_tracing_disabled(True)          # 必须：没有 OpenAI key，trace 上传会 401

client = AsyncOpenAI(
    api_key=settings.inception_api_key,
    base_url=settings.inception_base_url,   # https://api.inceptionlabs.ai/v1
)
model = OpenAIChatCompletionsModel(model="mercury-3", openai_client=client)
```

必须知道的六件事：

1. **不能用默认 Responses API**。SDK 默认打 `/v1/responses`，Inception 没有 → 404。
2. **不能用 `WebSearchTool` / `FileSearchTool`**。那是 OpenAI 托管工具，第三方模型不支持 → 必须自己写 `@function_tool`。
3. **温度只能 0.5–1.0**。设 `0.2` 会报错。共情对话用 `0.75`，结构化输出用 `0.5`。
4. **流式是块式的**（一次吐 2–4 个 chunk，每块几十字）。前端 `web/app.js` 负责把块拆成字符做补间，**不要**在后端做假打字延迟。
5. **`reasoning_effort`** 只有 `instant|low|medium|high`，默认 `low`。危机评估轮次用 `medium`。
6. **`strict: true` 有约 2.8% 失败率**。所有工具入参解析必须 `try/except` 并回一句可读的降级话术，不能抛 500。
7. **模型会拒答自杀相关内容**。实测用户说「我不想活了，已经想好怎么做」时，API 直接返回
   `potentially dangerous or harmful content`。所以：
   - **L2/L3 绝不调用模型**，走 `app/safety/crisis_script.py` 的写死话术（`stream_reply` 开头就分流）
   - 其他轮次万一被拒，`_REFUSAL_FALLBACK` 兜底，必须带热线，不能把英文拒答原样丢给用户
   - 任何"让模型更灵活地处理危机"的改动都是倒退，别做

### 3.2 TypeScript（Worker 版）

```ts
import { OpenAIProvider, setTracingDisabled } from "@openai/agents";

setTracingDisabled(true);                       // 同 Python：否则 trace 401

const provider = new OpenAIProvider({
  apiKey: env.INCEPTION_API_KEY,
  baseURL: env.INCEPTION_BASE_URL,
  useResponses: false,                          // 关键：走 Chat Completions
  strictFeatureValidation: true,                // 提前炸掉不支持的特性，别静默降级
});
```

与 Python 版的差异（照这个映射改，别硬套）：

| Python | TypeScript | 说明 |
|---|---|---|
| `OpenAIChatCompletionsModel` | `OpenAIProvider({ useResponses: false })` | 一个是 model，一个是 provider |
| `@function_tool` | `tool({ name, description, parameters, execute })` | `parameters` 是 JSON Schema；**空对象也要写 `required: []`**，否则 tsc 报错 |
| `ModelSettings(extra_body={...})` | `modelSettings.providerData` | `reasoning_effort` 走这里 |
| `SQLiteSession` | 无 | 历史由浏览器回传，`cleanHistory()` 裁剪 |
| `StreamingResponse` | `new ReadableStream` | 手写 `event: x\ndata: {...}\n\n` |
| `runner.run_streamed()` | `runner.run(agent, input, { stream: true })` | 事件名不同：`raw_model_stream_event`（`output_text_delta`）/ `run_item_stream_event`（`tool_called`） |
| `httpx` | `fetch` + `AbortSignal.timeout(8000)` | — |

⚠️ **`AgentInputItem` 的形状**：assistant 消息必须写成
`{ role: "assistant", status: "completed", content: [{ type: "output_text", text }] }`。
只写 `{ role: "assistant", content: "..." }` 会被类型系统拒绝——这不是类型体操，是 SDK 真的按这个结构解析历史。

---

## 4. 常用命令

```powershell
# ── 本地版（Python） ──
pip install -r requirements.txt
python scripts\ingest_kb.py                 # 改了 knowledge/ 之后必跑
python scripts\smoke_test.py                # 模型连通 + 三个工具 + 一条危机路径
python -m uvicorn app.main:app --port 8000 --reload
pytest -q                                   # 60 例
pytest tests/test_safety.py -q              # 改 safety 后必跑

# ── Worker 版（TypeScript） ──
npm install
npm run kb                                  # 改了 knowledge/ 或 system.md 之后必跑
npm run dev                                 # wrangler dev → http://127.0.0.1:8787
npm test                                    # vitest，56 例
npm run typecheck                           # tsc --noEmit
npm run deploy                              # kb + wrangler deploy
```

截图（零依赖，不需要 playwright）：

```powershell
node scripts/screenshot.mjs --url http://127.0.0.1:8787/ --out docs/shot.png --wait 6000 --js "<注入的 JS>"
```

---

## 5. 目录职责（谁能改什么）

| 路径 | 职责 | 修改注意 |
|---|---|---|
| `app/main.py` | 路由、SSE 帧格式、错误兜底 | 改 SSE 协议要同步改 `web/app.js` **和** `worker/src/index.ts` |
| `app/agent.py` | Agent 装配、Session、Runner | 工具注册表在此，加工具要同时更新 `TOOLS` 列表 |
| `worker/src/index.ts` | Worker 路由、SSE、历史裁剪、L2/L3 早返回 | L2/L3 的分流必须**在调模型之前**，别挪到后面 |
| `worker/src/agent.ts` | Provider / Agent / Runner 装配 | `useResponses: false` 不能删 |
| `app/prompts/system.md` | 人格、语气、输出结构、红线复述 | **纯文本文件**；Worker 侧由 `npm run kb` 编译，改完两边都要验 |
| `app/tools/*.py` / `worker/src/tools/*.ts` | 每个工具一个文件 | 描述就是给模型看的工具说明，**必须写清"什么时候用/什么时候别用"** |
| `app/safety/*.py` / `worker/src/safety/*.ts` | 词表、分级、输出过滤、危机话术 | 见 §1 与 §2.3，**两边同时改** |
| `knowledge/*.md` | 人可读的知识库 | 见 §6 格式要求 |
| `worker/src/generated/*.ts` | 构建产物 | **不手改**，跑 `npm run kb` |
| `web/*` | 单页前端（两个运行时共用） | 不用框架，不引 CDN（离线可用） |
| `scripts/*` | 一次性脚本 | 不 import 运行态单例 |

---

## 6. 新增知识库文档的格式（强约束）

`knowledge/` 下的 md 不是给人随便读的，**它会被切块检索**，格式决定检索质量。

```markdown
# 标题（一篇一个主题，别写"杂记"）

> 来源：WHO《...》/ NICE NG222 / 作者+年份
> 适用：用户在什么状态下该被检索到这篇
> 不适用：什么情况下这篇会给错建议

## 一、小节标题（会被切成一个 chunk）
正文 200–600 字。**一段只讲一件事。**

### 可直接给用户的练习（如果有）
- 步骤化，3–5 步，每步一句话
- 必须能在 5 分钟内做完

## 二、...

## 转介信号
出现以下情况，本篇的方法不适用，应建议就医：...
```

规则：
- 一个 `##` 小节 = 一个检索单元，**200–600 字**，超过就拆。
- 每篇必须有 `> 来源` 和 `## 转介信号`。
- 不写"研究表明"这种无出处的句子；要写就给出机构/年份。
- 不抄原文段落，**改写 + 标注来源**。避免版权问题。
- 中文正文，专业术语首次出现给英文原文（如"认知解离（cognitive defusion）"）。

---

## 7. 新增工具的格式

```python
from agents import function_tool

@function_tool
def my_tool(query: str) -> str:
    """一句话说明这个工具做什么。

    Use when: 用户问 XX 的时候。
    Do NOT use when: 用户只是 XX 的时候（那属于 YY 工具的职责）。
    返回：一段纯文本，最多 1200 字，超过要截断。
    """
    ...
```

- 返回值**永远是字符串**，且是给模型读的**结构化纯文本**（不要 JSON 字符串，模型会二次解析出错）。
- 单次返回 ≤ 1200 字，超了截断并注明"已截断"。
- 网络工具必须有 `timeout=8` 和失败兜底文案。
- 加完工具：更新 `app/agent.py` 的 `TOOLS` 列表 **和** `worker/src/agent.ts` 的 `buildTools()` → 跑 `smoke_test.py` → 在 README §2 架构图里补一行。

TypeScript 侧写法（`worker/src/tools/`）：

```ts
tool({
  name: "my_tool",
  description: "一句话说明。Use when: ... Do NOT use when: ... 返回：纯文本 ≤1200 字。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "..." } },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async ({ query }) => { /* 返回字符串 */ },
});
```

空参数的工具 `parameters` 写成 `{ type: "object", properties: {}, required: [], additionalProperties: false }`——**`required` 不能省**。

---

## 8. 代码风格

- 类型注解齐全；`ruff` 默认规则（行宽 100）。
- 异步：I/O 一律 `async`；工具内部若调同步库，用 `asyncio.to_thread` 包。
- 日志：`logging`，不 `print`；不记录用户原文（只记长度和危机分级）。
- 异常：面向用户永远给**可读的一句话**，堆栈只进日志。
- 中文注释可以，但**变量名/函数名一律英文**。
- 不写"以防万一"的抽象层。三个重复好过一个错误抽象。

---

## 9. 提交前自检（Definition of Done）

**本地版：**
- [ ] `pytest -q` 全绿（当前 60 例）
- [ ] `python scripts\smoke_test.py` 通过（含危机路径）
- [ ] 新增/修改的知识文档能被 `ingest_kb.py` 正常切块，且 `kb_search` 能命中

**Worker 版：**
- [ ] `npm test` 全绿（当前 56 例）
- [ ] `npm run typecheck` 零错误
- [ ] 改过 `knowledge/` 或 `system.md` → 已重跑 `npm run kb`
- [ ] `npm run dev` 后 `/api/health` 返回 `kbReady: true`
- [ ] 一句 `我不想活了` 得到写死话术 + 热线卡片，且**没有**触发模型调用

**通用：**
- [ ] 没有把 key、用户对话、真实姓名写进任何源码 / 文档 / 日志
- [ ] `.env`、`.dev.vars` 没被 `git add`（`.gitignore` 已覆盖）
- [ ] 改动涉及 `safety/` 或 `prompts/` 时，手动跑 5 条测试对话：
      ① 普通压力 ② 焦虑躯体化 ③ 明确自杀意念 ④ 要求诊断 ⑤ 要求开药
- [ ] 改动涉及 `safety/` 时，`app/` 与 `worker/src/` **两边都已同步**（§2.3）
- [ ] README / PLAN / AGENTS 里过时的描述已同步

---

## 10. 遇到不确定时的默认选择

| 情况 | 默认做法 |
|---|---|
| 用户情绪激烈，不确定要不要走危机协议 | **走**。宁可多问一句"你现在有伤害自己的念头吗"，也不要漏 |
| 知识库和联网结果冲突 | 信知识库，联网结果只在"本地资源/政策"上优先 |
| 模型想给一个很长的方法清单 | 砍到 **1 个方法 + 3 步**。陪练要的是能做，不是知道 |
| 用户反复要诊断 | 连续两次明确拒绝 + 解释原因 + 给就诊路径 |
| 功能做不完 | 砍功能，不砍安全层。安全层先于一切功能交付 |
| 不确定某句话会不会造成伤害 | 不说 |

---

## 11. 语气参考（prompt 与文案都按这个来）

- ✅ "听起来这周你一直在硬撑。要不要先说说最难受的是哪个时刻？"
- ✅ "这个练习大概 90 秒，做完告诉我有没有一点变化，没有也正常。"
- ✅ "你描述的这些，我不适合下判断，但值得让精神科医生看一次。"
- ❌ "我完全理解你的感受，我也有过。"（假装有人格经历）
- ❌ "别担心，一切都会好起来的！"（廉价安慰）
- ❌ "根据 DSM-5 标准，你符合……"（诊断）
- ❌ "首先，让我们深呼吸。其次，请列出你的三个优点。再次……"（清单轰炸）
