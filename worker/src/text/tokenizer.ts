/**
 * 中文检索分词（与 Python 版 app/text_tokenizer.py 保持同一套规则）。
 *
 * 索引和查询必须用同一套规则，所以抽出来放这里，两边都 import 它。
 * 不引 jieba / segmentit：知识库只有几十块，bigram 的召回足够，行为也可预测。
 */

const CJK = /[\u4e00-\u9fff]/g;
const WORD = /[a-z0-9]+/g;

/** 单字停用：这些字几乎出现在每一段里，留着只会让「量子色动力学」命中「行为动力」 */
export const STOP_CHARS = new Set(
  "的了是在我你他她它们有和与就都也很不要会能可这那个上下中对从到说做想吧吗呢啊呀" +
    "着过得地之其以为及或但而又再还只被把给让用于里后前时一二三些样么什怎",
);

/** 单字权重（bigram 为 1） */
export const UNIGRAM_WEIGHT = 0.35;

export function tokenize(text: string): string[] {
  const norm = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = norm.match(WORD) ?? [];

  const chars = norm.match(CJK) ?? [];
  for (const ch of chars) {
    if (!STOP_CHARS.has(ch)) tokens.push(ch);
  }
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

export function weight(token: string): number {
  return token.length === 1 && /[\u4e00-\u9fff]/.test(token) ? UNIGRAM_WEIGHT : 1;
}
