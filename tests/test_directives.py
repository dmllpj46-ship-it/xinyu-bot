"""安全指令测试：哪些消息要附带 `<this_turn>` 里的硬约束。

2026-10-26 删掉轮次路由（`routing.py`）后，这里守护的是**留在 `input_guard` 里的
那部分**——它们从来不是延迟优化，是安全约束：

| 触发 | 指令 |
|---|---|
| 非致命家暴 | 必须调一次 `crisis_resources`，号码原样转述，不许劝和 |
| L1 情绪高危 | 直问伤害念头 + 需要时调 `crisis_resources` 给号码 |
| L2/L3 | 不进模型，走 `crisis_script` |

致命家暴（扼颈/死亡威胁/凶器/重伤/正在发生）在 `lexicon.DV_L2_PATTERNS` 就判成了 L2，
到不了这里——见 `tests/test_safety.py`。

⚠️ 与 `worker/test/directives.test.ts` 是一对镜像，改一边必须同步另一边。
"""

from __future__ import annotations

import pytest

from app.safety.crisis_script import script_for
from app.safety.input_guard import assess
from app.tools.crisis import HOTLINES

POLICE = next(h["number"] for h in HOTLINES if h["name"] == "报警")
WOMENS_FEDERATION = next(h["number"] for h in HOTLINES if h["name"] == "妇联维权热线")


# ── 非致命家暴：必须写死"调一次危机资源" ────────────────────
# 只挂工具不够——实测模型拿到 crisis_resources 也常常不调，
# 于是妇联热线号码就不到用户眼前。
DV_SOFT = [
    "我老公昨天打我了，我该怎么办",
    "他跟踪我，还说不许我出门",
    "我想申请人身安全保护令",
    "他揍了我，但是没伤到",
    "家暴三年了，我很痛苦",
    "他打我了",
    "他只是推了我一下",
    "他推搡我",
    "他扇了我一耳光",
]


@pytest.mark.parametrize("message", DV_SOFT)
def test_dv_gets_forced_crisis_call(message: str) -> None:
    decision = assess(message)
    assert decision.level < 2, f"「{message}」不该被判成 L2"
    assert decision.dv is False
    assert "crisis_resources" in decision.directive
    assert "必须调用" in decision.directive


@pytest.mark.parametrize("message", DV_SOFT)
def test_dv_directive_forbids_reconciliation(message: str) -> None:
    """不许劝和、不许说「为了孩子忍一忍」、不许建议去沟通。"""
    directive = assess(message).directive
    assert "为了孩子忍一忍" in directive
    assert "不要劝和" in directive
    assert "沟通" in directive


@pytest.mark.parametrize("message", DV_SOFT)
def test_dv_directive_order_is_safety_first(message: str) -> None:
    """顺序写死：先问当下安全 → 有危险先报警 → 再谈证据/保护令。"""
    directive = assess(message).directive
    assert directive.index("是否安全") < directive.index("报警")
    assert directive.index("报警") < directive.index("证据")


def test_dv_directive_has_no_phone_number() -> None:
    """号码仍然只能从 crisis.py 出（R4），指令里不许写。"""
    directive = assess("他打我了").directive
    assert WOMENS_FEDERATION not in directive
    assert POLICE not in directive


# ── 反面对照：不是家暴 ──────────────────────────────────────
# 「打」字太常见。暴力动词必须配伤情词，否则「他打得很好」也会被判成家暴。
@pytest.mark.parametrize(
    "message",
    [
        "他打得很好",
        "我刚才打游戏",
        "别在背后打小报告",
        "我今天特别累",
        "我最近总是睡不着，怎么办",
        "最近有什么心理咨询的补贴政策",
        "你可以搜索一些相关网页吗",
    ],
)
def test_ordinary_messages_get_no_dv_directive(message: str) -> None:
    assert assess(message).directive == ""


# ── L1：情绪高危 ────────────────────────────────────────────
def test_l1_asks_about_self_harm() -> None:
    decision = assess("我觉得活着没什么意思")
    assert decision.level == 1
    assert "伤害自己的念头" in decision.directive


def test_l1_tells_model_to_fetch_hotline() -> None:
    """L1 不一定是危机，但用户问「能找谁」时必须当场给出号码。"""
    decision = assess("我觉得活着没什么意思")
    assert "crisis_resources" in decision.directive
    assert "12356" not in decision.directive  # 号码不从常量以外的地方来（R4）


def test_l1_and_dv_directives_stack() -> None:
    """既命中 L1 又命中家暴时，两段指令都要在。"""
    decision = assess("被他打完，我觉得活着没什么意思")
    assert decision.level == 1
    assert "伤害自己的念头" in decision.directive
    assert "crisis_resources" in decision.directive


# ── L2/L3：根本不进模型 ────────────────────────────────────
def test_l2_has_directive_but_never_used() -> None:
    """L2 仍然生成指令（便于调试），但 `stream_reply` 在模型之前就返回了。"""
    decision = assess("我真的不想活了，已经想好怎么做了")
    assert decision.level >= 2
    assert decision.directive


LETHAL_DV = [
    "他掐我脖子，是不是很危险",
    "他掐我脖子，还威胁要杀我",
    "他说要杀了我",
    "他拿刀对着我",
    "他把我打得住院了",
    "他刚才在家动手打我",
]


@pytest.mark.parametrize("message", LETHAL_DV)
def test_lethal_dv_is_level_2(message: str) -> None:
    """致命家暴必须走脚本，不调模型。

    为什么：Mercury 3 的 API 审核会拒掉显式暴力内容。实测
    「他掐我脖子，还威胁要杀我」被直接拒掉，`crisis_resources` 一次都没调到，
    110 和 12338 一个都到不了用户眼前。和自杀内容被拒是同一回事。
    """
    decision = assess(message)
    assert decision.level >= 2
    assert decision.dv is True


@pytest.mark.parametrize("message", LETHAL_DV)
def test_lethal_dv_script_has_both_numbers(message: str) -> None:
    """脚本里必须先给 110（保命），再给 12338（后续维权），顺序不能反。"""
    text = script_for(assess(message))
    assert POLICE in text and WOMENS_FEDERATION in text
    assert text.index(POLICE) < text.index(WOMENS_FEDERATION)
    assert "你现在安全吗" in text
    assert "**" not in text  # 脚本绕过 output_guard，不能有 Markdown


def test_lethal_dv_gets_no_self_harm_plan_card() -> None:
    """自伤安全计划那套步骤（"把可能伤害自己的东西交给别人保管"）用在家暴场景文不对题。"""
    decision = assess("他掐我脖子，还威胁要杀我")
    assert decision.dv is True
    assert decision.show_card is False


def test_self_harm_l2_keeps_plan_card() -> None:
    """反面对照：自杀路径仍然要给安全计划卡片。"""
    decision = assess("我真的不想活了，已经想好怎么做了")
    assert decision.dv is False
    assert decision.show_card is True
