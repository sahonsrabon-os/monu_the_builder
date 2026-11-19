#!/usr/bin/env node
/**
 * evidence.js — shared Evidence JSON writer for every Mission Barisal test
 * script.
 *
 * Every test run writes one machine-readable record to Test/Evidence/ so
 * that each script's outcome doubles as a durable backup artifact.
 *
 * File naming:  <script-slug>-<finished-at ISO-8601 with : and . replaced
 * by ->.json   (timestamped — runs accumulate, nothing is overwritten)
 *
 * Payload schema (missionbarisal-test-evidence/v1):
 *   {
 *     schema, script, category,
 *     started_at, finished_at, duration_ms,
 *     environment: { node, platform, arch, hostname, cwd, pid,
 *                    collected_at, ...caller metadata },
 *     summary: { status: "PASS" | "FAIL", total, passed, failed },
 *     tests: [ { name, status: "PASS" | "FAIL" | "SKIP", detail } ],
 *     notes: [ "free-form info lines captured during the run" ],
 *     artifacts: { ...file paths, directories, screenshots... }
 *   }
 *
 * Usage inside a test script:
 *
 *   const { createEvidence } = require("../lib/evidence.js");
 *   const ev = createEvidence("test-thing.js", "Thing");
 *   ev.meta({ run_uuid: uuid });           // environment metadata
 *   ev.note("boot took 751ms");            // free-form info line
 *   ev.check("health is 200", r === 200);  // record from boolean
 *   ev.test("named result", "FAIL", "...") // record explicitly
 *   const file = ev.write({ root: "/tmp/..." });  // flush to Evidence/
 *
 * The writer never throws into the test flow: write() failures are the
 * caller's problem to catch if it cares; a test that cannot write evidence
 * should still report on stdout.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const EVIDENCE_DIR = path.resolve(__dirname, "..", "Evidence");

function envSnapshot(extra) {
  const snap = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cwd: process.cwd(),
    pid: process.pid,
    collected_at: new Date().toISOString(),
  };
  if (extra && typeof extra === "object" && extra !== null) {
    Object.assign(snap, extra);
  }
  return snap;
}

/**
 * Create an evidence recorder for one test script.
 * @param {string} script   script file name, e.g. "test-multi-instance.js"
 * @param {string} category Test/ category folder, e.g. "MultiInstance"
 * @returns recorder with meta/note/test/check/counts/write
 */
function createEvidence(script, category) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const tests = [];
  const notes = [];
  const meta = {};

  const rec = {
    script,
    category,

    /** Merge environment/metadata fields into the record. */
    meta(obj) {
      if (obj && typeof obj === "object") Object.assign(meta, obj);
      return rec;
    },

    /** Append a free-form info line (captured verbatim in notes[]). */
    note(text) {
      notes.push(String(text));
      return rec;
    },

    /**
     * Record one test result.
     * @param {string} name   human-readable test name
     * @param {"PASS"|"FAIL"|"SKIP"} status
     * @param {string} [detail] exact evidence (values, payloads, timings)
     */
    test(name, status, detail) {
      tests.push({
        name: String(name),
        status,
        detail: detail == null ? "" : String(detail),
      });
      return rec;
    },

    /** Record from a boolean: true -> PASS, false -> FAIL. */
    check(name, cond, detail) {
      return rec.test(name, cond ? "PASS" : "FAIL", detail);
    },

    /** Current tallies. */
    counts() {
      const passed = tests.filter((t) => t.status === "PASS").length;
      const failed = tests.filter((t) => t.status === "FAIL").length;
      const skipped = tests.filter((t) => t.status === "SKIP").length;
      return { total: tests.length, passed, failed, skipped };
    },

    /**
     * Flush to Test/Evidence/<slug>-<timestamp>.json.
     * @param {object} [artifacts] artifact paths / directories of the run
     * @returns {string} absolute path of the written JSON file
     */
    write(artifacts) {
      const finishedAt = new Date().toISOString();
      const c = rec.counts();
      const payload = {
        schema: "missionbarisal-test-evidence/v1",
        script,
        category,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Date.now() - t0,
        environment: envSnapshot(meta),
        summary: {
          status: c.failed === 0 && c.total > 0 ? "PASS" : "FAIL",
          total: c.total,
          passed: c.passed,
          failed: c.failed,
          skipped: c.skipped,
        },
        tests,
        notes,
        artifacts:
          artifacts && typeof artifacts === "object" ? artifacts : {},
      };
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const stamp = finishedAt.replace(/[:.]/g, "-");
      const slug = path.basename(script, ".js");
      const file = path.join(EVIDENCE_DIR, slug + "-" + stamp + ".json");
      fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
      return file;
    },
  };

  return rec;
}

module.exports = { createEvidence, EVIDENCE_DIR };
