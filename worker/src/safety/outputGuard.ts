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
export const ALLOWED_NUMBERS = new Set([
  "12356",
  "120",
  "110",
  "119",
  "12338",
  "82951332",
  "01082951332",
]);

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
const MD_HEADING = /^#{1,6}\s*/gm;

/** 把模型吐出的 "下班" 变成「下班」——中文正文里 ASCII 引号很出戏。 */
function fancyQuotes(text: string): string {
  return text.replace(ASCII_QUOTE, (whole, inner: string) => {
    if (/[A-Za-z]/.test(inner) || !/[\u4e00-\u9fff]/.test(inner)) return whole;
    return `「${inner}」`;
  });
}

/**
 * 去掉 Markdown 标记。前端按纯文本渲染，`**` 和 `#` 会原样露出来。
 * 只删标记不删文字：`**重点**` → `重点`，不是整句丢掉。
 */
function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, "").replace(MD_HEADING, "");
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
  const masked = maskPhones(stripMarkdown(fancyQuotes(sentence)));
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

// ── 重复句检测 ────────────────────────────────────────────
// 模型会把同一句话写两遍：一次是「先共情」，一次是工具调用回来后「重新开头」。
// 提示词能降低概率，但压不到零（Mercury 3 尤其容易复用示例原句），
// 所以这里做一道硬去重——重复的那句直接不发。
const DEDUP_STRIP = /[\s。！？!?；;，,、：:「」『』“”"'（）()\[\]—…·~～]+/g;

const EXACT_MIN = 4; // 短于此不判重，否则「嗯。」「对。」会被误杀
const CONTAIN_MIN = 10; // 包含关系只在够长时才成立
const SIMILAR_MIN = 12; // 相似度比较的长度门槛
const SIMILAR_RATIO = 0.72;
const MAX_TAIL_NEWLINES = 2; // 连续空行上限，对应一个段落间隔

function dedupKey(text: string): string {
  return text.replace(DEDUP_STRIP, "");
}

/** 最长公共子序列长度（句子都很短，DP 足够）。 */
function lcsLen(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return prev[n];
}

/** 与 Python 的 difflib.SequenceMatcher.ratio() 同一口径：2M/T。 */
function similarity(a: string, b: string): number {
  const total = a.length + b.length;
  return total ? (2 * lcsLen(a, b)) / total : 0;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?；;\n])/).filter((p) => p.trim());
}

// ── 换个说法重讲一遍 ──────────────────────────────────────────
// 线上实录（2026-10-26 部署后第一屏就这样）：
//   「……这两种处理方式不太一样。」
//   下一段又接：「这两种处理不一样。」
// 两句去标点后字符重叠很少，相似度约 0.63，过不了 0.72——原来那套阈值抓不住。
// 这类话没有新信息，只是句尾给前一句做注脚，说第二遍就是卡带。
//
// ⚠️ 这一段必须有，前面的全部可选。曾经全可选 → 正则能匹配空串，
// exec 在每个位置都命中，指纹判断形同虚设。
const SKELETON_PATTERN = new RegExp(
  "(?:这两|那两|两|这|那)(?:种|个|类|方面|件事)?" +
    "(?:的)?" +
    "(?:处理|情况|方式|东西|做法|问题)?" +
    "(?:方式|方法|做法|处理|情况|东西)?" +
    "(?:其实|也|确实|可能|就)?" +
    "(?:不太?一样|不一样|完全不同|不同|不太?同|差不多|类似|有区别|有差别|差很多)",
  "g",
);
const SKELETON_MIN = 4;
const CLOSING_MARK = "\x00closing";
const CLOSING_PATTERN = new RegExp(
  "^(?:这两|那两|两|这|那)(?:种|个|类|两方面|方面|件事)?" +
    "(?:处理|情况|方式|东西|做法|问题)?" +
    "(?:方式|方法|做法|处理|情况|东西)?" +
    "(?:其实|也|确实|可能|就)?" +
    "(?:不太?一样|不一样|完全不同|不同|不太?同|差不多|类似|有区别|有差别|差很多)$",
);

