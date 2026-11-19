"use strict";
/**
 * context-slimmer.js — precision context for small local models (Mission Barisal).
 *
 * Principle: a small model needs AWARENESS plus retrieval paths, not bulk dumps.
 * The full files (syllabus.md, SSOT.md) stay on disk; the prompt carries only
 * input-relevant excerpts under a hard character budget, plus an index of titles
 * and a pointer so the model can read the rest with read_file when it matters.
 *
 * All three helpers are pure (contents in, string out) — no fs, no paths:
 *   slimSyllabus(fullText, userInput, opts)  top-N entries overlapping the input
 *   slimSSOT(fullText, userInput, opts)      same cut, for SSOT sections
 *   compactToolsText(toolMap)                names + params only; full JSON
 *                                            schemas already ride in `tools`
 *
 * 2026-09-27: created for the context-alignment directive (persona/context was
 * pushing single-agent prompts to ~5.7k tokens ≈ 147s first-round prefill on
 * the local 1B model).
 */

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "her", "was", "one", "our", "out", "get", "has", "have", "had", "how",
  "its", "may", "new", "now", "old", "see", "two", "way", "who", "did",
  "she", "use", "with", "that", "this", "these", "those", "from", "into",
  "when", "then", "than", "what", "which", "will", "would", "should",
  "please", "tell", "about", "make", "give", "show", "does", "using",
]);

function tokenize(text) {
  if (!text) return new Set();
  const lower = String(text).toLowerCase();
  const raw = lower.match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) || [];
  const out = new Set();
  for (const t of raw) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Split markdown into entries on level-1/2 headings. Text before the first
 * heading becomes entry 0 (the preamble) so nothing is ever lost silently.
 */
function splitByHeadings(text) {
  const lines = String(text).split("\n");
  const entries = [];
  let cur = { title: "", lines: [] };
  for (const line of lines) {
    const m = line.match(/^#{1,2}\s+(.*)$/);
    if (m) {
      if (cur.lines.length || cur.title) entries.push(cur);
      cur = { title: m[1].trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  entries.push(cur);
  return entries
    .map((e) => ({ title: e.title, text: e.lines.join("\n").trim() }))
    .filter((e) => e.text.length > 0);
}

function scoreEntry(qTokens, entry) {
  if (!qTokens.size) return 0;
  const titleToks = tokenize(entry.title);
  const bodyToks = tokenize(entry.text);
  let score = 0;
  for (const t of qTokens) {
    if (titleToks.has(t)) score += 2;
    else if (bodyToks.has(t)) score += 1;
  }
  return score;
}

/**
 * Relevance cut for the agent syllabus.
 * Keeps: (1) a compact index of ALL entry titles (awareness), (2) only the
 * top-matching entries in full (up to maxEntries / maxChars), (3) a retrieval
 * pointer. With no usable query the first entry (project header) is kept.
 */
function slimSyllabus(fullText, userInput, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 1500;
  const maxEntries = o.maxEntries || 3;
  if (!fullText || !String(fullText).trim()) return "";
  const entries = splitByHeadings(fullText);
  const q = tokenize(userInput);
  const titles = entries.map((e) => e.title).filter(Boolean);

  const scored = entries
    .map((e) => ({ e, s: scoreEntry(q, e) }))
    .sort((a, b) => b.s - a.s);
  const keep = [];
  if (q.size) {
    for (const item of scored) {
      if (item.s > 0 && keep.length < maxEntries) keep.push(item.e);
    }
  }
  if (!keep.length && scored.length) keep.push(scored[0].e);

  let body = keep.map((e) => e.text).join("\n\n").trim();
  if (body.length > maxChars) body = body.slice(0, maxChars) + "\n...[excerpt cut]";

  const parts = [];
  parts.push(
    "SYLLABUS INDEX (titles):" +
      (titles.length ? "\n- " + titles.join("\n- ") : " (none)"),
  );
  if (body) {
    parts.push("--- input-matched entries ---\n" + body + "\n--- END SYLLABUS EXCERPTS ---");
  }
  parts.push(
    "Full syllabus stays on disk at .zombiecoder/agents/syllabus.md — read it with read_file when a deeper answer needs it.",
  );
  return parts.join("\n");
}

/**
 * Relevance cut for the project SSOT. Sections (headings) matching the input
 * are kept up to maxChars; otherwise only the first overview chunk (short).
 * Returns "" when there is nothing to show.
 */
function slimSSOT(fullText, userInput, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 900;
  if (!fullText || !String(fullText).trim()) return "";
  const entries = splitByHeadings(fullText);
  const q = tokenize(userInput);

  const scored = entries
    .map((e) => ({ e, s: scoreEntry(q, e) }))
    .sort((a, b) => b.s - a.s);
  const keep = [];
  if (q.size) {
    for (const item of scored) {
      if (item.s > 0 && keep.length < (o.maxSections || 3)) keep.push(item.e);
    }
  }
  if (!keep.length) {
    // No match: keep a short overview so identity/stack awareness survives.
    const head = String(fullText).slice(0, Math.min(maxChars, 450));
    return head + (fullText.length > head.length ? "\n...[overview cut]" : "");
  }
  let body = keep.map((e) => e.text).join("\n\n").trim();
  if (body.length > maxChars) body = body.slice(0, maxChars) + "\n...[excerpt cut]";
  return body;
}

/**
 * Compact tool text index: name + parameter names only. The authoritative
 * descriptions and JSON schemas already travel in the request's `tools`
 * argument — repeating them as prose burned ~800 tokens per system prompt.
 */
function compactToolsText(toolMap) {
  try {
    const entries = Object.entries(toolMap || {});
    if (entries.length === 0) return "- (no tools available)\n";
    return (
      entries
        .map(([name, def]) => {
          const params = Object.keys(def.params || {}).join(", ");
          return "- **" + name + "**" + (params ? "(" + params + ")" : "");
        })
        .join("\n") +
      "\n(Full schemas are in the function definitions — call tools directly; do not describe them in prose.)\n"
    );
  } catch (e) {
    return "- (tools unavailable)\n";
  }
}

module.exports = { slimSyllabus, slimSSOT, compactToolsText, splitByHeadings };
