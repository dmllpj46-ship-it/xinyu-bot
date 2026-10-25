/** 联网搜索（AnySearch）。只补最新政策、本地机构这类信息，心理建议的底线由本地知识库保证。 */

import type { Env } from "../agent";

const MAX_OUTPUT_CHARS = 1100;
const TIMEOUT_MS = 8000;

export async function webSearchText(env: Env, query: string, maxResults = 4): Promise<string> {
  if (!env.ANYSEARCH_API_KEY) {
    return "联网搜索未配置（缺少 ANYSEARCH_API_KEY），请只使用本地知识库回答。";
  }

  const base = env.ANYSEARCH_BASE_URL ?? "https://api.anysearch.com";

  try {
    const res = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ANYSEARCH_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, max_results: maxResults, tag: "general.web" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return `联网搜索暂时不可用（HTTP ${res.status}）。请用本地知识库继续回答。`;

    const data = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { results?: Array<Record<string, string>> };
    };

    if (data.code !== 0) {
      return `联网搜索返回错误：${data.message ?? "未知错误"}。请用本地知识库继续回答。`;
    }

    const results = data.data?.results ?? [];
    if (!results.length) return "联网没有找到相关结果。请用本地知识库继续回答。";

    const blocks: string[] = [];
    let total = 0;
    for (const item of results) {
      const title = (item.title ?? "").trim();
      const url = (item.url ?? item.link ?? "").trim();
      const snippet = (item.snippet ?? item.content ?? "").trim().replace(/\s+/g, " ").slice(0, 220);
      const block = `- ${title}\n  ${snippet}\n  ${url}`;
      if (total + block.length > MAX_OUTPUT_CHARS) break;
      blocks.push(block);
      total += block.length;
    }

    return (
      "以下为网络搜索结果，**仅供参考，可能不准确**。" +
      "不要直接照搬其中的心理建议，只用于补充最新政策或本地机构信息：\n\n" +
      blocks.join("\n\n")
    );
  } catch (err) {
    const kind = err instanceof Error ? err.name : "Error";
    return `联网搜索暂时不可用（${kind}）。请用本地知识库继续回答，并说明无法核实最新信息。`;
  }
}
