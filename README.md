# FinanceHermes

A **live, real (not simulated) financial-research agent** built on a Hermes model from
Nous Research — made to be shown to a room of investment advisors. Ask a market
question; the model plans the research, calls a live web-search tool, reads what it
finds, and synthesizes an answer with citations, **streaming every step** (thinking →
tool call → tool result → answer) to the page as it happens.

Deploys to Vercel as a static site plus one serverless function. No framework, no
build step, zero npm dependencies.

## How it works

```
agent.html ──POST /api/agent──▶ api/agent.js (Vercel Node function)
    ▲                              │  agentic loop, up to 6 steps:
    │   SSE trace events           │  Hermes model ⇄ web_search / web_extract (Tavily)
    └──────────────────────────────┘  keys live in server env only
```

- `agent.html` + `assets/agent.{css,js}` + `assets/agent-field.js` — the standalone
  demo page: query box, example chips, live trace renderer, particle background.
- `api/agent.js` — the whole agent: provider selection, streaming tool-call loop,
  web tools, SSE protocol. Same-origin only, so the existing strict CSP
  (`connect-src 'self'`) is untouched; provider/search calls happen server-side.
- `index.html` — landing page with the discreet **Research Agent** nav link (the
  same one-line link to add to the main site's nav when merging).

## Reference implementation

The agent loop and tool surface are ported from
[JPFinnie/Neo](https://github.com/JPFinnie/Neo), the fork of
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent):

| This repo | From Neo / hermes-agent |
| --- | --- |
| OpenAI-compatible chat completions + function calling (`tools` → `tool_calls` → `role:"tool"`) | `agent/chat_completion_helpers.py`, `tools/registry.py` |
| `web_search` / `web_extract` tool schemas (verbatim) | `tools/web_tools.py` (`WEB_SEARCH_SCHEMA`, `WEB_EXTRACT_SCHEMA`) |
| Tavily search backend, `TAVILY_API_KEY`, `TAVILY_BASE_URL` override | `plugins/web/tavily/provider.py` |
| Reasoning capture: `reasoning`/`reasoning_content` deltas **and** inline `<think>…</think>` | `agent/chat_completion_helpers.py` |
| Inline `<tool_call>{json}</tool_call>` fallback parsing (Hermes-native format) | `agent/agent_runtime_helpers.py` |
| Nous Portal endpoint `https://inference-api.nousresearch.com/v1` (`NOUS_API_KEY`), OpenRouter fallback | `agent/auxiliary_client.py`, `cli-config.yaml.example` |
| System-prompt voice ("helpful, knowledgeable, and direct … targeted and efficient") | `agent/prompt_builder.py` (`DEFAULT_AGENT_IDENTITY`) |

One deliberate divergence: hermes-agent's docs note the Hermes 4 chat models are
tuned for chat/reasoning rather than the agent's own 40-tool coding loop. This demo
is exactly the workload they *are* built for — reasoning + schema-adherent function
calling over a **two-tool** research loop — and using a Hermes model is the point of
the demo. If tool-calling ever feels flaky on a given provider, the inline
`<tool_call>` fallback usually still catches it.

## Setup (one-time)

1. **Provision keys** (either model provider is fine):
   - Nous Portal — create an API key at <https://portal.nousresearch.com> → `NOUS_API_KEY`
   - or OpenRouter — <https://openrouter.ai/keys> → `OPENROUTER_API_KEY`
   - Tavily (web search) — <https://app.tavily.com/home> → `TAVILY_API_KEY`
2. **Add them in Vercel**: Project → Settings → Environment Variables (Production +
   Preview). Names as in [.env.example](.env.example). Redeploy.
3. Check that **Fluid Compute** is enabled (Project → Settings → Functions — it is
   the default on new projects). It's what lets the trace stream live instead of
   arriving in one lump at the end.
4. Open `/agent.html` and ask something.

Defaults: `Hermes-4-405B` on Nous Portal, `nousresearch/hermes-4-405b` on OpenRouter.
Set `HERMES_MODEL` to override — `Hermes-4-70B` or `Hermes-4.3-36B` are snappier if
405B feels slow for live use. `HERMES_REASONING=1` turns on Hermes-4 deep-thinking
mode (visible `<think>` traces — impressive, but slower).

If a key is missing or wrong, the page shows a clear, friendly error card — it never
crashes mid-demo.

## Local dev & rehearsal

```bash
# real thing locally (needs keys in .env):
cp .env.example .env   # fill in keys
npm run dev            # vercel dev

# OFFLINE rehearsal — no keys, no network; mock model + mock search wired
# through the real agent loop and real UI:
npm run mock           # → http://127.0.0.1:8787/agent.html

# automated checks (agent loop, SSE, <think>/tool-call parsing, no-key path):
npm test
```

`npm run mock` is also the meeting-day safety net: if the venue Wi-Fi or a provider
has a bad moment, the same page and trace run against canned data.

## Demo-day notes

- Warm it up: run one query a few minutes before showing it (cold starts + provider
  warm-up), and keep the answer on screen as a teaser.
- Good openers: *"What moved NVDA today, and what's the current analyst sentiment?"* ·
  *"Summarize the most recent Fed rate commentary and the market reaction."* · the
  Canadian-bank-earnings chip plays well with a CIBC Wood Gundy room.
- A full run typically lands in 10–30 s depending on model size and steps; the trace
  streaming keeps the room engaged while it works.
- The function caps runs at 6 tool steps / ~50 s and wraps up gracefully with
  whatever it has gathered.

## Merging into jpfinnie/website later

Everything is namespaced to avoid collisions with the main site's files: copy
`agent.html`, `assets/agent.css`, `assets/agent.js`, `assets/agent-field.js`, and
`api/agent.js` into the website repo, add the one nav line from `index.html`
(`<a href="/agent.html">Research Agent</a>`), and merge the `functions` block of
`vercel.json` into the site's existing one. The page calls only same-origin
`/api/agent` and loads no external assets, so the site's `connect-src 'self'` CSP
needs no changes. Swap the CSS variables at the top of `assets/agent.css` to the
site's palette if desired.

---

*Research & education only; not investment advice. Built on
[Hermes by Nous Research](https://nousresearch.com).*
