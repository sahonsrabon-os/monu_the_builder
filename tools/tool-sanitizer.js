/**
 * tool-sanitizer.js — Last-resort tool-call extractor for Mission Barisal
 * ========================================================================
 * PURPOSE
 *   Custom providers (and small local models) sometimes CANNOT emit native
 *   OpenAI tool_calls. They answer in plain text even when tools were sent.
 *   This module is the final safety layer: it scans the text for known
 *   tool-call MARKERS and synthesizes real OpenAI tool_calls from them.
 *   The normal path is untouched — extraction only runs when the model
 *   returned NO native tool_calls (see api.js callModelWithTools).
 *
 * DESIGN RULES (user spec)
 *   - New layer, existing design untouched (api.js stays clean: ONE require
 *     + ONE hook, all logic lives here).
 *   - Works with a canonical format the model can be TOLD to use (see
 *     formatHint()) plus several common fallback dialects.
 *   - Never invents calls: only extracts explicit markers, and (when an
 *     allowlist is given) only accepts tool names that were actually sent.
 *
 * SUPPORTED DIALECTS (in priority order)
 *   D1 fenced    : ```tool_call {"name":"x","arguments":{...}}``` (or array)
 *   D2 fenced    : ```function_call ...``` (same payload shape)
 *   D3 invoke    : "invoke name=" tags, close tag built via concatenation
 *                  in CALLERS/tests — this source never contains a raw
 *                  angle-bracket slash sequence (write-tool safe).
 *   D4 FL marker : [[FL]]{"name":"x","arguments":{...}}[[/FL]]
 *   D5 bare JSON : first balanced {"name": allowed, "arguments"|"args"|
 *                  "parameters": {...}} object found in the text.
 *
 * API
 *   extractToolCalls(text, allowlist) -> { tool_calls, cleaned, dialect }
 *   formatHint(tools)                  -> instruction string for prompts
 *   selftest()                         -> runs internal assertions
 *
 * RUN:  node tools/tool-sanitizer.js --selftest
 * Zero dependencies. Node >= 18.
 */
"use strict";

const CLOSE_INVOKE = "<" + "/invoke>";
const CLOSE_FUNCTION = "<" + "/function_call>";

const FENCE_RE = /```(tool_call|toolcalls|tool_calls|function_call)\s*\n([\s\S]*?)```/g;
const INVOKE_RE = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
const INVOKE_RE2 = new RegExp(
  '<invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)' + CLOSE_INVOKE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "g",
);
const FL_RE = /\[\[FL\]\]([\s\S]*?)\[\[\/FL\]\]/g;

function makeCall(name, argsObj, index) {
  let argsStr;
  if (typeof argsObj === "string") {
    // must be valid JSON text — validate, else wrap as {input: text}
    try {
      JSON.parse(argsObj);
      argsStr = argsObj;
    } catch (_) {
      argsStr = JSON.stringify({ input: argsObj });
    }
  } else {
    argsStr = JSON.stringify(argsObj || {});
  }
  return {
    id: "san_" + Date.now().toString(36) + "_" + index,
    type: "function",
    function: { name: name, arguments: argsStr },
  };
}

/** Parse one payload: single object, array of objects, or
 *  {"invoke":[{"name":..,"arguments":..}]} wrapper. Returns calls[] */
function parsePayload(payload, allowset, calls, dialect) {
  let data;
  try {
    data = JSON.parse(payload.trim());
  } catch (_) {
    return;
  }
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    // wrapper dialect: {invoke:[...]} or {function_calls:[...]}
    const wrapped = item.invoke || item.function_calls;
    if (Array.isArray(wrapped)) {
      for (const w of wrapped) collectOne(w, allowset, calls, dialect);
      continue;
    }
    collectOne(item, allowset, calls, dialect);
  }
}

function collectOne(item, allowset, calls, dialect) {
  if (!item || typeof item.name !== "string") return;
  if (allowset && !allowset.has(item.name)) return;
  const args = item.arguments !== undefined ? item.arguments
    : item.args !== undefined ? item.args
    : item.parameters !== undefined ? item.parameters
    : {};
  calls.push(makeCall(item.name, args, calls.length));
}

