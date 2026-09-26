#!/usr/bin/env node
// =============================================================================
// TEST: "custom_ টেস্ট প্রভাইডারের অস্তিত্ব কি থাকা উচিত?" + লোকাল মডেল টুল-ক্যাপ
//       + Universal Tool-Call Adapter ("external tools/tool.js") ইন্টিগ্রেশন
// =============================================================================
// পদ্ধতি (evidence-based, কোনো অনুমান নয়):
//   1) STATIC  — api.js থেকে আসল সোর্স-লাইন টেক্সট পড়ে assert করা হয়
//   2) DYNAMIC — api.js-এর আসল ব্লক extract করে ঠিক সেই কোডকে eval
//                করানো হয় (copy নয় — আসল কোড)
//   3) PART C  — tool.js-এর ৬টা অফিসিয়াল ডকের fixture দিয়ে কনভার্সন যাচাই
//   4) PART D  — normalizeResponse-এর সাথে অ্যাডাপ্টার সংযোগ (static+dynamic)
//
// চলার পদ্ধতি:  node tests/local-tool-cap.test.js
// শেষে exit code 0 = সব assertion pass।
// =============================================================================
const fs = require("fs");
const path = require("path");
const { makeAliasResolver } = require("../tools/model-alias.js");

const SRC = path.resolve(__dirname, "..", "api.js");
const src = fs.readFileSync(SRC, "utf8");
const lines = src.split("\n");

let pass = 0, fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) { pass++; rows.push(["PASS", name, detail || ""]); }
  else { fail++; rows.push(["FAIL", name, detail || ""]); }
}
function fact(name, detail) { rows.push(["INFO", name, detail || ""]); }

// ─────────────────────────────────────────────────────────────
// PART A — STATIC: api.js-এ কোন লাইনে কী আছে, সেটা প্রমাণ
// ─────────────────────────────────────────────────────────────

// A1. custom_ regex টেস্ট api.js-এ বাস্তবেই ব্যবহৃত হয়?
const customRegexLine = lines.findIndex((l) => /\/\^custom_\/\.test\(agentProviderId\)/.test(l));
assert(
  "A1  api.js-এ /^custom_/.test(agentProviderId) ব্যবহার হয়েছে",
  customRegexLine > 0,
  "line " + (customRegexLine + 1)
);

// A2. custom_N provider আসলেই তৈরি হয় (loadCustomProviders)
const customLoaderLine = lines.findIndex((l) => /const providerId = "custom_" \+ num;/.test(l));
const loaderCallLine = lines.findIndex((l) => /^loadCustomProviders\(\);/.test(l));
assert(
  "A2  CUSTOM_PROVIDER_N_* env → custom_N provider তৈরি হয়",
  customLoaderLine > 0 && loaderCallLine > customLoaderLine,
  "loader line " + (customLoaderLine + 1) + " → call line " + (loaderCallLine + 1)
);

// A3. exactOnly=true হলে নাম না মিললে resolveProvider null রিটার্ন করে
const exactOnlyNullLine = lines.findIndex((l) => /if \(exactOnly\) return null;/.test(l));
assert(
  "A3  resolveProvider(model, true) → miss হলে null (key gap এখানে জন্মায়)",
  exactOnlyNullLine > 0,
  "line " + (exactOnlyNullLine + 1)
);

// A4. MAX_TOOLS_LIMIT কতবার redefine হয়েছে (drift risk)
const maxToolsLines = lines
  .map((l, i) => (/const MAX_TOOLS_LIMIT\s*=/.test(l) ? i + 1 : 0))
  .filter(Boolean);
fact("A4  MAX_TOOLS_LIMIT redefine হয়েছে " + maxToolsLines.length + " বার", "lines: " + maxToolsLines.join(", "));
assert(
  "A4  লোকাল ক্যাপ 5 / ক্লাউড ক্যাপ 15 ঠিক আছে",
  /const MAX_TOOLS_LIMIT = isLocalAgent \? 5 : 15;/.test(src),
  "line " + (maxToolsLines[maxToolsLines.length - 1])
);

