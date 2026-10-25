"""把 knowledge/*.md 切成检索块，写成 data/kb_index.json。

切块规则（与 AGENTS.md §6 对齐）：
- 一个 `##` 小节 = 一个检索块
- 块文本前面拼上「篇名 › 小节名」，让脱离上下文的块也能自解释
- `00-` 开头的文件是索引，不参与检索

分词规则：
- 英文/数字按词切
- 中文取「单字 + 相邻双字（bigram）」
  不引 jieba：知识库只有几十块，bigram 的召回已经够，而且零依赖、行为可预测。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.text_tokenizer import tokenize  # noqa: E402
KB_DIR = ROOT / "knowledge"
OUT = ROOT / "data" / "kb_index.json"

MIN_CHUNK_CHARS = 60

def parse_doc(path: Path) -> tuple[str, list[dict]]:
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()

    title = path.stem
    for line in lines:
        if line.startswith("# "):
            title = line[2:].strip()
            break

    # 按二级标题切
    sections: list[tuple[str, list[str]]] = []
    cur_head = "开篇"
    cur_body: list[str] = []
    for line in lines:
        if line.startswith("## "):
            if cur_body:
                sections.append((cur_head, cur_body))
            cur_head = line[3:].strip()
            cur_body = []
        elif line.startswith("# "):
            continue
        else:
            cur_body.append(line)
    if cur_body:
        sections.append((cur_head, cur_body))

    chunks: list[dict] = []
    for head, body in sections:
        text = "\n".join(body).strip()
        if len(text) < MIN_CHUNK_CHARS:
            continue
        full = f"{title} › {head}\n{text}"
        chunks.append(
            {
                "doc": path.name,
                "title": title,
                "heading": head,
                "text": full,
                "tokens": tokenize(full),
            }
        )
    return title, chunks


def main() -> int:
    if not KB_DIR.exists():
        print(f"[x] 找不到知识库目录：{KB_DIR}")
        return 1

    files = sorted(p for p in KB_DIR.glob("*.md") if not p.name.startswith("00-"))
    if not files:
        print("[x] knowledge/ 下没有可用的 md")
        return 1

    docs: list[dict] = []
    chunks: list[dict] = []
    warns: list[str] = []

    for path in files:
        raw = path.read_text(encoding="utf-8")
        if "> 来源" not in raw:
            warns.append(f"{path.name}: 缺少 `> 来源`")
        if "## 转介信号" not in raw:
            warns.append(f"{path.name}: 缺少 `## 转介信号`")

        title, doc_chunks = parse_doc(path)
        docs.append({"file": path.name, "title": title, "chunks": len(doc_chunks)})
        for i, c in enumerate(doc_chunks):
            c["id"] = f"{path.stem}#{i}"
            chunks.append(c)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "tokenizer": "cjk-bigram+v1",
        "docs": docs,
        "chunks": chunks,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"[ok] {len(docs)} 篇 → {len(chunks)} 块 → {OUT.relative_to(ROOT)}")
    for d in docs:
        print(f"     {d['file']:42} {d['chunks']:>3} 块")
    for w in warns:
        print(f"[!] {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
