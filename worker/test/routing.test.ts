/**
 * 轮次路由测试：纯规则，不联网、不调模型。
 *
 * 这些用例是「延迟预算」的守门人：凡是能靠模型自己答的，就不该挂检索工具。
 * 新增关键词前先想清楚——每加一个词，就有一批消息多等两秒。
 *
 * ⚠️ 与 `tests/test_routing.py` 是一对镜像，改一边必须同步另一边。
 */

import { describe, expect, it } from "vitest";

import { plan } from "../src/routing";
import { assess } from "../src/safety/inputGuard";

const modeOf = (message: string) => plan(message, assess(message)).mode;

describe("chat：不检索", () => {
  const cases = ["嗯", "好", "谢谢", "在吗", "我今天特别累", "唉，就是觉得没劲", "你说得对，我再想想", "早上好"];
  for (const message of cases) {
    it(`「${message}」不需要检索`, () => {
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("chat");
      expect(turn.tools).toEqual([]);
    });
  }
});

describe("kb：本地知识库", () => {
  const cases = [
    "我最近总是睡不着，怎么办",
    "开会前会突然心慌手抖，是不是惊恐发作",
    "怎么拒绝同事临时甩过来的活",
    "什么都想拖到最后一刻，有什么办法",
    "情绪低落好几个月了，要不要看医生",
  ];
  for (const message of cases) {
    it(`「${message}」走 kb_search`, () => {
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("kb");
      expect(turn.tools).toEqual(["kb_search"]);
    });
  }
});

describe("web：联网", () => {
  const cases = [
    "最近有什么心理咨询的补贴政策吗",
    "上海哪里有免费的心理咨询",
    "这个机构靠谱吗",
    "现在医保能报销心理咨询吗",
    "2026 年心理治疗纳入医保了吗",
  ];
  for (const message of cases) {
    it(`「${message}」走 web_search`, () => {
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("web");
      expect(turn.tools).toEqual(["web_search"]);
    });
  }

  it("既像方法问题又像政策问题时，联网优先", () => {
    expect(modeOf("最近失眠有什么新政策能报销吗")).toBe("web");
  });

  it("只有地域词不算联网请求", () => {
    // 「我这边压力好大」不是地域检索请求，别误判成 web
    expect(modeOf("我这边压力好大")).not.toBe("web");
  });
});

describe("危机", () => {
  it("L2/L3 不调模型", () => {
    const message = "我真的不想活了，已经想好怎么做了";
    const turn = plan(message, assess(message));
    expect(turn.mode).toBe("crisis");
    expect(turn.tools).toEqual([]);
  });

  it("L1 保留 crisis_resources 以便给热线", () => {
    const message = "活着好累";
    const decision = assess(message);
    expect(decision.level).toBe(1);
    expect(plan(message, decision).tools).toContain("crisis_resources");
  });
});

describe("指令", () => {
  it("每个模式都有指令", () => {
    for (const message of ["嗯", "我睡不着怎么办", "最近有什么政策"]) {
      expect(plan(message, assess(message)).directive).toBeTruthy();
    }
  });

  it("kb 只查一次——反复查是之前延迟的主要来源之一", () => {
    const turn = plan("我睡不着怎么办", assess("我睡不着怎么办"));
    expect(turn.directive).toContain("一次");
    expect(turn.directive).toContain("不要换关键词反复查");
  });

  it("web 不许转述搜索结果里的电话号码（R4）", () => {
    const turn = plan("上海哪里有免费的心理咨询", assess("上海哪里有免费的心理咨询"));
    expect(turn.directive).toContain("不要转述搜索结果里的电话号码");
  });
});
