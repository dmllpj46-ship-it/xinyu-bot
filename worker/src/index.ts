/**
 * Cloudflare Worker 入口：静态资源 + POST /api/chat（SSE）。
 *
 * SSE 帧格式（与 web/app.js 对齐，改这里要同步改那边）：
 *   event: meta   data: {"level":0,"crisis":false}
 *   event: crisis data: {"hotlines":[...],"plan":[...]}
 *   event: tool   data: {"name":"kb_search"}
 *   event: token  data: {"text":"..."}
 *   event: done   data: {"tools":[...],"guardHits":[...]}
 *   event: error  data: {"message":"..."}
 *
 * `meta` 里曾经有 `mode`（chat/kb/web），2026-10-26 删掉轮次路由后没有了——
 * 前端也不再靠它预判「要不要先挂个正在检索的胶囊」，等真正的 `tool` 帧到了再说。
 *
 * 会话是无状态的：历史由浏览器带上来（history 字段）。
 * 这样既不需要 Durable Object / KV，也不会在服务端留下任何对话记录。
 */

import type { AgentInputItem } from "@openai/agents";
import {
  MAX_TURNS,
  REFUSAL_TEXT,
  buildAgent,
  buildRunner,
  isRefusal,
  type Env,
  type HistoryTurn,
} from "./agent";
import { assess } from "./safety/inputGuard";
import { StreamScrubber } from "./safety/outputGuard";
import { scriptChunks } from "./safety/crisisScript";
import { HOTLINES, SAFETY_PLAN_STEPS } from "./tools/crisis";

const MAX_HISTORY_TURNS = 10;
const MAX_TURN_CHARS = 800;

interface ChatBody {
  message?: string;
  history?: HistoryTurn[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function cleanHistory(history: HistoryTurn[] | undefined): HistoryTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (h) =>
        h &&
        (h.role === "user" || h.role === "assistant") &&
        typeof h.content === "string" &&
        h.content.trim().length > 0,
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((h) => ({ role: h.role, content: h.content.slice(0, MAX_TURN_CHARS) }));
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }

  const message = (body.message ?? "").trim();
  if (!message) return json({ error: "message 不能为空" }, 400);
  if (message.length > 2000) return json({ error: "message 过长（上限 2000 字）" }, 400);

  const decision = assess(message);
  const history = cleanHistory(body.history);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("meta", { level: decision.level, crisis: decision.level >= 2 });
      if (decision.showCard) {
        send("crisis", { hotlines: HOTLINES, plan: SAFETY_PLAN_STEPS });
      }

      // L2/L3 不调模型：Mercury 的 API 审核会拒答这类内容，且危机回复本就不该被生成
      if (decision.level >= 2) {
        for (const chunk of scriptChunks(decision)) send("token", { text: chunk });
        send("done", { tools: [], guardHits: [], crisis: true, scripted: true });
        controller.close();
        return;
      }

      // 跨轮去重：把上一轮回复喂给护栏，避免两段相邻气泡说同一句话
      const previous = [...history].reverse().find((h) => h.role === "assistant")?.content ?? "";
      const scrubber = new StreamScrubber(previous);
      const toolsUsed: string[] = [];

      try {
        const runner = buildRunner(env);
        const agent = buildAgent(env, decision);
        const input: AgentInputItem[] = history.map((h) =>
          h.role === "user"
            ? { role: "user" as const, content: h.content }
            : {
                role: "assistant" as const,
                status: "completed" as const,
                content: [{ type: "output_text" as const, text: h.content }],
              },
        );
        input.push({ role: "user", content: message });

        const result = await runner.run(agent, input, {
          stream: true,
          maxTurns: MAX_TURNS,
        });

        for await (const event of result) {
          const ev = event as unknown as {
            type: string;
            name?: string;
            data?: { type?: string; delta?: string };
            item?: { name?: string; rawItem?: { name?: string } };
          };

          if (ev.type === "raw_model_stream_event") {
            if (ev.data?.type === "output_text_delta" && typeof ev.data.delta === "string") {
              const safe = scrubber.feed(ev.data.delta);
              if (safe) send("token", { text: safe });
            }
          } else if (ev.type === "run_item_stream_event" && ev.name === "tool_called") {
            const name = ev.item?.name ?? ev.item?.rawItem?.name ?? "";
            if (name) {
              toolsUsed.push(name);
              send("tool", { name });
            }
          }
        }

        await result.completed;

        const tail = scrubber.flush();
        if (tail) send("token", { text: tail });

        send("done", {
          tools: toolsUsed,
          guardHits: [...new Set(scrubber.violations)],
          crisis: false,
        });
      } catch (err) {
        if (isRefusal(err)) {
          // 模型侧审核拒答。不能把英文拒绝语原样丢给用户。
          send("token", { text: REFUSAL_TEXT });
          send("done", { tools: toolsUsed, guardHits: ["model_refusal"], crisis: false });
        } else {
          console.error("agent run failed", err);
          const kind = err instanceof Error ? err.name : "Error";
          send("error", { message: `模型暂时没响应（${kind}）。稍等一下再发一次。` });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      return json({
        ok: true,
        model: env.MERCURY_MODEL ?? "mercury-3",
        runtime: "cloudflare-worker",
        kbReady: true,
      });
    }

    if (pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "只接受 POST" }, 405);
      return handleChat(request, env);
    }

    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    return env.ASSETS.fetch(request);
  },
};
