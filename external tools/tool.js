#!/usr/bin/env node
// =============================================================================
// tool.js — Universal Tool-Call Adapter (UTCA) for ZombieCoder Gateway
// =============================================================================
// ONE adapter, SIX official dialects → ONE canonical OpenAI tool_calls shape.
//
// Outbound:  tools[] / messages[]  → provider-specific request format
// Inbound:   provider response     → OpenAI  {tool_calls:[{id,type,function}]}
//
// ── Official documentation this file is built from ──────────────────────────
//  [1] Groq Tool Use Overview
//      https://console.groq.com/docs/tool-use/overview
//      • tools: [{type:"function", function:{name, description, parameters}}]
//      • response message.tool_calls: [{id, type:"function",
//          function:{name, arguments:"<JSON string>"}}]
//      • result message: {role:"tool", tool_call_id, name, content}
//  [2] Groq Responses API (OpenAI-compatible)
//      https://console.groq.com/docs/responses-api
//      • POST /openai/v1/responses — output[] carries typed items
//  [3] Google Gemini Function Calling
//      https://aistudio.google.com/docs/function-calling
//      • request tools: [{functionDeclarations:[{name,description,parameters}]}]
//      • response parts: [{functionCall:{name, args(<object>)}}]
//      • result: parts[{functionResponse:{name, response:<struct>}}]
//      • newer "interactions" steps: {type:"function_call", name, arguments,
//          call_id} + {type:"function_result", name, call_id, result}
//  [4] Ollama Tool Calling
//      https://docs.ollama.com/capabilities/tool-calling
//      • tools: same OpenAI chat shape (function wrapper)
//      • response tool_calls: [{type:"function", function:{index, name,
//          arguments:<OBJECT — not a JSON string>}}]   ← key quirk
//      • result message: {role:"tool", tool_name, content}  ← key quirk
//  [5] OpenAI Function Calling (Responses mode)
//      https://developers.openai.com/api/docs/guides/function-calling?api-mode=responses
//      • request tools FLAT: [{type:"function", name, description, parameters,
//          strict}]                                    ← key quirk
//      • response output[]: [{type:"function_call", id, call_id, name,
//          arguments:"<JSON string>"}]
//      • result input item: {type:"function_call_output", call_id, output}
//      • streaming: response.output_item.added +
//        response.function_call_arguments.delta/.done (accumulate strings)
//  [6] llama.cpp Function Calling
//      https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
//      • llama-server --jinja exposes OpenAI-style tools on
//        /v1/chat/completions (native + generic template handlers)
//      • parallel_tool_calls opt-in; without a tool-aware template the model
//        may emit the call as PLAIN TEXT → text-fallback parser below
//
// ALSO COVERED (already present in api.js normalizer, now converted properly):
//  [7] Anthropic Messages API — content blocks {type:"tool_use", id, name, input}
//  [8] AWS Bedrock Converse    — content blocks {toolUse:{toolUseId,name,input}}
//
// ZERO dependencies. Runs standalone:  node "external tools/tool.js" --selftest
// =============================================================================
"use strict";