function skeleton(key: string): string {
  const body = key.replace(SKELETON_PATTERN, "");
  if (body === key) return ""; // 没有重述特征
  if (body.length < SKELETON_MIN) return ""; // 整句就是「这两种处理不一样」
  if (!/[\u4e00-\u9fff]/.test(body)) return "";
  return body;
}

function closing(key: string): string {
  return CLOSING_PATTERN.test(key) ? CLOSING_MARK : "";
}

/** 比较指纹：有实质内容的句子用骨架，纯注脚用 CLOSING_MARK，其余为空。 */
function fingerprint(key: string): string {
  return skeleton(key) || closing(key);
}

export class StreamScrubber {
  private buf = "";
  private seen: string[] = [];
  private prints: string[] = []; // 比较指纹（骨架 / CLOSING_MARK）
  private tailNl = 0; // 已经连续发出的换行数，用来收敛多余空行
  readonly violations: string[] = [];

  constructor(
    seed = "",
    private readonly maxBuffer = 140,
  ) {
    // 跨轮去重：把上一轮回复里"有分量"的句子先记进来。
    // 只收够长的句子——「要不要试试？」这类衔接语重复出现是自然的，
    // 但"床和睡觉的关系会重新建立起来"这种整句连着说两遍就很机械。
    for (const seg of sentences(seed)) {
      const key = dedupKey(seg);
      if (key.length >= CONTAIN_MIN) this.seen.push(key);
      // 指纹不看长度：上一轮句尾那句「这两种处理方式不太一样」本身很短，
      // 但它恰恰是这一轮最容易被重复的那句。
      const fp = fingerprint(key);
      if (fp) this.prints.push(fp);
    }
  }

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
    return this.dedup(text);
  }

  /** 已经说过的句子不再发第二遍。 */
  private dedup(text: string): string {
    if (!text) return text;
    const key = dedupKey(text);

    // 纯空白/纯标点：控制连续换行不超过 2 个。
    // 否则丢掉一句之后，原来那句前后的 \n\n 会拼成一片空白。
    if (!key) {
      const newlines = (text.match(/\n/g) ?? []).length;
      if (newlines === 0) return "";
      const allow = Math.max(0, MAX_TAIL_NEWLINES - this.tailNl);
      const emit = "\n".repeat(Math.min(newlines, allow));
      this.tailNl += emit.length;
      return emit;
    }

    if (key.length < EXACT_MIN) {
      this.tailNl = 0;
      return text;
    }

    if (this.isRepeat(key)) {
      this.violations.push("repeat");
      return "";
    }

    this.seen.push(key);
    this.tailNl = 0;
    // 记下比较指纹：有实质内容的是骨架，纯注脚的是 CLOSING_MARK。
    // 换句话说同一件事时，句面不同、指纹相同。空指纹不进表
    // ——空串互相相等，会把所有普通句子判成重复。
    const fp = fingerprint(key);
    if (fp) this.prints.push(fp);
    return text;
  }

  private isRepeat(key: string): boolean {
    for (const prev of this.seen) {
      if (key === prev) return true;
      const short = key.length <= prev.length ? key : prev;
      const long = key.length <= prev.length ? prev : key;
      if (short.length >= CONTAIN_MIN && long.includes(short)) return true;
      if (short.length >= SIMILAR_MIN && similarity(key, prev) >= SIMILAR_RATIO) return true;
    }

    // 换个说法重讲一遍：句面不同，指纹相同。见文件上方 SKELETON_PATTERN 的说明。
    const mine = fingerprint(key);
    if (!mine) return false; // 没指纹的句子只走上面三条，不参与指纹比较
    return this.prints.includes(mine);
  }
}

/** 非流式场景用这个。 */
export function scrubText(text: string): ScrubResult {
  const s = new StreamScrubber();
  const out = s.feed(text) + s.flush();
  return { text: out, violations: s.violations };
}
