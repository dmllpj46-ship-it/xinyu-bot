import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HOTLINES, SAFETY_PLAN_STEPS, resourcesText, safetyPlanText } from "../src/tools/crisis";
import { search, searchHits } from "../src/tools/kbSearch";
import { ALLOWED_NUMBERS } from "../src/safety/outputGuard";
import { KB_CHUNKS } from "../src/generated/kb";
import { SYSTEM_PROMPT } from "../src/generated/prompt";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("知识库检索", () => {
  it("块数够用", () => {
    expect(KB_CHUNKS.length).toBeGreaterThanOrEqual(40);
  });

  it.each([
    ["我睡不着，躺下就开始想工作的事", "睡眠"],
    ["一想到上班就胸闷心慌", "焦虑"],
    ["什么都不想做，提不起劲", "抑郁"],
    ["我是不是抑郁症", "常见提问"],
    ["我朋友说他不想活了怎么办", "常见提问"],
    ["怎么跟家里人说我的情况", "常见提问"],
    ["想死", "危机"],
  ])("「%s」应命中「%s」", (query, expectDoc) => {
    const out = search(query, 3);
    const heads = out.split("\n").filter((l) => l.startsWith("【"));
    expect(heads.length, `${query} 没有任何命中`).toBeGreaterThan(0);
    expect(heads.some((h) => h.includes(expectDoc)), `${query} 未命中 ${expectDoc}：${heads}`).toBe(true);
  });

  it("没有命中时如实说，不硬凑", () => {
    expect(search("量子色动力学的渐近自由")).toContain("没有直接相关");
  });

  it("输出长度受控", () => {
    expect(search("压力很大 睡不着 心慌 什么都不想做").length).toBeLessThanOrEqual(1400);
  });
});

describe("危机资源", () => {
  it("热线表含 12356 / 120 / 110", () => {
    const numbers = new Set(HOTLINES.map((h) => h.number));
    expect(numbers.has("12356")).toBe(true);
    expect(numbers.has("120")).toBe(true);
    expect(numbers.has("110")).toBe(true);
  });

  it("常量表里的号码必须在输出护栏白名单内", () => {
    for (const h of HOTLINES) {
      const digits = h.number.replace(/\D/g, "");
      expect(ALLOWED_NUMBERS.has(digits), `${h.number} 不在白名单，会被护栏改掉`).toBe(true);
    }
  });

  it("resourcesText 含关键号码", () => {
    const text = resourcesText();
    expect(text).toContain("12356");
    expect(text).toContain("120");
  });

  it("安全计划是六步", () => {
    expect(SAFETY_PLAN_STEPS).toHaveLength(6);
    expect(safetyPlanText()).toContain("警示信号");
  });
});

// ── R4：prompt 与知识库里不许出现电话号码 ────────────────────

describe("R4 号码唯一真相源", () => {
  it("编译后的 system prompt 无 5 位以上数字", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{5,}/);
  });

  it("源文件 system.md 无 5 位以上数字", () => {
    const src = readFileSync(join(ROOT, "app/prompts/system.md"), "utf8");
    expect(src).not.toMatch(/\d{5,}/);
  });

  it("知识库 md 无电话号码", () => {
    const dir = join(ROOT, "knowledge");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(dir, name), "utf8");
      const hits = text.match(/1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}|\d{3,4}[- ]\d{3,4}[- ]\d{4}/g);
      expect(hits, `${name} 里出现了号码 ${hits}`).toBeNull();
    }
  });
});

// ── 联网搜索 ──────────────────────────────────────────────
// 2026-10 的静默失效：请求写死 tag: "general.web"，AnySearch 改名后返回 400，
// 工具降级成「请用本地知识库回答」，用户端看不到任何报错。这里钉住请求体。

