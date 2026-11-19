#!/usr/bin/env node
'use strict';

/**
 * cdp-driver.js — zero-dependency Chrome DevTools Protocol (CDP) driver.
 *
 * Uses the GLOBAL WebSocket client built into Node.js >= 22 (browser-style API).
 * NO npm packages — project rule: zero dependencies.
 *
 * CommonJS (require / module.exports).
 *
 * Public API:
 *   - class CDPDriver
 *   - launchChrome({ headless, port, userDataDir, extraArgs })
 *   - freePort(), getTargets(host, port)
 *   - DEFAULT_BLOCK_PATTERNS
 *
 * CLI demo:  node cdp-driver.js --demo
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const DEFAULT_CALL_TIMEOUT = 15000; // per-command timeout (ms)
const CHROME_BIN = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const TMP_ROOT = '/tmp/opencode';

/**
 * Default junk/tracking URL patterns that must never leave the browser.
 * These are URL SUBSTRINGS (or globs when they already contain `*`).
 *
 * Fetch.urlPattern is a wildcard GLOB matched against the whole request URL
 * (`*` = any characters). Patterns that do NOT contain `*` are wrapped as
 * `*<pattern>*` so they match as substrings (see toFetchPattern()).
 */
const DEFAULT_BLOCK_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.net',
  'fbclid=',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'sentry.io',
  'browser-intake',
  '/v1/collect',
  'telemetry',
  'doubleclick',
  'clarity.ms',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log('[cdp-driver]', ...args);
}

/** Bind-probe a random free TCP port on 127.0.0.1. NEVER hardcode ports. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

/** GET http://host:port/json/list → array of CDP targets (node:http). */
function getTargets(host = '127.0.0.1', port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/json/list', timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`/json/list HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`/json/list invalid JSON: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('/json/list timeout')));
    req.on('error', reject);
  });
}

/**
 * Convert a block pattern into a Fetch urlPattern (wildcard glob).
 * - pattern already contains `*` → pass through unchanged (e.g. `*track*`)
 * - bare substring (e.g. `google-analytics.com`) → wrap: `*google-analytics.com*`
 * Fetch matches the glob against the ENTIRE request URL.
 */
function toFetchPattern(pattern) {
  return pattern.includes('*') ? pattern : `*${pattern}*`;
}

/** Build a RegExp from the same pattern semantics (glob `*` → `.*`). */
function patternToRegex(pattern) {
  const src = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(src);
}

/**
 * Injected into every NEW document (and into the current one) via
 * Page.addScriptToEvaluateOnNewDocument.
 *
 * IMPORTANT: this only hides the automation flag `navigator.webdriver`.
 * We deliberately do NOT touch User-Agent, Canvas or Accept-Language —
 * the requirement is that the REAL Chrome values stay in sync (real
 * fingerprint, NO fake spoofing). See CDPDriver.syncFingerprint(), which
 * re-asserts the browser's own real values via Network.setUserAgentOverride.
 */
const STEALTH_SOURCE = `
(function () {
  // STEALTH: hide ONLY navigator.webdriver.
  // Do NOT spoof userAgent / canvas / accept-language — keep the real
  // Chrome fingerprint in sync instead (see syncFingerprint()).
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: function () { return undefined; },
      configurable: true,
    });
  } catch (e) {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: function () { return undefined; },
        configurable: true,
      });
    } catch (e2) { /* ignore */ }
  }
})();
`;

class CDPDriver extends EventEmitter {
  constructor({ callTimeout = DEFAULT_CALL_TIMEOUT } = {}) {
    super();
    this.callTimeout = callTimeout;
    this.ws = null;
    this.wsUrl = null;
    this.host = '127.0.0.1';
    this.port = null;
    this._seq = 0;
    this.pending = new Map(); // id → { resolve, reject, timer, method }
    this._handlers = new Map(); // method → Set<fn(params, sessionId)>
    this._closed = false;
    this.sessions = new Map(); // sessionId → targetId
    this.blockMode = null; // 'fetch' | 'network-blocked-urls'
    this._blockPatterns = [];
    this._fetchHandler = null;
  }

