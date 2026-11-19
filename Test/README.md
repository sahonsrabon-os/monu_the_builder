# Mission Barisal Test Suite

Real-life verification suite for the Mission Barisal Node server. Every
script in this tree exercises the system the way an actual consumer does —
over the wire, against real endpoints, with no mocks, no stubs, and no
simulated success paths. Each run writes a detailed JSON record to
`Test/Evidence/` as a durable backup of what was observed.

## Layout

```
Test/
  MultiInstance/
    test-multi-instance.js   Same server binary on N ports at once:
                             parallel boot, non-blocking burst, h2c
                             prior-knowledge, MCP handshake (.zombiecoder
                             recreation), buffered client persistence,
                             root-FS tool call, graceful cleanup.
  LocalMCP/
    test-start-local-mcp.js  start-local-mcp.js contract: ready status,
                             JSON-RPC round-trip per port, already-running
                             short circuit, stop teardown, parent-exit
                             orphan kill.
  CDP/
    cdp-driver.js            Zero-dependency Chrome DevTools Protocol
                             driver (self-launched headless Chrome).
    test-cdp.js              Driver feature proof: webdriver mask,
                             fingerprint consistency, network interception
                             block list, screenshot, teardown.
  Admin/
    test-admin-workflow.js   The admin.html user journey: list agents,
                             bind a model to an agent, reload and verify
                             the binding persisted, confirm the model
                             resolves for chat, confirm the agent persona
                             is present in the session.
  System/
    test-system-integration.js
                             Whole-system pass: health, identity, model
                             listing (masked + dev), MCP initialize /
                             tools-list / tools-call over HTTP and UDS,
                             SSE stream, streaming and non-streaming
                             chat paths, observability endpoints,
                             WebSocket availability.
  lib/
    evidence.js              Shared Evidence JSON writer (schema below).
  Evidence/                  One timestamped JSON per script run.
  Backup/                    Pre-edit file backups (api.js, .env,
                             external MCP servers, php broker).
  README.md                  This file.
```

## Running

From the repository root (`/home/sahon/vs`):

```
node Test/MultiInstance/test-multi-instance.js [N]   # N instances, default 2
node Test/LocalMCP/test-start-local-mcp.js
node Test/CDP/test-cdp.js
node Test/Admin/test-admin-workflow.js
node Test/System/test-system-integration.js
```

Exit code `0` means every assertion passed; `1` means at least one failed
or the script crashed. Every run appends its record under `Evidence/` with
a filename of the form `<script>-<finished-at>.json`.

## Safety contract shared by all scripts

- The live production server on port 3000 is treated as read-only. Tests
  probe it with GET requests and real client traffic; they never restart,
  kill, or mutate its process.
- Scripts only kill processes they spawned themselves. There is no
  pkill/fuser sweep anywhere in this tree.
- Isolated instances get their own working directory, data directory,
  log directory, lock directory, cache directory, and Unix socket, so a
  test run can never corrupt live state.
- Ports are allocated by bind-probe on a random free port; the fixed
  ports of running services (3000, 3001, 3002, 3100-3102, 3105, 9998,
  3306, 9222, 5100, 11434) are never chosen.

## Evidence schema

Every JSON record uses `schema: "missionbarisal-test-evidence/v1"`:

| Field | Meaning |
|---|---|
| `script`, `category` | Source script and its Test/ category |
| `started_at`, `finished_at`, `duration_ms` | Run timing (ISO-8601) |
| `environment` | Node/platform/hostname plus run-specific metadata: run UUID, live-server snapshot, ports, artifact paths |
| `summary` | `status`, `total`, `passed`, `failed`, `skipped` |
| `tests` | One entry per assertion: `name`, `status` (`PASS`/`FAIL`/`SKIP`), `detail` (exact observed values) |
| `notes` | Free-form info lines captured during the run (timings, pre-existing state, crash text) |
| `artifacts` | Directories, logs, screenshots produced by the run |

A crashed or timed-out run still writes its record with the observations
gathered up to that point, plus the error text in `notes`.

## Backup/

File snapshots taken immediately before each modifying change, kept
outside the working tree paths so they can never be loaded by the server:

- `api.js.bak-20260925` — api.js before the printSetupReport rewrite
- `api.js.bak-20260925-preup` — api.js before the HTTP/2, handshake,
  buffering, env and instance-ID upgrade batch
- `.env.bak-20260925` — environment file before AGENT_FS_SCOPE was added
- `*.bak-20260925` (external MCP servers, package.json, php broker) —
  before the loopback-bind and async-exec hardening pass

Note: `data/notes.json.bak1` is intentionally NOT here — it is live
rotation state actively used by `note-store.js` and must stay in place.