const APIS = [
  "openai", // Groq/OpenAI/llama.cpp/OpenCode chat completions  [1][6]
  "ollama", // Ollama native /api/chat                          [4]
  "responses", // OpenAI + Groq Responses API                  [2][5]
  "gemini", // Gemini generateContent + interactions           [3]
  "anthropic", // Anthropic Messages API                        [7]
  "bedrock", // AWS Bedrock Converse                            [8]
  "text", // plain-text fallback (llama.cpp generic template)  [6]
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _idSeq = 0;
function synthId(prefix) {
  _idSeq = (_idSeq + 1) % 100000;
  return (prefix || "call_") + Date.now().toString(36) + "_" + _idSeq;
}

// arguments → JSON string (OpenAI canonical). Objects/arrays are stringified;
// primitives wrapped; already-strings pass through untouched. [1][5]
function argsToString(a) {
  if (typeof a === "string") return a;
  if (a === undefined || a === null) return "{}";
  return JSON.stringify(a);
}

// arguments → OBJECT (Ollama canonical [4]). Strings are parsed; invalid JSON
// degrades to {} (the original string is already preserved elsewhere).
function argsToObject(a) {
  if (a && typeof a === "object") return a;
  if (typeof a === "string") {
    try {
      const p = JSON.parse(a);
      return p && typeof p === "object" ? p : { value: p };
    } catch (e) {
      return {};
    }
  }
  return {};
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Accept BOTH tool definition shapes as input:
//   chat style   {type:"function", function:{name,...}}        [1][4][6]
//   flat style   {type:"function", name,...}                   [3][5]
function normalizeToolDef(t) {
  if (!t || typeof t !== "object") return null;
  if (t.type && t.type !== "function") return null; // built-ins: pass caller-side
  const fn = t.function && typeof t.function === "object" ? t.function : t;
  if (!fn.name) return null;
  return {
    type: "function",
    function: {
      name: String(fn.name),
      description: typeof fn.description === "string" ? fn.description : "",
      parameters:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
      ...(fn.strict === true ? { strict: true } : {}),
    },
  };
}

// Gemini's Schema is an OpenAPI subset — it rejects several JSON-Schema
// keywords OpenAI allows (additionalProperties, $schema, title, type unions).
// Deep-sanitize so an OpenAI schema never 400s against generateContent. [3]
function sanitizeGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema" || k === "title" || k === "strict" || k === "default") continue;
    if (k === "type" && Array.isArray(v)) {
      // ["string","null"] → "string" (Gemini: use nullable instead)
      out.type = v.find((x) => x !== "null") || v[0];
      continue;
    }
    out[k] = sanitizeGeminiSchema(v);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND #1 — tools[]  →  provider request "tools" field
// ---------------------------------------------------------------------
//   toProviderTools(tools, "openai"|"ollama"|"llama-cpp") → chat style  [1][4][6]
//   toProviderTools(tools, "responses")                  → flat style   [5]
//   toProviderTools(tools, "gemini")                      → functionDeclarations [3]
//   toProviderTools(tools, "anthropic")                   → input_schema style  [7]
// ─────────────────────────────────────────────────────────────────────────────
function toProviderTools(tools, api) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  // Built-in tools (code_interpreter, browser_search, web_search...) are NOT
  // functions — keep them untouched for dialects that understand them. [2][5]
  const builtins = tools.filter((t) => t && t.type && t.type !== "function");
  const normalized = tools.map(normalizeToolDef).filter(Boolean);
  const apiName = api || "openai";

  let converted;
  switch (apiName) {
    case "responses":
      // Flat shape, optional strict. [5]
      converted = normalized.map((t) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        ...(t.function.strict ? { strict: true } : {}),
      }));
      break;

    case "gemini":
      // [{functionDeclarations:[...]}] — no tool_choice here (use toolConfig
      // if forcing); schema sanitized. [3]
      converted = [
        {
          functionDeclarations: normalized.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: sanitizeGeminiSchema(t.function.parameters),
          })),
        },
      ];
      break;

    case "anthropic":
      // [{name, description, input_schema}] — parameters map to input_schema. [7]
      converted = normalized.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      break;

    case "ollama":
    case "llama-cpp":
    case "openai":
    case "text":
    default:
      // Chat-completions style is already the canonical input shape. [1][4][6]
      converted = normalized;
      break;
  }
  if (builtins.length) converted = converted.concat(builtins);
  return converted;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND #2 — messages[]  →  provider-specific history