  /* ------------------------------------------------------------------ */
  /* connection                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * connect({ host, port })            → discover a page target via /json/list
   * connect({ wsUrl })                 → connect directly
   * connect({ host, port, discoverTimeout })  → retry discovery (default 15s)
   */
  async connect(opts = {}) {
    const {
      host = '127.0.0.1',
      port,
      wsUrl: directWs,
      discoverTimeout = 15000,
      openTimeout = 15000,
    } = opts;
    this.host = host;
    this.port = port;

    let wsUrl = directWs;
    if (!wsUrl) {
      if (!port) throw new Error('connect() requires { port } or { wsUrl }');
      const deadline = Date.now() + discoverTimeout;
      let lastErr = null;
      while (!wsUrl) {
        try {
          const targets = await getTargets(host, port, 2500);
          const page = targets.find(
            (t) => (t.type === 'page' || t.type === 'webview') && t.webSocketDebuggerUrl
          );
          if (page) wsUrl = page.webSocketDebuggerUrl;
        } catch (e) {
          lastErr = e;
        }
        if (!wsUrl) {
          if (Date.now() >= deadline) {
            throw new Error(
              `no page target on ${host}:${port} within ${discoverTimeout}ms` +
                (lastErr ? `: ${lastErr.message}` : '')
            );
          }
          await sleep(250);
        }
      }
    }

    this.wsUrl = wsUrl;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`WebSocket open timeout after ${openTimeout}ms: ${wsUrl}`));
      }, openTimeout);
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onErr);
        err ? reject(err) : resolve();
      };
      function onOpen() {
        done(null);
      }
      function onErr() {
        done(new Error(`WebSocket error opening ${wsUrl}`));
      }
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onErr);
    });

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      this._handleMessage(raw);
    });
    ws.addEventListener('close', (ev) =>
      this._handleClose(`socket closed (code ${ev && ev.code})`)
    );
    ws.addEventListener('error', () => this._handleClose('socket error'));
    return this;
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new Error(
            `CDP error on ${p.method}: ${msg.error.code} ${msg.error.message}`
          )
        );
      } else {
        p.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const params = msg.params || {};
      const sessionId = msg.sessionId;
      this.emit('event', msg.method, params, sessionId);
      const set = this._handlers.get(msg.method);
      if (set) for (const fn of Array.from(set)) {
        try {
          fn(params, sessionId);
        } catch (e) {
          log(`event handler error for ${msg.method}: ${e.message}`);
        }
      }
    }
  }

  _handleClose(reason) {
    if (this._closed) return;
    this._closed = true;
    const err = new Error(`CDP connection closed: ${reason}`);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('close', reason);
  }

  /**
   * The ONE command path. Returns a Promise resolving to the CDP result.
   * sessionId is included in the message (flat session protocol) when given.
   */
  send(method, params = {}, sessionId) {
    if (this._closed) {
      return Promise.reject(new Error(`CDP driver is closed (${method})`));
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket not open (${method})`));
    }
    const id = ++this._seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${this.callTimeout}ms: ${method}`));
      }, this.callTimeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** onEvent('Network.requestWillBeSent', (params, sessionId) => {...}) */
  onEvent(method, cb) {
    let set = this._handlers.get(method);
    if (!set) {
      set = new Set();
      this._handlers.set(method, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Resolve the params of the next matching CDP event (optional timeout). */
  waitForEvent(method, { sessionId, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const handler = (params, sid) => {
        if (sessionId !== undefined && sid !== sessionId) return;
        finish();
        resolve(params);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`waitForEvent timeout after ${timeout}ms: ${method}`));
      }, timeout);
      const finish = () => {
        clearTimeout(timer);
        const set = this._handlers.get(method);
        if (set) set.delete(handler);
      };
      let set = this._handlers.get(method);
      if (!set) {
        set = new Set();
        this._handlers.set(method, set);
      }
      set.add(handler);
    });
  }

  /* ------------------------------------------------------------------ */
  /* targets / sessions                                                  */
  /* ------------------------------------------------------------------ */

  /** Target.getTargets → targetInfos array. */
  async listTargets() {
    const res = await this.send('Target.getTargets', {});
    return res.targetInfos || [];
  }

  /**
   * Target.createTarget + Target.attachToTarget({flatten:true}).
   * Returns the sessionId used for all subsequent session-scoped send() calls.
   */
  async createPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    if (!sessionId) throw new Error('Target.attachToTarget returned no sessionId');
    this.sessions.set(sessionId, targetId);
    return sessionId;
  }

  /** Close a page created via createPage(sessionId). */
  async closePage(sessionId) {
    const targetId = this.sessions.get(sessionId);
    if (targetId) {
      this.sessions.delete(sessionId);
      await this.send('Target.closeTarget', { targetId });
    }
  }

  /* ------------------------------------------------------------------ */
  /* stealth + fingerprint sync                                          */
  /* ------------------------------------------------------------------ */

  /**
   * THE KEY FEATURE.
   *  a) Page.enable + Page.addScriptToEvaluateOnNewDocument(webdriver hidden)
   *     — and also applied to the CURRENT document so it takes effect
   *     immediately without a navigation.
   *  b) calls syncFingerprint(sessionId) to re-assert the REAL values.
   * Returns { stealth: true, fingerprint }.
   */
  async applyStealth(sessionId) {
    await this.send('Page.enable', {}, sessionId);
    await this.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: STEALTH_SOURCE },
      sessionId
    );
    try {
      await this.send(
        'Runtime.evaluate',
        { expression: STEALTH_SOURCE, returnByValue: true },
        sessionId
      );
    } catch (e) {
      log(`current-document stealth eval skipped: ${e.message}`);
    }
    const fingerprint = await this.syncFingerprint(sessionId);
    return { stealth: true, fingerprint };
  }

  /**
   * Re-assert the browser's REAL fingerprint so the automation context can't
   * drift — SYNC, not spoof:
   *   - Browser.getVersion()            → real userAgent string
   *   - Runtime.evaluate                 → navigator.language / languages
   *   - Network.setUserAgentOverride     → userAgent + acceptLanguage from the
   *     REAL values above (skipped silently with a log line if unsupported)
   */
  async syncFingerprint(sessionId) {
    const version = await this.send('Browser.getVersion', {});
    const realUA = version.userAgent;
    let language = null;
    let languages = [];

    try {
      const r = await this.send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify({language: navigator.language, languages: Array.from(navigator.languages || [])})',
          returnByValue: true,
        },
        sessionId
      );
      const val = r && r.result && r.result.value;
      if (typeof val === 'string') {
        const o = JSON.parse(val);
        language = o.language;
        languages = Array.isArray(o.languages) ? o.languages : [];
      }
    } catch (e) {
      log(`language read skipped: ${e.message}`);
    }
    // Normalize: a previous Network.setUserAgentOverride can leave raw q=
    // suffixes inside navigator.languages — strip them so repeated calls
    // never degrade the value (sync, not spoof).
    languages = Array.from(
      new Set(
        languages.map((l) => String(l).split(';')[0].trim()).filter(Boolean)
      )
    );
    if (!language || !languages.includes(language)) language = languages[0] || 'en-US';
    if (!languages.length) languages = [language];

    const acceptLanguage = languages
      .map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`))
      .join(',');

    let overrideApplied = false;
    let overrideError = null;
    try {
      await this.send(
        'Network.setUserAgentOverride',
        { userAgent: realUA, acceptLanguage },
        sessionId
      );
      overrideApplied = true;
    } catch (e) {
      overrideError = e.message;
      log(`Network.setUserAgentOverride skipped (not supported): ${e.message}`);
    }

    return {
      userAgent: realUA,
      product: version.product,
      language,
      languages,
      acceptLanguage,
      userAgentOverrideApplied: overrideApplied,
      userAgentOverrideError: overrideError,
    };
  }

  /* ------------------------------------------------------------------ */
  /* request blocking (network interception)                             */
  /* ------------------------------------------------------------------ */

  /**
   * Block junk metadata/tracking requests so they never leave the browser.
   *
   * Modes:
   *   "block" (default, what we need): matching → Fetch.failRequest(
   *     BlockedByClient); everything else → Fetch.continueRequest (raw
   *     passthrough, untouched).
   *
   * Preferred path: Fetch.enable({patterns:[{urlPattern, requestStage:"Request"}]}).
   * Pattern conversion: Fetch urlPattern is a wildcard GLOB over the whole URL;
   * bare substrings (no `*`) are wrapped as `*<pattern>*` (toFetchPattern),
   * existing globs such as `*track*` pass through unchanged.
   *
   * Fallback (if Fetch.enable is rejected by the browser):
   * Network.setBlockedURLS({urls}) with the SAME converted glob patterns.
   * Which mode is active is stored in `driver.blockMode` and logged.
   */
  async enableRequestBlocking(
    sessionId,
    patterns = DEFAULT_BLOCK_PATTERNS,
    { mode = 'block' } = {}
  ) {
    if (mode !== 'block') throw new Error(`unsupported blocking mode: ${mode}`);
    this._blockPatterns = patterns.slice();
    const fetchPatterns = patterns.map((p) => ({
      urlPattern: toFetchPattern(p),
      requestStage: 'Request',
    }));

    if (!this._fetchHandler) {
      this._fetchHandler = (params, sid) => {
        const req = params && params.request;
        if (!req || !req.url) return;
        const url = req.url;
        const matched = this._blockPatterns.some((p) =>
          patternToRegex(p).test(url)
        );
        const targetSession = sid || sessionId;
        if (matched) {
          this.send(
            'Fetch.failRequest',
            { requestId: params.requestId, errorReason: 'BlockedByClient' },
            targetSession
          ).catch((e) => log(`failRequest error: ${e.message}`));
        } else {
          this.send(
            'Fetch.continueRequest',
            { requestId: params.requestId },
            targetSession
          ).catch((e) => log(`continueRequest error: ${e.message}`));
        }
      };
      this.onEvent('Fetch.requestPaused', this._fetchHandler);
    }

    try {
      await this.send('Fetch.enable', { patterns: fetchPatterns }, sessionId);
      this.blockMode = 'fetch';
      log(
        `request blocking ACTIVE (mode=block, transport=Fetch) with ${
          fetchPatterns.length
        } patterns: ${fetchPatterns.map((p) => p.urlPattern).join(', ')}`
      );
    } catch (e) {
      log(`Fetch.enable rejected (${e.message}); falling back to Network.setBlockedURLS`);
      await this.send('Network.enable', {}, sessionId);
      await this.send(
        'Network.setBlockedURLS',
        { urls: patterns.map(toFetchPattern) },
        sessionId
      );
      this.blockMode = 'network-blocked-urls';
      log(
        `request blocking ACTIVE (mode=block, transport=Network.setBlockedURLS) with ${
          patterns.length
        } urls`
      );
    }
    return { mode: 'block', transport: this.blockMode, patterns: this._blockPatterns };
  }

  /* ------------------------------------------------------------------ */
  /* page helpers                                                        */
  /* ------------------------------------------------------------------ */

  /** Page.navigate + wait for Page.loadEventFired (timeout, default 30s). */
  async navigate(sessionId, url, timeout = 30000) {
    const waiter = this.waitForEvent('Page.loadEventFired', { sessionId, timeout });
    let res;
    try {
      res = await this.send('Page.navigate', { url }, sessionId);
    } catch (e) {
      waiter.catch(() => {});
      throw e;
    }
    if (res.errorText) {
      waiter.catch(() => {});
      throw new Error(`Page.navigate failed for ${url}: ${res.errorText}`);
    }
    await waiter;
    return res;
  }

  /** Runtime.evaluate {returnByValue, awaitPromise} → JS value. */
  async evaluate(sessionId, expression) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (res.exceptionDetails) {
      const d =
        (res.exceptionDetails.exception &&
          res.exceptionDetails.exception.description) ||
        res.exceptionDetails.text ||
        'unknown exception';
      throw new Error(`evaluate exception: ${d}`);
    }
    return res.result ? res.result.value : undefined;
  }

  /** Page.captureScreenshot → write PNG to path. Returns { path, bytes }. */
  async screenshot(sessionId, filePath) {
    const res = await this.send(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId
    );
    if (!res.data) throw new Error('Page.captureScreenshot returned no data');
    const buf = Buffer.from(res.data, 'base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    return { path: filePath, bytes: buf.length };
  }

  /** Close the WebSocket and reject every pending command. */
  async close() {
    this._handleClose('close() called');
    try {
      if (this.ws && this.ws.readyState <= WebSocket.CLOSING) this.ws.close();
    } catch (e) {
      /* ignore */
    }
    await sleep(20);
  }
}

/* -------------------------------------------------------------------- */
/* Chrome launcher                                                       */
/* -------------------------------------------------------------------- */

/**
 * Spawn Chrome. Returns { proc, port, userDataDir }.
 * Default args:
 *   [--headless=new] --remote-debugging-port=<port> --user-data-dir=<dir>
 *   --no-first-run --no-default-browser-check --disable-background-networking
 *   --no-proxy-server about:blank
 */
function launchChrome({
  headless = true,
  port,
  userDataDir,
  extraArgs = [],
  chromePath = CHROME_BIN,
} = {}) {
  if (!port) throw new Error('launchChrome requires { port }');
  if (!userDataDir) {
    userDataDir = path.join(TMP_ROOT, `cdp-profile-${crypto.randomUUID()}`);
  }
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [];
  if (headless) args.push('--headless=new');
  args.push(
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--no-proxy-server'
  );
  args.push(...extraArgs, 'about:blank');

  const proc = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.cdpOutput = '';
  const onData = (d) => {
    proc.cdpOutput += d.toString();
    if (proc.cdpOutput.length > 64 * 1024) {
      proc.cdpOutput = proc.cdpOutput.slice(-64 * 1024);
    }
  };
  if (proc.stdout) proc.stdout.on('data', onData);
  if (proc.stderr) proc.stderr.on('data', onData);
  proc.on('error', (e) => log(`chrome spawn error: ${e.message}`));
  proc.chromeArgs = args;
  return { proc, port, userDataDir, args };
}

/**
 * Kill ONLY the Chrome process we spawned (SIGKILL its pid), wait for it to
 * actually exit, then remove its user-data-dir (retried — Chrome may still be
 * flushing files while dying). Never touches any other Chrome.
 */
async function stopChrome(chrome, { userDataDir, waitMs = 5000 } = {}) {
  const proc = chrome && chrome.proc ? chrome.proc : chrome;
  const dir = userDataDir || (chrome && chrome.userDataDir);
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch (e) {
      /* already gone */
    }
    await Promise.race([
      new Promise((r) => proc.once('exit', r)),
      sleep(waitMs),
    ]);
  }
  if (dir) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        /* retry */
      }
      if (!fs.existsSync(dir)) return true;
      await sleep(200);
    }
    return !fs.existsSync(dir);
  }
  return true;
}

/* -------------------------------------------------------------------- */
/* CLI demo:  node cdp-driver.js --demo                                  */
/* -------------------------------------------------------------------- */

async function demo() {
  const out = (o) => console.log(JSON.stringify(o));
  const port = await freePort();
  const userDataDir = path.join(TMP_ROOT, `cdp-demo-${crypto.randomUUID()}`);
  let chrome = null;
  let driver = null;
  let ok = false;
  try {
    out({ step: 'launch', port, userDataDir });
    chrome = launchChrome({ headless: true, port, userDataDir });

    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 15000) {
      try {
        const ts = await getTargets('127.0.0.1', port, 2000);
        if (ts.some((t) => t.type === 'page')) {
          ready = true;
          break;
        }
      } catch (e) {
        /* retry */
      }
      await sleep(300);
    }
    if (!ready) throw new Error('chrome did not expose a page target in 15s');
    out({ step: 'ready', ms: Date.now() - t0 });

    driver = new CDPDriver();
    await driver.connect({ port });
    out({ step: 'connected', wsUrl: driver.wsUrl });

    const sessionId = await driver.createPage('about:blank');
    out({ step: 'createPage', sessionId });

    const st = await driver.applyStealth(sessionId);
    out({ step: 'applyStealth', fingerprint: st.fingerprint });

    const webdriver = await driver.evaluate(sessionId, 'navigator.webdriver');
    out({ step: 'navigator.webdriver', value: webdriver, isUndefined: webdriver === undefined });

    const pageUA = await driver.evaluate(sessionId, 'navigator.userAgent');
    const bv = await driver.send('Browser.getVersion', {});
    out({
      step: 'userAgent',
      pageUA,
      browserUA: bv.userAgent,
      equal: pageUA === bv.userAgent,
    });

    const lang = await driver.evaluate(sessionId, 'navigator.language');
    out({ step: 'navigator.language', value: lang });

    const shot = await driver.screenshot(
      sessionId,
      path.join(TMP_ROOT, `cdp-demo-${crypto.randomUUID()}.png`)
    );
    out({ step: 'screenshot', ...shot });

    ok = webdriver === undefined && pageUA === bv.userAgent && shot.bytes > 0;
    out({ step: 'done', pass: ok });
  } catch (e) {
    out({ step: 'error', error: e.message });
  } finally {
    try {
      if (driver) await driver.close();
    } catch (e) {
      /* ignore */
    }
    try {
      if (chrome) await stopChrome(chrome, { userDataDir });
    } catch (e) {
      /* ignore */
    }
  }
  return ok ? 0 : 1;
}

module.exports = {
  CDPDriver,
  launchChrome,
  stopChrome,
  freePort,
  getTargets,
  toFetchPattern,
  DEFAULT_BLOCK_PATTERNS,
  DEFAULT_CALL_TIMEOUT,
  STEALTH_SOURCE,
};

if (require.main === module) {
  if (process.argv.includes('--demo')) {
    demo().then((code) => process.exit(code));
  } else {
    console.log('Usage: node cdp-driver.js --demo');
    process.exit(0);
  }
}