// A5. MCP_TOOLS মোট কটি (TOC দাবি: 10)
const mcpStart = lines.findIndex((l) => /^const MCP_TOOLS = \{$/.test(l));
let mcpEnd = mcpStart;
while (mcpEnd < lines.length && lines[mcpEnd] !== "};") mcpEnd++;
const mcpKeys = lines
  .slice(mcpStart, mcpEnd)
  .map((l) => { const m = l.match(/^  ([a-z_]+): \{$/); return m ? m[1] : null; })
  .filter(Boolean);
const tocClaim = (lines.find((l) => /Total: .*MCP tools/.test(l)) || "").trim();
fact("A5  বাস্তব MCP_TOOLS সংখ্যা = " + mcpKeys.length, "TOC দাবি: " + tocClaim);
assert("A5  MCP_TOOLS ≥ 10 (TOC-র দাবি মেনে চলে)", mcpKeys.length >= 10, "বাস্তব: " + mcpKeys.length);

// A6. লোকাল মডেলের জন্য timeout আলাদা (cornering নয় — সুবিধা)
const localTimeout = lines.filter((l) => /timeout: isLocalCpu \? OLLAMA_TIMEOUT_MS : 60000/.test(l)).length;
assert("A6  লোকাল CPU-তে OLLAMA_TIMEOUT_MS (300s), ক্লাউডে 60s", localTimeout >= 2, localTimeout + " জায়গায়");

// A7. স্ট্রিম পাথে upstream হেডার আনে কিনা — getResponseStream শুধু stream রিটার্ন করে
const streamDropsHeaders = /return h2\.stream;/.test(src) && /resolve\(\{ stream: h2Stream, statusCode, headers: respHeaders/.test(src);
assert("A7  স্ট্রিম পাথ: h2.statusCode/headers ফেলে দেওয়া হয়, নন-স্ট্রিম: রাখা হয়", streamDropsHeaders, "line 5226 vs 11643");

// A8. ক্লাউড-নির্দিষ্ট User-Agent / x-opencode-* হেডার
assert(
  "A8  ক্লাউডে (opencode) ভিন্ন UA + x-opencode-* হেডার, লোকাল UDS-এ সাধারণ UA",
  /"opencode\/latest\/1\.3\.15\/cli"/.test(src) && /x-opencode-session/.test(src),
  "line 5203-5212, 5594-5603"
);

// A9. লোকাল প্রোভাইডার priority=10 (সবচেয়ে শেষ)
const customPriority = (lines.find((l) => /CUSTOM_PROVIDER_" \+ num \+ "_PRIORITY/.test(l)) || "").trim();
fact("A9  custom_N ডিফল্ট priority: " + (customPriority.includes('"10"') ? "10 (সর্বনিম্ন প্রাধান্য)" : "?"), "line 852-855");

// ─────────────────────────────────────────────────────────────
// PART B — DYNAMIC: api.js-এর আসল ব্লক নিয়েই চালানো
// ─────────────────────────────────────────────────────────────
const START_MARK = "// 🧟 LOCAL MODEL TOOL LIMIT:";
const SLICE_MARK = "toolsForStream = toolsForStream.slice(0, MAX_TOOLS_LIMIT);";
const sIdx = src.indexOf(START_MARK);
const slIdx = src.indexOf(SLICE_MARK);
if (sIdx < 0 || slIdx < 0) { console.error(" markers পাওয়া যায়নি"); process.exit(2); }
// ব্লক = START_MARK থেকে slice লাইনের পরের প্রথম `}` (cap ইফেটের ক্লোজ) পর্যন্ত
const sliceLineNo = src.slice(0, slIdx).split("\n").length;
let endIdx = slIdx, endLine = sliceLineNo;
for (let i = sliceLineNo; i < lines.length; i++) {
  endLine = i;
  if (lines[i].trim() === "}") { endIdx = src.split("\n").slice(0, i + 1).join("\n").length; break; }
}
const block = src.slice(sIdx, endIdx);
assert("B0  api.js থেকে আসল ব্লক extract হয়েছে", block.length > 200, block.split("\n").length + " লাইন");

// ─── আসল resolveProvider + তার হেল্পাররা api.js থেকেই extract করা হয় ───
// (পুরনো stub = প্রডাকশন লজিকের অনুকুল ছায়া-প্রতিলিপি ছিল — ডিজাইনের বাইরের
//  ওয়াটারমার্ক। এখন কপি নয়, আসল কোডই টেস্টে চলছে।)
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("extractFn: not found in api.js: " + name);
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error("extractFn: unbalanced braces for " + name);
  return src.slice(start, end);
}
const rpSrc = ["resolveProvider", "getModelName", "getApiModelName", "firstEnabledProviderId"]
  .map(extractFn)
  .join("\n");

function runBlock(resolveProvider, agentModel, toolsArg) {
  const agent = { id: "probe", model: agentModel };
  const logs = [];
  const log = (lvl, ev, data) => logs.push({ lvl, ev, data });
  const MCP_TOOLS = {};
  for (const k of mcpKeys) MCP_TOOLS[k] = { description: k, params: {}, required: [] };
  const tools = toolsArg;
  const factory = new Function(
    "resolveProvider", "agent", "log", "tools", "MCP_TOOLS",
    block + "\nreturn { isLocalAgent, MAX_TOOLS_LIMIT, toolsForStream, agentProviderId };"
  );
  return { ...factory(resolveProvider, agent, log, tools, MCP_TOOLS), logs };
}

const PROVIDERS = {
  opencode: { name: "OpenCode", priority: 1, models: ["gpt-4o-mini", "deepseek-r1-distill"], config: {} },
  ollama: { name: "Ollama", priority: 5, local: true, models: ["llama3.1:8b"] },
  custom_2: { name: "Custom-2", priority: 10, custom: true, models: ["phi3:mini"] },
};
// আসল resolveProvider চালাই — PROVIDER_CONFIG হিসেবে টেস্টের PROVIDERS বসানো
// applyModelAlias = api.js-এর প্রোডাকশন হুক (MODEL_ALIASES) — আসল রিসলভারই দেওয়া হয়
const realResolveProvider = new Function(
  "PROVIDER_CONFIG",
  "DISABLED_MODELS",
  "applyModelAlias",
  rpSrc + "\nreturn resolveProvider;",
)(PROVIDERS, new Set(), makeAliasResolver(process.env.MODEL_ALIASES || ""));
const rp = (m, e) => realResolveProvider(m, e);

// B1. custom_ provider = লোকাল → 5 টুল
const r1 = runBlock(rp, "phi3:mini");
assert("B1  custom_2 প্রোভাইডার → isLocalAgent=true, ক্যাপ=5", r1.isLocalAgent === true && r1.MAX_TOOLS_LIMIT === 5,
  "providerId=" + r1.agentProviderId + ", cap=" + r1.MAX_TOOLS_LIMIT);

// B2. ollama (local:true) রেজিস্টার্ড মডেল → 5 টুল
const r2 = runBlock(rp, "llama3.1:8b");
assert("B2  ollama(local:true) রেজিস্টার্ড মডেল → cap=5", r2.isLocalAgent === true && r2.MAX_TOOLS_LIMIT === 5,
  "providerId=" + r2.agentProviderId + ", cap=" + r2.MAX_TOOLS_LIMIT);

// B3. ক্লাউড মডেল → 15 টুল
const r3 = runBlock(rp, "gpt-4o-mini");
assert("B3  ক্লাউড মডেল → isLocalAgent=false, ক্যাপ=15", r3.isLocalAgent === false && r3.MAX_TOOLS_LIMIT === 15,
  "providerId=" + r3.agentProviderId + ", cap=" + r3.MAX_TOOLS_LIMIT);

// B4. GAP-1: লোকাল মডেল কিন্তু নাম ও প্রোভাইডার — দুটোই regex-এ পড়ে না
const r4 = runBlock(rp, "gemma4:31b"); // ollama-তে pull করা কিন্তু models list-এ নেই
assert(
  "B4  GAP: অন-রেজিস্টার্ড লোকাল মডেল → null → isLocalAgent=FALSE → ক্লাউডের মতো 15 টুল",
  r4.isLocalAgent === false && r4.MAX_TOOLS_LIMIT === 15 && r4.agentProviderId === "",
  "resolveProvider(exactOnly) null → /^custom_/.test('') = false"
);

// B5. GAP-2: ক্লাউড-হোস্টেড মডেল যার নাম deepseek/llama দিয়ে শুরু → ভুল লোকাল ধরা
const r5 = runBlock(rp, "deepseek-r1-distill");
assert("B5  GAP: ক্লাউড deepseek-r1-distill → নাম-regex মিলে যায় → ভুলভাবে cap=5", r5.isLocalAgent === true && r5.MAX_TOOLS_LIMIT === 5,
  "providerId=" + r5.agentProviderId + " (আসলে opencode ক্লাউড)");

// B6. লোকাল মডেল যে 5টি টুল পাবে — কোনগুলো?
const r6 = runBlock(rp, "llama3.1:8b");
const got5 = (r6.toolsForStream || []).map((t) => t.function.name);
const expect5 = mcpKeys.slice(0, 5);
assert("B6  লোকাল মডেল পায় ঠিক প্রথম 5টি টুল: " + got5.join(", "),
  JSON.stringify(got5) === JSON.stringify(expect5), "নির্বাচন = slice(0,5), কোনো priority নেই");
const lost = mcpKeys.slice(5);
fact("B6  লোকাল মডেলের কাছ থেকে বাদ পড়ল (" + lost.length + "টি): " + lost.join(", "), "");

// B7. লোকালে কোনো "শক্তিশালী" টুল নেই — grep/glob/exec/terminal/db_query বাদ
const powerTools = ["grep", "glob", "exec", "terminal", "db_query", "agent_mission"];
const lostPower = powerTools.filter((t) => !got5.includes(t));
assert("B7  লোকাল মডেলের 5-এ " + powerTools.length + "টি শক্তিশালী টুলই নেই", lostPower.length === powerTools.length,
  "বাদ পড়েছে: " + lostPower.join(", "));

// B8. ক্লাউড 15-এ কী পায় (প্রথম 15)
const r8 = runBlock(rp, "gpt-4o-mini");
const got15 = (r8.toolsForStream || []).map((t) => t.function.name);
const pos = (k) => mcpKeys.indexOf(k) + 1;
fact("B8  টুল অর্ডার অনুযায়ী অবস্থান: terminal #" + pos("terminal") + ", grep #" + pos("grep") + ", glob #" + pos("glob") + ", exec #" + pos("exec"), "ক্যাপ 15-এর বাইরে = কাউকে যায় না");
assert("B8  ক্লাউড=15-এ terminal পায়, কিন্তু grep/glob/exec (15-এর বাইরে) কাউকেই যায় না",
  got15.length === 15 && got15.includes("terminal") && !got15.includes("grep") && !got15.includes("exec"),
  "count=" + got15.length + ", grep@" + pos("grep") + " exec@" + pos("exec"));

// B9. custom_ টেস্ট প্রভাইডারের আসল প্রশ্ন: এটা কি "test-only" প্রভাইডার?
const isTestOnly = /if \(!url\) \{[^}]*Skipped: no URL set/.test(src);
assert("B9  custom_ প্রোভাইডার test-only নয় — URL থাকলেই প্রোডাকশন প্রোভাইডার হিসেবে লোড হয়",
  isTestOnly === true && loaderCallLine > 0, "line " + (customLoaderLine + 1) + " + startup call");
fact("B9  অর্থাৎ: এটা mutex/fixture নয়, এটা লোকাল-মডেল রাউটিংয়ের প্রধান চাবিকাঠি", "");

// ─────────────────────────────────────────────────────────────
// PART C — Universal Tool-Call Adapter ("external tools/tool.js")
//   ৬টা অফিসিয়াল ডকের fixture (Groq / Gemini / Ollama / OpenAI
//   Responses / llama.cpp / Anthropic / Bedrock) দিয়ে অ্যাডাপ্টারের
//   কনভার্সন যাচাই — কোনো অনুমান নয়, ডকের JSON কপি করা fixture।
// ─────────────────────────────────────────────────────────────
const ADAPTER_PATH = path.resolve(__dirname, "..", "external tools", "tool.js");
let ADAPTER = null;
try { ADAPTER = require(ADAPTER_PATH); } catch (e) { }
assert("C0  external tools/tool.js লোড হয়", !!ADAPTER,
  ADAPTER ? Object.keys(ADAPTER).length + " exports" : "load fail");

if (ADAPTER) {
  const chatTools = [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"], additionalProperties: false } } }];

  // C1 — Groq Tool Use doc: standard chat tool_calls [doc 1]
  const groqRaw = { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_abc123", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"San Francisco, CA\"}" } }] }, finish_reason: "tool_calls" }] };
  const c1 = ADAPTER.parseToolCalls(groqRaw);
  assert("C1  [Groq doc] chat tool_calls → canonical", c1.length === 1 && c1[0].id === "call_abc123" && JSON.parse(c1[0].function.arguments).location === "San Francisco, CA");

  // C2 — Ollama doc: arguments OBJECT, কোনো id নেই [doc 4]
  const ollamaRaw = { message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { index: 0, name: "get_temperature", arguments: { city: "New York" } } }] } };
  const c2 = ADAPTER.parseToolCalls(ollamaRaw);
  assert("C2  [Ollama doc] object args → JSON string + id synthesized", c2.length === 1 && typeof c2[0].function.arguments === "string" && JSON.parse(c2[0].function.arguments).city === "New York" && !!c2[0].id);

  // C3 — Ollama doc: tool result message → tool_name [doc 4]
  const om = ADAPTER.toProviderMessages([{ role: "tool", tool_call_id: "call_1", content: "22°C" }], "ollama");
  assert("C3  [Ollama doc] result message → {role:'tool', tool_name}", om[0].role === "tool" && om[0].tool_name === "call_1");

  // C4 — Gemini doc: parts[].functionCall {name, args:OBJECT} [doc 3]
  const gemRaw = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "set_light_values", args: { brightness: 25, color_temp: "warm" } } }] }, finishReason: "STOP" }] };
  const c4 = ADAPTER.parseToolCalls(gemRaw);
  assert("C4  [Gemini doc] functionCall part → tool_calls", c4.length === 1 && c4[0].function.name === "set_light_values" && JSON.parse(c4[0].function.arguments).brightness === 25);

  // C5 — Gemini doc: outbound functionDeclarations + schema sanitize [doc 3]
  const gt = ADAPTER.toProviderTools(chatTools, "gemini");
  assert("C5  [Gemini doc] tools → functionDeclarations, additionalProperties stripped",
    Array.isArray(gt) && gt[0].functionDeclarations[0].name === "get_weather" &&
    gt[0].functionDeclarations[0].parameters.additionalProperties === undefined);

  // C6 — Gemini doc: history — assistant→model functionCall, tool→user functionResponse [doc 3]
  const gh = ADAPTER.toProviderMessages([
    { role: "user", content: "lights?" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_9", type: "function", function: { name: "set_light_values", arguments: "{\"brightness\":25}" } }] },
    { role: "tool", tool_call_id: "call_9", content: "{\"ok\":true}" },
  ], "gemini");
  assert("C6  [Gemini doc] history → functionCall + functionResponse parts",
    gh[1].role === "model" && gh[1].parts[0].functionCall.name === "set_light_values" &&
    gh[2].role === "user" && gh[2].parts[0].functionResponse.name === "set_light_values" &&
    gh[2].parts[0].functionResponse.response.ok === true);

  // C7 — OpenAI Responses doc: FLAT tools + output[] function_call [doc 5]
  const respRaw = { id: "resp_1", output: [{ id: "fc_123", call_id: "call_12345xyz", type: "function_call", name: "get_horoscope", arguments: "{\"sign\":\"Taurus\"}" }] };
  const c7 = ADAPTER.parseToolCalls(respRaw);
  const rt = ADAPTER.toProviderTools(chatTools, "responses");
  assert("C7  [OpenAI Responses doc] output[] → tool_calls + FLAT tools",
    c7.length === 1 && c7[0].id === "call_12345xyz" && JSON.parse(c7[0].function.arguments).sign === "Taurus" &&
    rt[0].type === "function" && rt[0].name === "get_weather" && !rt[0].function);

  // C8 — llama.cpp doc: text-embedded call + allow-list [doc 6]
  const c8 = ADAPTER.extractTextToolCalls('```tool_call\n{"name":"python","arguments":{"code":"print(1)"}}\n```', ["python"]);
  const c8b = ADAPTER.extractTextToolCalls('{"name":"evil_tool","arguments":{}}', ["python"]);
  assert("C8  [llama.cpp doc] text → tool_calls; unknown name rejected", c8.length === 1 && JSON.parse(c8[0].function.arguments).code === "print(1)" && c8b.length === 0);

  // C9 — Anthropic tool_use → OpenAI shape (আগে raw ব্লক যেত, arguments অবজেক্ট ছিল)
  const c9 = ADAPTER.parseToolCalls({ content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } }], stop_reason: "tool_use" });
  assert("C9  [Anthropic] tool_use → {id, function:{name, arguments:STRING}}",
    c9.length === 1 && c9[0].id === "toolu_1" && typeof c9[0].function.arguments === "string" && JSON.parse(c9[0].function.arguments).location === "Paris");

  // C10 — Bedrock Converse toolUse [doc 8]
  const c10 = ADAPTER.parseToolCalls({ output: { message: { content: [{ toolUse: { toolUseId: "ts_1", name: "get_weather", input: { location: "Rome" } } }] } }, stopReason: "tool_use" });
  assert("C10 [Bedrock] toolUse → tool_calls", c10.length === 1 && c10[0].id === "ts_1");

  // C11 — কোনো call নেই → [] (ভুল positive নয়)
  assert("C11 plain text → [] (no false positive)", ADAPTER.parseToolCalls({ choices: [{ message: { content: "hello world" } }] }).length === 0);
}

