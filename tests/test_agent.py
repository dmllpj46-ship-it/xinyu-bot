"""Agent 装配测试：不需要网络，也不调模型。"""

from __future__ import annotations

import asyncio

from app.agent import build_agent, stream_reply
from app.routing import plan as plan_turn
from app.safety.input_guard import assess


def _agent_for(message: str):
    decision = assess(message)
    return build_agent(decision, plan_turn(message, decision))


def test_tools_registered() -> None:
    """工具是按轮次挂的：常识问题不挂任何检索工具，求方法只挂 kb_search。"""
    assert {t.name for t in _agent_for("嗯，今天特别累").tools} == set()
    assert {t.name for t in _agent_for("我最近总是睡不着，怎么办").tools} == {"kb_search"}
    assert {t.name for t in _agent_for("最近有什么心理咨询补贴政策").tools} == {"web_search"}


def test_l1_gets_crisis_tool() -> None:
    """L1 必须能拿到热线，所以额外挂 crisis_resources。"""
    agent = _agent_for("我觉得活着没什么意思，特别累")
    assert "crisis_resources" in {t.name for t in agent.tools}


def test_model_is_mercury() -> None:
    agent = build_agent()
    assert getattr(agent.model, "model", None) == "mercury-3"


def test_instructions_have_no_phone_number() -> None:
    agent = build_agent()
    import re

    assert not re.search(r"\d{5,}", agent.instructions), "instructions 里出现了电话号码（违反 R4）"


def test_crisis_directive_injected() -> None:
    decision = assess("我不想活了")
    agent = build_agent(decision)
    assert "<this_turn>" in agent.instructions
    assert "12356" in agent.instructions  # 指令里给热线是允许的，号码仍来自常量


def test_routing_directive_injected() -> None:
    """路由指令要进 <this_turn>，否则模型不知道自己这一轮没有检索工具。"""
    message = "我最近总是睡不着，怎么办"
    decision = assess(message)
    agent = build_agent(decision, plan_turn(message, decision))
    assert "【本轮路由 · 本地知识库】" in agent.instructions
    assert "不要换关键词反复查" in agent.instructions


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


def test_l3_script_prioritises_emergency() -> None:
    async def run() -> str:
        decision = assess("我刚吃了两瓶安眠药")
        events = [ev async for ev in stream_reply("test-l3", "x", decision)]
        return "".join(e["text"] for e in events if e["type"] == "token")

    text = asyncio.run(run())
    assert "120" in text
    assert text.index("120") < text.index("12356")
