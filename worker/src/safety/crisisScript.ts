/**
 * 危机话术：**不经过模型**的确定性回复。
 *
 * 为什么必须这样（2026-10-25 实测）：
 * Mercury 3 的 API 层自带内容审核。用户说「我真的不想活了，已经想好怎么做了」时，
 * 模型请求会被直接拒掉，返回 "I'm sorry, but I can't help with this because it involves
 * potentially dangerous or harmful content."——一句用不上的话，而且没有任何热线。
 *
 * 2026-10-26 又发现同一件事发生在显式暴力上：「他掐我脖子，还威胁要杀我」
 * 同样被拒，`crisis_resources` 一次都没调到。所以致命家暴也走这里（lexicon 的 DV_L2）。
 *
 * 所以在 L2/L3 上调用模型本身就是错误设计。危机回复必须写死：
 * 不依赖模型可用性、不依赖模型是否配合、号码一个字都不会错、语气不会漂。
 * 代价是失去个性化——危机当下，稳定 > 贴切。
 */

import type { GuardDecision } from "./inputGuard";
import { EMERGENCY_NUMBER, HOTLINE_NUMBER, POLICE_NUMBER, WOMENS_FEDERATION_NUMBER } from "../tools/crisis";

/** 致命家暴。和自伤那套的区别：不问「有没有伤害自己的念头」，问「现在安全吗、他还在不在现场」。 */
function dvScript(): string {
  return (
    "这句话我想认真接住。先问最要紧的：你现在安全吗？他还在不在现场？\n\n" +
    `如果他还在，或者你觉得他随时可能再动手——先拨 ${POLICE_NUMBER}，让警察到场。这件事最重要，别管面子，也别等。\n\n` +
    `如果暂时没有即时危险，拨 ${WOMENS_FEDERATION_NUMBER}（妇联维权热线）。他们能告诉你去哪、怎么留证据、怎么申请人身安全保护令。\n\n` +
    "你不需要现在决定要不要离开、要不要原谅。先保证今晚是安全的。"
  );
}

export function scriptFor(decision: GuardDecision): string {
  if (decision.dv) return dvScript();

  if (decision.level >= 3) {
    return (
      `先做一件事：现在拨 ${EMERGENCY_NUMBER}，或者让身边的人帮你拨。\n\n` +
      `然后拨 ${HOTLINE_NUMBER}。\n\n` +
      "不用解释，也不用说清楚，先把人叫过来。"
    );
  }

  if (decision.thirdParty) {
    return (
      "先直接问他一句：「你有想过伤害自己吗？」直接问不会害他，含糊其辞才会。\n\n" +
      "如果他说有，再问有没有具体的做法和时间。别让他一个人待着，联系他能信任的家人。必要时拨 120。\n\n" +
      `你自己也需要支持，可以打 ${HOTLINE_NUMBER}，他们会告诉你怎么陪。`
    );
  }

  return (
    "你刚说的这句话我记住了，不想跳过它。\n\n" +
    "我想认真问一句：你现在有伤害自己的念头吗？是只是想过，还是已经在考虑怎么做、什么时候？\n\n" +
    `如果此刻就有，先拨 ${HOTLINE_NUMBER}（24 小时，免费）。不用想好说什么，接起来说「我现在很难受」就够了。\n\n` +
    "你现在是一个人，还是身边有人？"
  );
}

/** 切成小块，让前端补间动画还有得放。 */
export function scriptChunks(decision: GuardDecision, size = 28): string[] {
  const text = scriptFor(decision);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
