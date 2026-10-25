"""联网搜索（AnySearch）。

只用来补三类信息：最新政策、本地具体机构、正在发生的事件。
心理建议的底线由本地知识库保证，不依赖网络。
"""

from __future__ import annotations

import httpx
from agents import function_tool

from app.config import get_settings

MAX_OUTPUT_CHARS = 1100
TIMEOUT = 8.0


async def search(query: str, max_results: int = 4) -> str:
    settings = get_settings()
    if not settings.anysearch_api_key:
        return "联网搜索未配置（缺少 ANYSEARCH_API_KEY），请只使用本地知识库回答。"

    payload = {"query": query, "max_results": max_results, "tag": "general.web"}
    headers = {
        "Authorization": f"Bearer {settings.anysearch_api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{settings.anysearch_base_url}/v1/search", json=payload, headers=headers
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # 网络类错误一律降级，不能让对话中断
        return f"联网搜索暂时不可用（{type(exc).__name__}）。请用本地知识库继续回答，并说明无法核实最新信息。"

    if data.get("code") != 0:
        return f"联网搜索返回错误：{data.get('message', '未知错误')}。请用本地知识库继续回答。"

    results = (data.get("data") or {}).get("results") or []
    if not results:
        return "联网没有找到相关结果。请用本地知识库继续回答。"

    blocks: list[str] = []
    total = 0
    for item in results:
        title = (item.get("title") or "").strip()
        url = (item.get("url") or item.get("link") or "").strip()
        snippet = (item.get("snippet") or item.get("content") or "").strip().replace("\n", " ")
        block = f"- {title}\n  {snippet[:220]}\n  {url}"
        if total + len(block) > MAX_OUTPUT_CHARS:
            break
        blocks.append(block)
        total += len(block)

    return (
        "以下为网络搜索结果，**仅供参考，可能不准确**。"
        "不要直接照搬其中的心理建议，只用于补充最新政策或本地机构信息：\n\n"
        + "\n\n".join(blocks)
    )


@function_tool
async def web_search(query: str) -> str:
    """联网搜索最新信息（政策、机构、新闻、本地资源）。

    Use when: 用户问"最近有什么政策""哪里有免费的""这个机构靠谱吗"，
              或需要核实 2026 年之后才有的信息。
    Do NOT use when: 用户在描述情绪、需要陪伴或方法（那属于 kb_search）；
                      用户在危机中（先给热线，不要先搜）。
    返回: 最多 4 条搜索结果，含标题、摘要、链接。结果可能不准确，需向用户说明。
    """
    return await search(query)
