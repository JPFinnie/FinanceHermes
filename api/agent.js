// api/agent.js — Hermes financial-research agent loop (Vercel Node serverless function).
//
// Ported from the reference implementation in JPFinnie/Neo (fork of
// NousResearch/hermes-agent):
//   * OpenAI-compatible chat-completions wire format with function calling
//     (tools -> assistant tool_calls -> role:"tool" results), as used by
//     agent/chat_completion_helpers.py and tools/registry.py.
//   * web_search / web_extract tool schemas copied from tools/web_tools.py
//     (WEB_SEARCH_SCHEMA / WEB_EXTRACT_SCHEMA), Tavily backend from
//     plugins/web/tavily/provider.py (TAVILY_API_KEY, api.tavily.com,
//     TAVILY_BASE_URL override).
//   * Reasoning extraction: structured `reasoning`/`reasoning_content`
//     deltas plus inline <think>…</think> blocks, mirroring
//     chat_completion_helpers.py.
//   * Inline <tool_call>{json}</tool_call> fallback parsing for Hermes'
//     native function-calling format (agent_runtime_helpers.py).
//
// Providers (checked in order; all OpenAI-compatible):
//   1. HERMES_BASE_URL + HERMES_API_KEY  — any custom endpoint (also used by dev mocks)
//   2. NOUS_API_KEY                      — Nous Portal inference API
//   3. OPENROUTER_API_KEY                — OpenRouter
//
// The response is a same-origin Server-Sent-Events stream of trace events:
//   init, status, step_start, thinking_delta, content_delta, tool_call,
//   tool_result, turn_end, done, error.
// No secrets ever reach the client; keys are read from Vercel env vars only.
//
// Two chat modes (POST body {"query": "...", "mode": "research" | "learn"}):
//   * research — Tier 1 (premium): the full live web-research loop above, plus
//     learn_lookup over the CIBC Investor's Edge Learn library for "Learn
//     more" links.
//   * learn    — Tier 2 (freemium): an educational chatbot grounded in the
//     CIBC Investor's Edge Learn library (api/learn-library.js + the locally
//     cached article bodies in api/learn-content.js). No web tools at all —
//     learn_lookup finds articles and learn_read serves their full text, so
//     the tier runs keyless and never leaves the function.
// If PREMIUM_ACCESS_CODE is set, research mode additionally requires a
// matching "access_code" in the body — the hook where a real Tier 1
// entitlement check (auth/subscription) belongs. Unset = both modes open.

import {
  LEARN_LOOKUP_SCHEMA,
  LEARN_READ_SCHEMA,
  runLearnLookup,
  runLearnRead,
  searchLearnLibrary,
  repairLearnLinks,
} from "./learn-library.js";

const NOUS_BASE_URL = "https://inference-api.nousresearch.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const NOUS_DEFAULT_MODEL = "nousresearch/hermes-4-405b";
const OPENROUTER_DEFAULT_MODEL = "nousresearch/hermes-4-405b";
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";

const MODES = {
  research: { tier: 1, maxSteps: 6 },
  // Learn mode is the freemium tier: shorter loop, library-grounded.
  learn: { tier: 2, maxSteps: 4 },
};
// Worst case adds one ~8s wrap-up model call after the deadline check, so
// keep this comfortably under the 60s function cap.
const RUN_DEADLINE_MS = 50_000;
const MODEL_CALL_TIMEOUT_MS = 35_000;
const TOOL_CALL_TIMEOUT_MS = 15_000;
const MAX_QUERY_CHARS = 2_000;
const MAX_TOKENS = 4_096;
const TEMPERATURE = 0.4;

// Hermes 4 deep-thinking directive (model card); opt-in because long
// chains of thought can be slow for a live meeting demo.
const HERMES_REASONING_DIRECTIVE =
  "You are a deep thinking AI, you may use extremely long chains of thought " +
  "to deeply consider the problem and deliberate with yourself via systematic " +
  "reasoning processes to help come to a correct solution prior to answering. " +
  "You should enclose your thoughts and internal monologue inside <think> " +
  "</think> tags, and then provide your solution or response to the problem.";