// ---------------------------------------------------------------------------
// Canonical input (our gateway):
//   {role:"user"|"system", content}
//   {role:"assistant", content, tool_calls:[{id,type,function:{name,arguments}}]}
//   {role:"tool", tool_call_id, content}
// ---------------------------------------------------------------------------
function toProviderMessages(messages, api) {
  if (!Array.isArray(messages)) return messages;
  const apiName = api || "openai";

  if (apiName === "gemini") {
    // → contents[{role:"user"|"model", parts:[text|functionCall|functionResponse]}] [3]
    const nameById = {};
    for (const m of messages) {
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.id) nameById[tc.id] = (tc.function || {}).name || "";
        }
      }
    }
    const contents = [];
    let pendingResponses = null; // group consecutive tool results into ONE content
    const flushResponses = () => {
      if (pendingResponses && pendingResponses.parts.length) {
        contents.push(pendingResponses);
      }
      pendingResponses = null;
    };
    for (const m of messages) {
      const role = m.role;
      if (role === "tool") {
        const name =
          m.name || nameById[m.tool_call_id] || m.tool_call_id || "tool";
        if (!pendingResponses) {
          pendingResponses = { role: "user", parts: [] };
        }
        pendingResponses.parts.push({
          functionResponse: {
            name: String(name).slice(0, 64),
            response: wrapGeminiResponse(m.content),
          },
        });
        continue;
      }
      flushResponses();
      if (role === "assistant") {
        const parts = [];
        if (m.content !== null && m.content !== undefined && m.content !== "") {
          parts.push({ text: String(m.content) });
        }
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (!tc || !tc.function || !tc.function.name) continue;
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: argsToObject(tc.function.arguments),
              },
            });
          }
        }
        if (parts.length) contents.push({ role: "model", parts });
        continue;
      }
      // user / system / anything else → user text turn (system folded in,
      // matching the pre-existing gateway behaviour)
      const text =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content === undefined ? "" : m.content);
      contents.push({ role: "user", parts: [{ text }] });
    }
    flushResponses();
    return contents;
  }

  if (apiName === "responses") {
    // → input items: messages + function_call + function_call_output. [5]
    const nameById = {};
    for (const m of messages) {
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.id) nameById[tc.id] = (tc.function || {}).name || "";
        }
      }
    }
    const out = [];
    for (const m of messages) {
      if (m.role === "tool") {
        out.push({
          type: "function_call_output",
          call_id: m.tool_call_id || "",
          output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        });
        continue;
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (m.content) out.push({ role: "assistant", content: m.content });
        for (const tc of m.tool_calls) {
          out.push({
            type: "function_call",
            call_id: tc.id || synthId(),
            name: (tc.function || {}).name || "",
            arguments: argsToString((tc.function || {}).arguments),
          });
        }
        continue;
      }
      out.push({
        role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
    }
    return out;
  }

  if (apiName === "ollama") {
    // Native /api/chat: tool results carry tool_name (not tool_call_id) and
    // assistant arguments ride as OBJECTS with an index. [4]
    const nameById = {};
    for (const m of messages) {
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.id) nameById[tc.id] = (tc.function || {}).name || "";
        }
      }
    }
    return messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_name: m.name || nameById[m.tool_call_id] || m.tool_call_id || "",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        };
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        return {
          role: "assistant",
          content: m.content || "",
          tool_calls: m.tool_calls.map((tc, i) => ({
            type: "function",
            function: {
              index: i,
              name: (tc.function || {}).name || "",
              arguments: argsToObject((tc.function || {}).arguments),
            },
          })),
        };
      }
      return m;
    });
  }

  // openai / llama-cpp / anthropic(payload untouched here) / text / default:
  // canonical shape is what chat-completions expects. [1][6]
  return messages;
}

