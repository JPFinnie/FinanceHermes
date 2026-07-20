#!/usr/bin/env node
// Automated checks for the agent loop, SSE protocol, graceful failure, and
// static pages. Runs entirely offline against dev/mock-server.mjs.
//   npm test

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, "mock-server.mjs");

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

function startServer(extraArgs = [], env = {}) {
  const child = spawn(process.execPath, [MOCK, ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolveStart, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("mock server did not start")), 8000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("[mock] mode")) {
        clearTimeout(timer);
        resolveStart(child);
      }
    });
    child.on("exit", (code) => reject(new Error(`mock server exited early (${code})`)));
  });
}

async function collectEvents(port, body) {
  const resp = await fetch(`http://127.0.0.1:${port}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!(resp.headers.get("content-type") || "").includes("text/event-stream")) {
    return { status: resp.status, json: await resp.json().catch(() => null), events: [] };
  }
  const events = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            events.push(JSON.parse(line.slice(5).trim()));
          } catch { /* ignore */ }
        }
      }
    }
  }
  return { status: resp.status, events };
}

const types = (events) => events.map((e) => e.type);

async function scenarioFullLoop() {
  console.log("\nScenario 1: full agent loop (structured tool calls)");
  const server = await startServer(["--port", "8791", "--upstream", "8792"]);
  try {
    const { status, events } = await collectEvents(8791, { query: "What moved Example Corp today?" });
    const t = types(events);
    ok(status === 200, "SSE responds 200");
    ok(t.includes("init"), "emits init");
    const init = events.find((e) => e.type === "init");
    ok(init?.model === "Hermes-4-405B-mock" && init?.search === "tavily", "init reports model + tavily search");
    ok(init?.mode === "research" && init?.tier === 1, "default mode is research (Tier 1)");
    ok(t.includes("step_start"), "emits step_start");
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => e.text).join("");
    ok(thinking.includes("search for") || thinking.includes("search first"), "reassembles <think> split across chunks");
    ok(!thinking.includes("<think>") && !thinking.includes("</think>"), "think tags stripped from thinking text");
    const content = events.filter((e) => e.type === "content_delta").map((e) => e.text).join("");
    ok(!content.includes("<think>") && !content.includes("</think>"), "think tags never leak into content");
    const call = events.find((e) => e.type === "tool_call");
    ok(call?.name === "web_search" && call?.args?.query?.includes("Example Corp stock move"), "tool_call args reassembled across argument deltas");
    const result = events.find((e) => e.type === "tool_result");
    ok(result?.ok === true && Array.isArray(result.items) && result.items.length === 3, "tool_result carries 3 search hits");
    ok(result?.items.every((r) => r.url.startsWith("https://")), "tool_result items have URLs");
    const done = events.find((e) => e.type === "done");
    ok(Boolean(done), "emits done");
    ok(done?.answer.includes("4.2%") && done?.answer.includes("reuters.com"), "final answer synthesized with citations");
    ok(done?.steps === 2, "loop took 2 steps (search turn + answer turn)");
    ok(!t.includes("error"), "no error events");
  } finally {
    server.kill();
  }
}

async function scenarioInlineToolCall() {
  console.log("\nScenario 2: Hermes-native inline <tool_call> fallback");
  const server = await startServer(["--port", "8793", "--upstream", "8794"], { MOCK_INLINE_TOOLCALL: "1" });
  try {
    const { events } = await collectEvents(8793, { query: "What moved Example Corp today?" });
    const call = events.find((e) => e.type === "tool_call");
    ok(call?.name === "web_search", "inline <tool_call> parsed into a tool call");
    ok(call?.args?.query?.includes("Example Corp"), "inline arguments parsed");
    const content = events.filter((e) => e.type === "content_delta").map((e) => e.text).join("");
    ok(content.includes("Let me check the latest coverage."), "commentary before the inline call is preserved");
    const done = events.find((e) => e.type === "done");
    ok(Boolean(done?.answer), "loop still reaches a final answer");
  } finally {
    server.kill();
  }
}

async function scenarioNoKeys() {
  console.log("\nScenario 3: graceful no-key misconfiguration");
  const server = await startServer(["--no-keys", "--port", "8795", "--upstream", "8796"]);
  try {
    const { status, events } = await collectEvents(8795, { query: "anything" });
    ok(status === 200, "still responds with a stream (no crash)");
    const err = events.find((e) => e.type === "error");
    ok(Boolean(err), "emits a friendly error event");
    ok(/NOUS_API_KEY|OPENROUTER_API_KEY/.test(err?.message || ""), "error names the env vars to set");
    ok(!types(events).includes("done"), "no done event");
  } finally {
    server.kill();
  }
}

async function scenarioHttpContract() {
  console.log("\nScenario 4: HTTP contract + static pages");
  const server = await startServer(["--port", "8797", "--upstream", "8798"]);
  try {
    const get = await fetch("http://127.0.0.1:8797/api/agent");
    ok(get.status === 405, "GET /api/agent → 405");
    const bad = await fetch("http://127.0.0.1:8797/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    ok(bad.status === 400, "empty query → 400");
    const long = await fetch("http://127.0.0.1:8797/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(3000) }),
    });
    ok(long.status === 400, "over-long query → 400");
    const idx = await (await fetch("http://127.0.0.1:8797/")).text();
    ok(idx.includes('href="/agent.html"'), "index.html links to /agent.html");
    const page = await fetch("http://127.0.0.1:8797/agent.html");
    ok(page.status === 200 && (await page.text()).includes("composer"), "agent.html serves");
    const meth = await fetch("http://127.0.0.1:8797/methodology.html");
    ok(meth.status === 200 && (await meth.text()).includes("Nous Research"), "methodology.html serves");
    for (const asset of ["/assets/agent.css", "/assets/agent.js", "/assets/agent-field.js"]) {
      const a = await fetch(`http://127.0.0.1:8797${asset}`);
      ok(a.status === 200, `${asset} serves`);
    }
  } finally {
    server.kill();
  }
}