// ─────────────────────────────────────────────────────────────
// PART D — নরমালাইজারের সাথে অ্যাডাপ্টারের সংযোগ (api.js)
//   STATIC: কোথায় যুক্ত হয়েছে + DYNAMIC: api.js থেকে আসল
//   normalizeResponse ব্লক extract করে eval করে fixture দেওয়া।
// ─────────────────────────────────────────────────────────────
assert("D1  api.js external tools/tool.js require করে",
  src.includes('require("./external tools/tool.js")'));

const gemOutboundCount = src.split('TOOLADAPTER.toProviderTools(tools, "gemini")').length - 1;
assert("D2  Gemini outbound: functionDeclarations দুই পাথে (non-stream + stream)",
  gemOutboundCount === 2, gemOutboundCount + " জায়গায়");

assert("D3  Gemini stream-এ functionCall accumulate + tool_calls রিসলভ",
  src.includes("streamToolCalls.push(...tc)") && src.includes("tool_calls: streamToolCalls"));
assert("D4  OpenAI stream-এ tool_call fragment accumulator (আগে শুধু ফ্ল্যাগ ছিল)",
  src.includes("accToolCalls") && src.includes("call_stream_"));

const passToolsStream = /return callGeminiModelStream\(\s*model,\s*messages,\s*temperature,\s*onChunk,\s*resolve,\s*providerId,\s*config,\s*tools,/.test(src);
const passToolsNonStream = /return callGeminiModel\(\s*model,\s*messages,\s*temperature,\s*resolve,\s*providerId,\s*config,\s*tools,/.test(src);
assert("D5  দুই call-site-এই tools পাস হয়", passToolsStream && passToolsNonStream,
  "stream=" + passToolsStream + " non-stream=" + passToolsNonStream);

// D6 — api.js থেকে আসল normalizeResponse ব্লক extract (copy নয়)
const nrStart = src.indexOf("function normalizeResponse(raw, modelHint) {");
const bannerIdx = nrStart > 0 ? src.indexOf("🔌 MODEL CALL", nrStart) : -1;
let nrBlock = "";
if (nrStart > 0 && bannerIdx > 0) nrBlock = src.slice(nrStart, src.lastIndexOf("\n", src.lastIndexOf("\n", bannerIdx)));
assert("D6  normalizeResponse ব্লক extract হয়েছে", nrBlock.length > 2000, nrBlock.length + " chars");

let normalizeResponse = null;
if (nrBlock) {
  try {
    normalizeResponse = new Function("log", "maskModelName", "TOOLADAPTER",
      nrBlock + "\nreturn normalizeResponse;")(() => {}, (m) => m, ADAPTER);
  } catch (e) { fact("D6  eval error", e.message); }
}
assert("D6b normalizeResponse eval হয়েছে", typeof normalizeResponse === "function");

if (typeof normalizeResponse === "function" && ADAPTER) {
  // D7 — Gemini + functionCall → tool_calls (আগে: টেক্সটই আসত না, ফাঁকি)
  const n7 = normalizeResponse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "set_light_values", args: { brightness: 25, color_temp: "warm" } } }] }, finishReason: "STOP" }] }, "gemini-flash");
  const m7 = n7.choices[0];
  assert("D7  normalizeResponse(gemini+functionCall) → finish=tool_calls + parsed args",
    m7.finish_reason === "tool_calls" && m7.message.tool_calls && m7.message.tool_calls.length === 1 &&
    JSON.parse(m7.message.tool_calls[0].function.arguments).color_temp === "warm" &&
    n7.toolCallsFrom === "universal-adapter",
    "originalFormat=" + n7.originalFormat);

  // D8 — Responses API output[] (আগে HAQ_MAWLA_UNKNOWN_FORMAT পড়ত)
  const n8 = normalizeResponse({ id: "resp_1", output: [{ call_id: "call_12345xyz", type: "function_call", name: "get_horoscope", arguments: "{\"sign\":\"Taurus\"}" }] }, "gpt-oss-120b");
  assert("D8  normalizeResponse(responses output[]) → tool_calls",
    n8.choices[0].message.tool_calls && n8.choices[0].message.tool_calls[0].id === "call_12345xyz",
    "originalFormat=" + n8.originalFormat);

  // D9 — Anthropic: arguments STRING (আগে raw input অবজেক্ট যেত)
  const n9 = normalizeResponse({ content: [{ type: "text", text: "আমি টুল ব্যবহার করছি" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } }], stop_reason: "tool_use" }, "claude-x");
  const t9 = n9.choices[0].message.tool_calls;
  assert("D9  normalizeResponse(anthropic tool_use) → string arguments + content রাখা",
    t9 && typeof t9[0].function.arguments === "string" && n9.choices[0].message.content.includes("আমি টুল"));

  // D10 — Gemini TEXT-ONLY regression: আগের পাথ অক্ষত
  const n10 = normalizeResponse({ candidates: [{ content: { role: "model", parts: [{ text: "নমস্কার ভাই!" }] }, finishReason: "STOP" }] }, "gemini-flash");
  assert("D10 gemini text-only → content অক্ষত, কোনো tool_calls নেই",
    n10.choices[0].message.content === "নমস্কার ভাই!" && !n10.choices[0].message.tool_calls && n10.choices[0].finish_reason === "stop");

  // D11 — unknown plain object → আগের fallback অক্ষত (crash নয়)
  const n11 = normalizeResponse({ foo: 1 }, "mystery-model");
  assert("D11 unknown format → unknown_external fallback অক্ষত",
    n11.originalFormat === "unknown_external" && n11.choices[0].message.role === "assistant");

  // D12 — OpenAI-ভিত্তিক পাথে object arguments (Ollama quirk) → string
  const n12 = normalizeResponse({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "f", arguments: { a: 1 } } }] }, finish_reason: "tool_calls" }] }, "m");
  assert("D12 choices-path: object arguments → JSON string (normalizeChatToolCalls)",
    typeof n12.choices[0].message.tool_calls[0].function.arguments === "string" &&
    JSON.parse(n12.choices[0].message.tool_calls[0].function.arguments).a === 1);

  // D13 — tool না থাকলে OpenAI পাথে tool_calls key থাকবে না (শূন্য array নয়)
  const n13 = normalizeResponse({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }, "m");
  assert("D13 plain chat → tool_calls key absent", !("tool_calls" in n13.choices[0].message));
}

