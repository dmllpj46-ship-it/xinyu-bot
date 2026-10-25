import { describe, expect, it } from "vitest";

import { assess } from "../src/safety/inputGuard";
import { scan } from "../src/safety/lexicon";
import { StreamScrubber, scrubText } from "../src/safety/outputGuard";

const L0 = [
  "最近工作压力好大，天天加班到十点",
  "明天要汇报，有点紧张",
  "我和我妈又吵架了，很烦",
  "我不想上班了，想请个假",
  "睡不着，翻来覆去到两点",
  "我不会自杀，只是最近很累",
  "我没有自杀的想法，就是压力大",
];

const L1 = [
  "我觉得活着没意思",
  "撑不住了，真的撑不住了",
  "看不到希望，每天都一样",
  "我想消失一段时间",
  "我是个累赘，没有我大家会轻松点",
];

const L2 = ["我不想活了", "想死", "我准备自杀了", "已经写好遗书了", "以前割过腕", "I want to die"];

const L3 = ["我刚吃了两瓶安眠药", "我现在站在天台上", "已经割腕了，血一直流"];

describe("危机分级", () => {
  it.each(L0)("L0: %s", (text) => {
    expect(scan(text).level).toBe(0);
  });
  it.each(L1)("L1: %s", (text) => {
    expect(scan(text).level).toBe(1);
  });
  it.each(L2)("L2: %s", (text) => {
    expect(scan(text).level).toBe(2);
  });
  it.each(L3)("L3: %s", (text) => {
    expect(scan(text).level).toBe(3);
  });

  it("否定式不误伤", () => {
    for (const text of ["我不会自杀", "没有想过自杀", "不至于去死", "我没自残过"]) {
      expect(scan(text).level, text).toBe(0);
    }
  });

  it("否定式不能赦免后半句", () => {
    expect(scan("我不会自杀，但有时候真的想死").level).toBeGreaterThanOrEqual(2);
  });

  it("识别第三人称", () => {
    const r = scan("我朋友说他想自杀");
    expect(r.level).toBeGreaterThanOrEqual(2);
    expect(r.thirdParty).toBe(true);
  });

  it("识别空格规避", () => {
    expect(scan("自 杀").level).toBeGreaterThanOrEqual(2);
    expect(scan("想 死").level).toBeGreaterThanOrEqual(2);
  });

  it("空输入", () => {
    expect(scan("").level).toBe(0);
    expect(scan("   ").level).toBe(0);
  });
});

describe("护栏指令", () => {
  it("危机给卡片与热线", () => {
    const d = assess("我不想活了");
    expect(d.level).toBe(2);
    expect(d.showCard).toBe(true);
    expect(d.directive).toContain("12356");
  });

  it("L1 不给卡片但要直问", () => {
    const d = assess("我觉得活着没意思");
    expect(d.level).toBe(1);
    expect(d.showCard).toBe(false);
    expect(d.directive).toContain("直接");
  });

  it("L0 无指令", () => {
    expect(assess("今天加班到很晚").directive).toBe("");
  });
});

describe("输出护栏", () => {
  it("拦诊断", () => {
    const r = scrubText("你这是抑郁症。");
    expect(r.violations).toContain("diagnosis");
    expect(r.text).not.toContain("抑郁症");
  });

  it("拦药名", () => {
    const r = scrubText("可以吃点舍曲林50mg。");
    expect(r.violations).toContain("medication");
    expect(r.text).not.toContain("舍曲林");
  });

  it("拦劝阻就医", () => {
    const r = scrubText("其实不用看医生，自己调整就行。");
    expect(r.violations).toContain("stop_care");
    expect(r.text).not.toContain("不用看医生");
  });

  it("替换编造号码", () => {
    const r = scrubText("可以打 400-161-9995 试试。");
    expect(r.violations).toContain("phone");
    expect(r.text).toContain("12356");
    expect(r.text).not.toContain("400");
  });

  it("保留白名单号码", () => {
    const r = scrubText("请拨 12356，紧急情况拨 120。");
    expect(r.violations).toEqual([]);
    expect(r.text).toContain("12356");
  });

  it("不动日期", () => {
    const r = scrubText("2025-05-01 起全国统一使用。");
    expect(r.violations).toEqual([]);
    expect(r.text).toContain("2025-05-01");
  });

  it("干净文本原样通过", () => {
    const src = "今晚可以试一个三分钟的小练习：把担心的事写在纸上。";
    const r = scrubText(src);
    expect(r.violations).toEqual([]);
    expect(r.text).toBe(src);
  });

  it("中文引号美化", () => {
    expect(scrubText('多半是大脑没"下班"。').text).toBe("多半是大脑没「下班」。");
    expect(scrubText('调用 "kb_search" 工具。').text).toBe('调用 "kb_search" 工具。');
  });

  it("按句缓冲", () => {
    const s = new StreamScrubber();
    expect(s.feed("你这是")).toBe("");
    const out = s.feed("抑郁症。");
    expect(out).not.toContain("抑郁症");
    expect(s.violations).toContain("diagnosis");
  });

  it("flush 吐出剩余", () => {
    const s = new StreamScrubber();
    s.feed("没有句号的尾巴");
    expect(s.flush()).toBe("没有句号的尾巴");
  });
});
