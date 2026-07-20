#!/usr/bin/env node
// Offline harness: serves the static site plus the REAL api/agent.js handler,
// wired to a local mock of the model provider (OpenAI-compatible) and of the
// Tavily search API. Two uses:
//
//   npm run mock          → rehearse the demo end-to-end with zero keys / no
//                           network (http://127.0.0.1:8787/agent.html)
//   npm test              → dev/test.mjs drives this server programmatically
//
// The mock NEVER runs in production: api/agent.js only reaches it when
// HERMES_BASE_URL / TAVILY_BASE_URL are explicitly pointed at it.
//
// Flags: --port N (site, default 8787) --upstream N (mock APIs, default 8788)
//        --no-keys  (start WITHOUT provider env, to exercise the graceful
//                    misconfiguration path)
//        --real     (do NOT mock anything: serve the site + the real agent
//                    using whatever provider/search env is already set — e.g.
//                    a local LM Studio/Ollama endpoint via HERMES_BASE_URL,
//                    or real NOUS/OPENROUTER/TAVILY keys — no Vercel CLI
//                    needed. See "Running it for $0" in the README.)
// Env:   MOCK_INLINE_TOOLCALL=1 → mock emits Hermes-native inline
//        <tool_call>{...}</tool_call> text instead of structured tool_calls.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(flag("port", "8787"), 10);
const UPSTREAM_PORT = parseInt(flag("upstream", "8788"), 10);
const NO_KEYS = args.includes("--no-keys");
const REAL = args.includes("--real");
const INLINE_TOOLCALL = process.env.MOCK_INLINE_TOOLCALL === "1";

// ── Mock upstream: OpenAI-compatible chat completions + Tavily ─────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sseChunks(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const delta of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta, index: 0 }] })}\n\n`);
    await sleep(8);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const FINAL_ANSWER = [
  "**Takeaway:** Shares of Example Corp rose about **4.2%** today after a stronger-than-expected ",
  "quarterly report and two analyst upgrades.\n\n",
  "### What moved it\n",
  "- Q2 revenue of $12.4B beat consensus of $11.8B ([1](https://www.reuters.com/markets/example))\n",
  "- Management raised full-year guidance by ~5% ([2](https://www.example.com/ir/q2-release))\n",
  "- Two upgrades this morning; average price target now $210 ([3](https://www.bloomberg.com/example))\n\n",
  "### Analyst sentiment\n",
  "Consensus is now 18 buy / 6 hold / 1 sell. The bull case centers on data-center demand; ",
  "bears flag valuation at 38x forward earnings.\n\n",
  "Sources\n",
  "1. [Reuters — Example Corp beats](https://www.reuters.com/markets/example)\n",
  "2. [Example Corp IR — Q2 release](https://www.example.com/ir/q2-release)\n",
  "3. [Bloomberg — analyst upgrades](https://www.bloomberg.com/example)\n",
];

const LEARN_FINAL_ANSWER = [
  "**An ETF (exchange-traded fund)** is, in CIBC's words, \"a professionally managed fund that ",
  "holds stocks or bonds and trades on exchanges, offering broad market exposure.\" You buy or ",
  "sell it like a single stock, and one purchase spreads your money across the whole basket — ",
  "that's diversification.\n\n",
  "A **mutual fund** also pools investments, but it prices once a day and often carries higher fees, ",
  "while ETFs trade all day at market prices and tend to cost less.\n\n",
  "### Keep learning\n",
  "- [What Is an ETF and How Does It Work?](https://www.investorsedge.cibc.com/en/learn/investing/etfs-and-mutual-funds/what-is-an-etf.html)\n",
  // Deliberately a relative link and a bare URL — the client renderer must
  // absolutize the first and auto-link the second (the real model does both).
  "- [ETFs and Mutual Funds](/en/learn/investing/etfs-and-mutual-funds.html)\n\n",
  "Full library: https://www.investorsedge.cibc.com/en/learn.html\n\n",
  "*Educational content from the CIBC Investor's Edge Learn library.*\n",
];

