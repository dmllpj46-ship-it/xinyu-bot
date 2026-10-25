"""FastAPI 入口：静态页 + POST /api/chat（SSE）。

SSE 帧格式（前端 web/app.js 按这个解析，改这里要同步改那边）：
    event: meta   data: {"level":0,"crisis":false,"mode":"kb"}
    event: crisis data: {"hotlines":[...],"plan":[...]}
    event: tool   data: {"name":"kb_search"}
    event: token  data: {"text":"..."}
    event: done   data: {"tools":[...],"guard_hits":[...],"mode":"kb"}
    event: error  data: {"message":"..."}
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.agent import reset_session, stream_reply
from app.config import get_settings
from app.routing import plan as plan_turn
from app.safety.input_guard import assess
from app.tools.crisis import HOTLINES, SAFETY_PLAN_STEPS

logging.basicConfig(
    level=getattr(logging, get_settings().log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("psybot")

app = FastAPI(title="心屿 · 心理陪练", docs_url=None, redoc_url=None)


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    message: str = Field(min_length=1, max_length=2000)


class ResetRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/health")
async def health() -> dict:
    s = get_settings()
    return {"ok": True, "model": s.mercury_model, "kb_index": s.kb_index_abs.exists()}


@app.post("/api/reset")
async def reset(req: ResetRequest) -> dict:
    reset_session(req.session_id)
    return {"ok": True}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    decision = assess(req.message)
    turn = plan_turn(req.message, decision)
    # 只记长度、分级与路由，不记原文
    logger.info(
        "chat session=%s len=%d level=%d mode=%s reason=%s",
        req.session_id[:8],
        len(req.message),
        decision.level,
        turn.mode,
        turn.reason,
    )

    async def gen() -> AsyncIterator[str]:
        yield _sse("meta", {"level": decision.level, "crisis": decision.is_crisis, "mode": turn.mode})

        if decision.show_card:
            yield _sse(
                "crisis",
                {
                    "hotlines": HOTLINES,
                    "plan": SAFETY_PLAN_STEPS,
                },
            )

        async for ev in stream_reply(req.session_id, req.message, decision):
            kind = ev.pop("type")
            yield _sse(kind, ev)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# 静态资源放最后挂，/api/* 优先匹配
app.mount("/", StaticFiles(directory=get_settings().web_dir, html=True), name="web")