// Tool schemas — verbatim from Neo tools/web_tools.py.
const WEB_SEARCH_SCHEMA = {
  name: "web_search",
  description:
    "Search the web for information. Returns up to 5 results by default with titles, URLs, and descriptions. " +
    "The query is passed through to the configured backend, so operators such as site:domain, filetype:pdf, " +
    'intitle:word, -term, and "exact phrase" may work when the backend supports them.',
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query to look up on the web. You may include backend-supported operators such as " +
          'site:example.com, filetype:pdf, intitle:word, -term, or "exact phrase".',
      },
      limit: {
        type: "integer",
        description: "Maximum number of results to return. Defaults to 5.",
        minimum: 1,
        maximum: 100,
        default: 5,
      },
    },
    required: ["query"],
  },
};

const WEB_EXTRACT_SCHEMA = {
  name: "web_extract",
  description:
    "Extract content from web page URLs. Returns page content in markdown format. Also works with PDF URLs " +
    "(arxiv papers, documents, etc.) — pass the PDF link directly and it converts to markdown text. " +
    "If a URL fails or times out, fall back to your search results instead.",
  parameters: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "List of URLs to extract content from (max 5 URLs per call)",
        maxItems: 5,
      },
    },
    required: ["urls"],
  },
};

const TOOL_EMOJI = { web_search: "🔍", web_extract: "📄", learn_lookup: "🎓", learn_read: "📖" };

function resolveProvider(env) {
  if (env.HERMES_BASE_URL && env.HERMES_API_KEY) {
    return {
      name: "custom",
      baseUrl: env.HERMES_BASE_URL.replace(/\/+$/, ""),
      apiKey: env.HERMES_API_KEY,
      model: env.HERMES_MODEL || NOUS_DEFAULT_MODEL,
      headers: {},
    };
  }
  if (env.NOUS_API_KEY) {
    return {
      name: "nous",
      baseUrl: NOUS_BASE_URL,
      apiKey: env.NOUS_API_KEY,
      model: env.HERMES_MODEL || NOUS_DEFAULT_MODEL,
      headers: {},
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY,
      model: env.HERMES_MODEL || OPENROUTER_DEFAULT_MODEL,
      headers: {
        "HTTP-Referer": env.SITE_URL || "https://github.com/JPFinnie/FinanceHermes",
        "X-Title": "FinanceHermes Research Agent",
      },
    };
  }
  return null;
}

