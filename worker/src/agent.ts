/**
 * Agent 装配（Cloudflare Workers 版）。
 *
 * Mercury 3 的三个适配点：
 * 1. 必须走 Chat Completions（useResponses: false），不能用默认的 Responses API
 * 2. 必须关掉 tracing，否则会拿没有的 OpenAI key 去上传
 * 3. reasoning_effort 不在 OpenAI 标准字段里，走 providerData
 *
 * ## 工具全部常挂，由模型自己决定调不调
 *
 * 2026-10-26 删掉了轮次路由。曾经的做法是每轮先用正则判一次「要不要检索、检索哪一边」，
 * 只挂命中那一个工具。这样省延迟，但代价是**判错就当面拒答**：用户写
 * 「你可以搜索一些相关网页吗」，四个联网信号一个都没中，被判成纯聊天，
 * 一个工具都没挂，bot 回一句「这轮我没法搜，工具没挂载」——一个明确的请求
 * 被自己的门卫拦在门外。
 *
 * 现在三个工具一次全挂，模型看到工具描述自己判断。省下的那点延迟不值得拿
 * 「该查的没查、该搜的没搜」去换。实测多挂工具不影响首字延迟——模型的第一句
 * 是边想边出的，多出来的时间只在**真的调了工具**时才付。
 *
 * 工具描述（下面的 description）因此成了唯一的调度依据，写法有硬要求：
 * 必须写清 Use when / Do NOT use when，见 AGENTS.md §6。
 *
 * 安全不在这里管：L2/L3 在调用模型之前就被 `inputGuard` 拦下走写死话术；
 * 非致命家暴的「必须调 crisis_resources」写在 `decision.directive` 里。
 *
 * ⚠️ 与 `app/agent.py` 是一对镜像，改一边必须同步另一边（AGENTS.md §2.3）。
 */

import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } from "@openai/agents";

import { SYSTEM_PROMPT } from "./generated/prompt";
import { search } from "./tools/kbSearch";
import { resourcesText, safetyPlanText } from "./tools/crisis";
import { webSearchText } from "./tools/webSearch";
import type { GuardDecision } from "./safety/inputGuard";

setTracingDisabled(true);

