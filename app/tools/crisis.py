"""危机资源：号码的唯一真相源。

R4 红线：模型不得凭记忆输出电话号码，prompt 里也不写号码。
所有号码只能从这里的常量表出去。
"""

from __future__ import annotations

from agents import function_tool

# ── 唯一真相源 ────────────────────────────────────────────
HOTLINES: list[dict[str, str]] = [
    {
        "number": "12356",
        "name": "全国统一心理援助热线",
        "hours": "24 小时",
        "note": "2025-05-01 起全国统一启用，免费，可直接拨打",
    },
    {
        "number": "120",
        "name": "急救",
        "hours": "24 小时",
        "note": "有即时生命危险（已服药、已受伤、意识不清）时优先拨这个",
    },
    {
        "number": "110",
        "name": "报警",
        "hours": "24 小时",
        "note": "正在发生危险、需要警察到场时",
    },
    {
        "number": "12338",
        "name": "妇联维权热线",
        "hours": "各地不同，多数工作时间",
        "note": "家暴、婚姻家庭权益受侵害时可用，可咨询庇护所与法律援助；紧急时仍先拨 110",
    },
    {
        "number": "010-8295-1332",
        "name": "北京心理危机研究与干预中心",
        "hours": "24 小时",
        "note": "专业危机干预热线，全国可拨",
    },
]

SAFETY_PLAN_STEPS: list[str] = [
    "识别警示信号：出现什么念头、情绪或场景时，说明「要开始了」",
    "内部应对：不需要联系任何人的事——听一张专辑、洗热水澡、出门走 20 分钟",
    "转移注意力的人或地方：去便利店、去朋友家坐着、去公园",
    "可以求助的人：写下 2–3 个具体名字和联系方式，想好第一句话说什么",
    "专业资源：心理援助热线、就近的精神专科急诊、正在看的医生",
    "让环境更安全：把可能伤害自己的东西交给别人保管，或至少增加获取难度",
]


def resources_text(region: str = "全国") -> str:
    lines = [f"【危机资源 · {region}】以下号码可直接拨打，请原样转述，不要改写：", ""]
    for h in HOTLINES:
        lines.append(f"{h['number']}　{h['name']}（{h['hours']}）")
        lines.append(f"　　{h['note']}")
    lines.append("")
    lines.append("如果有即时生命危险：先拨 120，再让身边的人过来陪你。")
    return "\n".join(lines)


def safety_plan_text() -> str:
    lines = ["【安全计划六步】和对方一起写，不要替他写。可以口述，让他复述一遍："]
    for i, step in enumerate(SAFETY_PLAN_STEPS, 1):
        lines.append(f"{i}. {step}")
    return "\n".join(lines)


@function_tool
def crisis_resources(region: str = "全国") -> str:
    """获取危机干预热线与安全计划步骤。

    Use when: 用户表达自伤/自杀念头、说自己撑不住、或问"能找谁帮忙""有没有热线"。
              也可以用于用户问"怎么帮一个想不开的朋友"。
    Do NOT use when: 用户只是普通压力、没有风险信号（那属于 kb_search 的职责）。
    返回: 可直接转述的热线清单（号码已核对）与安全计划六步。号码必须原样使用，不得改写。
    """
    return resources_text(region) + "\n\n" + safety_plan_text()
