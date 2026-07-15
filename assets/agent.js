// FinanceHermes research agent — frontend.
// Streams the trace from /api/agent (same-origin, satisfies connect-src 'self')
// and renders it step by step: thinking → tool call → tool result → answer.

(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("composer");
  const input = $("query");
  const askBtn = $("ask");
  const stopBtn = $("stop");
  const trace = $("trace");
  const runbar = $("runbar");
  const runbarText = $("runbar-text");
  const chips = document.querySelectorAll(".chips button");

  let controller = null;
  let timerId = 0;

  // ── tiny XSS-safe markdown renderer for the final answer ──────────────
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const safeHref = (url) => (/^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null);

  function inlineMd(s) {
    // input is already HTML-escaped
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => {
      const href = safeHref(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
    });
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    return s;
  }

  function renderMarkdown(md) {
    const lines = escapeHtml(md.replace(/\r\n/g, "\n")).split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let inCode = false;
    let code = [];
    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (inCode) {
          out.push(`<pre><code>${code.join("\n")}</code></pre>`);
          code = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(line);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const level = h[1].length;
        out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
        continue;
      }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? "ul" : "ol";
        if (list !== want) {
          closeList();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
        continue;
      }
      const bq = line.match(/^\s*&gt;\s?(.*)$/);
      if (bq) {
        closeList();
        out.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`);
        continue;
      }
      if (!line.trim()) {
        closeList();
        continue;
      }
      closeList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }
    if (inCode && code.length) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
    closeList();
    return out.join("\n");
  }

  // ── DOM helpers ────────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const nearBottom = () =>
    window.innerHeight + window.scrollY >= document.body.offsetHeight - 320;

  function autoScroll() {
    if (nearBottom()) window.scrollTo({ top: document.body.scrollHeight });
  }

  // ── run state ──────────────────────────────────────────────────────────
  const run = {
    reset() {
      this.step = null;
      this.thinkingEl = null;
      this.contentEl = null;
      this.toolEls = new Map();
      this.answerText = "";
      this.startedAt = Date.now();
      this.meta = "";
    },
  };

  function currentStep() {
    if (!run.step) newStep("");
    return run.step;
  }

  function newStep(label) {
    const card = el("section", "step");
    if (label) card.appendChild(el("p", "step-label", label));
    trace.appendChild(card);
    run.step = card;
    run.thinkingEl = null;
    run.contentEl = null;
    autoScroll();
    return card;
  }

  function setRunbar(state, text) {
    runbar.className = `runbar visible ${state}`;
    runbarText.textContent = text;
  }

  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      const s = ((Date.now() - run.startedAt) / 1000).toFixed(0);
      setRunbar("running", `${run.meta} · working ${s}s`);
    }, 1000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = 0;
  }

  function setBusy(busy) {
    askBtn.disabled = busy;
    input.disabled = busy;
    chips.forEach((c) => (c.disabled = busy));
    stopBtn.classList.toggle("visible", busy);
  }

  // ── event handlers per SSE event type ─────────────────────────────────
  function handleEvent(ev) {
    switch (ev.type) {
      case "init": {
        run.meta = `${ev.model} · ${ev.provider}${ev.search === "tavily" ? " · live web search" : " · no web search"}`;
        setRunbar("running", `${run.meta} · working`);
        break;
      }
      case "status": {
        currentStep().appendChild(el("p", "notice", ev.message));
        autoScroll();
        break;
      }
      case "step_start": {
        newStep(`Step ${ev.n}`);
        break;
      }
      case "thinking_delta": {
        const step = currentStep();
        if (!run.thinkingEl) {
          const wrap = el("div", "thinking");
          wrap.appendChild(el("span", "thinking-label", "🧠 model thinking"));
          run.thinkingEl = el("span");
          wrap.appendChild(run.thinkingEl);
          step.appendChild(wrap);
        }
        run.thinkingEl.textContent += ev.text;
        run.thinkingEl.parentElement.scrollTop = run.thinkingEl.parentElement.scrollHeight;
        autoScroll();
        break;
      }
      case "content_delta": {
        const step = currentStep();
        if (!run.contentEl) {
          run.contentEl = el("div", "model-text");
          step.appendChild(run.contentEl);
        }
        run.contentEl.textContent += ev.text;
        autoScroll();
        break;
      }
      case "turn_end": {
        // Content elements reset per turn; final promotion happens on "done".
        run.thinkingEl = null;
        if (!ev.had_tool_calls && run.contentEl) run.answerEl = run.contentEl;
        run.contentEl = null;
        break;
      }
      case "tool_call": {
        const step = currentStep();
        const box = el("div", "tool");
        const head = el("div", "tool-head");
        const spin = el("span", "spin");
        head.appendChild(spin);
        const argText =
          ev.name === "web_search"
            ? `“${ev.args?.query || ""}”`
            : Array.isArray(ev.args?.urls)
              ? ev.args.urls.join("  ")
              : JSON.stringify(ev.args || {});
        head.appendChild(el("span", "", `${ev.emoji || "🛠"} ${ev.name}`));
        head.appendChild(el("span", "argtext", argText));
        box.appendChild(head);
        step.appendChild(box);
        run.toolEls.set(ev.id, box);
        autoScroll();
        break;
      }
      case "tool_result": {
        const box = run.toolEls.get(ev.id);
        if (!box) break;
        box.querySelector(".spin")?.remove();
        if (ev.ok === false) box.classList.add("failed");
        box.appendChild(el("div", "tool-summary", ev.ok === false ? `failed — ${ev.summary}` : ev.summary));
        if (Array.isArray(ev.items) && ev.items.length) {
          const list = el("ul", "results");
          for (const item of ev.items.slice(0, 6)) {
            const li = el("li");
            const href = safeHref(item.url || "");
            if (href) {
              const host = el("span", "host");
              try {
                host.textContent = new URL(href).hostname.replace(/^www\./, "");
              } catch {
                host.textContent = "";
              }
              li.appendChild(host);
              const a = el("a", "", item.title || href);
              a.href = href;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              li.appendChild(a);
            } else {
              li.appendChild(el("span", "", item.title || ""));
            }
            if (item.snippet) li.appendChild(el("span", "snippet", item.snippet));
            list.appendChild(li);
          }
          box.appendChild(list);
        }
        autoScroll();
        break;
      }
      case "done": {
        stopTimer();
        const secs = (ev.elapsed_ms / 1000).toFixed(1);
        setRunbar("done", `${run.meta} · answered in ${secs}s · ${ev.steps} step${ev.steps === 1 ? "" : "s"}`);
        // Promote the final content into a highlighted answer card.
        const card = el("section", "step answer");
        card.appendChild(el("p", "step-label", "✦ Answer"));
        const body = el("div", "answer-body");
        body.innerHTML = renderMarkdown(ev.answer || "(no answer produced)");
        card.appendChild(body);
        if (run.answerEl) {
          // Replace the streamed plain text; drop its step card too if the
          // promotion leaves nothing but the "Step n" label behind.
          const host = run.answerEl.closest(".step");
          run.answerEl.remove();
          if (host && !host.querySelector(".thinking, .model-text, .tool, .notice")) host.remove();
        }
        trace.appendChild(card);
        autoScroll();
        break;
      }
      case "error": {
        stopTimer();
        setRunbar("error", "run failed");
        const card = el("section", "errorcard");
        card.appendChild(el("p", "step-label", "Something went wrong"));
        card.appendChild(el("p", "", ev.message || "Unknown error."));
        if (ev.hint) card.appendChild(el("p", "hint", ev.hint));
        trace.appendChild(card);
        autoScroll();
        break;
      }
    }
  }

  // ── SSE-over-fetch client ──────────────────────────────────────────────
  async function ask(query) {
    run.reset();
    run.answerEl = null;
    trace.replaceChildren();
    const q = el("section", "step user-turn");
    q.appendChild(el("p", "step-label", "Query"));
    q.appendChild(el("p", "q", query));
    trace.appendChild(q);

    setBusy(true);
    setRunbar("running", "connecting…");
    startTimer();
    controller = new AbortController();

    try {
      const resp = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      if (!resp.ok || !(resp.headers.get("content-type") || "").includes("text/event-stream")) {
        let msg = `The agent endpoint returned HTTP ${resp.status}.`;
        try {
          const j = await resp.json();
          if (j && j.error) msg = j.error;
        } catch { /* keep default */ }
        handleEvent({ type: "error", message: msg });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              handleEvent(JSON.parse(line.slice(5).trim()));
            } catch { /* ignore malformed frame */ }
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        stopTimer();
        setRunbar("done", "stopped");
      } else {
        handleEvent({
          type: "error",
          message: "Could not reach the agent endpoint. Are you online, and is the deployment healthy?",
        });
      }
    } finally {
      stopTimer();
      setBusy(false);
      controller = null;
      if (runbar.classList.contains("running")) setRunbar("done", `${run.meta || "run"} · finished`);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q && !askBtn.disabled) ask(q);
  });

  stopBtn.addEventListener("click", () => controller?.abort());

  chips.forEach((chip) =>
    chip.addEventListener("click", () => {
      input.value = chip.dataset.q || chip.textContent;
      form.requestSubmit();
    })
  );
})();