export interface Env {
  INCEPTION_API_KEY: string;
  INCEPTION_BASE_URL?: string;
  MERCURY_MODEL?: string;
  MERCURY_TEMPERATURE?: string;
  MERCURY_REASONING_EFFORT?: string;
  ANYSEARCH_API_KEY?: string;
  ANYSEARCH_BASE_URL?: string;
  ASSETS: Fetcher;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

const REFUSAL_FALLBACK =
  "这句话我想认真接住，但这一轮我没能生成回复。\n\n" +
  "如果它对你来说很重，可以直接打 12356（24 小时，免费），不用等到撑不住才打。\n\n" +
  "我们也可以换个说法继续——你想从哪一句开始？";

function clampTemperature(raw?: string): number {
  const n = Number(raw ?? "0.75");
  if (Number.isNaN(n)) return 0.75;
  return Math.min(1, Math.max(0.5, n)); // Mercury 3 只接受 0.5–1.0
}

let cachedProvider: OpenAIProvider | null = null;
let cachedKey = "";

function provider(env: Env): OpenAIProvider {
  const key = env.INCEPTION_API_KEY;
  if (cachedProvider && cachedKey === key) return cachedProvider;
  cachedProvider = new OpenAIProvider({
    apiKey: key,
    baseURL: env.INCEPTION_BASE_URL ?? "https://api.inceptionlabs.ai/v1",
    useResponses: false,
    strictFeatureValidation: true,
  });
  cachedKey = key;
  return cachedProvider;
}

function buildTools(env: Env) {
  const kbTool = tool({
    name: "kb_search",
    description:
      "检索本地心理健康知识库（循证自助方法、危机干预、沟通技巧、转介标准）。" +
      "Use when: 用户描述具体的情绪/躯体/睡眠问题，你需要给出有依据的方法或练习；" +
      "用户问「该怎么办」「有什么办法」「要不要看医生」；" +
      "用户讲到一件具体的生活事件（被裁、离婚、出轨、孩子厌学、婆媳矛盾、亲人去世）。" +
      "Do NOT use when: 用户在危机中需要立刻回应（那时先给热线，不要先查资料）；" +
      "你只是要寒暄、道谢、复述一句情绪——「嗯」「谢谢」「我今天特别累」这类直接用自己的话接。" +
      "只查一次。一次没查到就直接用常识回答，不要换关键词反复查——每多查一次，用户就多等两秒。" +
      "千万不要在回复里提「知识库」「资料」「检索」这些过程词，就像老朋友给建议不会先报出处。" +
      "返回: 若干知识库片段，每段带【篇名 › 小节】来源标注。无命中时会明确说明。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，用用户的原话或核心困扰" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => search(String((input as { query?: string })?.query ?? "")),
  });

  const webTool = tool({
    name: "web_search",
    description:
      "联网搜索最新信息（政策、机构、新闻、本地资源）。" +
      "Use when: 用户问「最近有什么政策」「哪里有免费的」「这个机构靠谱吗」「怎么挂号」，" +
      "或需要核实 2026 年之后才有的信息、具体地址与收费；" +
      "或用户**直接要求你搜索/上网查/看看网页**（「你可以搜一下吗」「帮我查一下当地的资源」）——" +
      "这种明确请求一定要调，不要回答「我没法联网」。" +
      "Do NOT use when: 用户在描述情绪、需要陪伴或方法（那属于 kb_search）；用户在危机中（先给热线，不要先搜）。" +
      "只搜一次。要说明这是网络信息、可能不准确。不要转述搜索结果里的电话号码。" +
      "返回: 最多 4 条搜索结果，含标题、摘要、链接。结果可能不准确，需向用户说明。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，带上「中国大陆」或用户所在城市命中率更高" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => webSearchText(env, String((input as { query?: string })?.query ?? "")),
  });

  const crisisTool = tool({
    name: "crisis_resources",
    description:
      "获取危机干预热线与安全计划步骤。" +
      "Use when: 用户表达自伤/自杀念头、说自己撑不住、或问「能找谁帮忙」「有没有热线」；" +
      "用户讲到被打、被推搡、被威胁、被限制出门（家暴）；" +
      "也可用于「怎么帮一个想不开的朋友」。" +
      "Do NOT use when: 用户只是普通压力、没有风险信号（那属于 kb_search 的职责）。" +
      "返回: 可直接转述的热线清单（号码已核对）与安全计划六步。号码必须原样使用，不得改写。",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async () => `${resourcesText()}\n\n${safetyPlanText()}`,
  });

  // 三个工具常挂，顺序固定，便于测试断言与两端对齐
  return [kbTool, webTool, crisisTool];
}

export function buildAgent(env: Env, decision: GuardDecision): Agent {
  const instructions = decision.directive
    ? `${SYSTEM_PROMPT}\n\n<this_turn>\n${decision.directive}\n</this_turn>`
    : SYSTEM_PROMPT;

  // 危机轮次给多一点思考预算；日常对话用 low，换来更快的第一句
  const effort = decision.level >= 2 ? "medium" : (env.MERCURY_REASONING_EFFORT ?? "low");

  return new Agent({
    name: "心屿",
    instructions,
    model: env.MERCURY_MODEL ?? "mercury-3",
    tools: buildTools(env),
    modelSettings: {
      temperature: clampTemperature(env.MERCURY_TEMPERATURE),
      maxTokens: 800,
      providerData: { reasoning_effort: effort },
    },
  });
}

/**
 * 1 次工具调用 + 1 次收尾 + 1 次余量（模型偶尔会连调两个工具）。
 * 不再按模式封顶：模型自己决定调几个，但最多 3 轮往返，
 * 防止反复检索把首字拖成十几秒。
 */
export const MAX_TURNS = 3;

export function buildRunner(env: Env): Runner {
  return new Runner({ modelProvider: provider(env) });
}

export function isRefusal(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes("potentially dangerous or harmful") || raw.includes("can't help with this");
}

export const REFUSAL_TEXT = REFUSAL_FALLBACK;
