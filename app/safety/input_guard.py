"""输入护栏：把一条用户消息判成 L0–L3，并生成"本轮追加给模型的指令"。

为什么不用 LLM 二次判定：
- 危机路径上每多 500ms 都是代价；
- 误报的代价只是"多问一句你现在有没有伤害自己的念头"——这在临床上本来就该问；
- 漏报的代价是不可逆的。
所以这里只用确定性规则，LLM 只在离线评估脚本里用来复核准确率。

## 接线地址

2026-10-26 删掉了轮次路由（`routing.py`）——工具改为**全部常挂、由模型自主决定调不调**。
原本挂在路由里的两条安全指令搬到了这里，因为它们从来不是延迟优化，而是安全约束：

- **非致命家暴**（`DV_NONLETHAL`）→ `_DV_DIRECTIVE`，写死"必须调一次 crisis_resources"
- **L1 情绪高危** → `_L1_HOTLINE`

致命家暴（扼颈/死亡威胁/凶器/重伤/正在发生）不在这里，它在 `lexicon.DV_L2_PATTERNS`
判成 L2，直接走 `crisis_script`，**根本不进模型**（见 R9）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.safety.lexicon import normalize, scan


@dataclass
class GuardDecision:
    level: int = 0
    hits: list[str] = field(default_factory=list)
    third_party: bool = False
    dv: bool = False
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

# ── 非致命家暴 ───────────────────────────────────────────────
# 覆盖"严重但没到致命"的那一档：打、揍、推搡、扇耳光、限制出门、保护令、庇护所……
# 致命的那几种（扼颈/死亡威胁/凶器/重伤/正在发生）在 lexicon 里已升到 L2 走脚本，
# 到不了这里。
#
# 覆盖面比"殴打"宽得多：用户不会用文档里的词。实测这些说法旧版全漏成了聊天，
# 一个热线都没给——「他揍了我一顿，我出血了」「他把我打得住院了」
# 「他拿刀对着我」「他打得我手臂都紫了」。
DV_NONLETHAL = re.compile(
    r"家暴|家庭暴力|殴打|被打|打我|打了我|揍我|揍了我|被揍|动了手|动手打|"
    r"掐.{0,3}脖|施暴|扇了?我|推了?我|推搡|踹|"
    r"拿刀|持刀|动刀|抄起|"
    r"跟踪我|威胁要杀|威胁.{0,4}杀|要杀我|杀了我|"
    r"不许出门|不让出门|限制人身自由|人身安全保护令|告诫书|庇护|"
    # 暴力动词 + 伤情词，两个都要出现——避免把「他打得很好」误判成家暴
    r"(打|揍|踹|踢|扇|抽).{0,10}(受伤|出伤|紫了|淤青|肿|出血|流血|住院|骨折|疼得)"
)

# 只挂工具不够——实测模型拿到 crisis_resources 也常常不调，
# 于是妇联热线号码就不到用户眼前。所以明确要求这一轮调一次。
_DV_DIRECTIVE = (
    "【本轮安全指令 · 家暴】这一轮**必须调用 crisis_resources 一次**，"
    "并把妇联维权热线的号码原样转述给用户（号码一个字都不要改）。"
    "回应顺序：先问当下是否安全、对方是否还在现场；"
    "有危险先给报警；再谈证据、安全计划、人身安全保护令。"
    "不要劝和、不要说「为了孩子忍一忍」、不要建议用户去「沟通」。"
)

# L1（无望、耗竭、想消失）不一定是危机，但必须能当场给出热线，
# 否则用户问「能找谁」时只能得到一句"会有人的"。同样写死。
_L1_HOTLINE = (
    "如果这一轮里对方问到「能找谁」「有没有热线」，"
    "调用 crisis_resources 拿到号码后原样转述，不要凭记忆报号码。"
)


def assess(message: str) -> GuardDecision:
    result = scan(message)
    decision = GuardDecision(
        level=result.level,
        hits=result.hits,
        third_party=result.third_party,
        dv=result.dv,
    )

    if result.level >= 2:
        # 家暴不给"自伤安全计划"卡片——那套步骤（"把可能伤害自己的东西交给别人保管"）
        # 用在家暴场景是文不对题。号码由危机话术正文直接给，不靠卡片。
        decision.show_card = not result.dv
        decision.directive = _DIRECTIVES[result.level]
        if result.third_party:
            decision.directive = decision.directive + "\n" + _THIRD_PARTY
        return decision

    directives: list[str] = []
    if result.level == 1:
        directives.append(_DIRECTIVES[1])
        directives.append(_L1_HOTLINE)

    # 非致命家暴：即使没到 L1 也要写死这段。致命的那几种已经在上面走脚本了。
    if not result.dv and DV_NONLETHAL.search(normalize(message)):
        directives.append(_DV_DIRECTIVE)

    decision.directive = "\n".join(directives)
    return decision
