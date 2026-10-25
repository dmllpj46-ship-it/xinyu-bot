"""本地知识库检索（BM25，零依赖）。

为什么不用向量库：72 个块、9 篇文档。BM25 在这个规模上的召回足够，
而且行为可解释——检索不准时能一眼看出是哪个词没命中。
"""

from __future__ import annotations

import json
import math
from collections import Counter
from functools import lru_cache
from pathlib import Path

from agents import function_tool

from app.config import get_settings
from app.text_tokenizer import tokenize, weight

MAX_OUTPUT_CHARS = 1200
TOP_K = 4
K1 = 1.5
B = 0.75
# 分数低于最高分的这个比例就丢弃，避免硬凑不相干的内容
RELATIVE_CUTOFF = 0.28
# 查询词命中比例低于此值就认为"不相干"。短查询（<=3 个词）不设此限。
MIN_COVERAGE = 0.34
SHORT_QUERY_TERMS = 3


class _Index:
    def __init__(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        self.chunks: list[dict] = data["chunks"]
        self.tfs: list[Counter[str]] = [Counter(c["tokens"]) for c in self.chunks]
        self.lengths = [len(c["tokens"]) for c in self.chunks]
        self.avg_len = sum(self.lengths) / max(1, len(self.lengths))

        df: Counter[str] = Counter()
        for tf in self.tfs:
            df.update(tf.keys())
        n = len(self.chunks)
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}

    def search(self, query: str, top_k: int = TOP_K) -> list[tuple[float, dict]]:
        q_tokens = list(dict.fromkeys(tokenize(query)))
        if not q_tokens:
            return []

        scored: list[tuple[float, float, int]] = []
        for i, tf in enumerate(self.tfs):
            score = 0.0
            matched = 0
            norm = K1 * (1 - B + B * self.lengths[i] / self.avg_len)
            for t in q_tokens:
                f = tf.get(t)
                if not f:
                    continue
                matched += 1
                score += weight(t) * self.idf.get(t, 0.0) * f * (K1 + 1) / (f + norm)
            if score > 0:
                scored.append((score, matched / len(q_tokens), i))

        if not scored:
            return []

        scored.sort(key=lambda x: (-x[0], -x[1]))
        best = scored[0][0]
        require_coverage = len(q_tokens) > SHORT_QUERY_TERMS

        out: list[tuple[float, dict]] = []
        for score, coverage, i in scored:
            if score < best * RELATIVE_CUTOFF:
                break
            if require_coverage and coverage < MIN_COVERAGE:
                continue
            out.append((score, self.chunks[i]))
            if len(out) >= top_k:
                break
        return out


@lru_cache(maxsize=1)
def _get_index() -> _Index | None:
    path = get_settings().kb_index_abs
    if not path.exists():
        return None
    return _Index(path)


def search(query: str, top_k: int = TOP_K) -> str:
    """返回给模型读的纯文本。没有命中就明说，不硬凑。"""
    index = _get_index()
    if index is None:
        return "知识库索引不存在。请先运行 python scripts/ingest_kb.py。"

    hits = index.search(query, top_k)
    if not hits:
        return "知识库中没有直接相关的内容。不要编造，改用你自己的通用知识并说明这是常识性建议。"

    blocks: list[str] = []
    total = 0
    for _score, chunk in hits:
        body = chunk["text"].split("\n", 1)[-1].strip()
        block = f"【{chunk['title']} › {chunk['heading']}】\n{body}"
        if total + len(block) > MAX_OUTPUT_CHARS and blocks:
            break
        blocks.append(block)
        total += len(block)

    header = f"以下为本地知识库检索结果（共命中 {len(blocks)} 段），引用时说明来自哪一节：\n\n"
    return header + "\n\n---\n\n".join(blocks)


@function_tool
def kb_search(query: str) -> str:
    """检索本地心理健康知识库（循证自助方法、危机干预、沟通技巧、转介标准）。

    Use when: 用户描述具体的情绪/躯体/睡眠问题，你需要给出有依据的方法或练习；
              用户问"该怎么办""有什么办法""要不要看医生"。
    Do NOT use when: 用户在危机中需要立刻回应（那时先给热线，不要先查资料）；
                      你只是要寒暄或复述情绪。
    返回: 若干知识库片段，每段带【篇名 › 小节】来源标注。无命中时会明确说明。
    """
    return search(query)
