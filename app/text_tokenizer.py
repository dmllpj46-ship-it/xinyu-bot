"""中文检索分词（零依赖）。

索引和查询必须用同一套规则，所以抽出来放这里，两边都 import 它。

规则：
- 英文/数字按词切
- 中文取「相邻双字（bigram）」为主，单字只在不属于停用字时保留，且权重更低
- 不引 jieba：知识库只有几十块，bigram 的召回足够，而且行为可预测
"""

from __future__ import annotations

import re
import unicodedata

_CJK = re.compile(r"[\u4e00-\u9fff]")
_WORD = re.compile(r"[a-z0-9]+")

# 单字停用：这些字几乎出现在每一段里，留着只会让"量子色动力学"命中"行为动力"
STOP_CHARS = set(
    "的了是在我你他她它们有和与就都也很不要会能可这那个上下中对从到说做想吧吗呢啊呀"
    "着过得地之其以为及或但而又再还只被把给让用于里后前时一二三些样么什怎"
)

# 单字权重（bigram 为 1.0）
UNIGRAM_WEIGHT = 0.35


def is_cjk_bigram(token: str) -> bool:
    return len(token) == 2 and all("\u4e00" <= ch <= "\u9fff" for ch in token)


def tokenize(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).lower()
    tokens: list[str] = _WORD.findall(text)

    chars = _CJK.findall(text)
    tokens.extend(ch for ch in chars if ch not in STOP_CHARS)
    tokens.extend(chars[i] + chars[i + 1] for i in range(len(chars) - 1))
    return tokens


def weight(token: str) -> float:
    if len(token) == 1 and "\u4e00" <= token <= "\u9fff":
        return UNIGRAM_WEIGHT
    return 1.0
