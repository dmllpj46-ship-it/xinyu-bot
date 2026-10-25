/**
 * Agent 装配测试：不联网、不调模型。
 *
 * 2026-10-26 删掉了轮次路由，工具改为**全部常挂、由模型自主决定调不调**。
 * 所以这里测的不再是「这一轮挂了哪个工具」，而是：
 *
 * 1. 三个工具**永远都在**（缺一个就是能力缺失，不是优化）
 * 2. 工具描述里写清了 Use when / Do NOT use when（模型唯一的调度依据）
 * 3. 安全指令仍然注入到 `<this_turn>` 里
 *
 * ⚠️ 与 `tests/test_agent.py` 是一对镜像，改一边必须同步另一边。
 */

import { describe, expect, it } from "vitest";

import { MAX_TURNS, OPENING_NOTE, buildAgent, isOpening, type Env } from "../src/agent";
import { assess } from "../src/safety/inputGuard";

const TOOL_NAMES = ["kb_search", "web_search", "crisis_resources"];

// 测试只用到这几个字段，其余给个空壳
const ENV = {
  INCEPTION_API_KEY: "test-key",
  MERCURY_MODEL: "mercury-3",
  ASSETS: {} as Fetcher,
} as Env;

const toolNames = (decision = assess("嗯")) =>
  (buildAgent(ENV, decision).tools ?? []).map((t) => t.name);

describe("工具常挂", () => {
  it.each([
    "嗯",
    "谢谢",
    "我今天特别累",
    "我最近总是睡不着，怎么办",
    "最近有什么心理咨询的补贴政策",
    "你可以搜索一些相关网页吗",
    "他打我了",
    "我觉得活着没什么意思",
  ])("「%s」三个工具都在", (message) => {
    // 这是 10-26 那次事故的直接教训：少挂一个工具 = 模型根本没法调它。
    // 用户说「你可以搜索一些相关网页吗」却得到「这轮我没法搜」，
    // 就是因为那一轮 web_search 压根没在工具列表里。
    expect(toolNames(assess(message)).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("顺序固定", () => {
    expect(toolNames()).toEqual(TOOL_NAMES);
  });

  it("轮次上限够跑一次工具往返", () => {
    expect(MAX_TURNS).toBeGreaterThanOrEqual(2);
    expect(MAX_TURNS).toBeLessThanOrEqual(4);
  });
});

describe("工具描述：模型唯一的调度依据", () => {
  const agent = buildAgent(ENV, assess("嗯"));
  const tools = agent.tools ?? [];

  it.each(tools.map((t) => t.name))("%s 同时写了 Use when 与 Do NOT use when", (name) => {
    const desc = tools.find((t) => t.name === name)?.description ?? "";
    expect(desc).toContain("Use when");
    expect(desc).toContain("Do NOT use when");
  });

  it("kb_search 禁止说「知识库」这类过程词", () => {
    // 线上出现过「我先从知识库查一下……」
    const desc = tools.find((t) => t.name === "kb_search")?.description ?? "";
    expect(desc).toContain("知识库");
    // 2026-10-26 复现：删路由后模型自己决定何时查，于是会在**调用前**播报
    // 「我先查一下针对「躺下脑子还在转」的循证方法」。光禁名词管不住动作。
    expect(desc).toContain("「我先查一下」");
    expect(desc).toContain("不要在回复里提");
  });

  it("kb_search 不鼓励转述来源", () => {
    const desc = tools.find((t) => t.name === "kb_search")?.description ?? "";
    expect(desc).toContain("不要转述给用户");
  });

  it("prompt 也不许播报检索过程", () => {
    const text = buildAgent(ENV, assess("嗯")).instructions ?? "";
    expect(text).toContain("不播报过程");
    expect(text).toContain("我先查一下");
  });

  it("web_search 明确告诉模型不要拒答", () => {
    const desc = tools.find((t) => t.name === "web_search")?.description ?? "";
    expect(desc).toContain("直接要求你搜索");
    expect(desc).toContain("我没法联网");
  });

  it("web_search 不许转述电话号码（R4）", () => {
    const desc = tools.find((t) => t.name === "web_search")?.description ?? "";
    expect(desc).toContain("不要转述搜索结果里的电话号码");
  });

  it("crisis_resources 覆盖家暴场景", () => {
    const desc = tools.find((t) => t.name === "crisis_resources")?.description ?? "";
    expect(desc).toContain("被打");
  });
});

describe("安全指令注入", () => {
  it("普通消息没有 <this_turn>", () => {
    expect(buildAgent(ENV, assess("嗯，今天特别累")).instructions).not.toContain("<this_turn>");
  });

  it("L1 注入直问念头 + 热线指令", () => {
    const { instructions } = buildAgent(ENV, assess("我不想活了"));
    expect(instructions).toContain("<this_turn>");
    expect(instructions).toContain("12356");
  });

  it("非致命家暴注入强制调用指令", () => {
    // 挂工具不等于模型会调，所以指令里要写死
    const { instructions } = buildAgent(ENV, assess("他只是推了我一下"));
    expect(instructions).toContain("<this_turn>");
    expect(instructions).toContain("crisis_resources");
    expect(instructions).toContain("为了孩子忍一忍");
    expect(instructions).not.toContain("12338"); // 号码仍只从 crisis.ts 出（R4）
  });
});

describe("身份声明（R7）：只在开场说", () => {
  it("<role> 里就有身份，不用等格式段", () => {
    // 旧版这句在 <format>（「首次对话用一句话说明自己是 AI 陪练」）。
    // 放在格式段里，模型把它当排版规则而不是身份，被问「你是真人吗」时无据可依。
    const text = buildAgent(ENV, assess("嗯")).instructions ?? "";
    const role = text.split("</role>")[0];
    expect(role).toContain("AI");
    expect(role).toContain("不是医生，不是咨询师");
  });

  it("格式段里不再重复身份要求", () => {
    const text = buildAgent(ENV, assess("嗯")).instructions ?? "";
    const fmt = text.split("<format>")[1].split("</format>")[0];
    expect(fmt).not.toContain("AI 陪练");
  });

  it("开场注入一次，第二轮不再提", () => {
    const first = buildAgent(ENV, assess("你好"), isOpening(0)).instructions ?? "";
    const later = buildAgent(ENV, assess("你好"), isOpening(2)).instructions ?? "";

    expect(first).toContain(OPENING_NOTE);
    expect(later).not.toContain(OPENING_NOTE);
    expect(first).toContain("<this_turn>");
    expect(later).not.toContain("<this_turn>");
  });

  it("开场 + 家暴可以共存", () => {
    const text = buildAgent(ENV, assess("我老公昨天打我了"), true).instructions ?? "";
    expect(text).toContain(OPENING_NOTE);
    expect(text).toContain("crisis_resources");
    expect(text).toContain("为了孩子忍一忍");
  });

  it("开场话术不许引导「我是真人」", () => {
    expect(OPENING_NOTE).toContain("不是真人");
  });
});

describe("模型配置", () => {
  it("默认用 mercury-3", () => {
    const agent = buildAgent(ENV, assess("嗯"));
    expect(agent.model).toBe("mercury-3");
  });

  it("system prompt 里没有电话号码（R4）", () => {
    const { instructions } = buildAgent(ENV, assess("嗯"));
    expect(instructions).not.toMatch(/\d{5,}/);
  });
});
