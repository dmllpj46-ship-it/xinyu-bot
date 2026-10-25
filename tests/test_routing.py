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


def test_kb_directive_forbids_meta_talk() -> None:
    """线上出现过「我先从知识库查一下……」——对方不需要知道检索过程。"""
    turn = plan("我睡不着怎么办", assess("我睡不着怎么办"))
    assert "不要提「知识库」" in turn.directive


def test_web_directive_forbids_phone_numbers() -> None:
    """搜索结果里常带机构电话，模型不能转述（R4）。"""
    turn = plan("上海哪里有免费的心理咨询", assess("上海哪里有免费的心理咨询"))
    assert "不要转述搜索结果里的电话号码" in turn.directive


# ── 家暴 ────────────────────────────────────────────────────
# 分两层：没到致命的走 kb + crisis_resources（模型还能说话），
# 致命的直接走脚本（模型会拒答，见 test_lethal_dv_skips_model）。
@pytest.mark.parametrize(
    "message",
    [
        "我老公昨天打我了，我该怎么办",
        "他跟踪我，还说不许我出门",
        "我想申请人身安全保护令",
        "他揍了我，但是没伤到",
        "家暴三年了，我很痛苦",
    ],
)
def test_dv_goes_to_kb_with_crisis_resources(message: str) -> None:
    """家暴必须查知识库（安全计划、证据、保护令都在那篇里），同时要能给出热线。"""
    turn = plan(message, assess(message))
    assert turn.mode == "kb"
    assert "kb_search" in turn.tools
    assert "crisis_resources" in turn.tools


@pytest.mark.parametrize(
    "message",
    [
        "他掐我脖子，是不是很危险",
        "他掐我脖子，还威胁要杀我",
        "他说要杀了我",
        "他拿刀对着我",
        "他把我打得住院了",
        "他刚才在家动手打我",
    ],
)
def test_lethal_dv_skips_model(message: str) -> None:
    """致命家暴必须走脚本，不调模型。

    为什么：Mercury 3 的 API 审核会拒掉显式暴力内容。实测
    「他掐我脖子，还威胁要杀我」被直接拒掉，`crisis_resources` 一次都没调到，
    110 和 12338 一个都到不了用户眼前。和自杀内容被拒是同一回事，
    所以同样不能过模型。
    """
    turn = plan(message, assess(message))
    assert turn.mode == "crisis"
    assert turn.tools == ()


def test_lethal_dv_script_has_police_and_federation() -> None:
    """脚本里必须先给 110（保命），再给 12338（后续维权），且顺序不能反。"""
    from app.safety.crisis_script import script_for

    text = script_for(assess("他掐我脖子，还威胁要杀我"))
    assert "110" in text and "12338" in text
    assert text.index("110") < text.index("12338")
    assert "你现在安全吗" in text


def test_lethal_dv_gets_no_self_harm_plan_card() -> None:
    """自伤安全计划那套步骤（"把可能伤害自己的东西交给别人保管"）用在家暴场景文不对题。"""
    decision = assess("他掐我脖子，还威胁要杀我")
    assert decision.dv is True
    assert decision.show_card is False


def test_dv_short_message_still_searches() -> None:
    """「他打我了」只有 4 个字，但绝不能因为短就跳过检索。"""
    turn = plan("他打我了", assess("他打我了"))
    assert turn.mode == "kb"
    assert turn.reason == "dv"


@pytest.mark.parametrize("message", ["他只是推了我一下", "他推搡我", "他扇了我一耳光"])
def test_dv_physical_variants(message: str) -> None:
    """「推了我一下」这类轻描淡写的说法也要挂危机资源——轻描淡写本身是常见反应。"""
    assert "crisis_resources" in plan(message, assess(message)).tools


@pytest.mark.parametrize(
    "message",
    [
        "他揍了我一顿，我出血了",
        "他把我打得住院了",
        "他拿刀对着我",
        "他打得我手臂都紫了",
    ],
)
def test_dv_serious_phrasings_are_covered(message: str) -> None:
    """旧版 _DV 只认「打我」，这些真实说法全漏成了 chat，一个热线都没给。

    用户不会用文档里的词。"揍了一顿出血""打得住院""拿刀""手臂都紫了"
    都比"打我"更该拿到号码。
    """
    turn = plan(message, assess(message))
    if turn.mode == "crisis":
        # 致命的那几种已经走脚本，号码在脚本文本里
        from app.safety.crisis_script import script_for

        assert "110" in script_for(assess(message))
        return
    assert turn.mode == "kb"
    assert "crisis_resources" in turn.tools


@pytest.mark.parametrize("message", ["他打得很好", "我刚才打游戏", "别在背后打小报告"])
def test_dv_does_not_fire_on_ordinary_hit(message: str) -> None:
    """「打」字太常见。暴力动词必须配伤情词，否则「他打得很好」也会被判成家暴。"""
    turn = plan(message, assess(message))
    assert "crisis_resources" not in turn.tools


def test_dv_directive_forbids_reconciliation() -> None:
    """挂工具不等于模型会调，所以指令里要写死：不许劝和，必须给号码。"""
    turn = plan("他只是推了我一下", assess("他只是推了我一下"))
    assert "crisis_resources" in turn.directive
    assert "为了孩子忍一忍" in turn.directive
    assert "12338" not in turn.directive  # 号码仍只从 crisis.py 出（R4）


# ── 四个新增领域的路由 ────────────────────────────────────
@pytest.mark.parametrize(
    "message",
    [
        "我们天天吵架，他回家就玩手机不说话",
        "我妈什么都管，我快三十了她还催我结婚",
        "我一辅导作业就发火，孩子根本不听我的",
        "领导永远不满意，天天加班到十一二点",
        "被裁了，不敢告诉家里",
    ],
)
def test_new_domains_route_to_kb(message: str) -> None:
    """新四篇都是"用户带着具体问题来"，应走知识库而不是直答。"""
    turn = plan(message, assess(message))
    assert turn.mode == "kb"
    assert turn.tools == ("kb_search",)


# ── 具体生活事件：短也要查 ──────────────────────────────────
@pytest.mark.parametrize(
    "message",
    [
        "被裁了，不敢告诉家里",
        "我离婚了",
        "他出轨了",
        "孩子厌学，不肯去学校了",
        "婆媳矛盾越来越严重了",
        "我爸生病住院了，赡养的事没人管",
        "我爷爷上周去世了",
        "我想辞职，但不敢",
    ],
)
def test_life_events_route_to_kb_without_length_gate(message: str) -> None:
    """事件词出现即成立——「被裁了」只有三个字，但已经是明确的求助。

    这里测的是 _KB_EVENT 不设长度门槛：少了这条，"被裁了，不敢告诉家里"
    （8 字）会被当成纯情绪表达直接答，职场那篇根本检索不到。
    """
    turn = plan(message, assess(message))
    assert turn.mode == "kb"
    assert turn.reason == "kb:event"


@pytest.mark.parametrize(
    "message",
    [
        "我好累",
        "压力好大",
        "最近很焦虑",
        "烦死了",
        "睡不着",
        "心里堵得慌",
    ],
)
def test_feeling_words_alone_stay_in_chat(message: str) -> None:
    """反面对照：感受词仍然要长度门槛，否则每条情绪消息都要多等一秒。"""
    turn = plan(message, assess(message))
    assert turn.mode == "chat"
    assert turn.tools == ()
