"""危机话术：**不经过模型**的确定性回复。

为什么必须这样（2026-10-25 实测）：
Mercury 3 的 API 层自带内容审核。用户说"我真的不想活了，已经想好怎么做了"时，
模型请求会被直接拒掉，返回 "I'm sorry, but I can't help with this because it involves
potentially dangerous or harmful content."——一句用不上的话，而且没有任何热线。

所以在 L2/L3 上调用模型本身就是一个错误设计。危机回复必须是写死的：
- 不依赖模型可用性
- 不依赖模型是否愿意配合
- 号码来自 crisis.py，一个字都不会错
- 语气稳定，不会因为温度漂移

代价是失去个性化。这个代价必须付——危机当下，稳定 > 贴切。
"""

from __future__ import annotations

from app.safety.input_guard import GuardDecision
from app.tools.crisis import HOTLINES

HOTLINE = HOTLINES[0]["number"]
EMERGENCY = "120"


def script_for(decision: GuardDecision) -> str:
    if decision.level >= 3:
        return (
            f"先做一件事：现在拨 {EMERGENCY}，或者让身边的人帮你拨。\n\n"
            f"然后拨 {HOTLINE}。\n\n"
            "不用解释，也不用说清楚，先把人叫过来。"
        )

    if decision.third_party:
        return (
            "先直接问他一句：「你有想过伤害自己吗？」直接问不会害他，含糊其辞才会。\n\n"
            "如果他说有，再问有没有具体的做法和时间。别让他一个人待着，"
            "联系他能信任的家人。必要时拨 120。\n\n"
            f"你自己也需要支持，可以打 {HOTLINE}，他们会告诉你怎么陪。"
        )

    return (
        "你刚说的这句话我记住了，不想跳过它。\n\n"
        "我想认真问一句：你现在有伤害自己的念头吗？是只是想过，"
        "还是已经在考虑怎么做、什么时候？\n\n"
        f"如果此刻就有，先拨 {HOTLINE}（24 小时，免费）。"
        "不用想好说什么，接起来说「我现在很难受」就够了。\n\n"
        "你现在是一个人，还是身边有人？"
    )


def script_chunks(decision: GuardDecision, size: int = 28) -> list[str]:
    """切成小块，让前端补间动画还有得放。"""
    text = script_for(decision)
    return [text[i : i + size] for i in range(0, len(text), size)]
