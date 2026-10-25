"""危机词表与分级扫描。

设计原则：
1. **先排除否定**（"我不会自杀"不该被判成高风险），再匹配风险。
2. 分级只看**最高命中**，不累加——累加会把"最近有点累"误伤成高危。
3. 词表只做**粗筛**。它宁可多报（L1 的代价只是多问一句），也不能漏报。
4. 电话号码不在这里，只在 app/tools/crisis.py。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# ── 归一化 ────────────────────────────────────────────────


def normalize(text: str) -> str:
    """全角转半角、去空白、英文小写。

    去空白是为了对付"自 杀""想 死"这类规避写法。
    """
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", "", text)
    return text.lower()


# ── 否定式（命中则把对应片段排除在风险判定之外）────────────
# 每条都是"否认有风险"的句式，不是"提到风险"的句式。
SAFE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p)
    for p in [
        r"(不会|不|没有|没|从没|从未|未曾|不至于|不打算|不想要|不准备).{0,6}"
        r"(自杀|自尽|轻生|自残|自伤|伤害自己|伤害我自己)",
        r"(不|没有|没|不想|不会).{0,4}想(死|要死)",
        r"(不想|不会|不可能|不至于).{0,3}(死|自杀|轻生)",
        r"(don't|donot|won't|never|not|no)\s*(wantto|want)?\s*"
        r"(killmyself|die|commitsuicide|hurtmyself|endmylife)",
        r"(没有|没|无).{0,3}(自杀|自残|自伤)(想法|念头|计划|倾向)",
    ]
]

# ── 分级词表 ──────────────────────────────────────────────
# L3：正在进行 / 刚刚发生 —— 立刻按紧急处理，不问细节
L3_PATTERNS: list[tuple[str, str]] = [
    ("已实施", r"(已经|刚刚|刚才|正在|现在|刚).{0,8}(吃了|吞了|割了|划了|跳了|喝了|上吊|割腕|吞药|吃了一把)"),
    ("现场", r"(在|站在|坐在|爬到).{0,6}(楼顶|天台|桥上|窗台|阳台边|栏杆外)"),
    ("手段", r"(割腕|割了手腕|上吊|跳楼|跳桥|卧轨|烧炭|喝了农药|吞了安眠药|吞了一整瓶)"),
    ("已出血", r"(血流不止|血一直流|药已经吃下去|已经吞下去)"),
]

# L2：明确意念 / 计划 / 既往尝试 —— 走危机协议
L2_PATTERNS: list[tuple[str, str]] = [
    ("意念", r"(想|要|打算|准备|计划|考虑).{0,4}(自杀|自尽|轻生|结束生命|了结自己|死了算了)"),
    ("意念", r"(想死|去死|求死|不想活|活不下去|不如死了|一死了之)"),
    ("意念", r"(自杀|自尽|轻生)"),
    ("计划", r"(遗书|遗言|告别信|最后一次见|交代后事)"),
    ("自伤", r"(自残|自伤|伤害自己|划手|割手臂|用刀划|割.{0,2}腕)"),
    ("既往", r"(试过|曾经|以前|上次|有过).{0,6}(自杀|自残|割腕|吞药|伤害自己)"),
    ("英文", r"(killmyself|suicide|endmylife|wanttodie|self-?harm|cutmyself)"),
]

# L1：被动意念 / 无望感 —— 必须直问一次，但不打断对话
L1_PATTERNS: list[tuple[str, str]] = [
    ("无意义", r"(活着|生活|一切|人生).{0,4}(没.{0,2}(意思|意义)|没盼头|没有意义)"),
    ("耗竭", r"(撑不住|扛不住|受不了了|顶不住了|快崩溃|要崩溃)"),
    ("消失", r"(想消失|消失掉|不想醒来|睡过去不醒|不想醒过来|不想再醒)"),
    ("无望", r"(绝望|看不到希望|没有希望|没有出路|没什么可留恋)"),
    ("累赘", r"(累赘|拖累别人|没有我更好|没有我会更好)"),
    ("疲惫", r"(活着好累|活得好累|太累了好想停)"),
]

# 第三人称：说的是别人，不是自己。协议不同（教怎么帮，而不是评估本人）
THIRD_PARTY_MARKERS = re.compile(
    r"(朋友|同学|同事|室友|舍友|家人|我妈|我爸|我妈|男朋友|女朋友|对象|孩子|弟弟|妹妹|哥哥|姐姐|他|她|别人|有人)"
)


@dataclass
class ScanResult:
    level: int = 0
    hits: list[str] = field(default_factory=list)
    third_party: bool = False

    @property
    def is_crisis(self) -> bool:
        return self.level >= 2

    def label(self) -> str:
        return {0: "L0 无", 1: "L1 关注", 2: "L2 风险", 3: "L3 紧急"}[self.level]


def _safe_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for rx in SAFE_PATTERNS:
        for m in rx.finditer(text):
            spans.append((m.start(), m.end()))
    return spans


def _inside(span: tuple[int, int], spans: list[tuple[int, int]]) -> bool:
    s, e = span
    return any(ss <= s and e <= se for ss, se in spans)


def _third_party(text: str, start: int) -> bool:
    window = text[max(0, start - 6) : start]
    return bool(THIRD_PARTY_MARKERS.search(window))


def scan(text: str) -> ScanResult:
    """扫描一条用户输入，返回最高风险等级。"""
    if not text or not text.strip():
        return ScanResult()

    norm = normalize(text)
    safe = _safe_spans(norm)
    result = ScanResult()

    for level, patterns in ((3, L3_PATTERNS), (2, L2_PATTERNS), (1, L1_PATTERNS)):
        for label, pattern in patterns:
            for m in re.finditer(pattern, norm):
                if _inside(m.span(), safe):
                    continue
                result.hits.append(f"L{level}:{label}:{m.group(0)[:12]}")
                result.level = max(result.level, level)
                if _third_party(norm, m.start()):
                    result.third_party = True

    # 高危词已经命中时，第三人称标记只作参考，不降级
    if result.level >= 2 and result.third_party and len(result.hits) == 1:
        # 只命中一次且是第三人称 → 按"帮朋友"处理，仍是 L2，但走另一套话术
        result.hits.append("third_party_only")

    return result
