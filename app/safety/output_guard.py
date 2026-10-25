"""输出护栏：流式输出时按句拦截违规内容。

三条红线在这里落地：
- 不给诊断（R1）
- 不给药名/剂量（R2）
- 不劝阻就医（R5）
另外顺手兜住"模型编造电话号码"——号码只能来自 app/tools/crisis.py。

流式的难点是"句子还没说完就得往外发"。所以按句边界缓冲：
遇到 。！？!? 或换行才检查这一句；缓冲超过 140 字强制检查一次，避免长句卡住。
"""

from __future__ import annotations

import re

# ── 白名单号码（与 app/tools/crisis.py 保持一致）──────────────
ALLOWED_NUMBERS = {"12356", "120", "110", "119", "82951332", "01082951332"}

_DIAGNOSIS = re.compile(
    r"(你|这|您)(是|属于|符合|患了|得了|就是).{0,8}"
    r"(抑郁症|焦虑症|双相|躁郁|精神分裂|强迫症|PTSD|创伤后应激|进食障碍|ADHD|多动症|人格障碍)"
)
_DSM = re.compile(r"(DSM|ICD)[- ]?\d?|诊断标准")

_DRUGS = (
    "舍曲林", "帕罗西汀", "氟西汀", "艾司西酞普兰", "西酞普兰", "文拉法辛", "度洛西汀",
    "米氮平", "曲唑酮", "安非他酮", "丁螺环酮", "阿普唑仑", "劳拉西泮", "氯硝西泮",
    "奥沙西泮", "地西泮", "奥氮平", "喹硫平", "利培酮", "丙戊酸钠", "碳酸锂",
    "佐匹克隆", "唑吡坦", "思诺思", "百忧解", "来士普",
)
_DRUG_RX = re.compile("|".join(_DRUGS))
_DOSE = re.compile(r"\d+(\.\d+)?\s*(mg|毫克|片|粒|g\b)")

_STOP_CARE = re.compile(
    r"(不用|不必|没必要|别|不需要).{0,4}(看医生|就医|去医院|吃药|找咨询师|看心理|看精神科)"
)
_BADMOUTH = re.compile(r"(咨询师|医生|心理师|精神科).{0,8}(都是|只想|就是为了|为了).{0,4}(赚钱|骗钱|忽悠)")

_PHONE_PATTERNS = [
    re.compile(r"1[3-9]\d{9}"),
    re.compile(r"0\d{2,3}[- ]?\d{7,8}"),
    re.compile(r"\d{3,4}[- ]\d{3,4}[- ]\d{4}"),
]

REPLACEMENTS = {
    "diagnosis": "你描述的这些体验，和某些常见情况有重叠，但这需要专业评估，我不下判断。",
    "medication": "药物相关的事，只有给你开药的医生能决定，我不适合给建议。",
    "stop_care": "这件事值得让专业的人看一次。",
    "badmouth": "找专业的人聊聊是值得的。",
}


def _mask_phones(text: str) -> tuple[str, bool]:
    hit = False
    for rx in _PHONE_PATTERNS:
        def _sub(m: re.Match[str]) -> str:
            nonlocal hit
            digits = re.sub(r"\D", "", m.group(0))
            if digits in ALLOWED_NUMBERS:
                return m.group(0)
            hit = True
            return "12356"

        text = rx.sub(_sub, text)
    return text, hit


_ASCII_QUOTE = re.compile(r'"([^"\n]{1,24})"')


def _fancy_quotes(text: str) -> str:
    """把模型吐出的 "下班" 变成「下班」——中文正文里 ASCII 引号很出戏。"""

    def _sub(m: re.Match[str]) -> str:
        inner = m.group(1)
        if re.search(r"[A-Za-z]", inner) or not re.search(r"[一-鿿]", inner):
            return m.group(0)
        return f"「{inner}」"

    return _ASCII_QUOTE.sub(_sub, text)


def scrub(sentence: str) -> tuple[str, list[str]]:
    """检查一个句子片段，返回（安全文本, 违规标签）。

    号码是"就地替换"，其他红线是"整句替换"——因为改号码不会让句子变病句，
    而删掉半句诊断会。
    """
    text, phone_hit = _mask_phones(_fancy_quotes(sentence))

    violations: list[str] = []
    if _DRUG_RX.search(text) or (_DOSE.search(text) and re.search(r"(吃|服|药|剂)", text)):
        violations.append("medication")
    if _DIAGNOSIS.search(text) or (_DSM.search(text) and "你" in text):
        violations.append("diagnosis")
    if _STOP_CARE.search(text):
        violations.append("stop_care")
    if _BADMOUTH.search(text):
        violations.append("badmouth")

    if violations:
        label = violations[0]
        if phone_hit:
            violations.append("phone")
        return REPLACEMENTS.get(label, ""), violations
    if phone_hit:
        return text, ["phone"]
    return text, []


class StreamScrubber:
    """按句缓冲的流式护栏。feed() 返回可以安全发出去的内容。"""

    BOUNDARY = "。！？!?\n；;"
    MAX_BUFFER = 140

    def __init__(self) -> None:
        self._buf = ""
        self.violations: list[str] = []

    def feed(self, chunk: str) -> str:
        self._buf += chunk
        out: list[str] = []
        while True:
            idx = self._next_boundary(self._buf)
            if idx is None:
                break
            seg, self._buf = self._buf[: idx + 1], self._buf[idx + 1 :]
            out.append(self._clean(seg))
        if len(self._buf) >= self.MAX_BUFFER:
            out.append(self._clean(self._buf))
            self._buf = ""
        return "".join(out)

    def flush(self) -> str:
        seg, self._buf = self._buf, ""
        return self._clean(seg) if seg else ""

    def _clean(self, seg: str) -> str:
        text, bad = scrub(seg)
        self.violations.extend(bad)
        return text

    def _next_boundary(self, s: str) -> int | None:
        for i, ch in enumerate(s):
            if ch in self.BOUNDARY:
                return i
        return None


def scrub_text(text: str) -> tuple[str, list[str]]:
    """非流式场景（一次性返回、日志回放）用这个。"""
    scrubber = StreamScrubber()
    return scrubber.feed(text) + scrubber.flush(), scrubber.violations
