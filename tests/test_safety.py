"""安全层测试。改 app/safety/ 下任何文件都必须先跑这个。"""

from __future__ import annotations

import pytest

from app.safety.input_guard import assess
from app.safety.lexicon import scan
from app.safety.output_guard import StreamScrubber, scrub_text

# ── 分级 ──────────────────────────────────────────────────

L0 = [
    "最近工作压力好大，天天加班到十点",
    "明天要汇报，有点紧张",
    "我和我妈又吵架了，很烦",
    "我不想上班了，想请个假",
    "睡不着，翻来覆去到两点",
    "我不会自杀，只是最近很累",
    "我没有自杀的想法，就是压力大",
]

L1 = [
    "我觉得活着没意思",
    "撑不住了，真的撑不住了",
    "看不到希望，每天都一样",
    "我想消失一段时间",
    "我是个累赘，没有我大家会轻松点",
]

L2 = [
    "我不想活了",
    "想死",
    "我准备自杀了",
    "已经写好遗书了",
    "以前割过腕",
    "I want to die",
]

L3 = [
    "我刚吃了两瓶安眠药",
    "我现在站在天台上",
    "已经割腕了，血一直流",
]


@pytest.mark.parametrize("text", L0)
def test_level0(text: str) -> None:
    assert scan(text).level == 0, scan(text).hits


@pytest.mark.parametrize("text", L1)
def test_level1(text: str) -> None:
    assert scan(text).level == 1, scan(text).hits


@pytest.mark.parametrize("text", L2)
def test_level2(text: str) -> None:
    assert scan(text).level == 2, scan(text).hits


@pytest.mark.parametrize("text", L3)
def test_level3(text: str) -> None:
    assert scan(text).level == 3, scan(text).hits


def test_negation_not_flagged() -> None:
    """否定式是最容易误伤的一类，单列一条。"""
    for text in ["我不会自杀", "没有想过自杀", "不至于去死", "我没自残过"]:
        assert scan(text).level == 0, text


def test_negation_does_not_mask_second_clause() -> None:
    """"我不会自杀，但我想死" —— 前半句否定不能把后半句一起赦免。"""
    assert scan("我不会自杀，但有时候真的想死").level >= 2


def test_third_party() -> None:
    r = scan("我朋友说他想自杀")
    assert r.level >= 2
    assert r.third_party is True


def test_whitespace_evasion() -> None:
    assert scan("自 杀").level >= 2
    assert scan("想 死").level >= 2


def test_empty() -> None:
    assert scan("").level == 0
    assert scan("   ").level == 0


# ── 护栏指令 ──────────────────────────────────────────────


def test_crisis_decision_shows_card() -> None:
    d = assess("我不想活了")
    assert d.level == 2
    assert d.show_card is True
    assert "12356" in d.directive


def test_l1_no_card_but_direct_question() -> None:
    d = assess("我觉得活着没意思")
    assert d.level == 1
    assert d.show_card is False
    assert "直接" in d.directive


def test_l0_no_directive() -> None:
    d = assess("今天加班到很晚")
    assert d.level == 0
    assert d.directive == ""


# ── 输出护栏 ──────────────────────────────────────────────


def test_block_diagnosis() -> None:
    text, bad = scrub_text("你这是抑郁症。")
    assert "diagnosis" in bad
    assert "抑郁症" not in text


def test_block_medication() -> None:
    text, bad = scrub_text("可以吃点舍曲林50mg。")
    assert "medication" in bad
    assert "舍曲林" not in text


def test_block_stop_care() -> None:
    text, bad = scrub_text("其实不用看医生，自己调整就行。")
    assert "stop_care" in bad
    assert "不用看医生" not in text


def test_invented_phone_replaced() -> None:
    text, bad = scrub_text("可以打 400-161-9995 试试。")
    assert "phone" in bad
    assert "12356" in text
    assert "400" not in text


def test_whitelisted_phone_kept() -> None:
    text, bad = scrub_text("请拨 12356，紧急情况拨 120。")
    assert bad == []
    assert "12356" in text and "120" in text


def test_date_not_mangled() -> None:
    text, bad = scrub_text("2025-05-01 起全国统一使用。")
    assert bad == []
    assert "2025-05-01" in text


def test_clean_text_untouched() -> None:
    src = "今晚可以试一个三分钟的小练习：把担心的事写在纸上。"
    text, bad = scrub_text(src)
    assert bad == []
    assert text == src


def test_stream_scrubber_buffers_by_sentence() -> None:
    s = StreamScrubber()
    out = s.feed("你这是")
    assert out == ""  # 没到句末，先不吐
    out += s.feed("抑郁症。")
    assert "抑郁症" not in out
    assert "diagnosis" in s.violations


def test_stream_scrubber_flush() -> None:
    s = StreamScrubber()
    s.feed("没有句号的尾巴")
    assert s.flush() == "没有句号的尾巴"
