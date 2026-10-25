"""Agent 装配与流式运行。

Mercury 3 的三个适配点（改之前先看 AGENTS.md §3）：
1. 必须走 ChatCompletions，不能用默认的 Responses API
2. 必须关掉 tracing，否则会拿没有的 OpenAI key 去上传
3. reasoning_effort 不在 OpenAI 标准字段里，走 extra_body

## 工具全部常挂，由模型自己决定调不调

2026-10-26 删掉了轮次路由。曾经的做法是每轮先用正则判一次"要不要检索、检索哪一边"，
只挂命中那一个工具。这样省延迟，但代价是**判错就当面拒答**：用户写「你可以搜索一些
相关网页吗」，四个联网信号一个都没中，被判成纯聊天，一个工具都没挂，bot 回一句
"这轮我没法搜，工具没挂载"——一个明确的请求被自己的门卫拦在门外。

现在三个工具一次全挂，模型看到工具描述自己判断。省下的那点延迟不值得拿"该查的没查、
该搜的没搜"去换。实测多挂工具不影响首字延迟（模型的第一句是边想边出的），
多出来的时间只在**真的调了工具**时才付。

工具描述（`app/tools/*.py` 的 docstring）因此成了唯一的调度依据，写法有硬要求：
必须写清 Use when / Do NOT use when，见 AGENTS.md §6。

安全不在这里管：L2/L3 在调用模型之前就被 `input_guard` 拦下走写死话术；
非致命家暴的"必须调 crisis_resources"写在 `decision.directive` 里。
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

# 三个工具常挂。顺序固定，便于测试断言与两端对齐。
TOOLS = (kb_search, web_search, crisis_resources)

# 1 次工具调用 + 1 次收尾 + 1 次余量（模型偶尔会连调两个工具）
# 不再按模式封顶：模型自己决定调几个，但最多 3 轮往返，防止反复检索把首字拖成十几秒。
MAX_TURNS = 3

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


def build_instructions(decision: GuardDecision | None = None) -> str:
    """基础 prompt + 本轮安全指令。指令为空时不加 `<this_turn>` 包裹。"""
    return system_prompt(decision.directive if decision else "")


def build_agent(decision: GuardDecision | None = None) -> Agent:
    s = get_settings()
    # 危机轮次给多一点思考预算；日常对话用 low，换来更快的第一句
    effort = "medium" if (decision and decision.level >= 2) else s.mercury_reasoning_effort

    return Agent(
        name="心屿",
        instructions=build_instructions(decision),
        model=_build_model(),
        tools=list(TOOLS),
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


async def _last_assistant_text(session: SQLiteSession) -> str:
    """取上一轮助手说的话，用于跨轮去重。取不到就返回空串，不影响主流程。"""
    try:
        items = await session.get_items(limit=6)
    except Exception:  # 会话层出问题不该拖垮回复
        return ""
    for item in reversed(items):
        role = item.get("role") if isinstance(item, dict) else getattr(item, "role", None)
        if role != "assistant":
            continue
        content = item.get("content") if isinstance(item, dict) else getattr(item, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [
                str(c.get("text", ""))
                for c in content
                if isinstance(c, dict) and c.get("type") in {"output_text", "text"}
            ]
            if parts:
                return "".join(parts)
    return ""


async def stream_reply(
    session_id: str, message: str, decision: GuardDecision
) -> AsyncIterator[dict[str, Any]]:
    """产出 SSE 事件：token / tool / done / error。"""
    # L2/L3 不调模型：Mercury 3 的 API 审核会拒掉这类内容，且危机回复本就不该被生成
    if decision.level >= 2:
        for chunk in script_chunks(decision):
            yield {"type": "token", "text": chunk}
        yield {
            "type": "done",
            "tools": [],
            "guard_hits": [],
            "crisis": True,
            "scripted": True,
        }
        return

    agent = build_agent(decision)
    session = get_session(session_id)
    scrubber = StreamScrubber(seed=await _last_assistant_text(session))
    tools_used: list[str] = []

    try:
        result = Runner.run_streamed(
            agent,
            input=message,
            session=session,
            max_turns=MAX_TURNS,
        )

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
            yield {
                "type": "done",
                "tools": tools_used,
                "guard_hits": ["model_refusal"],
                "crisis": False,
            }
            return
        logger.exception("agent run failed")
        yield {"type": "error", "message": f"模型暂时没响应（{type(exc).__name__}）。稍等一下再发一次。"}


async def run_once(session_id: str, message: str, decision: GuardDecision) -> str:
    """非流式，给 smoke_test 用。"""
    agent = build_agent(decision)
    result = await Runner.run(
        agent,
        input=message,
        session=get_session(session_id),
        max_turns=MAX_TURNS,
    )
    return str(result.final_output or "")
