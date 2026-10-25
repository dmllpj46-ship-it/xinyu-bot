/**
 * 联网搜索（AnySearch）。只补最新政策、本地机构这类信息，心理建议的底线由本地知识库保证。
 *
 * ⚠️ 2026-10 实测教训：请求里**不要带 tag**。
 * 原先写死 tag: "general.web"，而 AnySearch 已把该 tag 改名（现在是 general.general），
 * 服务端直接返回 400 `Invalid tag: general.web.`，联网搜索因此长期静默失效。
 * 不带 tag 时走默认通用搜索，实测 200 / 约 1.2s / 结果质量正常，且不会再被 tag 改名打断。
 */

import type { Env } from "../agent";

const MAX_OUTPUT_CHARS = 1100;
const TIMEOUT_MS = 6000; // 压力大的人等不起，宁可降级也不要拖满 8 秒

// 港澳台地区的域名后缀。本产品面向中国大陆用户，政策与机构信息以大陆为准；
// 实测「心理咨询补贴政策」这类泛化查询很容易召回台中市、卫福部的内容，
// 原样转述既不合规也不适用，所以在来源层就挡掉。
const BLOCKED_SUFFIXES = [".tw", ".hk", ".mo"];
// 官方来源优先。搜索结果顺序不可控，把 .gov.cn 提到前面能显著降低「引错」的概率。
const PREFERRED_SUFFIXES = [".gov.cn", ".org.cn"];

interface SearchItem {
  title?: string;
  url?: string;
  link?: string;
  snippet?: string;
  content?: string;
}

function hostOf(item: SearchItem): string {
  const url = (item.url ?? item.link ?? "").trim();
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isBlocked(item: SearchItem): boolean {
  const host = hostOf(item);
  return !!host && BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function rank(item: SearchItem): number {
  return PREFERRED_SUFFIXES.some((suffix) => hostOf(item).endsWith(suffix)) ? 0 : 1;
}

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
      // 注意：不传 tag。见文件开头的说明。
      body: JSON.stringify({ query, max_results: maxResults, language: "zh" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("web_search HTTP", res.status, (await res.text()).slice(0, 200));
      return `联网搜索暂时不可用（HTTP ${res.status}）。请用本地知识库继续回答。`;
    }

    const data = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { results?: SearchItem[] };
      results?: SearchItem[];
    };

    if (data.code !== 0) {
      console.warn("web_search error", data.message);
      return `联网搜索返回错误：${data.message ?? "未知错误"}。请用本地知识库继续回答。`;
    }

    const results = data.data?.results ?? data.results ?? [];
    if (!results.length) return "联网没有找到相关结果。请用本地知识库继续回答。";

    const usable = results.filter((item) => !isBlocked(item)).sort((a, b) => rank(a) - rank(b));
    if (!usable.length) {
      return "联网没有找到适用于中国大陆的结果。请用本地知识库继续回答。";
    }

    const blocks: string[] = [];
    let total = 0;
    for (const item of usable) {
      const title = (item.title ?? "").trim();
      const url = (item.url ?? item.link ?? "").trim();
      const snippet = (item.snippet ?? item.content ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 220);
      if (!title && !snippet) continue;
      const block = `- ${title}\n  ${snippet}\n  ${url}`.trimEnd();
      if (total + block.length > MAX_OUTPUT_CHARS) break;
      blocks.push(block);
      total += block.length;
    }

    if (!blocks.length) return "联网没有找到相关结果。请用本地知识库继续回答。";

    return (
      "以下为网络搜索结果，**仅供参考，可能不准确**。" +
      "不要直接照搬其中的心理建议，只用于补充最新政策或本地机构信息：\n\n" +
      blocks.join("\n\n")
    );
  } catch (err) {
    const kind = err instanceof Error ? err.name : "Error";
    console.warn("web_search failed", kind);
    return `联网搜索暂时不可用（${kind}）。请用本地知识库继续回答，并说明无法核实最新信息。`;
  }
}
