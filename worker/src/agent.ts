/**
 * Agent 装配（Cloudflare Workers 版）。
 *
 * Mercury 3 的三个适配点：
 * 1. 必须走 Chat Completions（useResponses: false），不能用默认的 Responses API
 * 2. 必须关掉 tracing，否则会拿没有的 OpenAI key 去上传
 * 3. reasoning_effort 不在 OpenAI 标准字段里，走 providerData
 *
 * ## 每轮只挂必要的工具
 *
 * `routing.ts` 会把每一轮判成 chat / kb / web，这里按判定结果挂工具。
 * chat 模式**一个检索工具都不挂**——这是首字延迟的关键，详见 routing 的模块注释。
 */

import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } from "@openai/agents";

import { SYSTEM_PROMPT } from "./generated/prompt";
import type { TurnPlan } from "./routing";
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
      "用户问「该怎么办」「有什么办法」「要不要看医生」。" +
      "Do NOT use when: 用户在危机中需要立刻回应（那时先给热线，不要先查资料）；你只是要寒暄或复述情绪。" +
      "只查一次。一次没查到就直接用常识回答，不要换关键词反复查——每多查一次，用户就多等两秒。" +
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
      "或需要核实 2026 年之后才有的信息、具体地址与收费。" +
      "Do NOT use when: 用户在描述情绪、需要陪伴或方法（那属于 kb_search）；用户在危机中（先给热线，不要先搜）。" +
      "只搜一次。不要转述搜索结果里的电话号码。" +
      "返回: 最多 4 条搜索结果，含标题、摘要、链接。结果可能不准确，需向用户说明。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
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
      "也可用于「怎么帮一个想不开的朋友」。" +
      "Do NOT use when: 用户只是普通压力、没有风险信号（那属于 kb_search 的职责）。" +
      "返回: 可直接转述的热线清单（号码已核对）与安全计划六步。号码必须原样使用，不得改写。",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async () => `${resourcesText()}\n\n${safetyPlanText()}`,
  });

  // 工具注册表。键名必须与 routing.TurnPlan.tools 里的字符串一致。
  return { kb_search: kbTool, web_search: webTool, crisis_resources: crisisTool };
}

export function buildAgent(env: Env, decision: GuardDecision, turn: TurnPlan): Agent {
  // 安全指令（inputGuard）在前，路由指令（routing）在后
  const directives = [decision.directive, turn.directive].filter(Boolean);
  const instructions = directives.length
    ? `${SYSTEM_PROMPT}\n\n<this_turn>\n${directives.join("\n\n")}\n</this_turn>`
    : SYSTEM_PROMPT;

  // 危机轮次给多一点思考预算；日常对话用 low，换来更快的第一句
  const effort = decision.level >= 2 ? "medium" : (env.MERCURY_REASONING_EFFORT ?? "low");

  const registry = buildTools(env);

  return new Agent({
    name: "心屿",
    instructions,
    model: env.MERCURY_MODEL ?? "mercury-3",
    tools: turn.tools.map((name) => registry[name as keyof typeof registry]).filter(Boolean),
    modelSettings: {
      temperature: clampTemperature(env.MERCURY_TEMPERATURE),
      maxTokens: 800,
      providerData: { reasoning_effort: effort },
    },
  });
}

/** 没有工具可挂时只跑一轮模型；有工具时给到 3 轮（1 次工具 + 1 次收尾 + 1 次余量） */
export function maxTurnsFor(mode: TurnPlan["mode"]): number {
  return mode === "chat" ? 1 : 3;
}

export function buildRunner(env: Env): Runner {
  return new Runner({ modelProvider: provider(env) });
}

export function isRefusal(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes("potentially dangerous or harmful") || raw.includes("can't help with this");
}

export const REFUSAL_TEXT = REFUSAL_FALLBACK;
