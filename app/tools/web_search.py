"""联网搜索（AnySearch）。

只用来补三类信息：最新政策、本地具体机构、正在发生的事件。
心理建议的底线由本地知识库保证，不依赖网络。

⚠️ 2026-10 实测教训：请求里**不要带 tag**。
原先写死 tag="general.web"，而 AnySearch 已把该 tag 改名（现在是 general.general），
服务端直接返回 400 `Invalid tag: general.web.`，联网搜索因此长期静默失效。
不带 tag 时走默认通用搜索，实测 200 / 约 1.2s / 结果质量正常，且不会再被 tag 改名打断。
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import httpx
from agents import function_tool

from app.config import get_settings

logger = logging.getLogger(__name__)

MAX_OUTPUT_CHARS = 1100
TIMEOUT = 6.0  # 压力大的人等不起，宁可降级也不要拖满 8 秒

# 港澳台地区的域名后缀。本产品面向中国大陆用户，政策与机构信息以大陆为准；
# 实测「心理咨询补贴政策」这类泛化查询很容易召回台中市、卫福部的内容，
# 原样转述既不合规也不适用，所以在来源层就挡掉。
_BLOCKED_SUFFIXES = (".tw", ".hk", ".mo")

# 官方来源优先。搜索结果顺序不可控，把 .gov.cn 提到前面能显著降低"引错"的概率。
_PREFERRED = (".gov.cn", ".org.cn")


def _host(item: dict) -> str:
    url = str(item.get("url") or item.get("link") or "")
    return (urlsplit(url).hostname or "").lower()


def _is_blocked(item: dict) -> bool:
    host = _host(item)
    return bool(host) and host.endswith(_BLOCKED_SUFFIXES)


def _rank(item: dict) -> int:
    return 0 if _host(item).endswith(_PREFERRED) else 1


def _format(data: dict) -> str:
    """把接口返回整理成给模型看的文本块。字段缺失时尽量兜住，不要抛异常。"""
    payload = data.get("data") or {}
    results = payload.get("results") or data.get("results") or []
    if not results:
        return "联网没有找到相关结果。请用本地知识库继续回答。"

    usable = [i for i in results if isinstance(i, dict) and not _is_blocked(i)]
    if not usable:
        return "联网没有找到适用于中国大陆的结果。请用本地知识库继续回答。"
    usable.sort(key=_rank)

    blocks: list[str] = []
    total = 0
    for item in usable:
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or item.get("link") or "").strip()
        snippet = str(item.get("snippet") or item.get("content") or "").strip()
        snippet = " ".join(snippet.split())
        if not (title or snippet):
            continue
        block = f"- {title}\n  {snippet[:220]}\n  {url}".rstrip()
        if total + len(block) > MAX_OUTPUT_CHARS:
            break
        blocks.append(block)
        total += len(block)

    if not blocks:
        return "联网没有找到相关结果。请用本地知识库继续回答。"

    return (
        "以下为网络搜索结果，**仅供参考，可能不准确**。"
        "不要直接照搬其中的心理建议，只用于补充最新政策或本地机构信息：\n\n"
        + "\n\n".join(blocks)
    )


async def search(query: str, max_results: int = 4) -> str:
    settings = get_settings()
    if not settings.anysearch_api_key:
        return "联网搜索未配置（缺少 ANYSEARCH_API_KEY），请只使用本地知识库回答。"

    # 注意：不传 tag。见模块开头的说明。
    payload = {"query": query, "max_results": max_results, "language": "zh"}
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
        logger.warning("web_search 失败：%s: %s", type(exc).__name__, exc)
        return (
            f"联网搜索暂时不可用（{type(exc).__name__}）。"
            "请用本地知识库继续回答，并说明无法核实最新信息。"
        )

    if data.get("code") != 0:
        msg = data.get("message", "未知错误")
        logger.warning("web_search 返回错误：%s", msg)
        return f"联网搜索返回错误：{msg}。请用本地知识库继续回答。"

    return _format(data)


WEB_SEARCH_DESCRIPTION = (
    "联网搜索最新信息（政策、机构、新闻、本地资源）。\n"
    "Use when: 用户问「最近有什么政策」「哪里有免费的」「这个机构靠谱吗」「怎么挂号」，\n"
    "或需要核实 2026 年之后才有的信息、具体地址与收费；\n"
    "或用户**直接要求你搜索/上网查/看看网页**（「你可以搜一下吗」「帮我查一下当地的资源」）"
    "——这种明确请求一定要调，不要回答「我没法联网」。\n"
    "Do NOT use when: 用户在描述情绪、需要陪伴或方法（那属于 kb_search）；\n"
    "用户在危机中（先给热线，不要先搜）。\n"
    "只搜一次。要说明这是网络信息、可能不准确。不要转述搜索结果里的电话号码。\n"
    "只采用中国大陆官方来源（.gov.cn、卫健委、医保局）；港澳台地区信息不要采用，"
    "提到时一律写「中国台湾」「中国香港」「中国澳门」。\n"
    "返回: 最多 4 条搜索结果，含标题、摘要、链接。结果可能不准确，需向用户说明。"
)


@function_tool(description_override=WEB_SEARCH_DESCRIPTION)
async def web_search(query: str) -> str:
    """联网搜索最新信息。

    描述走 `description_override`：docstring 只有第一段会被当成工具描述
    （详见 `kb_search` 的注释）。
    """
    return await search(query)
