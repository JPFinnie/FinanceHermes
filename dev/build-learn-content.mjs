#!/usr/bin/env node
// Regenerates api/learn-content.js — the locally cached article bodies for the
// CIBC Investor's Edge Learn library indexed in api/learn-library.js.
//
//   node dev/build-learn-content.mjs
//
// For every entry in LEARN_LIBRARY this fetches the live page, slices out the
// <main> content, converts it to plain markdown (headings, paragraphs, lists,
// links, emphasis, simple tables), absolutizes every link against
// investorsedge.cibc.com (the site uses relative /en/... hrefs, which would
// 404 if repeated verbatim on our domain), drops obvious page chrome, and
// writes the result as one big generated module. Zero npm dependencies, like
// the rest of the repo. Content © CIBC — served with attribution and canonical
// links back to the source pages (see README "Chat modes").

import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LEARN_LIBRARY } from "../api/learn-library.js";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../api/learn-content.js");
const BASE = "https://www.investorsedge.cibc.com";
const CONCURRENCY = 6;
const MAX_BODY_CHARS = 20_000;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// ── minimal HTML → markdown ────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", copy: "©",
  reg: "®", trade: "™", eacute: "é",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function absolutize(href) {
  href = decodeEntities(String(href || "").trim());
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return BASE + href;
  return null; // anchors, javascript:, mailto:, relative-without-slash → keep text only
}

const stripTags = (s) => s.replace(/<[^>]+>/g, " ");

function htmlToMarkdown(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|form|iframe|video|audio|picture)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");

  // Links first (their inner markup gets flattened to text).
  s = s.replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (!text) return " ";
    const url = absolutize(href);
    return url ? ` [${text}](${url}) ` : ` ${text} `;
  });

  // Emphasis.
  s = s
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, t, inner) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      return text ? ` **${text}** ` : " ";
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, t, inner) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      return text ? ` *${text}* ` : " ";
    });

  // Block structure → markdown markers.
  s = s
    .replace(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      return text ? `\n\n${"#".repeat(Number(n))} ${text}\n\n` : "\n\n";
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li|ul|ol)>/gi, "\n")
    .replace(/<(p|div|section|article|blockquote|figcaption)\b[^>]*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ");

  s = decodeEntities(stripTags(s));

  // Normalize whitespace and drop page chrome / boilerplate lines.
  const CHROME =
    /^(share( on)?( this)?( article)?|print|facebook|twitter|linkedin|email|back to top|load (\{\{count\}\} )?more( articles)?|showing .* items|open an account|sign on|apply now|book a meeting|watch again|read transcript|transcript)$/i;
  const lines = s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").replace(/\s+\|\s*$/, "").trim())
    .filter((l) => !CHROME.test(l));

  const out = [];
  for (const line of lines) {
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    // Merge the split "- " list markers the tag pass can produce.
    if (line === "-") continue;
    out.push(line);
  }
  let md = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > MAX_BODY_CHARS) md = md.slice(0, MAX_BODY_CHARS).trimEnd() + "\n\n[Article truncated — read the full page at the canonical URL.]";
  return md;
}

function extractMain(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return m ? m[1] : html;
}

// ── fetch all pages ────────────────────────────────────────────────────────

async function fetchBody(url) {
  const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return htmlToMarkdown(extractMain(await resp.text()));
}

const queue = [...LEARN_LIBRARY];
const content = {};
const failures = [];

async function worker() {
  for (;;) {
    const entry = queue.shift();
    if (!entry) return;
    const path = entry.url.replace(BASE, "");
    try {
      const body = await fetchBody(entry.url);
      if (body.length < 200) throw new Error(`suspiciously short body (${body.length} chars)`);
      content[path] = body;
      console.log(`  ok   ${path} (${body.length} chars)`);
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
      console.error(`  FAIL ${path}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const paths = Object.keys(content).sort();
const generated =
  `// api/learn-content.js — GENERATED by dev/build-learn-content.mjs (${new Date().toISOString().slice(0, 10)}).\n` +
  "// Locally cached article bodies (markdown) for the CIBC Investor's Edge Learn\n" +
  "// library, keyed by page path. All links inside the bodies are absolutized to\n" +
  "// investorsedge.cibc.com. Content © CIBC — always served with attribution and\n" +
  "// a canonical link back to the source page. Do not edit by hand; re-run the\n" +
  "// build script to refresh after CIBC publishes or updates articles.\n\n" +
  "export const LEARN_CONTENT = {\n" +
  paths.map((p) => `  ${JSON.stringify(p)}:\n    ${JSON.stringify(content[p])},`).join("\n") +
  "\n};\n";

await writeFile(OUT, generated);
console.log(`\nWrote ${OUT}: ${paths.length}/${LEARN_LIBRARY.length} pages, ${(generated.length / 1024).toFixed(0)} KB`);
if (failures.length) {
  console.error(`\n${failures.length} page(s) failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
}