function buildSystemPrompt(env, searchEnabled, mode, query) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [];
  if (env.HERMES_REASONING === "1") parts.push(HERMES_REASONING_DIRECTIVE);

  if (mode === "learn") {
    parts.push(
      "You are Hermes Learn, a friendly investing educator built on Hermes by Nous Research, running in the " +
        "Learn chatbot (Tier 2, free tier). You teach self-directed investors — many of them beginners — how " +
        "investing works: products (stocks, ETFs, mutual funds, bonds, GICs, options, structured notes), " +
        "registered accounts (TFSA, RRSP, RRIF, RESP, FHSA), portfolio strategies, risk management, and the " +
        "Investor's Edge platform. Explain in plain, encouraging language, define jargon on first use, and " +
        "use short concrete examples with simple numbers where they help."
    );
    parts.push(
      "Your grounding source is the official CIBC Investor's Edge Learn library, available locally through " +
        "two tools. For each question: call learn_lookup first to find the relevant CIBC pages, then call " +
        "learn_read on the best 1-2 URLs to get the articles' full text. Base your answer on that actual " +
        "article content — summarize and teach from it, include its key specifics (definitions, numbers, " +
        "rules, examples), and quote short passages where CIBC's wording matters, always attributing the " +
        'material to CIBC Investor\'s Edge. End with a "Keep learning" section linking 1-3 of the pages you ' +
        "used. If the library has no relevant page, say so and give a careful general-knowledge explanation " +
        "instead."
    );
    parts.push(
      "Linking rules: write links as markdown [title](url) using the exact canonical URLs the tools return — " +
        "always absolute https://www.investorsedge.cibc.com/... addresses. Never write a URL from memory: " +
        "every link must be copied verbatim from a tool result in this conversation. Never invent, shorten, " +
        "or use relative URLs like /en/learn/…, and never link pages the tools did not return."
    );
    // Seed the conversation with the library's top matches so grounding never
    // depends on the model choosing to call tools, and the only URLs in
    // context are real ones.
    const seeds = searchLearnLibrary(query, 5);
    if (seeds.length) {
      parts.push(
        "To save you a step, learn_lookup has already been run on the user's question. Top matches:\n" +
          seeds.map((s) => `- ${s.title} [${s.category}] — ${s.url}\n  ${s.summary}`).join("\n") +
          "\nStart by calling learn_read on the most relevant of these URLs; run learn_lookup again only " +
          "for different angles."
      );
    }
    parts.push(
      "Stay educational. Do not give personalized investment advice or buy/sell recommendations, and do not " +
        "quote live prices or claim current market data — Learn mode has no live market tools. If the user " +
        "asks for live research (what moved a stock today, analyst sentiment, breaking macro news), briefly " +
        "note that Research mode (Tier 1, premium) does live web research with citations, then teach the " +
        "underlying concept as far as the library allows. Today's date is " + today + "."
    );
    return parts.join("\n\n");
  }

  // Identity adapted from Neo agent/prompt_builder.py DEFAULT_AGENT_IDENTITY.
  parts.push(
    "You are Hermes Research, an intelligent financial-research assistant built on Hermes by Nous Research, " +
      "running in Research mode (Tier 1, premium). " +
      "You are helpful, knowledgeable, and direct. You assist investment professionals with market research: " +
      "what moved a stock and why, earnings and filings, analyst sentiment, macro and central-bank commentary, " +
      "and sector developments. You communicate clearly, admit uncertainty when appropriate, and prioritize " +
      "being genuinely useful over being verbose. Be targeted and efficient in your research."
  );
  if (searchEnabled) {
    parts.push(
      "You have live web tools. Use web_search to find current information — market moves, news, filings, " +
        "commentary — and web_extract to read the most promising pages in depth when search snippets are not " +
        "enough. Prefer recent, reputable financial sources (exchange/company IR pages, regulatory filings, " +
        "Reuters, Bloomberg, FT, WSJ, central banks). You may call tools multiple times across turns, but keep " +
        "the investigation tight: usually 1-3 searches suffice. Today's date is " +
        today +
        " — for anything time-sensitive (prices, moves, ratings, rates), search rather than relying on memory."
    );
  } else {
    parts.push(
      "Live web search is not configured in this deployment, so answer from your knowledge and clearly flag " +
        "that figures may be out of date. Today's date is " + today + "."
    );
  }
  parts.push(
    "You also have the CIBC Investor's Edge Learn library (~100 educational articles, courses and guides) " +
      "through two local tools: learn_lookup (search the index) and learn_read (full article text). When " +
      "your answer leans on a concept the library explains — margin, options strategies, covered call ETFs, " +
      "registered accounts like TFSAs and RRSPs, dollar-cost averaging, tax-loss selling and so on — look it " +
      "up, draw on the article content, and close with a short \"Learn more\" section of 1-3 relevant CIBC " +
      "Learn links (exact URLs as returned by the tools, never relative paths). Live research stays primary; " +
      "the library supplements it."
  );
  parts.push(
    "When you have what you need, produce a clear, well-structured final answer in markdown: a one-paragraph " +
      "takeaway first, then short sections or bullets with specifics (numbers, dates, who said what). Cite web " +
      "sources inline as [n] markdown links and finish with a short Sources list. You are a research tool, not " +
      "an investment adviser: present facts and attributed views, note material uncertainty, and do not give " +
      "personalized investment advice."
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// SSE plumbing (our response to the browser)
// ---------------------------------------------------------------------------

function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function makeSender(res) {
  return (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

// ---------------------------------------------------------------------------
// Incremental <think>…</think> splitter (Hermes emits reasoning inline when
// no structured reasoning field is provided — see Neo chat_completion_helpers).
// ---------------------------------------------------------------------------

class ThinkSplitter {
  constructor() {
    this.inside = false;
    this.buf = "";
  }
  // Feed a content delta; returns { think, content } text extracted so far.
  feed(chunk) {
    this.buf += chunk;
    let think = "";
    let content = "";
    for (;;) {
      const tag = this.inside ? "</think>" : "<think>";
      const idx = this.buf.indexOf(tag);
      if (idx !== -1) {
        const before = this.buf.slice(0, idx);
        if (this.inside) think += before;
        else content += before;
        this.buf = this.buf.slice(idx + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // Hold back any suffix that could be the start of the tag we seek.
      let hold = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (this.buf.endsWith(tag.slice(0, k))) {
          hold = k;
          break;
        }
      }
      const emit = this.buf.slice(0, this.buf.length - hold);
      if (this.inside) think += emit;
      else content += emit;
      this.buf = this.buf.slice(this.buf.length - hold);
      break;
    }
    return { think, content };
  }
  flush() {
    const rest = this.buf;
    this.buf = "";
    if (!rest) return { think: "", content: "" };
    return this.inside ? { think: rest, content: "" } : { think: "", content: rest };
  }
}

// ---------------------------------------------------------------------------
// Provider call: one model turn, streamed. Returns assembled turn.
// ---------------------------------------------------------------------------

async function chatTurn(provider, messages, tools, send, signal) {
  const body = {
    model: provider.model,
    messages,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: true,
  };
  if (tools && tools.length) {
    body.tools = tools.map((schema) => ({ type: "function", function: schema }));
    body.tool_choice = "auto";
  }

  const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const detail = sanitizeProviderError(await safeText(resp));
    throw new ProviderError(resp.status, detail);
  }

  const splitter = new ThinkSplitter();
  let content = "";
  let reasoning = "";
  const toolCalls = []; // assembled by index
  let finishReason = null;

  const emitThink = (t) => {
    if (!t) return;
    reasoning += t;
    send({ type: "thinking_delta", text: t });
  };
  const emitContent = (t) => {
    if (!t) return;
    content += t;
    send({ type: "content_delta", text: t });
  };

  const ctype = resp.headers.get("content-type") || "";
  if (ctype.includes("text/event-stream")) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        // Structured reasoning deltas (OpenRouter `reasoning`, Nous-style
        // `reasoning_content`) take priority; inline <think> handled below.
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === "string" && r) emitThink(r);
        if (typeof delta.content === "string" && delta.content) {
          const parts = splitter.feed(delta.content);
          emitThink(parts.think);
          emitContent(parts.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = Number.isInteger(tc.index) ? tc.index : 0;
            if (!toolCalls[i]) toolCalls[i] = { id: tc.id || "", name: "", args: "" };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].name += tc.function.name;
            if (typeof tc.function?.arguments === "string") toolCalls[i].args += tc.function.arguments;
            else if (tc.function?.arguments && typeof tc.function.arguments === "object")
              toolCalls[i].args += JSON.stringify(tc.function.arguments);
          }
        }
      }
    }
  } else {
    // Non-streaming fallback (some OpenAI-compatible servers reject stream:true).
    const json = JSON.parse(await resp.text());
    const msg = json.choices?.[0]?.message || {};
    finishReason = json.choices?.[0]?.finish_reason || null;
    const r = msg.reasoning_content ?? msg.reasoning;
    if (typeof r === "string") emitThink(r);
    if (typeof msg.content === "string" && msg.content) {
      const parts = splitter.feed(msg.content);
      emitThink(parts.think);
      emitContent(parts.content);
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        toolCalls.push({
          id: tc.id || "",
          name: tc.function?.name || "",
          args: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
        });
      }
    }
  }

  const tail = splitter.flush();
  emitThink(tail.think);
  emitContent(tail.content);

  // Hermes-native fallback: inline <tool_call>{json}</tool_call> in content
  // when the provider did not surface structured tool calls (Neo
  // agent_runtime_helpers.py). Strip the blocks from the visible content.
  let cleanContent = content;
  if (!toolCalls.length) {
    const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed && typeof parsed.name === "string") {
          toolCalls.push({
            id: "",
            name: parsed.name,
            args: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}),
          });
        }
      } catch {
        // Unparseable inline block: leave it in the text.
      }
    }
    if (toolCalls.length) cleanContent = content.replace(re, "").trim();
  }

  return {
    content: cleanContent,
    reasoning,
    toolCalls: toolCalls.filter((t) => t && t.name),
    finishReason,
  };
}

