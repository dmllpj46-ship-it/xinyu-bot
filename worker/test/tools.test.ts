import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HOTLINES, SAFETY_PLAN_STEPS, resourcesText, safetyPlanText } from "../src/tools/crisis";
import { search } from "../src/tools/kbSearch";
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