describe("web_search", () => {
  const env = { ANYSEARCH_API_KEY: "test-key" } as never;

  it("请求里不带 tag", async () => {
    let sent: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          code: 0,
          data: { results: [{ title: "标题", url: "https://example.com", snippet: "摘要" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const { webSearchText } = await import("../src/tools/webSearch");
      const out = await webSearchText(env, "测试查询");
      expect("tag" in sent).toBe(false);
      expect(sent.query).toBe("测试查询");
      expect(out).toContain("标题");
      expect(out).toContain("https://example.com");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("HTTP 400 时降级而不是抛异常", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: -1, message: "Invalid tag: general.web." }), {
        status: 400,
      })) as typeof fetch;

    try {
      const { webSearchText } = await import("../src/tools/webSearch");
      const out = await webSearchText(env, "测试查询");
      expect(out).toContain("联网搜索暂时不可用");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("缺 key 时明确说明未配置", async () => {
    const { webSearchText } = await import("../src/tools/webSearch");
    const out = await webSearchText({} as never, "测试查询");
    expect(out).toContain("ANYSEARCH_API_KEY");
  });
});

describe("web_search 来源过滤", () => {
  // 实测「心理咨询补贴政策」这类泛化查询会召回台中市、卫福部的内容。
  // 面向大陆用户的产品不能原样转述，所以在来源层挡掉。
  const env = { ANYSEARCH_API_KEY: "test-key" } as never;

  async function runWith(results: Array<Record<string, string>>): Promise<string> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, data: { results } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const { webSearchText } = await import("../src/tools/webSearch");
      return await webSearchText(env, "测试查询");
    } finally {
      globalThis.fetch = original;
    }
  }

  it("丢掉港澳台来源", async () => {
    const out = await runWith([
      { title: "台中市免費心理諮商", url: "https://www.health.taichung.gov.tw/x", snippet: "衛福部" },
      { title: "香港心理衛生會", url: "https://www.mheh.org.hk/b", snippet: "香港" },
      { title: "国家卫健委 心理援助", url: "https://www.nhc.gov.cn/z", snippet: "12356" },
    ]);
    expect(out).not.toContain("台中");
    expect(out).not.toContain("衛福部");
    expect(out).not.toContain("香港");
    expect(out).toContain("国家卫健委");
  });

  it("官方来源排在前面", async () => {
    const out = await runWith([
      { title: "某商业网站", url: "https://example.com/a", snippet: "内容" },
      { title: "省医保局", url: "https://ybj.xx.gov.cn/a", snippet: "纳入医保" },
    ]);
    expect(out.indexOf("省医保局")).toBeLessThan(out.indexOf("某商业网站"));
  });

  it("全部被挡时降级说明", async () => {
    const out = await runWith([{ title: "台中市", url: "https://a.gov.tw/x", snippet: "x" }]);
    expect(out).toContain("中国大陆");
  });
});

// ── 家暴知识库 ────────────────────────────────────────────
// 这篇的检索特别容易出错：用户说的是「他打我了」，而文档正文写的是「殴打」。
// 靠领域锚词（kbSearch.ANCHORS）兜住，否则会被「怎么办」抢走命中。
describe("家暴知识库", () => {
  const queries = [
    "我老公昨天打我了，我该怎么办",
    "他掐我脖子，是不是很危险",
    "这算不算家暴，他只是推了我一下",
    "我想申请人身安全保护令，怎么弄",
    "家暴要留什么证据",
    "被打了但是为了孩子要不要忍",
  ];

  for (const query of queries) {
    it(`「${query}」首条命中家暴篇`, () => {
      const hits = searchHits(query, 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].chunk.title).toContain("家暴");
    });
  }

  it("锚词机制不影响无关查询", () => {
    expect(search("量子色动力学的渐近自由")).toContain("没有直接相关");
  });

  it("热线表里有妇联维权热线", () => {
    expect(HOTLINES.map((h) => h.number)).toContain("12338");
  });

  it("知识库不写号码（R4）", () => {
    const dir = join(ROOT, "knowledge");
    const file = readdirSync(dir).find((f) => f.includes("家暴"));
    expect(file).toBeTruthy();
    const text = readFileSync(join(dir, file!), "utf8");
    expect(text).not.toContain("12338");
    expect(text).not.toMatch(/1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}/);
  });
});
