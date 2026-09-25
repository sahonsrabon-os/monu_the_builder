#!/usr/bin/env node
'use strict';

/**
 * test-cdp.js — live test for cdp-driver.js
 *
 * Launches its OWN headless Chrome on a RANDOM free port, proves every driver
 * feature, prints a PASS/FAIL checklist and exits 0 (all pass) / 1 (any fail).
 *
 * Zero npm dependencies. CommonJS. All temp artifacts under /tmp/opencode/.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  CDPDriver,
  launchChrome,
  stopChrome,
  freePort,
  getTargets,
  DEFAULT_BLOCK_PATTERNS,
} = require('./cdp-driver');

// Shared Evidence JSON writer — every run is archived under Test/Evidence/.
const { createEvidence } = require('../lib/evidence.js');

const TMP_ROOT = '/tmp/opencode';
const uuid = crypto.randomUUID();

const results = [];
const ev = createEvidence('test-cdp.js', 'CDP');
ev.meta({ run_uuid: uuid, tmp_root: TMP_ROOT });

function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  ev.check(name, pass, detail);
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}
function info(...args) {
  ev.note(args.join(' '));
  console.log('INFO |', ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  /* ---- 1. random free port + random user-data-dir (never 9222) ------- */
  const chromePort = await freePort(); // bind-probe, random
  const userDataDir = path.join(TMP_ROOT, `cdp-${uuid}`);
  const shotPath = path.join(TMP_ROOT, `cdp-test-${uuid}.png`);
  ev.meta({ chrome_port: chromePort, user_data_dir: userDataDir, screenshot: shotPath });
  info(`chrome debug port = ${chromePort} (random, not 9222)`);
  info(`user-data-dir = ${userDataDir}`);

  let chrome = null;
  let driver = null;
  let server = null;

  try {
    /* ---- 2. launch headless Chrome, wait for /json/list page target --- */
    chrome = launchChrome({ headless: true, port: chromePort, userDataDir });
    info(`spawned chrome pid=${chrome.proc.pid}`);

    const t0 = Date.now();
    let targets = null;
    while (Date.now() - t0 < 15000) {
      if (chrome.proc.exitCode !== null) {
        throw new Error(
          `chrome exited early (code ${chrome.proc.exitCode}): ${chrome.proc.cdpOutput.slice(-800)}`
        );
      }
      try {
        const ts = await getTargets('127.0.0.1', chromePort, 2000);
        if (ts.some((t) => t.type === 'page')) {
          targets = ts;
          break;
        }
      } catch (e) {
        /* retry */
      }
      await sleep(300);
    }
    if (!targets) throw new Error('no page target on /json/list within 15s');
    info(`chrome ready in ${Date.now() - t0}ms, targets=${targets.length}`);

    /* ---- 3. connect + createPage + applyStealth ----------------------- */
    driver = new CDPDriver();
    await driver.connect({ host: '127.0.0.1', port: chromePort });
    info(`connected: ${driver.wsUrl}`);

    const sessionId = await driver.createPage('about:blank');
    info(`createPage → sessionId=${sessionId}`);

    const st = await driver.applyStealth(sessionId);
    info(`applyStealth → fingerprint=${JSON.stringify(st.fingerprint)}`);

    /* ---- CHECK 1: navigator.webdriver strictly undefined -------------- */
    const wd = await driver.evaluate(sessionId, 'navigator.webdriver');
    check(
      'CHECK 1 navigator.webdriver === undefined',
      wd === undefined,
      `typeof=${typeof wd}, value=${JSON.stringify(wd)}`
    );

    /* ---- CHECK 2: page UA === Browser.getVersion().userAgent ---------- */
    const bv = await driver.send('Browser.getVersion', {});
    const pageUA = await driver.evaluate(sessionId, 'navigator.userAgent');
    check(
      'CHECK 2 page UA === Browser.getVersion().userAgent (real value kept, not spoofed)',
      pageUA === bv.userAgent,
      `pageUA=${pageUA} | browserUA=${bv.userAgent} | equal=${pageUA === bv.userAgent}`
    );

    /* ---- CHECK 3: navigator.language + syncFingerprint ---------------- */
    let syncErr = null;
    let fp = null;
    try {
      fp = await driver.syncFingerprint(sessionId);
    } catch (e) {
      syncErr = e.message;
    }
    const lang = await driver.evaluate(sessionId, 'navigator.language');
    const langOk =
      typeof lang === 'string' && lang.length > 0 && syncErr === null;
    check(
      'CHECK 3 navigator.language non-empty + syncFingerprint applied without error',
      langOk,
      `language=${JSON.stringify(lang)} languages=${JSON.stringify(
        fp && fp.languages
      )} acceptLanguage=${fp && fp.acceptLanguage} overrideApplied=${
        fp && fp.userAgentOverrideApplied
      }${syncErr ? ` ERROR=${syncErr}` : ''}`
    );

    /* ---- CHECK 4: request blocking / interception --------------------- */
    // Local HTTP server: `/` serves the test page, `/ok` returns 200,
    // `/pixel?track=1` would return 200 if it were ever allowed through.
    server = http.createServer((req, res) => {
      const u = req.url || '/';
      if (u.startsWith('/pixel')) {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end('GIF89a');
        return;
      }
      if (u.startsWith('/ok')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><html><head><title>cdp-test</title></head><body><h1>cdp test</h1><script>
          window.__ok = null; window.__blocked = null; window.__pixel = null;
          fetch("/ok").then(r => r.text()).then(() => { window.__ok = "sent"; })
            .catch(e => { window.__ok = "error"; });
          fetch("http://127.0.0.1:${serverPort}/pixel?track=1")
            .then(() => { window.__pixel = "sent"; })
            .catch(e => { window.__blocked = "blocked"; });
        </script></body></html>`
      );
    });
    const serverPort = await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const pageUrl = `http://127.0.0.1:${serverPort}/`;
    info(`local test server on ${pageUrl}`);

    // Collect CDP network events for the proof below.
    const netEvents = { willBeSent: [], responseReceived: [], paused: [] };
    driver.onEvent('Network.requestWillBeSent', (p) =>
      netEvents.willBeSent.push((p.request && p.request.url) || '')
    );
    driver.onEvent('Network.responseReceived', (p) =>
      netEvents.responseReceived.push((p.response && p.response.url) || '')
    );
    driver.onEvent('Fetch.requestPaused', (p) =>
      netEvents.paused.push((p.request && p.request.url) || '')
    );

    await driver.send('Network.enable', {}, sessionId);

    const blocking = await driver.enableRequestBlocking(sessionId, [
      ...DEFAULT_BLOCK_PATTERNS,
      '/pixel',
      '*track*',
    ]);
    info(`blocking = ${JSON.stringify(blocking)}`);

    await driver.navigate(sessionId, pageUrl, 30000);
    await sleep(1200); // let both fetches settle

    const win = await driver.evaluate(
      sessionId,
      'JSON.stringify({ok: window.__ok, blocked: window.__blocked, pixel: window.__pixel})'
    );
    const state = JSON.parse(win);
    info(`page state = ${win}`);
    info(
      `events: requestWillBeSent=${netEvents.willBeSent.length} responseReceived=${netEvents.responseReceived.length} requestPaused=${netEvents.paused.length}`
    );

    const pixelResp = netEvents.responseReceived.filter((u) => u.includes('/pixel'));
    const pixelReq = netEvents.willBeSent.filter((u) => u.includes('/pixel'));
    const pixelPaused = netEvents.paused.filter((u) => u.includes('/pixel'));
    const okReq = netEvents.willBeSent.filter((u) => u.includes('/ok'));

    /*
     * ASSERTION CHOSEN (stated as required):
     *   - `window.__blocked === "blocked"`  → the /pixel fetch REJECTED in the
     *     page (BlockedByClient), proving interception fired.
     *   - `window.__ok === "sent"`          → the normal /ok fetch PASSED
     *     through untouched (raw passthrough).
     *   - EVENT PROOF: `Network.responseReceived` never contains /pixel —
     *     i.e. the tracking request NEVER completed over the wire. We do NOT
     *     rely on requestWillBeSent absence (Chrome may emit it before the
     *     Fetch pause), so the provable event assertion is "no /pixel response
     *     ever received", plus, in Fetch mode, `Fetch.requestPaused` observed
     *     for /pixel (paused at Request stage → failed with BlockedByClient).
     */
    const pass4 =
      state.blocked === 'blocked' &&
      state.ok === 'sent' &&
      pixelResp.length === 0 &&
      (blocking.transport === 'fetch'
        ? pixelPaused.length > 0
        : pixelReq.length > 0);
    check(
      'CHECK 4 request blocking: /pixel blocked + /ok passthrough + no /pixel response',
      pass4,
      `__blocked=${state.blocked} __ok=${state.ok} | pixel responses=${pixelResp.length} ` +
        `pixel requestWillBeSent=${pixelReq.length} pixel requestPaused=${pixelPaused.length} ` +
        `ok requestWillBeSent=${okReq.length} transport=${blocking.transport} | ` +
        `assertion: __blocked==="blocked" && __ok==="sent" && no /pixel responseReceived` +
        (blocking.transport === 'fetch' && pixelPaused.length > 0
          ? ' && Fetch.requestPaused seen for /pixel'
          : ' && /pixel requestWillBeSent seen (setBlockedURLS mode)')
    );

    /* ---- CHECK 5: screenshot ------------------------------------------ */
    const shot = await driver.screenshot(sessionId, shotPath);
    const size = fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0;
    check(
      'CHECK 5 screenshot written and > 0 bytes',
      size > 0,
      `${shotPath} size=${size} bytes (driver reported ${shot.bytes})`
    );
  } finally {
    /* ---- CLEANUP: only the resources THIS test created ---------------- */
    try {
      if (driver) await driver.close();
    } catch (e) {
      info(`driver.close error: ${e.message}`);
    }
    try {
      if (chrome) {
        // SIGKILL only OUR spawned pid, wait for exit, then remove the dir.
        const removed = await stopChrome(chrome, { userDataDir });
        info(
          `killed our chrome pid=${chrome.proc.pid}, user-data-dir removed=${removed}`
        );
      }
    } catch (e) {
      info(`chrome cleanup error: ${e.message}`);
    }
    try {
      if (server) await new Promise((r) => server.close(r));
    } catch (e) {
      info(`server close error: ${e.message}`);
    }
  }

  /* ---- report --------------------------------------------------------- */
  const passed = results.filter((r) => r.pass).length;
  console.log('');
  console.log('================ CDP TEST CHECKLIST ================');
  for (const r of results) {
    console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}`);
    console.log(`       ${r.detail}`);
  }
  console.log('====================================================');
  console.log(`CDP TEST: ${passed}/${results.length} PASSED`);
  try {
    ev.note(`CDP TEST: ${passed}/${results.length} PASSED`);
    const evFile = ev.write({
      screenshot: shotPath,
      user_data_dir: userDataDir,
      chrome_port: chromePort,
    });
    console.log('EVIDENCE: ' + evFile);
  } catch (e) {
    console.log('EVIDENCE WRITE FAILED: ' + e.message);
  }
  process.exit(passed === results.length ? 0 : 1);
}

/* global guard so the test can never hang forever */
const guard = setTimeout(() => {
  console.log('FAIL | global timeout (180s) — test hung');
  console.log('CDP TEST: 0/5 PASSED');
  try {
    ev.note('global timeout (180s) — test hung');
    console.log('EVIDENCE: ' + ev.write({}));
  } catch (_) {
    /* best-effort on the timeout path */
  }
  process.exit(1);
}, 180000);
guard.unref();

main().catch((e) => {
  console.log(`FAIL | unexpected error: ${e && e.stack ? e.stack : e}`);
  console.log('CDP TEST: 0/5 PASSED');
  try {
    ev.note('unexpected error: ' + ((e && e.stack) || e));
    console.log('EVIDENCE: ' + ev.write({}));
  } catch (_) {
    /* best-effort on the crash path */
  }
  process.exit(1);
});
