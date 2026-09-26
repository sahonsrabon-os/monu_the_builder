"use strict";
/**
 * model-alias.js — public alias -> canonical model id (Mission Barisal).
 *
 * P1 (Zombie Mini display alias): callers may address the local model by a
 * public name ("zombie-mini") while everything downstream keeps the canonical
 * id ("llama-local", design log S6). Aliases live in the MODEL_ALIASES env
 * var, format: public:canonical,comma-separated
 *
 * Why an env var and not the provider model lists: the normalizer sync prunes
 * any custom-provider entry whose apiModel the upstream does not report, and
 * llama.cpp reports only its loaded/aliased model. A dedicated alias map is
 * therefore applied BEFORE provider resolution and survives every sync.
 *
 * Splitting uses the FIRST colon, so canonical ids may themselves contain
 * colons (ollama-style tags like qwen2:0.5b). Only aliases are configured
 * here — provider model lists keep their own literal-colon semantics.
 *
 * Pure functions, no fs, no paths: string in, resolver out.
 */

/**
 * Parse an alias string into a Map (public name -> canonical id).
 * Entries that are not public:canonical are ignored (safe for junk).
 */
function parseAliases(str) {
  const out = new Map();
  if (!str || typeof str !== "string") return out;
  for (const raw of str.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const idx = entry.indexOf(":");
    if (idx <= 0) continue; // no separator or empty public name
    const pub = entry.slice(0, idx).trim();
    const canonical = entry.slice(idx + 1).trim();
    if (pub && canonical) out.set(pub, canonical);
  }
  return out;
}

/**
 * Build a resolver: alias -> canonical, anything else passes through
 * unchanged (including non-strings and empty values).
 */
function makeAliasResolver(str) {
  const aliases = parseAliases(str);
  if (aliases.size === 0) {
    return (model) => model;
  }
  return (model) => {
    if (typeof model !== "string" || !model) return model;
    return aliases.get(model) || model;
  };
}

module.exports = { parseAliases, makeAliasResolver };
