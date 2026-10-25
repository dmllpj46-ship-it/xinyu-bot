"""轮次路由测试：纯规则，不联网、不调模型。

这些用例是"延迟预算"的守门人：凡是能靠模型自己答的，就不该挂检索工具。
新增关键词前先想清楚——每加一个词，就有一批消息多等两秒。
"""

from __future__ import annotations

import pytest

from app.routing import plan
from app.safety.input_guard import assess


def _mode(message: str) -> str:
    return plan(message, assess(message)).mode


# ── chat：不检索 ────────────────────────────────────────────
@pytest.mark.parametrize(
    "message",
    [
        "嗯",
        "好",
        "谢谢",
        "在吗",
        "我今天特别累",
        "唉，就是觉得没劲",
        "你说得对，我再想想",
        "早上好",
    ],
)
def test_chat_needs_no_retrieval(message: str) -> None:
    turn = plan(message, assess(message))
    assert turn.mode == "chat"
    assert turn.tools == ()


# ── kb：本地知识库 ──────────────────────────────────────────
@pytest.mark.parametrize(
    "message",
    [
        "我最近总是睡不着，怎么办",
        "开会前会突然心慌手抖，是不是惊恐发作",
        "怎么拒绝同事临时甩过来的活",
        "什么都想拖到最后一刻，有什么办法",
        "情绪低落好几个月了，要不要看医生",
    ],
)
def test_kb_for_method_questions(message: str) -> None:
    turn = plan(message, assess(message))
    assert turn.mode == "kb"
    assert turn.tools == ("kb_search",)


# ── web：联网 ───────────────────────────────────────────────
@pytest.mark.parametrize(
    "message",
    [
        "最近有什么心理咨询的补贴政策吗",
        "上海哪里有免费的心理咨询",
        "这个机构靠谱吗",
        "现在医保能报销心理咨询吗",
        "2026 年心理治疗纳入医保了吗",
    ],
)
def test_web_for_time_sensitive_questions(message: str) -> None:
    turn = plan(message, assess(message))
    assert turn.mode == "web"
    assert turn.tools == ("web_search",)


def test_web_beats_kb() -> None:
    """既像方法问题又像政策问题时，联网优先——本地库答不了会变的信息。"""
    assert _mode("最近失眠有什么新政策能报销吗") == "web"


def test_locality_alone_is_not_enough() -> None:
    """「我这边压力好大」不是地域检索请求，别误判成 web。"""
    assert _mode("我这边压力好大") == "chat"


# ── 危机 ────────────────────────────────────────────────────
def test_crisis_level_skips_model() -> None:
    turn = plan("我真的不想活了，已经想好怎么做了", assess("我真的不想活了，已经想好怎么做了"))
    assert turn.mode == "crisis"
    assert turn.tools == ()


def test_l1_keeps_crisis_tool() -> None:
    message = "我觉得活着没什么意思"
    decision = assess(message)
    assert decision.level == 1
    turn = plan(message, decision)
    assert "crisis_resources" in turn.tools


# ── 指令 ────────────────────────────────────────────────────
def test_each_mode_has_directive() -> None:
    for message in ["嗯", "我睡不着怎么办", "最近有什么政策"]:
        assert plan(message, assess(message)).directive


def test_kb_directive_forbids_repeat_search() -> None:
    """kb 只查一次——反复查是之前延迟的主要来源之一。"""
    turn = plan("我睡不着怎么办", assess("我睡不着怎么办"))
    assert "一次" in turn.directive
    assert "不要换关键词反复查" in turn.directive


def test_web_directive_forbids_phone_numbers() -> None:
    """搜索结果里常带机构电话，模型不能转述（R4）。"""
    turn = plan("上海哪里有免费的心理咨询", assess("上海哪里有免费的心理咨询"))
    assert "不要转述搜索结果里的电话号码" in turn.directive


# ── 家暴 ────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "message",
    [
        "我老公昨天打我了，我该怎么办",
        "他掐我脖子，是不是很危险",
        "他跟踪我，还说不许我出门",
        "我想申请人身安全保护令",
    ],
)
def test_dv_goes_to_kb_with_crisis_resources(message: str) -> None:
    """家暴必须查知识库（安全计划、证据、保护令都在那篇里），同时要能给出热线。"""
    turn = plan(message, assess(message))
    assert turn.mode == "kb"
    assert "kb_search" in turn.tools
    assert "crisis_resources" in turn.tools


def test_dv_short_message_still_searches() -> None:
    """「他打我了」只有 4 个字，但绝不能因为短就跳过检索。"""
    turn = plan("他打我了", assess("他打我了"))
    assert turn.mode == "kb"
    assert turn.reason == "dv"


@pytest.mark.parametrize("message", ["他只是推了我一下", "他推搡我", "他扇了我一耳光"])
def test_dv_physical_variants(message: str) -> None:
    """「推了我一下」这类轻描淡写的说法也要挂危机资源——轻描淡写本身是常见反应。"""
    assert "crisis_resources" in plan(message, assess(message)).tools


def test_dv_directive_forbids_reconciliation() -> None:
    """挂工具不等于模型会调，所以指令里要写死：不许劝和，必须给号码。"""
    turn = plan("他只是推了我一下", assess("他只是推了我一下"))
    assert "crisis_resources" in turn.directive
    assert "为了孩子忍一忍" in turn.directive
    assert "12338" not in turn.directive  # 号码仍只从 crisis.py 出（R4）
