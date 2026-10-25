"""Agent 装配测试：不需要网络，也不调模型。

2026-10-26 删掉了轮次路由，工具改为**全部常挂、由模型自主决定调不调**。
所以这里测的不再是"这一轮挂了哪个工具"，而是：

1. 三个工具**永远都在**（缺一个就是能力缺失，不是优化）
2. 工具描述里写清了 Use when / Do NOT use when（模型唯一的调度依据）
3. 安全路径没有被这次改动带走（L2 脚本、家暴指令、L1 热线）
"""

from __future__ import annotations

import asyncio
import re

from app.agent import MAX_TURNS, TOOLS, build_agent, build_instructions, stream_reply
from app.safety.input_guard import assess

_TOOL_NAMES = ("kb_search", "web_search", "crisis_resources")


# ── 工具常挂 ────────────────────────────────────────────────
def test_all_tools_always_mounted() -> None:
    """任何消息、任何分级，三个工具都在。

    这是 10-26 那次事故的直接教训：少挂一个工具 = 模型**根本没法**调它。
    用户说「你可以搜索一些相关网页吗」却得到"这轮我没法搜"，就是因为那一轮
    web_search 压根没在工具列表里。
    """
    for message in [
        "嗯",
        "谢谢",
        "我今天特别累",
        "我最近总是睡不着，怎么办",
        "最近有什么心理咨询的补贴政策",
        "你可以搜索一些相关网页吗",
        "他打我了",
        "我觉得活着没什么意思",
    ]:
        agent = build_agent(assess(message))
        assert {t.name for t in agent.tools} == set(_TOOL_NAMES), f"「{message}」工具不全"


def test_tool_order_is_stable() -> None:
    """顺序固定，两端好对齐，也便于断言。"""
    agent = build_agent()
    assert [t.name for t in agent.tools] == list(_TOOL_NAMES)


def test_tools_are_the_registry() -> None:
    assert [t.name for t in TOOLS] == list(_TOOL_NAMES)


def test_max_turns_allows_a_tool_roundtrip() -> None:
    """必须 ≥2 才能跑完"调用工具 → 收尾回答"；也不能太大，否则反复检索把首字拖长。"""
    assert 2 <= MAX_TURNS <= 4


# ── 工具描述：模型唯一的调度依据 ─────────────────────────────
def test_every_tool_has_use_and_do_not_use() -> None:
    """工具描述是模型判断调不调的唯一依据，所以必须写清两面（AGENTS.md §6）。

    旧的提示词里写的是"这一轮你没有 kb_search 就是不需要检索"——那套话术在
    工具常挂之后是错的，模型会等着别人告诉它挂载了什么。
    """
    for t in TOOLS:
        desc = t.description or ""
        assert "Use when" in desc, f"{t.name} 缺 Use when"
        assert "Do NOT use when" in desc, f"{t.name} 缺 Do NOT use when"


def test_kb_tool_forbids_meta_talk() -> None:
    """线上出现过「我先从知识库查一下……」——对方不需要知道检索过程。"""
    kb = next(t for t in TOOLS if t.name == "kb_search")
    desc = kb.description or ""
    assert "知识库" in desc
    assert "千万不要在回复里提" in desc


def test_web_tool_tells_model_not_to_refuse() -> None:
    """用户明确要求搜索时不许答"我没法联网"——这句话本身就是事故。"""
    web = next(t for t in TOOLS if t.name == "web_search")
    desc = web.description or ""
    assert "直接要求你搜索" in desc
    assert "我没法联网" in desc


def test_web_tool_forbids_phone_numbers() -> None:
    """搜索结果里常带机构电话，模型不能转述（R4）。"""
    web = next(t for t in TOOLS if t.name == "web_search")
    assert "不要转述搜索结果里的电话号码" in (web.description or "")


def test_crisis_tool_covers_dv() -> None:
    """家暴也得能拿到 110 / 12338，所以 crisis_resources 的描述里要提到它。"""
    crisis = next(t for t in TOOLS if t.name == "crisis_resources")
    assert "被打" in (crisis.description or "")


def test_system_prompt_says_tools_are_always_available() -> None:
    """prompt 里不能再说"工具是按轮次挂载的"。"""
    text = build_instructions()
    assert "随时都可用" in text
    assert "按轮次挂载" not in text


def test_system_prompt_covers_all_three() -> None:
    text = build_instructions()
    for name in _TOOL_NAMES:
        assert f"`{name}`" in text


# ── 模型与 prompt 的基本约束 ────────────────────────────────
def test_model_is_mercury() -> None:
    agent = build_agent()
    assert getattr(agent.model, "model", None) == "mercury-3"


def test_instructions_have_no_phone_number() -> None:
    """system prompt 里不能写号码（R4）。"""
    assert not re.search(r"\d{5,}", build_instructions()), "instructions 里出现了电话号码（违反 R4）"


# ── 安全指令仍然注入 ────────────────────────────────────────
def test_l1_directive_injected() -> None:
    decision = assess("我不想活了")
    agent = build_agent(decision)
    assert "<this_turn>" in agent.instructions
    assert "12356" in agent.instructions  # 指令里给热线是允许的，号码仍来自常量


def test_dv_directive_injected() -> None:
    """非致命家暴必须写死"调一次 crisis_resources"——挂工具不等于模型会调。"""
    agent = build_agent(assess("他只是推了我一下"))
    assert "<this_turn>" in agent.instructions
    assert "crisis_resources" in agent.instructions
    assert "为了孩子忍一忍" in agent.instructions
    assert "12338" not in agent.instructions  # 号码仍只从 crisis.py 出（R4）


def test_ordinary_message_has_no_this_turn() -> None:
    """普通消息不该被塞 <this_turn>——指令越少，模型越不跑偏。"""
    agent = build_agent(assess("嗯，今天特别累"))
    assert "<this_turn>" not in agent.instructions


# ── 危机路径：根本不进模型 ──────────────────────────────────
def test_l2_never_calls_model() -> None:
    """危机路径必须是写死的，不能依赖模型（Mercury 会拒答）。"""

    async def run() -> list[dict]:
        decision = assess("我真的不想活了，已经想好怎么做了。")
        return [ev async for ev in stream_reply("test-l2", "x", decision)]

    events = asyncio.run(run())
    text = "".join(e["text"] for e in events if e["type"] == "token")
    done = [e for e in events if e["type"] == "done"][0]

    assert done["scripted"] is True
    assert done["tools"] == []
    assert "12356" in text
    assert "120" not in text  # L2 不该直接喊急救，那是 L3 的事


def test_lethal_dv_never_calls_model() -> None:
    """致命家暴同样走脚本：Mercury 的审核会拒掉这类内容，热线会全丢（R9）。"""

    async def run() -> tuple[str, dict]:
        decision = assess("他掐我脖子，还威胁要杀我")
        events = [ev async for ev in stream_reply("test-dv", "x", decision)]
        text = "".join(e["text"] for e in events if e["type"] == "token")
        done = [e for e in events if e["type"] == "done"][0]
        return text, done

    text, done = asyncio.run(run())
    assert done["scripted"] is True
    assert "110" in text and "12338" in text
    assert text.index("110") < text.index("12338")
    assert "**" not in text  # 脚本绕过 output_guard，不能有 Markdown


def test_l3_script_prioritises_emergency() -> None:
    async def run() -> str:
        decision = assess("我刚吃了两瓶安眠药")
        events = [ev async for ev in stream_reply("test-l3", "x", decision)]
        return "".join(e["text"] for e in events if e["type"] == "token")

    text = asyncio.run(run())
    assert "120" in text
    assert text.index("120") < text.index("12356")
