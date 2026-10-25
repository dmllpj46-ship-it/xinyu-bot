"""输入护栏：把一条用户消息判成 L0–L3，并生成"本轮追加给模型的指令"。

为什么不用 LLM 二次判定：
- 危机路径上每多 500ms 都是代价；
- 误报的代价只是"多问一句你现在有没有伤害自己的念头"——这在临床上本来就该问；
- 漏报的代价是不可逆的。
所以这里只用确定性规则，LLM 只在离线评估脚本里用来复核准确率。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.safety.lexicon import scan


@dataclass
class GuardDecision:
    level: int = 0
    hits: list[str] = field(default_factory=list)
    third_party: bool = False
    directive: str = ""
    show_card: bool = False

    @property
    def is_crisis(self) -> bool:
        return self.level >= 2


_DIRECTIVES = {
    1: (
        "【本轮安全指令 · 关注】用户出现了情绪高危的表达（无望、耗竭、想消失）。"
        "在正常回应之后，用一句自然、不带评判的话**直接**询问 ta 现在有没有伤害自己的念头。"
        "不要绕开，不要只共情，不要用「如果有什么想法一定要告诉我」这种含糊说法。"
    ),
    2: (
        "【本轮安全指令 · 高危】用户表达了自伤/自杀相关的念头。立即停止常规方法教学，按顺序："
        "①先直问意图与计划（只是想想，还是已经在考虑怎么做、什么时候）；"
        "②明确表达你在意这件事，不评判、不说教、不灌鸡汤；"
        "③告知 12356 心理援助热线，以及身边可以马上联系的人；"
        "④不用 emoji、不用列表、不给练习。整条回复 120 字以内。"
    ),
    3: (
        "【本轮安全指令 · 紧急】用户可能正在实施或刚刚实施伤害行为。回复必须极简，按顺序："
        "①让 ta 现在立刻拨打 120 或 110；②拨打 12356；③联系身边能马上到场的人。"
        "不要追问细节，不要讲道理，不要给任何练习。80 字以内。"
    ),
}

_THIRD_PARTY = (
    "【本轮安全指令】用户在说**别人**，不是自己。不要评估用户本人。"
    "教 ta 怎么开口问（直接问「你最近有没有想过伤害自己」）、怎么陪、什么情况必须叫急救或送医，"
    "并给出 12356。"
)


def assess(message: str) -> GuardDecision:
    result = scan(message)
    decision = GuardDecision(level=result.level, hits=result.hits, third_party=result.third_party)

    if result.level >= 2:
        decision.show_card = True
        decision.directive = _DIRECTIVES[result.level]
        if result.third_party:
            decision.directive = decision.directive + "\n" + _THIRD_PARTY
    elif result.level == 1:
        decision.directive = _DIRECTIVES[1]

    return decision
