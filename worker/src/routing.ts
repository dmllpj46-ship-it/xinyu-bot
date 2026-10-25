/**
 * 轮次路由：决定这一轮要不要检索、检索哪一边。
 *
 * ## 为什么需要路由
 *
 * 压力大的人对延迟极度敏感。一次检索要付两份钱：多一轮模型调用 + 一次外部请求，
 * 实测在 1.5–3 秒之间。而绝大多数轮次其实不需要检索——接一句情绪、答一个常识问题，
 * 模型自己就够了。反过来，涉及政策、本地机构、时事的问题，不联网就只能瞎编。
 *
 * 所以每轮先判一次，**只挂必要的工具**。判错的代价是不对称但都可接受：
 * - 该检索没检索 → 答得浅一点，不会说错；
 * - 不该检索却检索 → 只损失速度。
 *
 * ## 四种模式
 *
 * | mode | 挂哪些工具 | 典型输入 |
 * |---|---|---|
 * | `crisis` | 不调模型，脚本兜底 | 自伤/自杀信号（L2/L3） |
 * | `chat` | 无检索工具 | 「嗯」「谢谢」「我今天特别累」 |
 * | `kb` | `kb_search` | 「睡不着怎么办」「怎么拒绝同事」 |
 * | `web` | `web_search` | 「最近有什么补贴政策」「哪有免费咨询」 |
 *
 * ⚠️ 本文件与 `app/routing.py` 是一对镜像，改一边必须同步另一边（AGENTS.md §2.3）。
 */

import type { GuardDecision } from "./safety/inputGuard";
import { normalize } from "./safety/lexicon";

export type Mode = "crisis" | "chat" | "kb" | "web";

// ── 联网信号 ──────────────────────────────────────────────
// 时效性词单独出现不够：中文里「最近」「现在」几乎无处不在（"我最近很累"），
// 必须和一个"会随时间变的东西"（政策或具体资源）同时出现才算联网请求。
const WEB_FRESH =
  /最新|最近|近期|今年|明年|去年|目前|现在|这两天|这几天|这阵子|新闻|报道|出台了|刚发布|新规/;
// 制度性：政策、钱、报销。这类词本身就说明要外部信息，可以单独成立。
const WEB_POLICY = /政策|规定|条例|法规|医保|报销|补贴|纳入|收费标准|多少钱|费用|价格/;
// 地域性：必须和资源名词同时出现，否则「我这边压力好大」会被误判
const WEB_LOCAL =
  /北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|重庆|天津|苏州|长沙|郑州|青岛|我这边|本地|当地|附近|周边|哪里|哪儿|哪家/;
const WEB_RESOURCE =
  /医院|机构|门诊|咨询|援助|热线|资源|预约|挂号|医生|心理科|精神科|服务中心|平台|APP|app|小程序|公众号/;
// 机构类：问「靠不靠谱」本身就需要外部信息
const WEB_INSTITUTION = /机构|靠谱|正规|资质|认证|哪家好/;

// ── 知识库信号 ────────────────────────────────────────────
// 主题名词是最强信号：出现就说明这条消息落在知识库覆盖的范围内。
// 但要有一定长度——「我这边压力好大」这种纯情绪短句，模型自己就能接住，不必检索。
const KB_TOPIC =
  /失眠|睡不着|入睡|早醒|多梦|噩梦|睡眠|焦虑|恐慌|惊恐|抑郁|低落|情绪|压力|内耗|反刍|胡思乱想|拖延|注意力|专注|procrastinat|心慌|心悸|手抖|出汗|胸闷|躯体|头痛|胃|食欲|社交|沟通|拒绝|边界|完美主义|自责|羞耻|内疚|悲伤|难过|哀伤|丧失|去世|分手|离婚|失恋|失业|裁员|考试|绩效|加班|领导|同事|父母|孩子|伴侣|婚姻|原生家庭|创伤|成瘾|手机|游戏/;

