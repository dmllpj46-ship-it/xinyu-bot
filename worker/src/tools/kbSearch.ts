/**
 * 本地知识库检索（BM25，零依赖）。
 *
 * 知识库在构建时编译进 Worker（scripts/build-kb.mjs），所以没有文件系统依赖，
 * 冷启动只需对 72 个块分词一次（毫秒级）。
 */

import { KB_CHUNKS, type KbChunk } from "../generated/kb";
import { tokenize, weight } from "../text/tokenizer";

const MAX_OUTPUT_CHARS = 1200;
const TOP_K = 4;
const K1 = 1.5;
const B = 0.75;
/** 分数低于最高分的这个比例就丢弃，避免硬凑不相干的内容 */
const RELATIVE_CUTOFF = 0.28;
/** 查询词命中比例低于此值就认为「不相干」。短查询（<=3 个词）不设此限。 */
const MIN_COVERAGE = 0.34;
const SHORT_QUERY_TERMS = 3;

/**
 * 领域锚词：有些词单独出现就足以定性，不该被覆盖度门槛拦下。
 *
 * 典型失败：用户说「我老公昨天打我了，我该怎么办」，查询里大量 bigram 是
 * 「昨天」「我该」「怎么办」，家暴那篇只覆盖到「打我」，覆盖度 0.21 → 被丢弃，
 * 结果模型拿到了「朋友不想活了我该怎么办」那一条，答非所问。
 *
 * 命中锚词时：这类块排在最前，且**只返回**这类块——查询已经明确指向一个领域了。
 * ⚠️ 与 app/tools/kb_search.py 的 ANCHORS 是一对镜像，改一边必须同步另一边。
 */
const ANCHORS = [
  "家暴",
  "家庭暴力",
  "殴打",
  "施暴",
  "掐脖",
  "保护令",
  "告诫书",
  "庇护",
  "打我",
  "打了我",
  "被打",
  "扇我",
];

interface IndexedChunk {
  chunk: KbChunk;
  tf: Map<string, number>;
  length: number;
}

let index: { chunks: IndexedChunk[]; idf: Map<string, number>; avgLen: number } | null = null;

function build() {
  const chunks: IndexedChunk[] = KB_CHUNKS.map((chunk) => {
    const tokens = tokenize(`${chunk.title} › ${chunk.heading}\n${chunk.text}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { chunk, tf, length: tokens.length };
  });

  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  const n = chunks.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));

  const avgLen = chunks.reduce((s, c) => s + c.length, 0) / Math.max(1, n);
  return { chunks, idf, avgLen };
}

function getIndex() {
  if (!index) index = build();
  return index;
}

export interface Hit {
  score: number;
  chunk: KbChunk;
}

export function searchHits(query: string, topK = TOP_K): Hit[] {
  const { chunks, idf, avgLen } = getIndex();
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];

  const qAnchors = ANCHORS.filter((a) => query.includes(a));

  const scored: Array<{ score: number; coverage: number; chunk: KbChunk; anchored: boolean }> = [];
  for (const c of chunks) {
    let score = 0;
    let matched = 0;
    const norm = K1 * (1 - B + (B * c.length) / avgLen);
    for (const t of qTokens) {
      const f = c.tf.get(t);
      if (!f) continue;
      matched++;
      score += (weight(t) * (idf.get(t) ?? 0) * f * (K1 + 1)) / (f + norm);
    }
    if (score > 0) {
      const haystack = `${c.chunk.title} ${c.chunk.heading} ${c.chunk.text}`;
      const anchored = qAnchors.length > 0 && qAnchors.some((a) => haystack.includes(a));
      scored.push({ score, coverage: matched / qTokens.length, chunk: c.chunk, anchored });
    }
  }

  if (!scored.length) return [];

  // 锚词命中的块排最前，其余按分数、覆盖度排
  scored.sort(
    (a, b) => Number(b.anchored) - Number(a.anchored) || b.score - a.score || b.coverage - a.coverage,
  );

  const hasAnchor = scored.some((s) => s.anchored);
  const best = scored[0].score;
  const requireCoverage = qTokens.length > SHORT_QUERY_TERMS;
  const out: Hit[] = [];
  for (const s of scored) {
    if (hasAnchor && !s.anchored) break; // 查询已经明确指向某个领域，不再混入其他篇
    if (s.score < best * RELATIVE_CUTOFF) break;
    if (requireCoverage && !s.anchored && s.coverage < MIN_COVERAGE) continue;
    out.push({ score: s.score, chunk: s.chunk });
    if (out.length >= topK) break;
  }
  return out;
}

/** 返回给模型读的纯文本。没有命中就明说，不硬凑。 */
export function search(query: string, topK = TOP_K): string {
  const hits = searchHits(query, topK);
  if (!hits.length) {
    return "知识库中没有直接相关的内容。不要编造，改用你自己的通用知识并说明这是常识性建议。";
  }

  const blocks: string[] = [];
  let total = 0;
  for (const { chunk } of hits) {
    const block = `【${chunk.title} › ${chunk.heading}】\n${chunk.text}`;
    if (total + block.length > MAX_OUTPUT_CHARS && blocks.length) break;
    blocks.push(block);
    total += block.length;
  }
  return `以下为本地知识库检索结果（共命中 ${blocks.length} 段），引用时说明来自哪一节：\n\n${blocks.join("\n\n---\n\n")}`;
}
