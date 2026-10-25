"""Agent 装配与流式运行。

Mercury 3 的三个适配点（改之前先看 AGENTS.md §3）：
1. 必须走 ChatCompletions，不能用默认的 Responses API
2. 必须关掉 tracing，否则会拿没有的 OpenAI key 去上传
3. reasoning_effort 不在 OpenAI 标准字段里，走 extra_body
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from pathlib import Path
from typing import Any, AsyncIterator

from agents import (
    Agent,
    AsyncOpenAI,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RawResponsesStreamEvent,
    RunItemStreamEvent,
    Runner,
    set_tracing_disabled,
)
from agents.memory import SQLiteSession

from app.config import get_settings
from app.safety.crisis_script import script_chunks
from app.safety.input_guard import GuardDecision
from app.safety.output_guard import StreamScrubber
from app.tools.crisis import crisis_resources
from app.tools.kb_search import kb_search
from app.tools.web_search import web_search

logger = logging.getLogger(__name__)

set_tracing_disabled(True)  # 没有 OpenAI key，trace 上传只会 401

_PROMPT = Path(__file__).resolve().parent / "prompts" / "system.md"
_MAX_SESSIONS = 64

# 模型拒答时的兜底。不给热线会让人卡在"说了一半没人接"的位置。
_REFUSAL_FALLBACK = (
    "这句话我想认真接住，但这一轮我没能生成回复。\n\n"
    "如果它对你来说很重，可以直接打 12356（24 小时，免费），"
    "不用等到撑不住才打。\n\n我们也可以换个说法继续——你想从哪一句开始？"
)

_client: AsyncOpenAI | None = None
_sessions: OrderedDict[str, SQLiteSession] = OrderedDict()


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        s = get_settings()
        _client = AsyncOpenAI(api_key=s.inception_api_key, base_url=s.inception_base_url)
    return _client


def _build_model() -> OpenAIChatCompletionsModel:
    return OpenAIChatCompletionsModel(model=get_settings().mercury_model, openai_client=_get_client())


def system_prompt(directive: str = "") -> str:
    base = _PROMPT.read_text(encoding="utf-8")
    if directive:
        return f"{base}\n\n<this_turn>\n{directive}\n</this_turn>"
    return base


def build_agent(decision: GuardDecision | None = None) -> Agent:
    s = get_settings()
    directive = decision.directive if decision else ""
    # 危机轮次给多一点思考预算；日常对话用 low，换来更快的第一句
    effort = "medium" if (decision and decision.level >= 2) else s.mercury_reasoning_effort

    return Agent(
        name="心屿",
        instructions=system_prompt(directive),
        model=_build_model(),
        tools=[kb_search, web_search, crisis_resources],
        model_settings=ModelSettings(
            temperature=s.mercury_temperature,
            max_tokens=800,
            extra_body={"reasoning_effort": effort},
        ),
    )


def get_session(session_id: str) -> SQLiteSession:
    """会话存在内存里（db_path=":memory:"），进程退出即清空——v1 刻意不落盘。"""
    session = _sessions.get(session_id)
    if session is not None:
        _sessions.move_to_end(session_id)
        return session

    session = SQLiteSession(session_id, db_path=":memory:")
    _sessions[session_id] = session
    while len(_sessions) > _MAX_SESSIONS:
        _sessions.popitem(last=False)
    return session


def reset_session(session_id: str) -> None:
    _sessions.pop(session_id, None)


async def stream_reply(
    session_id: str, message: str, decision: GuardDecision
) -> AsyncIterator[dict[str, Any]]:
    """产出 SSE 事件：token / tool / done / error。"""
    # L2/L3 不调模型：Mercury 3 的 API 审核会拒掉这类内容，且危机回复本就不该被生成
    if decision.level >= 2:
        for chunk in script_chunks(decision):
            yield {"type": "token", "text": chunk}
        yield {"type": "done", "tools": [], "guard_hits": [], "crisis": True, "scripted": True}
        return

    agent = build_agent(decision)
    session = get_session(session_id)
    scrubber = StreamScrubber()
    tools_used: list[str] = []

    try:
        result = Runner.run_streamed(agent, input=message, session=session, max_turns=6)

        async for event in result.stream_events():
            if isinstance(event, RawResponsesStreamEvent):
                data = event.data
                if getattr(data, "type", "") == "response.output_text.delta":
                    safe = scrubber.feed(getattr(data, "delta", "") or "")
                    if safe:
                        yield {"type": "token", "text": safe}

            elif isinstance(event, RunItemStreamEvent):
                item = event.item
                if getattr(item, "type", "") == "tool_call_item":
                    name = getattr(getattr(item, "raw_item", None), "name", "") or ""
                    if name:
                        tools_used.append(name)
                        yield {"type": "tool", "name": name}

        tail = scrubber.flush()
        if tail:
            yield {"type": "token", "text": tail}

        if scrubber.violations:
            logger.warning("output_guard 拦截：%s", sorted(set(scrubber.violations)))

        yield {
            "type": "done",
            "tools": tools_used,
            "guard_hits": sorted(set(scrubber.violations)),
            "crisis": decision.level >= 2,
        }

    except Exception as exc:
        raw = str(exc)
        if "potentially dangerous or harmful" in raw or "can't help with this" in raw:
            # 模型侧审核拒答。不能把这句话原样丢给用户。
            logger.warning("model refused: %s", raw[:120])
            yield {"type": "token", "text": _REFUSAL_FALLBACK}
            yield {"type": "done", "tools": tools_used, "guard_hits": ["model_refusal"], "crisis": False}
            return
        logger.exception("agent run failed")
        yield {"type": "error", "message": f"模型暂时没响应（{type(exc).__name__}）。稍等一下再发一次。"}


async def run_once(session_id: str, message: str, decision: GuardDecision) -> str:
    """非流式，给 smoke_test 用。"""
    agent = build_agent(decision)
    result = await Runner.run(agent, input=message, session=get_session(session_id), max_turns=6)
    return str(result.final_output or "")
