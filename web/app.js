/* 心屿 · 前端逻辑
   Mercury 3 是块式流式（一次吐几十字），所以这里必须做补间，
   否则观感是"一顿一顿地跳"。补间速度 12ms/字，积压多时自动追赶。 */

(() => {
  "use strict";

  const thread = document.getElementById("thread");
  const messages = document.getElementById("messages");
  const welcome = document.getElementById("welcome");
  const form = document.getElementById("form");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const resetBtn = document.getElementById("resetBtn");
  const tplBot = document.getElementById("tpl-bot");
  const tplMe = document.getElementById("tpl-me");
  const tplCrisis = document.getElementById("tpl-crisis");

  const SESSION_KEY = "xinyu.session";
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }
  let busy = false;

  // ── 补间打字 ─────────────────────────────────────────────
  class Typer {
    constructor(el, speed = 12) {
      this.el = el;
      this.queue = "";
      this.timer = null;
      this.speed = speed;
    }
    push(text) {
      this.queue += text;
      if (!this.timer) this.timer = setInterval(() => this.tick(), this.speed);
    }
    tick() {
      if (!this.queue) {
        clearInterval(this.timer);
        this.timer = null;
        return;
      }
      // 积压越多，一次吐越多，避免落后于网络
      const n = Math.max(1, Math.ceil(this.queue.length / 10));
      this.el.textContent += this.queue.slice(0, n);
      this.queue = this.queue.slice(n);
      scrollToBottom();
    }
    flushNow() {
      if (this.queue) {
        this.el.textContent += this.queue;
        this.queue = "";
      }
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      scrollToBottom();
    }
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
  }

  function hideWelcome() {
    if (welcome && !welcome.classList.contains("hidden")) {
      welcome.classList.add("hidden");
    }
  }

  function addMe(text) {
    const node = tplMe.content.firstElementChild.cloneNode(true);
    node.querySelector(".chat-bubble").textContent = text;
    messages.appendChild(node);
    scrollToBottom();
  }

  function addBot() {
    const node = tplBot.content.firstElementChild.cloneNode(true);
    node.classList.add("streaming");
    messages.appendChild(node);
    scrollToBottom();
    return node;
  }

  function addToolPill(botNode, label) {
    let pill = botNode.querySelector(".tool");
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "tool";
      pill.innerHTML =
        '<span class="loading loading-dots loading-sm" aria-hidden="true"></span><span></span>';
      botNode.insertBefore(pill, botNode.firstChild);
    }
    pill.querySelector("span:last-child").textContent = label;
  }

  function clearToolPill(botNode) {
    const pill = botNode.querySelector(".tool");
    if (pill) pill.remove();
  }

  function addCrisisCard(botNode, data) {
    document.body.classList.add("crisis");
    const card = tplCrisis.content.firstElementChild.cloneNode(true);

    const primary = data.hotlines && data.hotlines[0];
    if (primary) {
      card.querySelector(".num").textContent = primary.number;
      card.querySelector(".lbl").textContent = `${primary.name} · ${primary.hours}`;
      card.querySelectorAll('a[href^="tel:"]').forEach((a) => {
        a.href = `tel:${primary.number.replace(/[^\d+]/g, "")}`;
      });
      card.querySelector(".solid-btn").textContent = `拨打 ${primary.number}`;
    }

    const planBox = card.querySelector(".plan");
    const planBtn = card.querySelector("[data-plan]");
    planBtn.addEventListener("click", () => {
      if (planBox.hidden) {
        const ol = document.createElement("ol");
        (data.plan || []).forEach((step) => {
          const li = document.createElement("li");
          li.textContent = step;
          ol.appendChild(li);
        });
        planBox.replaceChildren(ol);
        planBox.hidden = false;
        planBtn.textContent = "收起安全计划";
      } else {
        planBox.hidden = true;
        planBtn.textContent = "一起做个安全计划";
      }
      scrollToBottom();
    });

    botNode.appendChild(card);
    scrollToBottom();
  }

  // ── SSE ──────────────────────────────────────────────────
  function parseFrame(raw) {
    let event = "message";
    const dataLines = [];
    raw.split("\n").forEach((line) => {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    });
    if (!dataLines.length) return null;
    try {
      return { event, data: JSON.parse(dataLines.join("\n")) };
    } catch {
      return null;
    }
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    autoGrow();
    hideWelcome();
    addMe(text);

    const botNode = addBot();
    const textEl = botNode.querySelector(".text");
    const typer = new Typer(textEl);
    let gotCrisis = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = parseFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (!frame) continue;

          const { event, data } = frame;
          if (event === "meta") {
            if (data.crisis) document.body.classList.add("crisis");
          } else if (event === "crisis") {
            gotCrisis = true;
            addCrisisCard(botNode, data);
          } else if (event === "tool") {
            const label =
              data.name === "kb_search"
                ? "正在查阅资料…"
                : data.name === "web_search"
                ? "正在联网查证…"
                : data.name === "crisis_resources"
                ? "正在找可联系的人…"
                : "正在处理…";
            addToolPill(botNode, label);
          } else if (event === "token") {
            clearToolPill(botNode);
            typer.push(data.text || "");
          } else if (event === "error") {
            typer.push(data.message || "出了点问题，稍后再试。");
          }
        }
      }
    } catch (err) {
      typer.push("网络好像不太稳，刚才那条没发出去。要不要再试一次？");
      console.error(err);
    } finally {
      typer.flushNow();
      clearToolPill(botNode);
      botNode.classList.remove("streaming");
      if (gotCrisis) document.body.classList.add("crisis");
      busy = false;
      sendBtn.disabled = !input.value.trim();
      input.focus();
    }
  }

  // ── 输入 ─────────────────────────────────────────────────
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 132) + "px";
  }

  input.addEventListener("input", () => {
    autoGrow();
    sendBtn.disabled = busy || !input.value.trim();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });

  document.getElementById("chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    input.value = chip.textContent.trim();
    autoGrow();
    sendBtn.disabled = false;
    input.focus();
  });

  resetBtn.addEventListener("click", async () => {
    if (busy) return;
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      /* 重置失败不影响本地清屏 */
    }
    messages.replaceChildren();
    welcome.classList.remove("hidden");
    document.body.classList.remove("crisis");
    input.value = "";
    autoGrow();
    sendBtn.disabled = true;
    window.scrollTo({ top: 0 });
  });

  autoGrow();
})();