// D14 — প্রক্সি /v1/chat/completions চূড়ান্ত রেসপন্সে tool_calls ফরোয়ার্ড
//   (এই ব্লক আগে finish_reason:"stop" হার্ডকোড করে tool_calls বাদ দিত —
//    লাইভে ধরা পড়েছিল, তাই এখন static regression guard)
const proxyForwardsTools =
  src.includes("proxyToolCalls") &&
  src.includes('finish_reason: proxyToolCalls.length ? "tool_calls" : "stop"');
assert("D14 প্রক্সি রেসপন্সে tool_calls forward + dynamic finish_reason", proxyForwardsTools);

// D15 — হেডারের TOOLS AVAILABLE লিস্ট ডায়নামিক (SSOT: রেজিস্ট্রি থেকে derive,
//   হার্ডকোড লিস্ট নয় — নতুন টুল যোগ হলেও হেডার নিজে থেকে আপডেট হবে)
const dynamicHeader =
  src.includes('Object.keys(MCP_TOOLS).sort().join(", ")') &&
  !src.includes("- TOOLS AVAILABLE: read_file, write_file, list_directory");
assert(
  "D15 এজেন্ট-হেডার টুল-লিস্ট = Object.keys(MCP_TOOLS) (কোনো হার্ডকোড লিস্ট নেই)",
  dynamicHeader,
  "registry-derived",
);

