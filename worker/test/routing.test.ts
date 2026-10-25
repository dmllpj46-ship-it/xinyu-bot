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
import { scriptFor } from "../src/safety/crisisScript";
import { POLICE_NUMBER, WOMENS_FEDERATION_NUMBER } from "../src/tools/crisis";

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

  it("kb 不许提「知识库」这类过程词", () => {
    // 线上出现过「我先从知识库查一下……」——对方不需要知道检索过程
    const turn = plan("我睡不着怎么办", assess("我睡不着怎么办"));
    expect(turn.directive).toContain("不要提「知识库」");
  });

  it("web 不许转述搜索结果里的电话号码（R4）", () => {
    const turn = plan("上海哪里有免费的心理咨询", assess("上海哪里有免费的心理咨询"));
    expect(turn.directive).toContain("不要转述搜索结果里的电话号码");
  });
});

describe("家暴", () => {
  // 分两层：没到致命的走 kb + crisis_resources（模型还能说话），
  // 致命的直接走脚本（模型会拒答，见下面"致命家暴不调模型"）。
  const cases = [
    "我老公昨天打我了，我该怎么办",
    "他跟踪我，还说不许我出门",
    "我想申请人身安全保护令",
    "他揍了我，但是没伤到",
    "家暴三年了，我很痛苦",
  ];

  for (const message of cases) {
    it(`「${message}」查知识库 + 给危机资源`, () => {
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("kb");
      expect(turn.tools).toContain("kb_search");
      expect(turn.tools).toContain("crisis_resources");
    });
  }

  const lethal = [
    "他掐我脖子，是不是很危险",
    "他掐我脖子，还威胁要杀我",
    "他说要杀了我",
    "他拿刀对着我",
    "他把我打得住院了",
    "他刚才在家动手打我",
  ];
  for (const message of lethal) {
    it(`「${message}」致命家暴不调模型`, () => {
      // 为什么：Mercury 3 的 API 审核会拒掉显式暴力内容。实测
      // 「他掐我脖子，还威胁要杀我」被直接拒掉，crisis_resources 一次都没调到，
      // 110 和 12338 一个都到不了用户眼前。和自杀内容被拒是同一回事。
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("crisis");
      expect(turn.tools).toEqual([]);
    });
  }

  it("致命家暴的脚本先给 110 再给 12338", () => {
    const text = scriptFor(assess("他掐我脖子，还威胁要杀我"));
    expect(text).toContain(POLICE_NUMBER);
    expect(text).toContain(WOMENS_FEDERATION_NUMBER);
    expect(text.indexOf(POLICE_NUMBER)).toBeLessThan(text.indexOf(WOMENS_FEDERATION_NUMBER));
    expect(text).toContain("你现在安全吗");
  });

  it("致命家暴不发自伤安全计划卡片", () => {
    // 「把可能伤害自己的东西交给别人保管」用在家暴场景文不对题
    const d = assess("他掐我脖子，还威胁要杀我");
    expect(d.dv).toBe(true);
    expect(d.showCard).toBe(false);
  });

  const serious = [
    "他揍了我一顿，我出血了",
    "他把我打得住院了",
    "他拿刀对着我",
    "他打得我手臂都紫了",
  ];
  for (const message of serious) {
    it(`「${message}」这类真实说法必须拿到号码`, () => {
      // 旧版 DV 只认「打我」，这些全漏成了 chat，一个热线都没给
      const turn = plan(message, assess(message));
      if (turn.mode === "crisis") {
        expect(scriptFor(assess(message))).toContain(POLICE_NUMBER);
        return;
      }
      expect(turn.mode).toBe("kb");
      expect(turn.tools).toContain("crisis_resources");
    });
  }

  const ordinary = ["他打得很好", "我刚才打游戏", "别在背后打小报告"];
  for (const message of ordinary) {
    it(`「${message}」不是家暴`, () => {
      // 「打」字太常见。暴力动词必须配伤情词，否则「他打得很好」也会被判成家暴
      expect(plan(message, assess(message)).tools).not.toContain("crisis_resources");
    });
  }

  it("短消息也不跳过检索", () => {
    // 「他打我了」只有 4 个字，但绝不能因为短就跳过检索
    const turn = plan("他打我了", assess("他打我了"));
    expect(turn.mode).toBe("kb");
    expect(turn.reason).toBe("dv");
  });

  const variants = ["他只是推了我一下", "他推搡我", "他扇了我一耳光"];
  for (const message of variants) {
    it(`「${message}」这类轻描淡写的说法也挂危机资源`, () => {
      // 轻描淡写本身是常见反应
      expect(plan(message, assess(message)).tools).toContain("crisis_resources");
    });
  }

  it("指令里写死：不许劝和，必须给号码", () => {
    // 挂工具不等于模型会调，所以指令里要写死
    const turn = plan("他只是推了我一下", assess("他只是推了我一下"));
    expect(turn.directive).toContain("crisis_resources");
    expect(turn.directive).toContain("为了孩子忍一忍");
    expect(turn.directive).not.toContain("12338"); // 号码仍只从 crisis.ts 出（R4）
  });
});

describe("四个新增领域的路由", () => {
  const cases = [
    "我们天天吵架，他回家就玩手机不说话",
    "我妈什么都管，我快三十了她还催我结婚",
    "我一辅导作业就发火，孩子根本不听我的",
    "领导永远不满意，天天加班到十一二点",
    "被裁了，不敢告诉家里",
  ];
  for (const message of cases) {
    it(`「${message}」走知识库而不是直答`, () => {
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("kb");
      expect(turn.tools).toEqual(["kb_search"]);
    });
  }
});

describe("具体生活事件：短也要查", () => {
  const cases = [
    "被裁了，不敢告诉家里",
    "我离婚了",
    "他出轨了",
    "孩子厌学，不肯去学校了",
    "婆媳矛盾越来越严重了",
    "我爸生病住院了，赡养的事没人管",
    "我爷爷上周去世了",
    "我想辞职，但不敢",
  ];
  for (const message of cases) {
    it(`「${message}」事件词出现即成立`, () => {
      // 测的是 KB_EVENT 不设长度门槛：少了这条，"被裁了，不敢告诉家里"
      // （8 字）会被当成纯情绪表达直接答，职场那篇根本检索不到。
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("kb");
      expect(turn.reason).toBe("kb:event");
    });
  }

  const feelings = ["我好累", "压力好大", "最近很焦虑", "烦死了", "睡不着", "心里堵得慌"];
  for (const message of feelings) {
    it(`「${message}」纯感受仍然不检索`, () => {
      // 反面对照：感受词仍要长度门槛，否则每条情绪消息都要多等一秒
      const turn = plan(message, assess(message));
      expect(turn.mode).toBe("chat");
      expect(turn.tools).toEqual([]);
    });
  }
});