function mockChat(req, res, body) {
  const messages = body.messages || [];
  const hadToolResults = messages.some((m) => m.role === "tool");
  const model = String(body.model || "");
  const toolNames = (body.tools || []).map((t) => t?.function?.name).filter(Boolean);

  // Learn mode (Tier 2): library tools offered, open web_search absent. Both
  // learn_lookup and learn_read execute for real inside api/agent.js (local
  // index + cached bodies, no network), so this exercises the library end to
  // end: search → read full article → answer grounded in its content.
  if (toolNames.includes("learn_lookup") && !toolNames.includes("web_search")) {
    const toolRounds = messages.filter((m) => m.role === "tool").length;
    if (toolRounds === 0) {
      return sseChunks(res, [
        { content: "<think>An educational question. I should ground the answer in the CIBC Learn library first.</think>" },
        { content: "Checking the CIBC Investor's Edge Learn library…" },
        { tool_calls: [{ index: 0, id: "call_mock_learn", function: { name: "learn_lookup", arguments: '{"query": "what is an etf", "limit": 3}' } }] },
      ]);
    }
    if (toolRounds === 1) {
      return sseChunks(res, [
        { content: "<think>Good matches — I'll read the ETF explainer in full before answering.</think>" },
        { content: "Reading the full article…" },
        { tool_calls: [{ index: 0, id: "call_mock_read", function: { name: "learn_read", arguments: '{"urls": ["https://www.investorsedge.cibc.com/en/learn/investing/etfs-and-mutual-funds/what-is-an-etf.html"]}' } }] },
      ]);
    }
    return sseChunks(res, LEARN_FINAL_ANSWER.map((content) => ({ content })));
  }

  if (!hadToolResults) {
    if (INLINE_TOOLCALL || model.endsWith("-inline")) {
      // Hermes-native inline format, tag split across chunk boundaries on purpose.
      return sseChunks(res, [
        { content: "<thi" },
        { content: "nk>The user asks about a stock move. I should search for today's news and analyst notes.</think>" },
        { content: "Let me check the latest coverage.\n<tool_call>\n" },
        { content: '{"name": "web_search", "arguments": {"query": "Example Corp stock move today analyst", "limit": 5}}' },
        { content: "\n</tool_call>" },
      ]);
    }
    // Structured tool calling; arguments split across two deltas on purpose.
    return sseChunks(res, [
      { content: "<thi" },
      { content: "nk>The user asks about a stock move. I need current data: search first, then read the best hit.</think>" },
      { content: "Scanning today's coverage and analyst notes…" },
      { tool_calls: [{ index: 0, id: "call_mock_1", function: { name: "web_search", arguments: '{"query": "Example Corp st' } }] },
      { tool_calls: [{ index: 0, function: { arguments: 'ock move today analyst sentiment", "limit": 5}' } }] },
    ]);
  }
  return sseChunks(res, FINAL_ANSWER.map((content) => ({ content })));
}

const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch { /* ignore */ }

  if (req.url.endsWith("/chat/completions")) return mockChat(req, res, body);

  if (req.url.endsWith("/search")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        results: [
          { title: "Example Corp beats Q2 estimates, raises guidance", url: "https://www.reuters.com/markets/example", content: "Example Corp reported quarterly revenue of $12.4 billion, above consensus of $11.8 billion, and raised full-year guidance…" },
          { title: "Analysts lift targets after Example Corp report", url: "https://www.bloomberg.com/example", content: "Two brokerages upgraded the stock this morning; the average price target moved to $210 from $195…" },
          { title: "Example Corp Q2 press release", url: "https://www.example.com/ir/q2-release", content: "Q2 revenue grew 22% year over year on data-center demand; management raised FY guidance by approximately 5%…" },
        ],
      })
    );
  }

  if (req.url.endsWith("/extract")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        results: (body.urls || []).map((u) => ({ url: u, raw_content: "Full text of the page: Example Corp Q2 revenue $12.4B (+22% y/y), EPS $1.42 vs $1.31 expected. Guidance raised ~5%. Management cited data-center demand." })),
        failed_results: [],
      })
    );
  }

  res.writeHead(404).end();
});

// ── Site server: statics + real /api/agent handler ──────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  const abs = resolve(join(ROOT, filePath));
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(abs);
    res.writeHead(200, { "Content-Type": MIME[extname(abs)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

async function main() {
  if (REAL) {
    // Leave the environment exactly as provided (real keys or a local
    // OpenAI-compatible server such as LM Studio / Ollama).
  } else if (!NO_KEYS) {
    process.env.HERMES_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;
    process.env.HERMES_API_KEY = "mock-key";
    process.env.HERMES_MODEL = process.env.HERMES_MODEL || "Hermes-4-405B-mock";
    process.env.TAVILY_API_KEY = "mock-key";
    process.env.TAVILY_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
  } else {
    for (const k of ["HERMES_BASE_URL", "HERMES_API_KEY", "NOUS_API_KEY", "OPENROUTER_API_KEY", "TAVILY_API_KEY", "TAVILY_BASE_URL"]) {
      delete process.env[k];
    }
  }

  const { default: agentHandler } = await import("../api/agent.js");

  if (!REAL) await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  const site = http.createServer((req, res) => {
    if (new URL(req.url, "http://x").pathname === "/api/agent") return agentHandler(req, res);
    return serveStatic(req, res);
  });
  await new Promise((r) => site.listen(PORT, "127.0.0.1", r));

  console.log(`[mock] site        http://127.0.0.1:${PORT}/agent.html`);
  if (REAL) {
    const provider = process.env.HERMES_BASE_URL && process.env.HERMES_API_KEY
      ? `custom endpoint ${process.env.HERMES_BASE_URL}`
      : process.env.NOUS_API_KEY ? "Nous Portal"
      : process.env.OPENROUTER_API_KEY ? "OpenRouter"
      : "NONE — the page will show the misconfiguration error";
    console.log(`[mock] provider    ${provider}${process.env.HERMES_MODEL ? ` (model ${process.env.HERMES_MODEL})` : ""}`);
    console.log(`[mock] search      ${process.env.TAVILY_API_KEY ? "tavily" : "not configured (model-only)"}`);
    console.log(`[mock] mode        real (no mocks — env-provided provider/search)`);
  } else {
    console.log(`[mock] upstream    http://127.0.0.1:${UPSTREAM_PORT} (${NO_KEYS ? "UNUSED — no-keys mode" : "model + search mocks"})`);
    console.log(`[mock] mode        ${NO_KEYS ? "no-keys (graceful failure path)" : INLINE_TOOLCALL ? "inline <tool_call> fallback" : "structured tool calls"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