async function scenarioLearnMode() {
  console.log("\nScenario 5: Learn mode (Tier 2) grounded in the CIBC Learn library");
  const server = await startServer(["--port", "8799", "--upstream", "8800"]);
  try {
    const { status, events } = await collectEvents(8799, { query: "What is an ETF?", mode: "learn" });
    ok(status === 200, "SSE responds 200");
    const init = events.find((e) => e.type === "init");
    ok(init?.mode === "learn" && init?.tier === 2, "init reports learn mode (Tier 2)");
    ok(init?.max_steps === 4, "learn mode runs the shorter loop");
    const call = events.find((e) => e.type === "tool_call");
    ok(call?.name === "learn_lookup" && /etf/i.test(call?.args?.query || ""), "model calls learn_lookup");
    const result = events.find((e) => e.type === "tool_result");
    ok(result?.ok === true && Array.isArray(result.items) && result.items.length > 0, "library search returns articles");
    ok(
      (result?.items || []).every((r) => r.url.startsWith("https://www.investorsedge.cibc.com/en/learn")),
      "all results are CIBC Learn pages"
    );
    ok(/what is an etf/i.test(result?.items?.[0]?.title || ""), "top hit is the ETF explainer");
    ok(!events.some((e) => e.type === "tool_call" && e.name === "web_search"), "no open web_search in learn mode");
    const done = events.find((e) => e.type === "done");
    ok(done?.mode === "learn", "done reports learn mode");
    ok(/investorsedge\.cibc\.com\/en\/learn/.test(done?.answer || ""), "answer links back to CIBC Learn pages");
    const badMode = await fetch("http://127.0.0.1:8799/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hi", mode: "vip" }),
    });
    ok(badMode.status === 400, "unknown mode → 400");
  } finally {
    server.kill();
  }
}

async function scenarioPremiumGate() {
  console.log("\nScenario 6: PREMIUM_ACCESS_CODE gates research (Tier 1)");
  const server = await startServer(["--port", "8801", "--upstream", "8802"], { PREMIUM_ACCESS_CODE: "sesame" });
  try {
    const noCode = await collectEvents(8801, { query: "What is an ETF?", mode: "research" });
    const init1 = noCode.events.find((e) => e.type === "init");
    ok(init1?.mode === "learn" && init1?.tier === 2, "research without access code downgrades to learn");
    ok(
      noCode.events.some((e) => e.type === "status" && /premium/i.test(e.message || "")),
      "downgrade explained in a status event"
    );
    ok(Boolean(noCode.events.find((e) => e.type === "done")), "downgraded run still answers");
    const withCode = await collectEvents(8801, { query: "What moved Example Corp today?", mode: "research", access_code: "sesame" });
    const init2 = withCode.events.find((e) => e.type === "init");
    ok(init2?.mode === "research" && init2?.tier === 1, "valid access code unlocks research mode");
    const learnStillFree = await collectEvents(8801, { query: "What is an ETF?", mode: "learn" });
    const init3 = learnStillFree.events.find((e) => e.type === "init");
    ok(init3?.mode === "learn", "learn mode needs no access code");
  } finally {
    server.kill();
  }
}

try {
  await scenarioFullLoop();
  await scenarioInlineToolCall();
  await scenarioNoKeys();
  await scenarioHttpContract();
  await scenarioLearnMode();
  await scenarioPremiumGate();
} catch (err) {
  console.error("\nHarness error:", err);
  failures++;
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed ✓");
process.exit(failures ? 1 : 0);
