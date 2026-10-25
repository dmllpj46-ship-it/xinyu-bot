"""联网搜索连通性自检。

## 为什么需要这个

2026-10 发生过一次静默失效：代码里写死 `tag: "general.web"`，AnySearch 把这个 tag
改名了，服务端返回 400，工具按设计降级成"请用本地知识库回答"——
用户端没有任何报错，只觉得"这 bot 不会上网"。这种故障只能靠主动探测发现。

## 用法

    .\\.venv\\Scripts\\python.exe scripts/check_search.py

退出码 0 表示搜索可用，1 表示不可用（可直接接进 CI 或部署前检查）。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.tools.web_search import search  # noqa: E402

PROBES = [
    ("政策类", "12356 心理援助热线 政策"),
    ("机构类", "北京 免费心理咨询 机构"),
]


async def main() -> int:
    failures = 0
    for label, query in PROBES:
        print(f"[{label}] {query}")
        text = await search(query)
        # 降级文案都以"联网"开头，正常结果以"以下为网络搜索结果"开头
        if not text.startswith("以下为网络搜索结果"):
            failures += 1
            print(f"  [FAIL] {text[:160]}")
        else:
            lines = [ln for ln in text.splitlines() if ln.startswith("- ")]
            print(f"  [ok] {len(lines)} 条结果")
            for ln in lines[:2]:
                print(f"       {ln}")

    if failures:
        print(f"\n{failures}/{len(PROBES)} 条探测失败：联网搜索当前不可用。")
        return 1
    print("\n联网搜索可用。")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