// D16 — append_syllabus টুল রেজিস্ট্রিতে + ডিসপ্যাচে (ডক-অডিটের মিসম্যাচ ফিক্স:
//   হেডার rule-5 যে টুলটা চায় সেটা সত্যিই আছে কিনা)
const hasAppendEntry =
  /append_syllabus:\s*\{[\s\S]{0,1500}required:\s*\["topic",\s*"summary"\]/.test(src);
const hasAppendCase = src.includes('case "append_syllabus":');
assert(
  "D16 append_syllabus: MCP_TOOLS entry + executeMcpTool case আছে",
  hasAppendEntry && hasAppendCase,
  "entry=" + hasAppendEntry + ", case=" + hasAppendCase,
);

// D17 — append_syllabus case-এর আচরণ (D6-র মতো extract+eval, stub writeSyllabus):
//   keyPoints স্ট্রিং হলে স্প্লিট, required মিসে গেলে writeSyllabus কলই হয় না
{
  const cs = src.indexOf('case "append_syllabus":');
  const ce = src.indexOf('case "list_directory": {', cs);
  let blockOk = false, a = "", b = "";
  if (cs >= 0 && ce > cs) {
    const block = src.slice(src.indexOf(":", cs) + 1, ce).trim(); // "{ ... }"
    const fn = new Function(
      "args", "writeSyllabus", "mcpWorkingDir", "log",
      "return (function run(args, writeSyllabus, mcpWorkingDir, log) " + block +
        ")(args, writeSyllabus, mcpWorkingDir, log);",
    );
    let cap = null;
    const outA = fn(
      { topic: "T1", summary: "S1", source: "Web Search", keyPoints: "a, b\nc" },
      (dir, topic, entry) => { cap = { dir, topic, entry }; return true; },
      "/wd", () => {},
    );
    a = (cap && cap.topic === "T1" && Array.isArray(cap.entry.keyPoints) &&
         cap.entry.keyPoints.join("|") === "a|b|c" && /appended: T1/.test(outA.content[0].text))
      ? "ok" : JSON.stringify(cap) + "|" + outA.content[0].text;
    let called = false;
    const outB = fn(
      { topic: "T2" },
      () => { called = true; return true; },
      "/wd", () => {},
    );
    b = (!called && /required/.test(outB.content[0].text)) ? "ok" : "called=" + called;
    blockOk = a === "ok" && b === "ok";
  }
  assert(
    "D17 append_syllabus: keyPoints split + required-guard (stubbed eval)",
    blockOk,
    "keypoints=" + a + ", guard=" + b,
  );
}

// ─────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════");
console.log("  TEST: local tool cap + custom_ provider existence");
console.log("  source: " + SRC);
console.log("══════════════════════════════════════════════════════════");
for (const [st, name, detail] of rows) {
  const tag = st === "PASS" ? "  ✅ " : st === "FAIL" ? "  ❌ " : "  ℹ️  ";
  console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
}
console.log("────────────────────────────────────────────────────────────");
console.log("  RESULT: " + pass + " passed, " + fail + " failed, " + rows.filter(r => r[0] === "INFO").length + " facts");
console.log("══════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