// 求方法：强信号本身就说明「我要一个办法」，没有歧义，不需要长度门槛
const KB_ASK_STRONG =
  /怎么办|咋办|怎么才能|怎么才|如何|有什么办法|有没有办法|方法|技巧|练习|该不该|要不要|是不是|正常吗|算不算/;
// 弱信号：单个「怎么」「多久」在情绪表达里也很常见（"我怎么这么累"），
// 需要配一点上下文长度才认定是在求方法
const KB_ASK_WEAK = /怎么|多久|为什么/;

const KB_TOPIC_MIN = 12; // 主题名词成立所需的最短长度
const KB_ASK_WEAK_MIN = 10; // 弱求方法信号成立所需的最短长度

// ── 路由指令（追加到 system prompt 的 <this_turn> 里）─────────
const DIRECTIVES: Record<Mode, string> = {
  chat:
    "【本轮路由 · 不检索】这一轮不需要查知识库，也不需要联网。" +
    "直接用常识和共情回应。不要提「知识库」「资料」，不要列方法清单。" +
    "控制在 120 字以内，让对方愿意继续说下去。",
  kb:
    "【本轮路由 · 本地知识库】调用 kb_search **一次**即可，然后用检索结果回答。" +
    "一次没查到就直接用常识回答，**不要换关键词反复查**——每多查一次，对方就多等两秒。",
  web:
    "【本轮路由 · 联网】必须调用 web_search **一次**，基于搜索结果回答。" +
    "要说明这是网络信息、可能不准确。" +
    "**不要转述搜索结果里的电话号码**，号码只能来自 crisis_resources。" +
    "只采用中国大陆的官方来源（.gov.cn、卫健委、医保局）；" +
    "港澳台地区的信息不要采用，提到时一律写「中国台湾」「中国香港」「中国澳门」。" +
    "搜索关键词里带上「中国大陆」或用户所在城市，命中率会明显提高。",
  crisis: "",
};

export interface TurnPlan {
  mode: Mode;
  tools: string[];
  directive: string;
  reason: string;
}

function webSignal(text: string): string {
  // 政策/机构类可以单独成立
  if (WEB_POLICY.test(text)) return "policy";
  if (WEB_INSTITUTION.test(text)) return "institution";
  // 地域 + 资源
  if (WEB_LOCAL.test(text) && WEB_RESOURCE.test(text)) return "local";
  // 时效性必须配一个"会变的东西"，否则「我最近很累」会被误判成联网
  if (WEB_FRESH.test(text) && (WEB_RESOURCE.test(text) || WEB_POLICY.test(text))) return "fresh";
  return "";
}

function kbSignal(text: string): string {
  if (KB_ASK_STRONG.test(text)) return "ask";
  if (KB_ASK_WEAK.test(text) && text.length >= KB_ASK_WEAK_MIN) return "ask-weak";
  if (KB_TOPIC.test(text) && text.length >= KB_TOPIC_MIN) return "topic";
  return "";
}

/** 给出这一轮的模式、工具集与追加指令。 */
export function plan(message: string, decision: GuardDecision): TurnPlan {
  if (decision.level >= 2) {
    return { mode: "crisis", tools: [], directive: "", reason: `level=${decision.level}` };
  }

  const text = normalize(message);

  // 联网优先于知识库：需要外部信息时，本地库帮不上忙
  const web = webSignal(text);
  const kb = kbSignal(text);

  let mode: Mode;
  let tools: string[];
  let reason: string;

  if (web) {
    mode = "web";
    tools = ["web_search"];
    reason = `web:${web}`;
  } else if (kb) {
    mode = "kb";
    tools = ["kb_search"];
    reason = `kb:${kb}`;
  } else {
    mode = "chat";
    tools = [];
    reason = "no-retrieval-signal";
  }

  // L1（情绪高危）必须能给出热线，所以额外挂 crisis_resources
  if (decision.level === 1) tools.push("crisis_resources");

  return { mode, tools, directive: DIRECTIVES[mode], reason };
}
