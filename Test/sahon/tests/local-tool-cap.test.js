#!/usr/bin/env node
// =============================================================================
// TEST: "custom_ টেস্ট প্রভাইডারের অস্তিত্ব কি থাকা উচিত?" + লোকাল মডেল টুল-ক্যাপ
// =============================================================================
// পদ্ধতি (evidence-based, কোনো অনুমান নয়):
//   1) STATIC  — api.js থেকে আসল সোর্স-লাইন টেক্সট পড়ে assert করা হয়
//   2) DYNAMIC — api.js-এর 14551-14580 ব্লকের কোডটা নিজে থেকে extract করে
//                ঠিক সেই কোডকে eval করানো হয় (copy নয় — আসল কোড)
//
// চলার পদ্ধতি:  node tests/local-tool-cap.test.js
// শেষে exit code 0 = সব assertion pass।
// =============================================================================
const fs = require("fs");
const path = require("path");

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

// হেল্পার: resolveProvider-এর exactOnly আচরণের ছায়া-প্রতিলিপি
function stubResolveProvider(providerMap, model, exactOnly) {
  for (const [id, p] of Object.entries(providerMap)) {
    if ((p.models || []).includes(model)) return { providerId: id, config: p };
  }
  if (exactOnly) return null;
  const firstId = Object.keys(providerMap)[0];
  return { providerId: firstId, config: providerMap[firstId], matchType: "fallback" };
}

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
const rp = (m, e) => stubResolveProvider(PROVIDERS, m, e);

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