class ProviderError extends Error {
  constructor(status, detail) {
    super(`provider ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 400);
  } catch {
    return "";
  }
}

function sanitizeProviderError(text) {
  // Never echo anything that looks like a key; keep it short and readable.
  return String(text || "")
    .replace(/(sk-|Bearer\s+)[\w.-]+/gi, "$1***")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function friendlyProviderMessage(err, provider) {
  const where = provider.name === "nous" ? "Nous Portal" : provider.name === "openrouter" ? "OpenRouter" : "the model endpoint";
  if (err.name === "AbortError" || err.name === "TimeoutError")
    return `${where} took too long to respond. Try again — live models occasionally have slow moments.`;
  if (err instanceof ProviderError) {
    if (err.status === 401 || err.status === 403)
      return `${where} rejected the API key. Check the key in the Vercel project's environment variables.`;
    if (err.status === 402) return `${where} reports insufficient credits on this API key.`;
    if (err.status === 404)
      return `${where} could not find the model "${provider.model}". Check HERMES_MODEL.${err.detail ? ` (${err.detail})` : ""}`;
    if (err.status === 429) return `${where} is rate-limiting right now. Give it a few seconds and try again.`;
    return `${where} returned an error (HTTP ${err.status}). ${err.detail || ""}`.trim();
  }
  return `Could not reach ${where}: ${err.message || "network error"}.`;
}

// ---------------------------------------------------------------------------
// Web tools — Tavily backend, shapes per Neo plugins/web/tavily/provider.py
// ---------------------------------------------------------------------------

async function tavilyRequest(env, endpoint, payload, signal) {
  const base = (env.TAVILY_BASE_URL || TAVILY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const resp = await fetch(`${base}/${endpoint.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, api_key: env.TAVILY_API_KEY }),
    signal,
  });
  if (!resp.ok) throw new Error(`Tavily ${endpoint} failed (HTTP ${resp.status})`);
  return resp.json();
}

const clip = (s, n) => {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
};

async function runWebSearch(env, args, signal) {
  const query = String(args.query || "").slice(0, 400);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 8);
  if (!query) return { forModel: "Error: empty search query.", display: { ok: false, summary: "empty query" } };
  const json = await tavilyRequest(env, "search", { query, max_results: limit }, signal);
  const results = (json.results || []).map((r, i) => ({
    position: i + 1,
    title: clip(r.title, 160) || r.url,
    url: r.url || "",
    snippet: clip(r.content, 1200),
  }));
  const forModel = results.length
    ? `Search results for "${query}":\n\n` +
      results.map((r) => `${r.position}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")
    : `No results found for "${query}".`;
  return {
    forModel: clip(forModel, 6000),
    display: { ok: true, summary: `${results.length} result${results.length === 1 ? "" : "s"}`, items: results.map(({ title, url, snippet }) => ({ title, url, snippet: clip(snippet, 220) })) },
  };
}

async function runWebExtract(env, args, signal) {
  const urls = (Array.isArray(args.urls) ? args.urls : []).filter((u) => /^https?:\/\//i.test(String(u))).slice(0, 3);
  if (!urls.length) return { forModel: "Error: no valid http(s) URLs given.", display: { ok: false, summary: "no valid URLs" } };
  const json = await tavilyRequest(env, "extract", { urls }, signal);
  const docs = (json.results || []).map((r) => ({
    url: r.url,
    content: clip(r.raw_content || r.content, 4000),
  }));
  const failed = (json.failed_results || []).map((f) => f.url);
  let forModel = docs.map((d) => `## ${d.url}\n\n${d.content}`).join("\n\n---\n\n") || "No content could be extracted.";
  if (failed.length) forModel += `\n\n(Extraction failed for: ${failed.join(", ")})`;
  return {
    forModel: clip(forModel, 9000),
    display: {
      ok: docs.length > 0,
      summary: `${docs.length} page${docs.length === 1 ? "" : "s"} extracted${failed.length ? `, ${failed.length} failed` : ""}`,
      items: docs.map((d) => ({ title: d.url, url: d.url, snippet: clip(d.content, 220) })),
    },
  };
}

async function execTool(env, name, args, signal, mode, searchEnabled) {
  // The library tools are local (api/learn-library.js) — no keys, no network.
  if (name === "learn_lookup") return runLearnLookup(args);
  if (name === "learn_read") return runLearnRead(args);
  if (mode === "learn") {
    // Freemium tier: no web tools, even if the model hallucinates a call.
    return {
      forModel: `Error: ${name} is not available in Learn mode. Use learn_lookup and learn_read instead.`,
      display: { ok: false, summary: "not available in Learn mode" },
    };
  }
  if (!searchEnabled) {
    return { forModel: "Error: web tools are not configured.", display: { ok: false, summary: "tools disabled" } };
  }
  if (name === "web_search") return runWebSearch(env, args, signal);
  if (name === "web_extract") return runWebExtract(env, args, signal);
  return { forModel: `Error: unknown tool "${name}".`, display: { ok: false, summary: "unknown tool" } };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    return req.body; // Vercel parses JSON bodies for Node functions
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function timeoutSignal(parent, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), ms);
  const onAbort = () => ctl.abort(parent.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", onAbort);
    },
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ error: "Use POST with a JSON body: {\"query\": \"...\"}" }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request body too large." }));
    return;
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > MAX_QUERY_CHARS) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Provide a non-empty "query" up to ${MAX_QUERY_CHARS} characters.` }));
    return;
  }
  const requestedMode = body.mode === undefined ? "research" : String(body.mode);
  if (!MODES[requestedMode]) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unknown "mode" — use ${Object.keys(MODES).map((m) => `"${m}"`).join(" or ")}.` }));
    return;
  }

  const env = process.env;
  const provider = resolveProvider(env);

  // Tier gate: research is the Tier 1 (premium) mode. When PREMIUM_ACCESS_CODE
  // is set, a research request must present it or it is served in Learn mode
  // (Tier 2, freemium) instead. This is where a real subscription/entitlement
  // check plugs in; with the variable unset (demo default), both modes are open.
  let mode = requestedMode;
  let downgraded = false;
  if (mode === "research" && env.PREMIUM_ACCESS_CODE) {
    const code = typeof body.access_code === "string" ? body.access_code : "";
    if (code !== env.PREMIUM_ACCESS_CODE) {
      mode = "learn";
      downgraded = true;
    }
  }
  const maxSteps = MODES[mode].maxSteps;

  sseStart(res);
  const send = makeSender(res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 12_000);

  const master = new AbortController();
  req.on("close", () => master.abort(new Error("client disconnected")));

  const finish = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };

  if (!provider) {
    send({
      type: "error",
      message:
        "No model API key is configured. Add NOUS_API_KEY (Nous Portal) or OPENROUTER_API_KEY " +
        "to this Vercel project's environment variables and redeploy.",
      hint: "See .env.example in the repo for all supported variables.",
    });
    finish();
    return;
  }

  const searchEnabled = Boolean(env.TAVILY_API_KEY);
  // The library tools work in both modes and need no keys (local index +
  // cached article bodies); only the web tools depend on Tavily. Learn mode
  // is library-only, so the freemium tier runs fully keyless.
  const tools =
    mode === "learn"
      ? [LEARN_LOOKUP_SCHEMA, LEARN_READ_SCHEMA]
      : [...(searchEnabled ? [WEB_SEARCH_SCHEMA, WEB_EXTRACT_SCHEMA] : []), LEARN_LOOKUP_SCHEMA, LEARN_READ_SCHEMA];

  send({
    type: "init",
    mode,
    tier: MODES[mode].tier,
    model: provider.model,
    provider: provider.name,
    search: searchEnabled ? "tavily" : "disabled",
    max_steps: maxSteps,
  });
  if (downgraded) {
    send({
      type: "status",
      message:
        "Research mode is a Tier 1 (premium) feature and this request had no valid access code — answering " +
        "in Learn mode (Tier 2, free) instead, grounded in the CIBC Investor's Edge Learn library.",
    });
  }
  if (!searchEnabled && mode !== "learn") {
    // Learn mode is unaffected: its tools are local and keyless.
    send({
      type: "status",
      message:
        "TAVILY_API_KEY is not set — running model-only (no live web search). Answers may not reflect today's data.",
    });
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(env, searchEnabled, mode, query) },
    { role: "user", content: query },
  ];

  const startedAt = Date.now();
  const deadline = startedAt + RUN_DEADLINE_MS;
  let finalAnswer = "";
  let steps = 0;

  try {
    for (let step = 1; step <= maxSteps; step++) {
      steps = step;
      const remaining = deadline - Date.now();
      if (remaining < 4_000) {
        send({
          type: "status",
          message: "Time limit reached — asking the model to wrap up with what it has.",
        });
        messages.push({
          role: "user",
          content:
            "Time is up. Stop researching and give your best final answer now from what you have gathered, with citations.",
        });
      }
      send({ type: "step_start", n: step });

      const t = timeoutSignal(master.signal, Math.min(MODEL_CALL_TIMEOUT_MS, Math.max(remaining, 8_000)));
      let turn;
      try {
        turn = await chatTurn(provider, messages, remaining < 4_000 ? [] : tools, send, t.signal);
      } finally {
        t.clear();
      }

      if (!turn.toolCalls.length) {
        finalAnswer = turn.content.trim();
        send({ type: "turn_end", n: step, had_tool_calls: false });
        break;
      }

      // Record the assistant turn, then execute each tool call in order.
      const assistantMsg = { role: "assistant", content: turn.content || null, tool_calls: [] };
      const calls = turn.toolCalls.slice(0, 4).map((tc, i) => ({
        ...tc,
        id: tc.id || `call_${step}_${i}`,
      }));
      for (const tc of calls) {
        assistantMsg.tool_calls.push({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args || "{}" },
        });
      }
      messages.push(assistantMsg);
      send({ type: "turn_end", n: step, had_tool_calls: true });

      for (const tc of calls) {
        let args = {};
        try {
          args = JSON.parse(tc.args || "{}");
        } catch {
          /* leave args empty; the tool reports the problem */
        }
        send({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          emoji: TOOL_EMOJI[tc.name] || "🛠",
          args,
        });
        let result;
        const tt = timeoutSignal(master.signal, TOOL_CALL_TIMEOUT_MS);
        try {
          result = await execTool(env, tc.name, args, tt.signal, mode, searchEnabled);
        } catch (err) {
          result = {
            forModel: `Error running ${tc.name}: ${clip(err.message, 200)}`,
            display: { ok: false, summary: clip(err.message, 120) },
          };
        } finally {
          tt.clear();
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.forModel });
        send({ type: "tool_result", id: tc.id, name: tc.name, ...result.display });
      }
    }

    if (!finalAnswer) {
      send({
        type: "status",
        message: "Step limit reached — requesting a final synthesis.",
      });
      steps += 1;
      send({ type: "step_start", n: steps });
      messages.push({
        role: "user",
        content: "Give your best final answer now from what you have gathered, with citations.",
      });
      const t = timeoutSignal(master.signal, Math.min(MODEL_CALL_TIMEOUT_MS, Math.max(deadline - Date.now(), 8_000)));
      try {
        const turn = await chatTurn(provider, messages, [], send, t.signal);
        finalAnswer = turn.content.trim();
      } finally {
        t.clear();
      }
    }

    // Deterministic guard: models sometimes invent plausible Learn URLs.
    // Normalize/repair every CIBC Learn link against the real library before
    // the answer card renders (the streamed deltas are replaced by this).
    finalAnswer = repairLearnLinks(finalAnswer);

    send({
      type: "done",
      answer: finalAnswer,
      steps,
      mode,
      model: provider.model,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    if (!master.signal.aborted) {
      send({ type: "error", message: friendlyProviderMessage(err, provider) });
    }
  } finally {
    finish();
  }
}
