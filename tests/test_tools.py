"""工具与不变量测试。不需要网络、不需要模型。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.safety.output_guard import ALLOWED_NUMBERS
from app.tools.crisis import HOTLINES, SAFETY_PLAN_STEPS, resources_text, safety_plan_text
from app.tools.kb_search import _get_index, search

ROOT = Path(__file__).resolve().parent.parent
HAS_INDEX = _get_index() is not None


def test_index_built() -> None:
    if not HAS_INDEX:
        pytest.skip("先运行 python scripts/ingest_kb.py")
    assert len(_get_index().chunks) >= 40  # type: ignore[union-attr]


@pytest.mark.skipif(not HAS_INDEX, reason="需要先建索引")
@pytest.mark.parametrize(
    "query,expect",
    [
        ("我睡不着，躺下就开始想工作的事", "睡眠"),
        ("一想到上班就胸闷心慌", "焦虑"),
        ("什么都不想做，提不起劲", "抑郁"),
        ("我是不是抑郁症", "常见提问"),
        ("我朋友说他不想活了怎么办", "常见提问"),
        ("怎么跟家里人说我的情况", "常见提问"),
        ("想死", "危机"),
    ],
)
def test_kb_hits_expected_doc(query: str, expect: str) -> None:
    out = search(query, 3)
    heads = [line for line in out.split("\n") if line.startswith("【")]
    assert heads, f"{query} 没有任何命中"
    assert any(expect in h for h in heads), f"{query} 未命中 {expect}：{heads}"


@pytest.mark.skipif(not HAS_INDEX, reason="需要先建索引")
def test_kb_no_hit_is_honest() -> None:
    out = search("量子色动力学的渐近自由")
    assert "没有直接相关" in out


@pytest.mark.skipif(not HAS_INDEX, reason="需要先建索引")
def test_kb_output_length() -> None:
    out = search("压力很大 睡不着 心慌 什么都不想做")
    assert len(out) <= 1400


# ── 危机资源 ──────────────────────────────────────────────


def test_hotline_table_has_12356() -> None:
    numbers = {h["number"] for h in HOTLINES}
    assert "12356" in numbers
    assert "120" in numbers
    assert "110" in numbers


def test_hotlines_are_whitelisted_in_output_guard() -> None:
    """常量表里的号码必须同时出现在输出护栏白名单里，否则会被自己替换掉。"""
    for h in HOTLINES:
        digits = re.sub(r"\D", "", h["number"])
        assert digits in ALLOWED_NUMBERS, f"{h['number']} 不在白名单，会被护栏改掉"


def test_resources_text_contains_numbers() -> None:
    text = resources_text()
    assert "12356" in text
    assert "120" in text


def test_safety_plan_six_steps() -> None:
    assert len(SAFETY_PLAN_STEPS) == 6
    assert "警示信号" in safety_plan_text()


# ── R4：prompt 里不许出现电话号码 ─────────────────────────


def test_system_prompt_has_no_phone_numbers() -> None:
    prompt = (ROOT / "app" / "prompts" / "system.md").read_text(encoding="utf-8")
    assert not re.search(r"\d{5,}", prompt), "system.md 里出现了 5 位以上数字，违反 R4"


def test_knowledge_base_has_no_phone_numbers() -> None:
    for path in (ROOT / "knowledge").glob("*.md"):
        text = path.read_text(encoding="utf-8")
        hits = re.findall(r"1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}|\d{3,4}[- ]\d{3,4}[- ]\d{4}", text)
        assert not hits, f"{path.name} 里出现了号码 {hits}，应只从 crisis.py 取"