/** Find first balanced JSON object starting at or after `from`. */
function balancedJson(text, from) {
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Extract tool calls from plain text.
 * @param {string} text   assistant content
 * @param {string[]|undefined} allowlist  names of tools that were sent
 * @returns {{tool_calls:Array, cleaned:string, dialect:string|null}}
 */
function extractToolCalls(text, allowlist) {
  const empty = { tool_calls: [], cleaned: text || "", dialect: null };
  if (!text || typeof text !== "string") return empty;
  const allowset =
    allowlist && allowlist.length ? new Set(allowlist) : null;

  const calls = [];
  let dialect = null;
  let cleaned = text;

  // D1/D2 — fenced blocks
  FENCE_RE.lastIndex = 0;
  let m;
  let fenceFound = false;
  while ((m = FENCE_RE.exec(text)) !== null) {
    fenceFound = true;
    parsePayload(m[2], allowset, calls, m[1]);
  }
  if (fenceFound) dialect = "fenced";

  // D3 — invoke tags (regex assembled without raw close-literal in source)
  INVOKE_RE2.lastIndex = 0;
  let invokeFound = false;
  while ((m = INVOKE_RE2.exec(text)) !== null) {
    invokeFound = true;
    collectOne({ name: m[1], arguments: m[2].trim() }, allowset, calls, "invoke");
  }
  if (invokeFound && !dialect) dialect = "invoke";

  // D4 — [[FL]] markers
  FL_RE.lastIndex = 0;
  let flFound = false;
  while ((m = FL_RE.exec(text)) !== null) {
    flFound = true;
    parsePayload(m[1], allowset, calls, "FL");
  }
  if (flFound && !dialect) dialect = "FL";

  // D5 — bare balanced JSON fallback (only if nothing else matched)
  if (!calls.length) {
    let idx = 0;
    while (idx < text.length && calls.length < 5) {
      const bal = balancedJson(text, idx);
      if (!bal) break;
      try {
        const obj = JSON.parse(bal.json);
        if (obj && typeof obj.name === "string" &&
            (obj.arguments !== undefined || obj.args !== undefined || obj.parameters !== undefined)) {
          const before = calls.length;
          collectOne(obj, allowset, calls, "bare");
          if (calls.length > before && !dialect) dialect = "bare";
        }
      } catch (_) {}
      idx = bal.end;
    }
  }

  if (!calls.length) return empty;

  // Clean: drop the marker regions we consumed so the model does not echo them.
  cleaned = text;
  if (dialect === "fenced") {
    cleaned = cleaned.replace(FENCE_RE, "");
  } else if (dialect === "invoke") {
    cleaned = cleaned.replace(INVOKE_RE2, "");
  } else if (dialect === "FL") {
    cleaned = cleaned.replace(FL_RE, "");
  }
  cleaned = cleaned.trim();

  return { tool_calls: calls, cleaned, dialect };
}

/**
 * One-line instruction to append to a prompt when a custom provider is
 * asked to use tools but cannot emit native tool_calls.
 */
function formatHint(tools) {
  const names = (tools || [])
    .map((t) => (t && t.function && t.function.name) || (t && t.name))
    .filter(Boolean);
  if (!names.length) return "";
  return (
    "If you cannot emit native tool_calls, reply with EXACTLY this marker format " +
    "(one per call): [[FL]]" + JSON.stringify({ name: "TOOL_NAME", arguments: {} }) +
    "[[/FL]] — available tools: " + names.join(", ") + "."
  );
}

// ── Selftest ───────────────────────────────────────────────────
function selftest() {
  let pass = 0;
  let fail = 0;
  const tools = ["get_weather", "read_file"];
  function ok(cond, label) {
    if (cond) { pass++; console.log("  PASS " + label); }
    else { fail++; console.log("  FAIL " + label); }
  }

  // 1. fenced single
  const t1 = 'I will check.\n```tool_call\n{"name":"get_weather","arguments":{"city":"Dhaka"}}\n```\n';
  const r1 = extractToolCalls(t1, tools);
  ok(r1.tool_calls.length === 1 && r1.tool_calls[0].function.name === "get_weather", "fenced single");
  ok(r1.dialect === "fenced", "fenced dialect");
  ok(r1.cleaned.indexOf("tool_call") === -1, "fenced cleaned");

  // 2. fenced array
  const t2 = '```tool_call\n[{"name":"read_file","arguments":{"path":"a.txt"}},{"name":"get_weather","arguments":{"city":"Barishal"}}]\n```';
  const r2 = extractToolCalls(t2, tools);
  ok(r2.tool_calls.length === 2, "fenced array -> 2 calls");

  // 3. invoke dialect (close tag assembled, no raw slash sequence in source)
  const t3 = '<invoke name="read_file">{"path":"x.txt"}' + CLOSE_INVOKE;
  const r3 = extractToolCalls(t3, tools);
  ok(r3.tool_calls.length === 1 && r3.tool_calls[0].function.name === "read_file", "invoke dialect");

  // 4. FL marker (canonical)
  const t4 = 'Using tool [[FL]]{"name":"get_weather","arguments":{"city":"Dhaka"}}[[/FL]] now.';
  const r4 = extractToolCalls(t4, tools);
  ok(r4.tool_calls.length === 1 && r4.dialect === "FL", "FL marker");
  ok(r4.cleaned.indexOf("[[FL]]") === -1, "FL cleaned");

  // 5. allowlist rejects unknown tool
  const t5 = '```tool_call\n{"name":"rm_rf","arguments":{"path":"/"}}\n```';
  const r5 = extractToolCalls(t5, tools);
  ok(r5.tool_calls.length === 0, "allowlist blocks unknown tool");

  // 6. plain prose returns empty (no false positive)
  const t6 = "The weather in Dhaka is warm and humid today.";
  const r6 = extractToolCalls(t6, tools);
  ok(r6.tool_calls.length === 0 && r6.cleaned === t6, "plain prose untouched");

  // 7. bare JSON fallback
  const t7 = 'Sure. {"name":"get_weather","arguments":{"city":"Khulna"}} is next.';
  const r7 = extractToolCalls(t7, tools);
  ok(r7.tool_calls.length === 1 && r7.dialect === "bare", "bare JSON fallback");

  // 8. args as string preserved
  const t8 = '[[FL]]{"name":"read_file","arguments":"{\\"path\\":\\"y.txt\\"}"}[[/FL]]';
  const r8 = extractToolCalls(t8, tools);
  ok(r8.tool_calls.length === 1 && JSON.parse(r8.tool_calls[0].function.arguments).path === "y.txt", "string arguments");

  // 9. formatHint mentions tools
  const h = formatHint([{ function: { name: "get_weather" } }]);
  ok(h.indexOf("get_weather") !== -1 && h.indexOf("[[FL]]") !== -1, "formatHint contains marker + tool");

  // 10. arguments default {} when missing args object with allowed name — no crash
  const t10 = '```tool_call\n{"name":"read_file"}\n```';
  const r10 = extractToolCalls(t10, tools);
  ok(r10.tool_calls.length === 1 && r10.tool_calls[0].function.arguments === "{}", "missing arguments -> {}");

  console.log("\nSELFTEST: " + pass + " passed, " + fail + " failed");
  return fail === 0;
}

module.exports = { extractToolCalls, formatHint };

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--selftest") {
    process.exit(selftest() ? 0 : 1);
  } else if (arg === "--extract") {
    const fs = require("fs");
    const input = fs.readFileSync(process.argv[3] || 0, "utf8");
    console.log(JSON.stringify(extractToolCalls(input), null, 2));
  } else {
    console.log("usage: tool-sanitizer.js --selftest | --extract file|-");
    process.exit(2);
  }
}
