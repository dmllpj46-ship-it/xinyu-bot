/**
 * 输出护栏：流式输出时按句拦截违规内容。
 *
 * 三条红线在这里落地：不给诊断、不给药名剂量、不劝阻就医。
 * 另外兜住「模型编造电话号码」——号码只能来自 tools/crisis.ts。
 *
 * 流式的难点是「句子还没说完就得往外发」，所以按句边界缓冲：
 * 遇到 。！？!? 或换行才检查这一句；缓冲超过 140 字强制检查一次。
 */

/** 白名单号码（与 tools/crisis.ts 保持一致，有测试守着） */
export const ALLOWED_NUMBERS = new Set(["12356", "120", "110", "119", "82951332", "01082951332"]);

const DIAGNOSIS =
  /(你|这|您)(是|属于|符合|患了|得了|就是).{0,8}(抑郁症|焦虑症|双相|躁郁|精神分裂|强迫症|PTSD|创伤后应激|进食障碍|ADHD|多动症|人格障碍)/;
const DSM = /(DSM|ICD)[- ]?\d?|诊断标准/;

const DRUGS = [
  "舍曲林", "帕罗西汀", "氟西汀", "艾司西酞普兰", "西酞普兰", "文拉法辛", "度洛西汀",
  "米氮平", "曲唑酮", "安非他酮", "丁螺环酮", "阿普唑仑", "劳拉西泮", "氯硝西泮",
  "奥沙西泮", "地西泮", "奥氮平", "喹硫平", "利培酮", "丙戊酸钠", "碳酸锂",
  "佐匹克隆", "唑吡坦", "思诺思", "百忧解", "来士普",
];
const DRUG_RX = new RegExp(DRUGS.join("|"));
const DOSE = /\d+(\.\d+)?\s*(mg|毫克|片|粒|g\b)/;

const STOP_CARE = /(不用|不必|没必要|别|不需要).{0,4}(看医生|就医|去医院|吃药|找咨询师|看心理|看精神科)/;
const BADMOUTH = /(咨询师|医生|心理师|精神科).{0,8}(都是|只想|就是为了|为了).{0,4}(赚钱|骗钱|忽悠)/;

const PHONE_PATTERNS = [/1[3-9]\d{9}/g, /0\d{2,3}[- ]?\d{7,8}/g, /\d{3,4}[- ]\d{3,4}[- ]\d{4}/g];

const REPLACEMENTS: Record<string, string> = {
  diagnosis: "你描述的这些体验，和某些常见情况有重叠，但这需要专业评估，我不下判断。",
  medication: "药物相关的事，只有给你开药的医生能决定，我不适合给建议。",
  stop_care: "这件事值得让专业的人看一次。",
  badmouth: "找专业的人聊聊是值得的。",
};

const ASCII_QUOTE = /"([^"\n]{1,24})"/g;

/** 把模型吐出的 "下班" 变成「下班」——中文正文里 ASCII 引号很出戏。 */
function fancyQuotes(text: string): string {
  return text.replace(ASCII_QUOTE, (whole, inner: string) => {
    if (/[A-Za-z]/.test(inner) || !/[\u4e00-\u9fff]/.test(inner)) return whole;
    return `「${inner}」`;
  });
}

function maskPhones(text: string): { text: string; hit: boolean } {
  let hit = false;
  let out = text;
  for (const rx of PHONE_PATTERNS) {
    out = out.replace(rx, (m) => {
      const digits = m.replace(/\D/g, "");
      if (ALLOWED_NUMBERS.has(digits)) return m;
      hit = true;
      return "12356";
    });
  }
  return { text: out, hit };
}

export interface ScrubResult {
  text: string;
  violations: string[];
}

/**
 * 检查一个句子片段。
 * 号码是「就地替换」，其他红线是「整句替换」——改号码不会让句子变病句，
 * 而删掉半句诊断会。
 */
export function scrub(sentence: string): ScrubResult {
  const masked = maskPhones(fancyQuotes(sentence));
  const text = masked.text;

  const violations: string[] = [];
  if (DRUG_RX.test(text) || (DOSE.test(text) && /(吃|服|药|剂)/.test(text))) {
    violations.push("medication");
  }
  if (DIAGNOSIS.test(text) || (DSM.test(text) && text.includes("你"))) {
    violations.push("diagnosis");
  }
  if (STOP_CARE.test(text)) violations.push("stop_care");
  if (BADMOUTH.test(text)) violations.push("badmouth");

  if (violations.length) {
    if (masked.hit) violations.push("phone");
    return { text: REPLACEMENTS[violations[0]] ?? "", violations };
  }
  if (masked.hit) return { text, violations: ["phone"] };
  return { text, violations: [] };
}

const BOUNDARY = new Set(["。", "！", "？", "!", "?", "\n", "；", ";"]);

export class StreamScrubber {
  private buf = "";
  readonly violations: string[] = [];

  constructor(
    private readonly maxBuffer = 140,
  ) {}

  /** 返回可以安全发出去的内容。 */
  feed(chunk: string): string {
    this.buf += chunk;
    const out: string[] = [];

    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.buf.length; i++) {
        if (BOUNDARY.has(this.buf[i])) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      out.push(this.clean(this.buf.slice(0, idx + 1)));
      this.buf = this.buf.slice(idx + 1);
    }

    if (this.buf.length >= this.maxBuffer) {
      out.push(this.clean(this.buf));
      this.buf = "";
    }
    return out.join("");
  }

  flush(): string {
    const seg = this.buf;
    this.buf = "";
    return seg ? this.clean(seg) : "";
  }

  private clean(seg: string): string {
    const { text, violations } = scrub(seg);
    this.violations.push(...violations);
    return text;
  }
}

/** 非流式场景用这个。 */
export function scrubText(text: string): ScrubResult {
  const s = new StreamScrubber();
  const out = s.feed(text) + s.flush();
  return { text: out, violations: s.violations };
}
