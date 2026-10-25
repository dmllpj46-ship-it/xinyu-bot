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

// ── 重复句去重 ────────────────────────────────────────────
// 模型会把同一句话说两遍（一次先共情，工具回来后重新开头）。
// 提示词压不到零，所以输出侧做硬去重。

describe("重复句去重", () => {
  it("完全重复只留一次", () => {
    const { text, violations } = scrubText(
      "这种拧着的感觉最磨人。\n\n这种拧着的感觉最磨人。\n\n先确认一下：你是睡不着还是容易醒？",
    );
    expect(violations).toContain("repeat");
    expect(text.split("这种拧着的感觉最磨人").length - 1).toBe(1);
    expect(text).toContain("先确认一下");
  });

  it("包含关系也算重复", () => {
    const long = "先确认一下：你是躺下睡不着，还是睡着了但半夜醒？这两种处理不太一样。";
    const short = "先确认一下：你是躺下睡不着，还是睡着了但半夜醒？";
    const { text, violations } = scrubText(`${long}\n\n${short}`);
    expect(violations).toContain("repeat");
    expect(text.split("先确认一下").length - 1).toBe(1);
  });

  it("短句重复也拦", () => {
    const { text, violations } = scrubText("要不要试试？\n\n要不要试试？");
    expect(violations).toContain("repeat");
    expect(text.split("要不要试试").length - 1).toBe(1);
  });

  it("丢句后不留多余空行", () => {
    const { text } = scrubText("A 句在这里。\n\nA 句在这里。\n\n下一段。");
    expect(text).not.toContain("\n\n\n");
    expect(text).toBe("A 句在这里。\n\n下一段。");
  });

  it("意思不同、只是用词接近的句子不误杀", () => {
    const src =
      "先确认一下：你是躺下睡不着，还是睡着了但半夜醒？\n\n" +
      "如果是入睡困难，今晚可以先试一件小事：躺下 20 分钟还清醒就起来。";
    const { text, violations } = scrubText(src);
    expect(violations).toEqual([]);
    expect(text).toBe(src);
  });

  it("正常回复不受影响", () => {
    const src =
      "白天被催着，躺下了那股劲还没散。\n\n" +
      "先确认一下：你是躺下半天睡不着，还是睡着了又反复醒？\n\n" +
      "今晚可以先试一件小事：躺下 20 分钟还清醒就起来。要不要试试？";
    const { text, violations } = scrubText(src);
    expect(violations).toEqual([]);
    expect(text).toBe(src);
  });
});

// ── 词表漏洞回归 ──────────────────────────────────────────
describe("无意义表达的变体", () => {
  // 「没什么意思」中间夹了「什么」，早先的正则匹配不到——这是漏报
  const cases = ["我觉得活着没什么意思", "生活没什么意义了", "活着没意思", "一切都没有意义"];
  for (const message of cases) {
    it(`「${message}」至少判 L1`, () => {
      expect(assess(message).level).toBeGreaterThanOrEqual(1);
    });
  }
});

// ── Markdown 标记清理 ────────────────────────────────────
// 前端按纯文本渲染，`**` 和 `#` 会原样露出来。
describe("Markdown 标记清理", () => {
  it("去掉加粗标记但保留文字", () => {
    const { text, violations } = scrubText("**上海市心理热线**是 12356。");
    expect(text).not.toContain("**");
    expect(text).toContain("上海市心理热线");
    expect(violations).toEqual([]);
  });

  it("去掉标题井号", () => {
    const { text } = scrubText("## 今晚可以试的\n\n躺下 20 分钟还清醒就起来。");
    expect(text).not.toContain("##");
    expect(text).toContain("今晚可以试的");
  });
});

// ── 跨轮去重 ────────────────────────────────────────────
// 两段相邻气泡说同一句话，比一段里重复更出戏。
describe("跨轮去重", () => {
  it("上一轮说过的整句不再出现", () => {
    const prev =
      "躺下 20 分钟还清醒，就起来到暗一点的地方坐会儿，有困意再回床。这样反复几次，床和睡觉的关系会重新建立起来。";
    const s = new StreamScrubber(prev);
    const out = s.feed("别硬躺，起来做点别的。这样反复几次，床和睡觉的关系会重新建立起来。");
    expect(out).not.toContain("床和睡觉的关系会重新建立起来");
    expect(out).toContain("别硬躺");
    expect(s.violations).toContain("repeat");
  });

  it("短的衔接语允许跨轮重复", () => {
    const s = new StreamScrubber("今晚可以先试一件小事。要不要试试？");
    const out = s.feed("那就先做这一件。要不要试试？");
    expect(out).toContain("要不要试试");
    expect(s.violations).not.toContain("repeat");
  });
});
