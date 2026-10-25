/**
 * 危机词表与分级扫描（与 Python 版 app/safety/lexicon.py 同规则）。
 *
 * 1. 先排除否定（「我不会自杀」不该判成高风险），再匹配风险。
 * 2. 分级只看最高命中，不累加——累加会把「最近有点累」误伤成高危。
 * 3. 词表只做粗筛。宁可多报（L1 的代价只是多问一句），也不能漏报。
 * 4. 电话号码不在这里，只在 worker/src/tools/crisis.ts。
 */

export type Level = 0 | 1 | 2 | 3;

export interface ScanResult {
  level: Level;
  hits: string[];
  thirdParty: boolean;
}

/** 全角转半角、去空白、英文小写。去空白是为了对付「自 杀」「想 死」这类规避写法。 */
export function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 否定式：命中则把对应片段排除在风险判定之外。每条都是「否认有风险」的句式。 */
const SAFE_PATTERNS: RegExp[] = [
  /(不会|不|没有|没|从没|从未|未曾|不至于|不打算|不想要|不准备).{0,6}(自杀|自尽|轻生|自残|自伤|伤害自己|伤害我自己)/g,
  /(不|没有|没|不想|不会).{0,4}想(死|要死)/g,
  /(不想|不会|不可能|不至于).{0,3}(死|自杀|轻生)/g,
  /(don't|donot|won't|never|not|no)\s*(wantto|want)?\s*(killmyself|die|commitsuicide|hurtmyself|endmylife)/g,
  /(没有|没|无).{0,3}(自杀|自残|自伤)(想法|念头|计划|倾向)/g,
];

/** L3：正在进行 / 刚刚发生 —— 立刻按紧急处理，不问细节 */
const L3: Array<[string, RegExp]> = [
  ["已实施", /(已经|刚刚|刚才|正在|现在|刚).{0,8}(吃了|吞了|割了|划了|跳了|喝了|上吊|割腕|吞药|吃了一把)/g],
  ["现场", /(在|站在|坐在|爬到).{0,6}(楼顶|天台|桥上|窗台|阳台边|栏杆外)/g],
  ["手段", /(割腕|割了手腕|上吊|跳楼|跳桥|卧轨|烧炭|喝了农药|吞了安眠药|吞了一整瓶)/g],
  ["已出血", /(血流不止|血一直流|药已经吃下去|已经吞下去)/g],
];

/** L2：明确意念 / 计划 / 既往尝试 —— 走危机协议 */
const L2: Array<[string, RegExp]> = [
  ["意念", /(想|要|打算|准备|计划|考虑).{0,4}(自杀|自尽|轻生|结束生命|了结自己|死了算了)/g],
  ["意念", /(想死|去死|求死|不想活|活不下去|不如死了|一死了之)/g],
  ["意念", /(自杀|自尽|轻生)/g],
  ["计划", /(遗书|遗言|告别信|最后一次见|交代后事)/g],
  ["自伤", /(自残|自伤|伤害自己|划手|割手臂|用刀划|割.{0,2}腕)/g],
  ["既往", /(试过|曾经|以前|上次|有过).{0,6}(自杀|自残|割腕|吞药|伤害自己)/g],
  ["英文", /(killmyself|suicide|endmylife|wanttodie|self-?harm|cutmyself)/g],
];

/** L1：被动意念 / 无望感 —— 必须直问一次，但不打断对话 */
const L1: Array<[string, RegExp]> = [
  ["无意义", /(活着|生活|一切|人生).{0,4}(没.{0,2}(意思|意义)|没盼头|没有意义)/g],
  ["耗竭", /(撑不住|扛不住|受不了了|顶不住了|快崩溃|要崩溃)/g],
  ["消失", /(想消失|消失掉|不想醒来|睡过去不醒|不想醒过来|不想再醒)/g],
  ["无望", /(绝望|看不到希望|没有希望|没有出路|没什么可留恋)/g],
  ["累赘", /(累赘|拖累别人|没有我更好|没有我会更好)/g],
  ["疲惫", /(活着好累|活得好累|太累了好想停)/g],
];

/** 第三人称：说的是别人，不是自己。协议不同（教怎么帮，而不是评估本人） */
const THIRD_PARTY =
  /(朋友|同学|同事|室友|舍友|家人|我妈|我爸|男朋友|女朋友|对象|孩子|弟弟|妹妹|哥哥|姐姐|他|她|别人|有人)/;

function safeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const rx of SAFE_PATTERNS) {
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) {
      const start = m.index ?? 0;
      spans.push([start, start + m[0].length]);
    }
  }
  return spans;
}

function inside(start: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([s, e]) => s <= start && end <= e);
}

function isThirdParty(text: string, start: number): boolean {
  return THIRD_PARTY.test(text.slice(Math.max(0, start - 6), start));
}

export function scan(text: string): ScanResult {
  const result: ScanResult = { level: 0, hits: [], thirdParty: false };
  if (!text || !text.trim()) return result;

  const norm = normalize(text);
  const safe = safeSpans(norm);

  const tiers: Array<[Level, Array<[string, RegExp]>]> = [
    [3, L3],
    [2, L2],
    [1, L1],
  ];

  for (const [level, patterns] of tiers) {
    for (const [label, rx] of patterns) {
      rx.lastIndex = 0;
      for (const m of norm.matchAll(rx)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (inside(start, end, safe)) continue;
        result.hits.push(`L${level}:${label}:${m[0].slice(0, 12)}`);
        if (level > result.level) result.level = level;
        if (isThirdParty(norm, start)) result.thirdParty = true;
      }
    }
  }

  if (result.level >= 2 && result.thirdParty && result.hits.length === 1) {
    result.hits.push("third_party_only");
  }
  return result;
}

export function levelLabel(level: Level): string {
  return { 0: "L0 无", 1: "L1 关注", 2: "L2 风险", 3: "L3 紧急" }[level];
}