// Gemini functionResponse.response must be a STRUCT. [3]
function wrapGeminiResponse(content) {
  const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed) || Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch (e) {
    return { result: raw };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND — ANY provider response  →  OpenAI tool_calls[]
//   Returns [] when the payload contains no tool call.
//   Every entry: {id:<string>, type:"function",
//                 function:{name:<string>, arguments:<JSON string>}}   [1][5]
// ─────────────────────────────────────────────────────────────────────────────
function normalizeChatToolCalls(tcs) {
  if (!Array.isArray(tcs)) return [];
  return tcs
    .filter((tc) => tc && ((tc.function && tc.function.name) || tc.name))
    .map((tc, i) => {
      const fn = tc.function || tc;
      return {
        id: tc.id || tc.call_id || synthId("call_"),
        type: "function",
        function: {
          name: String(fn.name),
          arguments: argsToString(fn.arguments),
        },
      };
    });
}

function parseToolCalls(raw, opts) {
  if (!raw || typeof raw !== "object") return [];
  const allowed = opts && Array.isArray(opts.allowedNames) ? opts.allowedNames : null;

  // 1 ── OpenAI / Groq / llama.cpp chat completions  [1][6]
  const chatMsg = raw.choices && raw.choices[0] && raw.choices[0].message;
  if (chatMsg && Array.isArray(chatMsg.tool_calls) && chatMsg.tool_calls.length) {
    return normalizeChatToolCalls(chatMsg.tool_calls);
  }

  // 2 ── Ollama native /api/chat — arguments OBJECT, no ids  [4]
  if (raw.message && Array.isArray(raw.message.tool_calls) && raw.message.tool_calls.length) {
    return normalizeChatToolCalls(raw.message.tool_calls);
  }

  // 3 ── OpenAI/Groq Responses API — output[] typed items  [2][5]
  if (Array.isArray(raw.output)) {
    const calls = raw.output.filter((it) => it && it.type === "function_call");
    if (calls.length) {
      return calls.map((it) => ({
        id: it.call_id || it.id || synthId(),
        type: "function",
        function: { name: String(it.name), arguments: argsToString(it.arguments) },
      }));
    }
    // textual output items may embed a call (rare) — fall through to text scan
    const texts = raw.output
      .map((it) => (it && (it.text || (it.content && it.content[0] && it.content[0].text))) || "")
      .filter(Boolean)
      .join("\n");
    if (texts) {
      const tc = extractTextToolCalls(texts, allowed);
      if (tc.length) return tc;
    }
  }

  // 4 ── Gemini generateContent — parts[].functionCall {name, args:OBJECT}  [3]
  const cand = raw.candidates && raw.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) {
    const fcs = cand.content.parts.filter((p) => p && p.functionCall);
    if (fcs.length) {
      return fcs.map((p, i) => ({
        id: synthId("call_"),
        type: "function",
        function: {
          name: String(p.functionCall.name),
          arguments: argsToString(p.functionCall.args),
        },
      }));
    }
  }

  // 5 ── Gemini "interactions" steps — {type:"function_call",...}  [3]
  const steps = (raw.interaction && raw.interaction.steps) || raw.steps;
  if (Array.isArray(steps)) {
    const fcs = steps.filter((s) => s && s.type === "function_call");
    if (fcs.length) {
      return fcs.map((s) => ({
        id: s.call_id || s.id || synthId(),
        type: "function",
        function: { name: String(s.name), arguments: argsToString(s.arguments) },
      }));
    }
  }

  // 6 ── Anthropic Messages API — content[].tool_use {id,name,input}  [7]
  if (Array.isArray(raw.content)) {
    const uses = raw.content.filter((b) => b && b.type === "tool_use");
    if (uses.length) {
      return uses.map((b) => ({
        id: b.id || synthId(),
        type: "function",
        function: { name: String(b.name), arguments: argsToString(b.input) },
      }));
    }
  }

  // 7 ── AWS Bedrock Converse — content[].toolUse {toolUseId,name,input}  [8]
  const bedrockBlocks = Array.isArray(raw.output && raw.output.message && raw.output.message.content)
    ? raw.output.message.content
    : Array.isArray(raw.content)
      ? raw.content
      : null;
  if (bedrockBlocks) {
    const uses = bedrockBlocks.filter((b) => b && b.toolUse);
    if (uses.length) {
      return uses.map((b) => ({
        id: b.toolUse.toolUseId || synthId(),
        type: "function",
        function: {
          name: String(b.toolUse.name),
          arguments: argsToString(b.toolUse.input),
        },
      }));
    }
  }

  // 8 ── Plain-text fallback (llama.cpp generic template / non-tool models) [6]
  const text =
    (opts && opts.text) ||
    (typeof raw.content === "string" ? raw.content : "") ||
    (raw.choices && raw.choices[0] && raw.choices[0].message
      ? raw.choices[0].message.content
      : "");
  if (typeof text === "string" && text) {
    const tc = extractTextToolCalls(text, allowed);
    if (tc.length) return tc;
  }

  return [];
}

// Auto-detect the dialect of a raw payload (for logs / tests).
function detectApi(raw) {
  if (!raw || typeof raw !== "object") return "unknown";
  if (raw.choices) return "openai";
  if (raw.message && raw.message.tool_calls !== undefined) return "ollama";
  if (Array.isArray(raw.output)) return "responses";
  if (raw.candidates) return "gemini";
  if (raw.interaction || raw.steps) return "gemini";
  if (raw.content && raw.stop_reason) return "anthropic";
  if ((raw.output && raw.output.message) || (Array.isArray(raw.content) && raw.content.some((b) => b && b.toolUse))) return "bedrock";
  if (typeof raw.content === "string" && (raw.stop !== undefined || raw.n_predict !== undefined)) return "llama-cpp";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND #2 — text → tool_calls (models with NO native function-calling)
// llama.cpp "generic" template & small local models emit the call as text [6].
// STRICT by design: a call is only accepted when BOTH a tool name and JSON
// arguments are found — and, when allowedNames is given, the name is in it.
// ─────────────────────────────────────────────────────────────────────────────
function extractTextToolCalls(text, allowedNames) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  const seen = new Set();
  const allowed = Array.isArray(allowedNames) && allowedNames.length ? new Set(allowedNames) : null;

  const push = (name, argsRaw) => {
    if (!name) return;
    name = String(name).trim();
    if (allowed && !allowed.has(name)) return;
    let argumentsStr;
    if (typeof argsRaw === "string") {
      argumentsStr = argsRaw.trim();
      try {
        JSON.parse(argumentsStr); // must at least be valid JSON
      } catch (e) {
        try {
          argumentsStr = JSON.stringify(argsToObject(argumentsStr));
        } catch (e2) {
          argumentsStr = "{}";
        }
      }
    } else {
      argumentsStr = argsToString(argsRaw);
    }
    const key = name + "|" + argumentsStr;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      id: synthId("call_"),
      type: "function",
      function: { name, arguments: argumentsStr },
    });
  };

  // (a) fenced code block holding {"name":...,"arguments":{...}}
  const fenceRe = /```(?:tool_call|toolcalls|json|javascript|js)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const obj = JSON.parse(body);
      const cand = normalizeLooseCallObject(obj);
      if (cand) push(cand.name, cand.arguments);
    } catch (e) {
      // block may contain a bare object after a marker line
      const inner = body.match(/\{[\s\S]*\}/);
      if (inner) {
        try {
          const cand = normalizeLooseCallObject(JSON.parse(inner[0]));
          if (cand) push(cand.name, cand.arguments);
        } catch (e2) { /* not a call */ }
      }
    }
  }

  // (b) TOOL_CALL: name({json})  — parens around the JSON are optional
  const markerRe = /TOOL_CALL:\s*([A-Za-z0-9_\-.]+)\s*\(?\s*(\{[\s\S]*?\})/g;
  while ((m = markerRe.exec(text)) !== null) push(m[1], m[2]);

  // (c) Hermes-style  <function=NAME>{json}</function>   (and <invoke name="NAME">)
  const hermesRe = /<function=([A-Za-z0-9_\-.]+)>(\{[\s\S]*?\})<\//g;
  while ((m = hermesRe.exec(text)) !== null) push(m[1], m[2]);
  const invokeRe = /<invoke\s+name=["']([A-Za-z0-9_\-.]+)["']>\s*(\{[\s\S]*?\})<\//g;
  while ((m = invokeRe.exec(text)) !== null) push(m[1], m[2]);

  // (d) bare {"name":"x","arguments":{...}} / {"function":"x","args":{...}}
  const bareRe = /\{\s*"(?:name|function|tool)"\s*:\s*"([A-Za-z0-9_\-.]+)"\s*,\s*"(?:arguments|args|parameters|params)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((m = bareRe.exec(text)) !== null) push(m[1], m[2]);

  return found;
}

// Accept loose JSON call objects: {name, arguments} | {function, args} |
// {tool, parameters} | {"function":{name, arguments}}
function normalizeLooseCallObject(obj) {
  if (!isPlainObject(obj)) return null;
  if (isPlainObject(obj.function) && obj.function.name) {
    return { name: obj.function.name, arguments: obj.function.arguments ?? obj.function.args ?? {} };
  }
  const name = obj.name || obj.function || obj.tool;
  if (typeof name !== "string") return null;
  const args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.params;
  if (args === undefined) return null;
  return { name, arguments: args };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience — does this normalized OpenAI payload contain tool calls?
// ─────────────────────────────────────────────────────────────────────────────
function normalizedHasToolCalls(normalized) {
  const msg =
    normalized &&
    normalized.choices &&
    normalized.choices[0] &&
    normalized.choices[0].message;
  return !!(msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length);
}

// Best-effort plain TEXT from any dialect (so a function-call response can
// still carry whatever the model said alongside the call).
function extractText(raw) {
  if (!raw || typeof raw !== "object") return "";
  // Gemini parts
  const parts = raw.candidates && raw.candidates[0] && raw.candidates[0].content && raw.candidates[0].content.parts;
  if (Array.isArray(parts)) return parts.filter((p) => p && typeof p.text === "string").map((p) => p.text).join("");
  // Responses API output items (message / output_text)
  if (Array.isArray(raw.output)) {
    return raw.output
      .map((it) => {
        if (!it) return "";
        if (typeof it.text === "string") return it.text;
        if (Array.isArray(it.content)) return it.content.map((c) => (c && c.text) || "").join("");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  // Anthropic text blocks / Bedrock text blocks
  if (Array.isArray(raw.content)) {
    return raw.content
      .filter((b) => b && (b.type === "text" || b.text !== undefined))
      .map((b) => b.text || "")
      .join("");
  }
  // Ollama native message
  if (raw.message && typeof raw.message.content === "string") return raw.message.content;
  if (typeof raw.output_text === "string") return raw.output_text;
  return "";
}

module.exports = {
  APIS,
  // outbound
  toProviderTools,
  toProviderMessages,
  // inbound
  parseToolCalls,
  normalizeChatToolCalls,
  extractTextToolCalls,
  extractText,
  detectApi,
  normalizedHasToolCalls,
  // helpers (exported for tests + gateway)
  normalizeToolDef,
  sanitizeGeminiSchema,
  argsToString,
  argsToObject,
};

// ─────────────────────────────────────────────────────────────────────────────
// Standalone self-test: node "external tools/tool.js" --selftest
// Fixtures below are copied from the official docs cited at the top.
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module && process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const ok = (name, cond) => {
    if (cond) { pass++; console.log("  ✅ " + name); }
    else { fail++; console.log("  ❌ " + name); }
  };

  const chatTools = [
    { type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"], additionalProperties: false } } },
  ];

  // [1] Groq/OpenAI chat response
  const groqResp = { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_abc123", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"San Francisco, CA\"}" } }] }, finish_reason: "tool_calls" }] };
  const t1 = parseToolCalls(groqResp);
  ok("[1] Groq chat tool_calls passthrough", t1.length === 1 && t1[0].id === "call_abc123" && t1[0].function.arguments.includes("San Francisco"));

  // [4] Ollama native: object arguments, no id
  const ollamaResp = { message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { index: 0, name: "get_temperature", arguments: { city: "New York" } } }] } };
  const t2 = parseToolCalls(ollamaResp);
  ok("[4] Ollama object args → JSON string + id", t2.length === 1 && typeof t2[0].function.arguments === "string" && JSON.parse(t2[0].function.arguments).city === "New York" && !!t2[0].id);

  // [4] Ollama history: tool_name
  const om = toProviderMessages([{ role: "user", content: "temp?" }, { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_temperature", arguments: "{\"city\":\"NY\"}" } }] }, { role: "tool", tool_call_id: "call_1", content: "22°C" }], "ollama");
  ok("[4] Ollama tool result uses tool_name", om[2].role === "tool" && om[2].tool_name === "get_temperature" && om[2].content === "22°C");

  // [3] Gemini generateContent response
  const gemResp = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "set_light_values", args: { brightness: 25, color_temp: "warm" } } }] }, finishReason: "STOP" }] };
  const t3 = parseToolCalls(gemResp);
  ok("[3] Gemini functionCall part → tool_calls", t3.length === 1 && t3[0].function.name === "set_light_values" && JSON.parse(t3[0].function.arguments).brightness === 25);

  // [3] Gemini tools request shape + schema sanitize
  const gt = toProviderTools(chatTools, "gemini");
  ok("[3] Gemini tools → functionDeclarations", Array.isArray(gt) && gt[0].functionDeclarations[0].name === "get_weather" && gt[0].functionDeclarations[0].parameters.additionalProperties === undefined);

  // [3] Gemini history: functionCall + functionResponse
  const gh = toProviderMessages([{ role: "user", content: "lights?" }, { role: "assistant", content: "", tool_calls: [{ id: "call_9", type: "function", function: { name: "set_light_values", arguments: "{\"brightness\":25}" } }] }, { role: "tool", tool_call_id: "call_9", content: "{\"ok\":true}" }], "gemini");
  ok("[3] Gemini history model→functionCall / tool→functionResponse",
    gh[1].role === "model" && gh[1].parts[0].functionCall.name === "set_light_values" &&
    gh[2].role === "user" && gh[2].parts[0].functionResponse.name === "set_light_values" &&
    gh[2].parts[0].functionResponse.response.ok === true);

  // [5] OpenAI Responses API
  const respResp = { id: "resp_1", output: [{ id: "fc_123", call_id: "call_12345xyz", type: "function_call", name: "get_horoscope", arguments: "{\"sign\":\"Taurus\"}" }] };
  const t5 = parseToolCalls(respResp);
  ok("[5] Responses output[] function_call → tool_calls", t5.length === 1 && t5[0].id === "call_12345xyz" && JSON.parse(t5[0].function.arguments).sign === "Taurus");
  const rt = toProviderTools(chatTools, "responses");
  ok("[5] Responses tools are FLAT (no function wrapper)", rt[0].type === "function" && rt[0].name === "get_weather" && !rt[0].function);
  const rh = toProviderMessages([{ role: "user", content: "horoscope?" }, { role: "assistant", content: "", tool_calls: [{ id: "call_12345xyz", type: "function", function: { name: "get_horoscope", arguments: "{\"sign\":\"Taurus\"}" } }] }, { role: "tool", tool_call_id: "call_12345xyz", content: "otter" }], "responses");
  ok("[5] Responses history → function_call_output", rh[2].type === "function_call_output" && rh[2].call_id === "call_12345xyz" && rh[2].output === "otter");

  // [6] llama.cpp text fallback
  const t6 = extractTextToolCalls('I will call the tool.\n```tool_call\n{"name":"python","arguments":{"code":"print(1)"}}\n```', ["python"]);
  ok("[6] llama.cpp generic text → tool_calls (name-filtered)", t6.length === 1 && t6[0].function.name === "python" && JSON.parse(t6[0].function.arguments).code === "print(1)");
  const t6b = extractTextToolCalls('TOOL_CALL: get_weather({"location":"Paris"})', ["get_weather"]);
  ok("[6] TOOL_CALL: marker → tool_calls", t6b.length === 1 && t6b[0].function.name === "get_weather");
  const t6c = extractTextToolCalls('{"name":"evil_tool","arguments":{}}', ["python"]);
  ok("[6] unknown tool name rejected when allow-list given", t6c.length === 0);

  // [7] Anthropic tool_use
  const antResp = { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } }], stop_reason: "tool_use" };
  const t7 = parseToolCalls(antResp);
  ok("[7] Anthropic tool_use → OpenAI tool_calls", t7.length === 1 && t7[0].id === "toolu_1" && JSON.parse(t7[0].function.arguments).location === "Paris");

  // [8] Bedrock toolUse
  const brResp = { output: { message: { content: [{ toolUse: { toolUseId: "ts_1", name: "get_weather", input: { location: "Rome" } } }] } }, stopReason: "tool_use" };
  const t8 = parseToolCalls(brResp);
  ok("[8] Bedrock toolUse → OpenAI tool_calls", t8.length === 1 && t8[0].id === "ts_1" && JSON.parse(t8[0].function.arguments).location === "Rome");

  // detect + negative
  ok("detectApi labels", detectApi(gemResp) === "gemini" && detectApi(groqResp) === "openai" && detectApi(ollamaResp) === "ollama" && detectApi(respResp) === "responses" && detectApi(antResp) === "anthropic");
  ok("plain text without call → []", parseToolCalls({ choices: [{ message: { content: "hello world" } }] }).length === 0);

  console.log("\n  SELFTEST: " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
