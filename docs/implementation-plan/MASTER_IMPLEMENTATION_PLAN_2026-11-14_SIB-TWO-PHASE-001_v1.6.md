# MASTER IMPLEMENTATION PLAN — Sibambo Stable: local MCP + live viewer realignment

ID **SIB-TWO-PHASE-001** · Version **1.6** · Date **2026-11-14, Asia/Jakarta** · Authored 18:40–19:10 WIB.

**Author / provenance:** primary Claude Code session, model **Claude Sonnet 5.5** (`claude-sonnet-5-5`, as reported by the client in this session's own telemetry). It is **not** on the AGENTS.md named list of eligible PLAN authors (GPT-6 Sol floor; Sol 6.1+, Astra, Gemini 4, Claude Opus 5.5, Claude Fable). Eligibility therefore rests only on the owner's direct instruction in this session to perform RECLAIM → REALIGN PLAN → IMPLEMENT with this model; capability equivalence to the floor is **unverified** and no benchmark equivalence is claimed. The owner may re-run PLAN/REVIEW with a listed model. No subagents were used (handoff grants no delegation).

**Status: FROZEN — SAFE FOR LOWER-CAPABILITY EXECUTION for WP1–WP6 as written; WP7 (real clients) and WP8 (publication) are NOT SAFE FOR LOWER-CAPABILITY DELEGATION** (they require live judgement about native-client behaviour and about what may be published).

**Supersedes:** master v1.5 + D16 (Notion CURRENT page `412c4a6aaf738117ac36c5101c01fae2`, base v1.4/v1.3) **only for (a) the local-demo functional verdict and (b) the dependency edge "real combined SE-03+SE-04+SE-05 managed-IdP gate (D16 E11) → Done"**, which is split below. Everything else in v1.5/D16 — Stable → Experimental phase gate, atomic 1–8-module transactions, single fenced writer, 64 KiB / 256 KiB caps, no save/export MCP tool, owner-only Save, no draft persistence before Save, SE-11 real-client requirement, D7 — stays binding. v1.0–v1.5 are preserved unmodified.

**Revision history:** v1.6 — owner decision of 2026-11-14 ("defer Auth0 and security; focus on MCP capability and live viewer for local/offline testing and demos"); realigns dependencies; freezes the local architecture; adds the requestId/guide/IR-read capability repairs.

---

## Objective and User-Visible Definition of Done

**Intent (observable):** on the owner's Windows machine, with no Auth0 tenant, tunnel, hosting or new certificate, **one command** starts the canonical service, the Editor and per-client MCP configuration. The owner opens `http://localhost:5175`, signs in with one click ("local demo" banner), opens project `local-demo`, presses **Hubungkan draft live**. A **real Claude Code** and a **real Codex** then each discover the eight canonical tools, read the same draft, build a 4 m × 3 m room (height 2.7 m, wall thickness 0.15 m), inspect it, revise it (owner inbox request, then one supported opening) and validate it; the owner **sees** the room appear, change and gain the opening in the Editor with matching accepted/rendered revision counters. The owner's inbox request becomes **addressed only after the render ACK** of the revision that answers it. Two tabs behave primary/follower; writer contention between the two clients yields `LEASE_HELD`; pause/resume works; reconnect and server restart never duplicate walls or silently drop the last good frame.

**Done (LOCAL-FUNCTIONAL, verdict `LF`):** rows LF-1…LF-12 in §Test and Verification Contract each carry an evidence class and PASS/FAIL/NOT_RUN; every automated row PASS; every real-client row PASS on a recorded source identity; owner manual gates recorded as pending (never invented). `LF` PASS ≠ remote/security PASS ≠ task Done.

**Two verdicts, never merged**

| Verdict | Meaning | Blocks local demo? |
|---|---|---|
| `LF` — local functional readiness | one launcher, two real clients, canonical actor, visible build/revise/opening, inbox ACK, lifecycle | **it is the demo gate** |
| `RS` — remote/security readiness | Auth0/OIDC/PKCE, signed-client pairing over HTTPS, tenant isolation, read-only matrix, real tunnel/hosting, pentest, production | **DEFERRED — blocks nothing local, but blocks any global Done/Stable acceptance** |

## Current-State Findings

Verified by reading source and by two throw-away spikes (scratch only, no product change) on 2026-11-14.

1. **Reclaim state.** Notion SE-05 claim: `Codex desktop / 01a1d520-… / claim v2 FULL source completed; Review`, locks `stable/editor-sync`; owner instructed this session to reclaim. Editor `work/se-05/full-sync-20261113` HEAD `fa818f3f1e06b7e955e12b240206306fadb54338` (+ pre-existing untracked `tooling/testing/results/`, preserved); Builder same branch HEAD `eb28489ab8504e96eb1dde36f6bb1dce2d83eca4`, tracked clean. Draft PRs Editor #24 / Builder #94. Old runtimes PID 42904 (service, command line `…ps51-acceptance-02\venv\Scripts\python.exe …\se030405-real-20261114\start-local-service.py`) and PID 41420 (Editor, `node …\start-local-editor.mjs`) are task-owned by their command lines (verified), still listening on 127.0.0.1:8765 / :5175 with the Auth0/TLS configuration; they hold the ports the new launcher needs.
2. **Canonical actor path.** `service/tools.py::Tools.call(principal, project, name, args)` → `tool_*` → `ProjectActor` (`core/project/actor.py`) is shared by HTTP (`service/mcp_http.py::build_server.run`), the owner REST surface (`service/tools.py::OwnerApi`, `service/owner_mcp.py::OwnerMcp`), the draft WebSocket (`service/draft_ws.py::DraftHub/DraftSocket`) and the local bridge (`service/bridge.py::BridgeServer.dispatch`).
3. **Stdio bridge works today.** `service/stdio_bridge.py::build_stdio_server` registers the same eight tools via `service/mcp_http.py::register_tools` and forwards each call through `bridge_call` (loopback TCP, 1 MiB frames, per-launch 64-hex secret, constant-time compare) to `BridgeServer.dispatch`, which uses one fixed `Principal` + `project`. Existing test `tests/test_remote_mcp.py::BridgeTests.test_real_stdio_client_shares_the_one_canonical_actor_with_http` proves one actor. **Spike result (no Auth0, no pairing):** real **Claude Code 2.1.322** (`--strict-mcp-config --mcp-config`, built-in tools disabled) called `read_project` → `projectRevision 0` in 3.8 s; real **Codex 0.164.0** (`-c mcp_servers.<name>={command,args,env}` + per-tool `approval_mode="approve"`, stdin closed) called `read_project` in 22 s wall (includes model latency). Without per-tool approval Codex reports "MCP tool call requires approval, but approval policy is never".
4. **Service app accepts a non-HTTPS loopback issuer.** `service/app.py::create_app(config, verifier=, host=)` builds with `ServiceConfig(issuer='http://127.0.0.1:8765', audience='http://127.0.0.1:8765/mcp')` and an injected verifier (spike). `tests/remote_support.py::Env(tls=False)` already serves plain HTTP.
5. **Editor BFF is OIDC-only.** `apps/editor/src/lib/server/mcp-bff.ts`: `oidcConfig()` requires Auth0 env; `getSession` binds `issuer`; `serviceBase()` allows plain HTTP only when SvelteKit `dev`; `draftWebSocketUrl()` requires `wss:`; `routes/api/mcp/login/+server.ts` redirects to the IdP. `apps/editor/svelte.config.js` CSP `connect-src` allows only `'self'` + one exact **WSS** origin; `lib/mcp/draft-client.ts` constructor throws unless `wss:`. `__Host-` Secure cookies **do work on `http://localhost`** in the Chromium built-in browser (spike: cookie set and echoed back).
6. **requestId gap (root cause).** `service/tools.py::tool_apply_operation` calls `self.host.drafts.publish(actor, out, args.get('requestId'))`, and `DraftHub.publish` records `channel.request_operations[revision]` only when `isinstance(request_id, str) and request_id in channel.requests`; `DraftHub.acknowledge` then sets status `addressed` and emits `owner_request_status`. The wire registration `register_tools::apply_operation(... requestId: str | None)` exists, but (a) no tool description or guide mentions `requestId`, (b) `read_owner_requests` returns `id` as an **integer** while the schema demands a string, so a conforming agent either omits it or fails validation. Native Codex therefore omitted it: request stayed `read`.
7. **Guide/IR are not delivered to agents.** The eight tools expose `guideVersion/guideSha256` only; the acceptance runner `scratch/se030405-real-20261114/run-real-agent.mjs` **pasted the guide into the prompt** ("operator-supplied"). `inspect_module` returns faces only, **not the module IR**, so an agent in a new session cannot revise an existing module faithfully. Both are capability defects for "build, inspect, revise".
8. **Lifecycle mechanics already present** (not to reimplement): `DraftHub.attach` last-attachment-primary + follower, `acked=-1` reset on attach and snapshot-before-ACK, bounded queue/replay (64 events/4 MiB; 128/8 MiB), `viewer()` verdicts `none/pending/timeout/ok`, `NO_ACTIVE_VIEWER`/`RENDER_PENDING`/`RENDER_ACK_TIMEOUT`, `Tools._preflight`, `BUSY` write gate, idempotent replay (`replayed=True`, `rendered` flag), epoch UUID per actor instance with `EPOCH_CHANGED` on stale HELLO; Editor `draft-client.ts` generation fences, ticket refresh on reconnect (`833f956`), worker validation, `DraftScene` atomic swap + ACK after render, `+page.svelte` dirty/unload warnings.
9. **Baselines run in this session:** Builder `unittest` (`tests.test_remote_mcp tests.test_draft_ws tests.test_project_actor tests.test_remote_mcp_guide`) **109 PASS / 0 FAIL** (venv `outputs/2026-11-13-se05-full/ps51-acceptance-02/venv`, Python 3.13.12, `mcp==2.3.0`); Editor `bun test ./unit/mcp` **98 PASS / 0 FAIL / 319 expects**. Claude Code `claude`, Codex `codex.exe`, Bun 1.4.4, Node v24.21.0 installed.
10. **Connectivity facts (recorded, not claimed away):** the two clients' **model inference is cloud** (Anthropic / OpenAI accounts already logged in); stdio bridge, actor, service, Editor and viewer are local loopback. The product is **local-functional, not air-gapped**.

## Root Cause / Gap

(1) No local identity/transport path: the only owner path needs Auth0 + HTTPS + pairing; Claude's pairing bootstrap is blocked by the remote 403-before-dispatch contract, which is a *remote* concern. (2) requestId unusable by real agents (finding 6). (3) Guide and module IR not obtainable through MCP (finding 7). (4) No single launcher; configs and ports were hand-assembled per run. (5) CSP/BFF/draft-client hard-reject non-WSS, so the Editor cannot reach a loopback service without TLS and a trusted certificate.

## Locked Architecture Decisions

The executor must not redesign any of these.

- **L1 Explicit local mode.** Enabled only by `SIBAMBO_LOCAL_DEMO=1` (Editor build+runtime) and the dedicated entry point `python -m service.local_demo` (Builder). Never inferred, never default, never enabled by Vercel/`VERCEL` env. All remote/OIDC/Auth0/TLS code stays unmodified in behaviour when the flag is absent.
- **L2 Agent transport = stdio bridge.** Claude Code and Codex spawn `python -m service.stdio_bridge` (existing). **One `BridgeServer` per client** with its own `Principal` (so writer lease/grant/audit are per client) → the **same** `Tools(host)` → the **same** `ProjectActor`. No HTTP `/mcp` use in local mode, no separate journal/draft server.
- **L3 Identities.** Issuer string `sibambo-local-demo`, tenant `local`. Owner principal: `principal_id(ISSUER,'local-owner','sibambo-editor-local')`. Agent principals: `principal_id(ISSUER,'local-claude-code','claude-code')` and `principal_id(ISSUER,'local-codex','codex')`; `host.drafts.identities[principal.id]` = their subject string for display.
- **L4 Grants.** The launcher, acting as the owner principal through `OwnerApi.grant`, pre-grants **exactly** `['read','write']` to those two principals on the single project (default id `local-demo`). No pairing codes in local mode. The owner can still revoke from the panel (`/grants` revoke/remove path unchanged) and pause/resume. A revoked client's next call fails with `GRANT_DENIED` (existing).
- **L5 Owner auth.** A `LocalVerifier(JwtVerifier)` in `service/local_demo.py`: `principal_of(token)` returns the owner principal iff `hmac.compare_digest(token, owner_secret)`; `verify_token` returns `None` (so the SDK HTTP `/mcp` surface answers 401 to everything — local mode offers **no** HTTP MCP). The Editor BFF presents that secret as the bearer on `/v1/projects/{p}/owner/mcp*`. The secret is 32 random bytes base64url, generated by the launcher, stored only in the launcher's private dir (mode: `D:` private folder, never printed, never logged), passed to the two processes through environment.
- **L6 Editor local mode.** Env gate `SE04_LOCAL_DEMO=1` (+ build-time `SIBAMBO_LOCAL_DEMO=1`). When set and valid: login mints a sealed session `{sub:'local-owner', issuer:'sibambo-local-demo', accessToken:<owner secret>, exp: now+4h, csrf}` without any IdP; `serviceBase()` accepts `http://127.0.0.1|localhost[:port]`; `draftWebSocketUrl()` accepts `ws://127.0.0.1|localhost:<port>` exact origin; CSP `connect-src` and `DraftClient` accept `ws:` **only** for loopback hosts. When set but invalid (non-loopback service/WS origin, non-loopback request host, missing/short secret, `VERCEL` set): fail closed with HTTP 503 — never fall back to OIDC silently. Owner CSRF, Origin check, sealed cookies, `__Host-` names, 8 KiB body cap, `expose` allowlist, project-ID regex: unchanged.
- **L7 Tool inventory is frozen at eight.** Additive optional parameters only: `read_project(includeGuide: bool=False)`, `inspect_module(includeIr: bool=False)`, `apply_operation.requestId: str | int | None` (normalised to `str`). `guideVersion` becomes **2** (hash changes; test lints re-run). No ninth tool, no save/export.
- **L8 requestId semantics.** An owner request is `open` → `read` (on `read_owner_requests`) → `addressed` **only** when the render ACK for the revision committed by a transaction that carried that `requestId` is accepted from the *primary* viewer. Accepted-write alone never addresses. `withdrawn` stays terminal. Owner UI cannot forge `addressed` (existing `mark-addressed` → FORBIDDEN).
- **L9 Guide delivery.** `read_project(includeGuide=true)` returns `guide:{version,sha256,markdown}` (markdown ≈ ≤ 16 KiB, LF-normalised, hash identical to `GUIDE_SHA256`). `INSTRUCTIONS` (≤ 1800 characters) tells the agent: call `read_project` with `includeGuide=true` first in a new session; pass `requestId` when answering an owner request; units metres, +Z up. Server `instructions` and tool descriptions stay ≤ 2048 characters each (client truncation limit).
- **L10 Retention.** Draft is volatile RAM exactly as v1.5; **no persistence, no Save** added. Server restart = new actor, new epoch UUID; stale tabs show the existing `EPOCH_CHANGED` message and keep the last frame; **never** claim the old model was restored.
- **L11 Launcher.** `tooling/local-demo/launch.mjs` (Editor repo, Node ≥ 22, no dependencies) orchestrates; Builder owns `service/local_demo.py`. Run root default `D:\projects\sibambo\scratch\local-demo-run`; refuse any run root, temp, or output path on `C:` (win32). `TEMP/TMP` set to `<run-root>/tmp` for every child.
- **L12 Ports/hosts.** Service `127.0.0.1:8765`; Editor `127.0.0.1:5175` served as `http://localhost:5175`; allowed origins `http://localhost:5175`,`http://127.0.0.1:5175`; allowed hosts `127.0.0.1:8765`,`localhost:8765`. A launcher run **refuses** to start if a port is held by a process that is not a recorded child of a previous launcher run, unless `--replace-task-owned` and the owning command line matches a task-owned script path.
- **L13 Secrets in client configs.** Per-client bridge secret goes in a private file; the generated client config carries only the file path (`SIBAMBO_BRIDGE_SECRET_FILE`) and the loopback address — never the secret in argv/env of the client process, never printed.
- **L14 Remote code retention.** OIDC/Auth0 BFF path, JWT verifier, `EdgeGuard` 403-before-dispatch contract, pairing flow and their tests are **not modified** except where an additive branch is required by L6; their existing tests must still pass unchanged.

## Data and Control Flow

**Before (remote):** agent → HTTPS `/mcp` (OAuth bearer) → `EdgeGuard` (403+pairing if ungranted) → SDK → `Tools` → actor; owner browser → BFF (OIDC session) → HTTPS owner API; WS over `wss://`.

**After (local):**

```
launch.mjs ──spawns──> python -m service.local_demo
                         ProjectHost ─ ProjectActor  (single canonical draft, epoch UUID)
                         ├─ BridgeServer[claude-code] 127.0.0.1:<ephemeral> ──> Tools(host, principal_cc)
                         ├─ BridgeServer[codex]       127.0.0.1:<ephemeral> ──> Tools(host, principal_cx)
                         └─ uvicorn 127.0.0.1:8765: OwnerMcp(+LocalVerifier) + DraftSocket(/draft)
          ──spawns──> node apps/editor/build/index.js (SE04_LOCAL_DEMO=1) at http://localhost:5175

Claude Code / Codex ──stdio──> python -m service.stdio_bridge ──TCP+secret──> BridgeServer ──> Tools ──> actor
                                                                                     └─ DraftHub.publish ─> WS peers
Owner browser ─ /api/mcp/* (BFF, sealed cookie, CSRF) ─ http://127.0.0.1:8765/v1/projects/{p}/owner/mcp*  (owner secret)
Browser tab ─ ws://127.0.0.1:8765/draft (single-use ticket) ─ worker validate ─ DraftScene swap ─ frame ─ ACK ─ DraftHub.acknowledge
                                                                               └─ request addressed ─ owner_request_status
```

Unchanged: ticket mint/consume, snapshot-before-ACK, ACK after painted frame, bounded queues, resync, generation fences.

## Change Surface

**MUST change (Builder `sibambo-bomc-builder`):**
- NEW `service/local_demo.py` (runner + `LocalVerifier` + client-config writer).
- `service/bridge.py::bridge_call` (+ `ENV_SECRET_FILE`), `service/mcp_http.py` (`register_tools` params, `INSTRUCTIONS`), `service/tools.py` (`tool_read_project`, `tool_inspect_module`, `tool_apply_operation` requestId normalisation), `service/guide/REMOTE-CONSTRUCTION-GUIDE.md` (v2), `service/guide/tool_descriptions.py` (`GUIDE_VERSION=2`, descriptions).
- NEW `tests/test_local_demo.py`; update `tests/test_remote_mcp_guide.py` / `tests/test_remote_mcp.py` only for the intended guideVersion/schema additions.

**MUST change (Editor `sibambo-editor`):** `apps/editor/src/lib/server/mcp-bff.ts`, `routes/api/mcp/login/+server.ts`, `routes/api/mcp/session/+server.ts`, `src/lib/mcp/connection.ts` (`McpSessionView.localDemo/defaultProject`), `src/lib/mcp/McpPanel.svelte` (banner, prefill, login label), `src/lib/mcp/draft-client.ts` (loopback `ws:`), `svelte.config.js` (CSP gate), NEW `tooling/local-demo/{launch.mjs,run-agent.mjs,README.md}`, NEW tests under `apps/editor/unit/mcp/` and `apps/editor/tests/` (local-mode browser integration).

**CONDITIONAL:** `apps/editor/src/lib/mcp/OwnerRequests.svelte` only if the inbox cannot create a request for the demo module without a UI change (specify the minimal change in the summary); `apps/editor/playwright.*.config.ts` only to register a new spec.

**READ-ONLY:** `core/**`, `bomc/**`, `schemas/**` (module IR/compiler/validator), `service/draft_ws.py` (`DraftHub` semantics), `service/owner_mcp.py`, `service/auth.py`, `service/app.py`, all `packages/**`, `draft-protocol.ts`, `draft-store.ts`, `draft-scene.ts`, `draft.worker.ts`, `+page.svelte`.

**FORBIDDEN:** importer/compiler/IR/geometry semantics; roof/stair/new IR kinds; export/save/producer/RBZ; EdgeGuard 403 contract and pairing; Auth0 tenant, Tailscale, Vercel configuration; global Claude/Codex settings; Experimental scope; weakening any cap, CAS, fence, idempotency, epoch, ACK or CSRF rule; raising any test timeout/threshold.

## Implementation Contracts

### C1 `service/local_demo.py` (NEW)
- `LOCAL_ISSUER='sibambo-local-demo'`, `LOCAL_TENANT='local'`; `class LocalVerifier(JwtVerifier)`: `__init__(owner_secret: str, owner: Principal, audience)` calls `super().__init__(issuer=LOCAL_ISSUER, audience=audience, key_resolver=lambda t: None)`; `principal_of(token)` → owner iff `hmac.compare_digest(token.encode(), secret.encode())` and `len(secret) >= 32`, else `None`; `async verify_token` → `None`.
- `principal(sub, client)` helper = `Principal(principal_id(LOCAL_ISSUER, sub, client), LOCAL_TENANT, LOCAL_ISSUER, sub, client)`.
- `build(project, owner_secret, clients=('claude-code','codex'), port, editor_origins)`: `ProjectHost()`; `OwnerApi(host).open(owner, project)`; for each client: `OwnerApi.grant(owner, project, p.id, client, ['read','write'])`; `host.drafts.identities[p.id]=subject`; `BridgeServer(Tools(host), p, project).start()`; `create_app(ServiceConfig(issuer, audience=f'http://127.0.0.1:{port}/mcp', allowed_hosts=(f'127.0.0.1:{port}',f'localhost:{port}'), allowed_origins=editor_origins), verifier=LocalVerifier, host=host)`.
- `main()`: argparse `--project --port --run-root --clients`; **refuses** a non-loopback bind or a run-root on `C:`; reads `SIBAMBO_LOCAL_OWNER_TOKEN` from env (error if absent/short); writes per-client bridge secrets to `<run-root>/private/bridge-<client>.secret` (create `private/` first; write, then flush); writes `<run-root>/agents/claude.mcp.json` and `<run-root>/agents/codex.overrides.json` containing only `command`, `args:['-m','service.stdio_bridge']`, `env:{PYTHONPATH,PYTHONDONTWRITEBYTECODE,TEMP,TMP,SIBAMBO_BRIDGE_ADDR,SIBAMBO_BRIDGE_PROJECT,SIBAMBO_BRIDGE_SECRET_FILE}`, plus a public `<run-root>/manifest.json` (ports, project, pid, epoch, client names, **no** secrets); prints `LOCAL_DEMO_READY` once uvicorn reports started; `uvicorn.run(app, host='127.0.0.1', port, log_level='warning', access_log=False)`; on SIGINT/SIGTERM stops bridges and exits 0.
- Failure: any exception before ready → exit code 2 and **no** manifest. Unknown `--clients` name → exit 2.

### C2 `service/bridge.py::bridge_call`
After reading `ENV_ADDR`, resolve secret: `env.get(ENV_SECRET)` else read UTF-8 text from `env.get('SIBAMBO_BRIDGE_SECRET_FILE')`, `.strip()`, reject empty / > 256 bytes. On unreadable file return the **same** uniform `UNAUTHENTICATED "bridge address/secret are not configured"`. No other behaviour change; `BridgeServer.env()` unchanged (tests rely on it).

### C3 `service/tools.py`
- `tool_apply_operation`: before use, `request_id = args.get('requestId')`; if `type(request_id) is int and request_id >= 0` → `str(request_id)`; else if not `str` → `None`; pass the normalised value to `drafts.publish`. Nothing else in the function changes (order of preflight/gate/submit preserved).
- `tool_read_project(args)`: if `args.get('includeGuide') is True` add `out['guide']={'version':GUIDE_VERSION,'sha256':GUIDE_SHA256,'markdown':<GUIDE_PATH text, \r\n→\n>}`; default response byte-for-byte unchanged.
- `tool_inspect_module(args)`: if `args.get('includeIr') is True` add `out['module']=copy of actor._state.project.modules[mid]` (canonical IR dict, already ≤ 64 KiB by actor budget) — read-only, after the existing NOT_FOUND check; default response unchanged.

### C4 `service/mcp_http.py::register_tools`
`read_project(projectId=None, includeGuide: bool=False)`, `inspect_module(moduleId, projectId=None, includeIr: bool=False)`, `apply_operation(... requestId: str | int | None = None)`; each forwards the extra arg in its `run(...)` dict. `INSTRUCTIONS` replaced by the L9 text. `TOOLS[...]` descriptions in `tool_descriptions.py` updated to document the three additions and the requestId rule (each ≤ 2048 chars; lint test keeps units/bounds/example/error-code requirements).

### C5 Guide v2 (`REMOTE-CONSTRUCTION-GUIDE.md`)
Add, without removing existing sections/examples: §"Operation reference" (field table for `floor-slab`, `wall-run`, `opening-cut` copied from `schemas/module-ir-v1.schema.json`: required fields, units, `opId` regex `^[a-z][a-z0-9-]*$`, opening `targetWallOpId`/`offset`/`width`/`height`/`sillHeight`/`openingType`); §"Single room recipe" (4 × 3 m footprint walls order W,S,E,N, bounds must enclose walls incl. half thickness); §"Answering an owner request" (call `read_owner_requests`, include the returned `id` as `requestId`, one request per transaction); §"Revising" (`inspect_module(includeIr=true)`, bump `revision`, `expectedModuleRevision`, new `idempotencyKey`). `GUIDE_VERSION=2`.

### C6 Editor `mcp-bff.ts`
New `localDemo()`: returns `null` unless `process.env.SE04_LOCAL_DEMO==='1'`; otherwise validates (`!process.env.VERCEL`; `SE04_LOCAL_OWNER_TOKEN` ≥ 32 chars; `key()` valid; `SE04_SERVICE_BASE_URL` loopback `http`; optional `SE04_LOCAL_PROJECT` matching `projectId` regex else default `local-demo`) and returns `{token, project, issuer:'sibambo-local-demo'}`, else `throw error(503,'Local demo mode is misconfigured')`. Changes: `configured()` true when `localDemo()`; `getSession` compares `v.issuer` with `localDemo()?.issuer ?? oidcConfig().issuer`; `setSession` cookie `maxAge` cap `localDemo()?14400:3600`; `serviceBase()` treats `localDemo()` like `dev` for http-loopback; `draftWebSocketUrl()` accepts `ws:` + loopback host when `localDemo()`; export `startLocalSession(event)` that verifies `event.url.hostname ∈ {localhost,127.0.0.1,[::1]}` and `Sec-Fetch-Site ∈ {same-origin,none,absent}` then `setSession(...)`. `oidcConfig`, `discovery`, `callbackUrl`, flow cookie code untouched.
`routes/api/mcp/login/+server.ts`: first line `const local = localDemo(); if (local) { startLocalSession(event); throw redirect(303,'/?mcp=connected'); }`. `session/+server.ts` GET: include `localDemo: true, defaultProject: local.project` in both `disconnected`/`project-selected` bodies only when local; `expose()` allowlist gains no new service-supplied field.

### C7 Editor client
`connection.ts`: `McpSessionView.localDemo?: boolean; defaultProject?: string`. `McpPanel.svelte`: when `session?.localDemo` render a persistent banner "MODE DEMO LOKAL · loopback saja · tanpa Auth0 · bukan konfigurasi remote/produksi", change login anchor text to "Masuk (demo lokal)", prefill `projectId` from `defaultProject` once when empty, and hide the remote OAuth hint text. `draft-client.ts` constructor: accept `wss:` as before, **or** `ws:` iff `hostname ∈ {127.0.0.1,localhost,[::1]}`; all other checks unchanged. `svelte.config.js`: the existing exact-origin parse additionally accepts `ws://127.0.0.1:<port>` / `ws://localhost:<port>` **iff** `process.env.SIBAMBO_LOCAL_DEMO==='1'`; otherwise the existing `wss:` rule throws as before.

### C8 Launcher `tooling/local-demo/launch.mjs`
Sequence (fixed): (1) resolve paths/args (`--run-root`, `--python`, `--builder`, `--project local-demo`, `--rebuild`, `--replace-task-owned`, `--no-agents`); reject `C:`; (2) read-or-create `<run-root>/private/owner-token` and `session-key` (32 random bytes base64url; file written once, never printed); (3) port check per L12; (4) spawn Python runner with env `SIBAMBO_LOCAL_OWNER_TOKEN`, `TEMP/TMP`; wait for `LOCAL_DEMO_READY` (timeout 60 s) → else kill and exit 2; (5) if `apps/editor/build/__local_demo.json` ≠ `{ws:'ws://127.0.0.1:8765',head:<git HEAD>}` or `--rebuild`: run `bun run build` with `SIBAMBO_LOCAL_DEMO=1 SE05_DRAFT_WS_ORIGIN=ws://127.0.0.1:8765`, then write the stamp; (6) spawn `node build/index.js` with `HOST=127.0.0.1 PORT=5175 ORIGIN=http://localhost:5175 SE04_LOCAL_DEMO=1 SE04_LOCAL_OWNER_TOKEN SE04_SESSION_KEY SE04_SERVICE_BASE_URL=http://127.0.0.1:8765 SE05_DRAFT_WS_ORIGIN=ws://127.0.0.1:8765 SE04_LOCAL_PROJECT`; poll `/` 200 (60 s); (7) print the Editor URL, the two agent commands (paths only), and `Ctrl+C to stop`; (8) on signal terminate both children, delete `agents/*` configs and bridge secret files, keep `manifest.json` renamed `manifest.last.json`. Writes a PID/command ledger `<run-root>/pids.json` used by L12.
`run-agent.mjs <claude|codex> <case>`: adapted metadata-only runner (no raw model payload/log): spawns the client with the generated config, `--strict-mcp-config`/per-tool `approve`, built-in tools off, allowed tools restricted to the eight, prompt from a case table (`probe, build, revise-inbox, opening, verify, contention`), records JSON receipt to `--out` on `D:` with client version, case, timings (spawn→first tool, first tool→final, total), tool-call names/counts, error codes, revisions, final JSON (`outcome/revision/codes/moduleIds`); kills the child on any non-allowed tool use. **Does not paste the guide into the prompt** (the product must deliver it).

## Invariants

1. Exactly one `ProjectActor` per project; every tool call from either client, the owner API and the WS use it; no second journal/draft.
2. Eight tools; no save/export tool; caps 1–8 modules, 256 KiB request, 64 KiB module unchanged.
3. Atomic transaction: a rejected transaction changes nothing; events are one per accepted revision; viewer swaps all modules of a transaction together.
4. CAS (`baseProjectRevision`, `expectedModuleRevision`), writer fence + lease, idempotency (`replayed`), epoch UUID, ACK-after-frame and snapshot-before-ACK unchanged and still tested.
5. `addressed` follows ACK of the carrying revision only (L8); request text never logged; model payload never logged.
6. Selecting/re-attaching never accumulates meshes: after any reconnect/second tab/restart the viewer shows one module per `moduleId` and the revision equal to the server's.
7. Local mode is unreachable from Vercel builds and from non-loopback hosts; remote tests unchanged and green.
8. No file outside `D:` is written by launcher, runner or tests (temp included).
9. Last good frame stays visible on error, pause, logout, reconnect failure, epoch change.
10. No automatic camera fit on live edits (existing explicit **Bingkai draft**).

## Edge Cases and Failure Semantics

| Case | Required behaviour |
|---|---|
| Port 8765/5175 busy, not a recorded child | launcher exits 2, prints owning PID + command line only, touches nothing |
| Owner token missing/short/rotated | Python exits 2; BFF returns 503 `Local demo mode is misconfigured`; old cookie invalid → "Masuk (demo lokal)" again |
| Launcher restart | new actor + new epoch; open tab shows `EPOCH_CHANGED` message, keeps last frame; summary states the old RAM model is **not** restored |
| Agent writes with no viewer | `NO_ACTIVE_VIEWER` (E7 unchanged); agent must stop and tell the owner to press **Hubungkan draft live** |
| Both clients try the writer | second gets `LEASE_HELD` with `retryAfterMs`; after release it succeeds; no interleaved transaction |
| `requestId` unknown / not an owner request id | ignored (no association), write still commits; never an error |
| `requestId` int | normalised to string, associates |
| Owner pause | `PAUSED_BY_OWNER` for `acquire_writer`/`apply_operation`; resume restores |
| Replay after lost response | `replayed:true`, no second event, `rendered` reflects ACK |
| Slow/hidden tab | `RENDER_PENDING`/`RENDER_ACK_TIMEOUT` unchanged; follower never ACKs |
| Bridge secret file unreadable | uniform `UNAUTHENTICATED` tool error, no path in message |
| `includeIr` on missing module | existing `NOT_FOUND` |
| Out of scope (state in summary, not implemented) | physical offline test automation, roof/stair, Save/reopen (SE-07), restore (SE-08), read-only grant UI matrix, multi-machine |

## Work Packages

Strict order; each WP lists files, steps, acceptance, stop rule. Risk: L=low, M=medium. Eligible agent: any primary implementer unless marked. Sol/qualified REVIEW afterwards: **optional** except where marked.

**WP0 — Reclaim, ledger and plan (done in this document).** Verify sources/claims/locks (done), write v1.6, copy to Editor repo `docs/implementation-plan/`, sync Notion master page (v1.6 CURRENT note), SE-03/SE-05 task rows (claim **Claude Code (this session) — reclaimed 2026-11-14 from Codex desktop 01a1d520…; local-functional continuation**, Evidence/Next Action, Focus lane unchanged: SE-03+SE-05 **Now/Review**, SE-04 owner-held off focus, SE-06 **Up Next/Blocked**, Last Done SE-00/01/02, Experimental locked), add a "Deferred security backlog" section. **Stop:** if Notion live state shows another active claim newer than the snapshot → report, do not overwrite.

**WP1 — Builder local runner (risk M).** Steps: C2 → C1 → `tests/test_local_demo.py`. Acceptance: tests in §Test contract T-B1…T-B6 PASS; `python -m service.local_demo --help` exits 0; full baseline 109 tests still PASS. Checkpoint CP1.

**WP2 — Builder capability repair (risk L–M).** Steps: C3 → C4 → C5, update guide/schema tests. Acceptance: T-B7…T-B11 PASS (including **a test that fails on `eb28489`**: int requestId → `addressed` after ACK; and `includeGuide`/`includeIr` content/hash). Checkpoint CP2.

**WP3 — Editor local mode (risk M).** Steps: C6 → C7 (BFF, routes, connection type, panel, draft-client, svelte.config). Acceptance: T-E1…T-E6; `bun run check` 0 errors / 0 warnings; remote BFF tests unchanged green. Checkpoint CP3.

**WP4 — Launcher + runner (risk M).** Steps: C8 `launch.mjs`, `run-agent.mjs`, `README.md` (Indonesian owner steps). Acceptance: T-L1…T-L3. Checkpoint CP4.

**WP5 — Production-build browser proof, synthetic clients (risk M).** NEW Playwright spec `apps/editor/tests/local-demo.spec.ts` (config `playwright.local-demo.config.ts`): launches the launcher, signs in via the one-click link, opens `local-demo`, connects the draft, drives two scripted stdio-bridge clients (Python helper using `bridge_call`, one per principal) through build → inbox revise (requestId) → opening, asserts pixels/DOM/counters, two tabs, reconnect, pause/resume, restart. Acceptance: T-I1…T-I8 PASS on a clean production build. Checkpoint CP5.

**WP6 — Real clients (risk M, NOT SAFE FOR LOWER-CAPABILITY DELEGATION).** With the launcher running and the viewer attached: `run-agent.mjs` cases in order — Claude `probe` → Claude `build` → Codex `probe` → Codex `verify` (reads Claude's room) → Owner posts an inbox revision (UI, module = the room, text "make the room 4.5 m long") → Codex `revise-inbox` → Claude `opening` → both `verify`; then `contention` (scripted holder + real Codex). Acceptance: LF-5…LF-9 PASS or recorded FAIL with defect list; **retries of a failed case are allowed after a root-cause fix and are recorded as new rows; failures are never overwritten.** Checkpoint CP6. **Stop:** a real client cannot discover/call the tools after one fix attempt → record evidence, `blocked → REVIEW/PLAN`; do not weaken tool inventory/auth.

**WP7 — Visual and lifecycle proof in the real viewer (risk M).** Via the built-in browser: screenshots (dimensions overlay measurement from the model's own `inspect_module` bounds + the screenshot), two tabs, pause/resume, tab reload (reattach → snapshot → same module count), service restart (epoch message + last frame), dirty-unload `Cancel`. Evidence to `D:`. Owner human visual acceptance stays **manual pending**.

**WP8 — Summary, receipts, publication (risk M, NOT SAFE FOR LOWER-CAPABILITY DELEGATION).** Write `IMPLEMENTATION_SUMMARY_2026-11-14_SIB-LOCAL-MCP-LIVE-VIEWER-001_v1.0.md` (+ receipt JSONs under `outputs/2026-11-14-local-mcp-live-viewer/`), copy plan/summary into the Editor repo `docs/`, fetch and compare remotes, commit **only task-owned paths**, push `work/se-05/full-sync-20261113` of both repos (fast-forward; no force), update Draft PRs #24/#94 bodies with supersede links, sync Notion/GitHub issue comments (#16, #73), re-read the board. **Stop:** remote tip moved or unrelated dirty paths cannot be isolated → hold push, report.

## Test and Verification Contract

Evidence classes: UNIT, INTEGRATION, BROWSER, REAL-CLIENT, MANUAL. Each row has a negative assertion.

**Builder (UNIT/INTEGRATION, `unittest`, TEMP on D:)**
- T-B1 `LocalVerifier` accepts only the exact secret (wrong/short/empty/prefix → `None`; `verify_token` → `None`); neg: HTTP `/mcp` returns 401 for the owner secret.
- T-B2 `build()` yields one project, two grants with exactly `{read,write}` for the two named clients and **no** grant for any other principal; neg: a third principal gets `GRANT_DENIED`.
- T-B3 Two bridges share one actor: claude writes rev 1 (with a stub viewer ACK), codex `read_project` sees rev 1 and its own `writer` is `None`/`another`; neg: tampered secret refused uniformly (existing behaviour).
- T-B4 `SIBAMBO_BRIDGE_SECRET_FILE` works; missing/empty/oversized file → uniform `UNAUTHENTICATED`; neg: secret never appears in the returned error text.
- T-B5 `main()` refuses non-loopback bind and a `C:` run-root; exits 2 without manifest; unknown client → exit 2.
- T-B6 generated `claude.mcp.json` / `codex.overrides.json` contain no 64-hex secret and no owner token (regex scan); manifest has no secret.
- T-B7 **regression:** transaction carrying `requestId` as int (and as str) after `read_owner_requests` → status `read` → after primary ACK → `addressed` and `owner_request_status` emitted; before ACK still `read`; withdrawn stays withdrawn; unknown id no-op. **Fails on `eb28489`.**
- T-B8 `read_project(includeGuide=true)`: `guide.sha256 == GUIDE_SHA256 == sha256(markdown)`, version 2, size ≤ 16 KiB; default response keys unchanged (frozen key list).
- T-B9 `inspect_module(includeIr=true)` returns the canonical IR equal to the committed module (byte-equal canonical JSON); default response unchanged; unknown module `NOT_FOUND`.
- T-B10 guide lint/examples still execute (existing suite), `INSTRUCTIONS` ≤ 1800 chars, every tool description ≤ 2048 chars.
- T-B11 full existing suites still PASS (baseline 109 + new) with no timeout/threshold change.

**Editor (UNIT)**
- T-E1 `localDemo()` returns null without the flag; throws 503 with the flag and: `VERCEL` set, short token, non-loopback service URL, bad project id; neg: never falls back to OIDC.
- T-E2 login route in local mode sets the sealed session (issuer `sibambo-local-demo`, csrf, 4 h cap) and 303-redirects; refuses non-loopback `Host` and `Sec-Fetch-Site: cross-site`; **OIDC login untouched when flag absent** (existing tests).
- T-E3 `serviceBase()`/`draftWebSocketUrl()` accept loopback http/ws only in local mode; `wss:` rule unchanged otherwise; non-loopback `ws:` rejected in both modes.
- T-E4 `DraftClient` constructor: `ws://127.0.0.1:8765/draft` accepted; `ws://evil.example/draft`, `ws://127.0.0.1/draft?x`, userinfo → rejected.
- T-E5 `svelte.config.js` CSP: with `SIBAMBO_LOCAL_DEMO=1` includes exact `ws://127.0.0.1:8765`; without it the same origin throws (existing guard).
- T-E6 panel: banner + prefill + login label visible only when `localDemo`; existing remote strings unchanged.

**Launcher (UNIT)** T-L1 refuses `C:` paths; T-L2 port-owner check refuses unknown owner, accepts recorded child; T-L3 cleanup removes agent configs and secrets.

**Production-build BROWSER (WP5, real Chromium, real pixels, scripted clients)** T-I1 one-click login + open + connect; T-I2 build room → DOM counters accepted=rendered=1, one module, non-background pixels inside the viewport; T-I3 inbox request + requestId transaction → `data-revision`=2, request chip `addressed` **after** ACK (and `read` immediately before, asserted by pausing ACK via hidden tab); T-I4 opening transaction → rendered revision 3, still one module, no duplicate walls (module/face counts); T-I5 second tab → primary/follower, follower never ACKs; T-I6 forced WS drop → reconnect, same counts; T-I7 pause/resume; T-I8 service restart → `EPOCH_CHANGED` message, last frame retained.

**LF rows (final verdict ledger):** LF-1 launcher one command; LF-2 no Auth0/tunnel/cert dependency; LF-3 client configs contain no secret; LF-4 Claude discovers+reads; LF-5 Claude builds 4×3×2.7 room t=0.15; LF-6 Codex reads/inspects the same room (IR); LF-7 Codex revises via inbox with requestId, request `addressed` after ACK; LF-8 opening (window or door) added and visible; LF-9 validate valid/compiled with measured face/triangle counts; LF-10 writer contention `LEASE_HELD`; LF-11 pause/resume/reconnect/restart/two tabs no duplication; LF-12 accepted==rendered counters throughout. **Dimension check (LF-5):** `inspect_module` bounds and a viewer screenshot measurement must match 4.0 × 3.0 × 2.7 m within the compiler's rounding (≤ 0.01 m); report the actual numbers.

**RS rows — DEFERRED (not run, not converted):** RS-1 Auth0/OIDC owner login & PKCE; RS-2 Claude native pairing bootstrap vs EdgeGuard 403 (stays recorded **FAIL** for the *remote* path, task origin SE-03/SE-04, history unchanged); RS-3 tenant isolation / alternate-URL / second-tenant; RS-4 read-only grant matrix; RS-5 HTTPS/WSS + real tunnel; RS-6 pentest/hardening; RS-7 physical offline/online & native unload (listed also as local manual). **Activation condition:** owner lifts the deferral and supplies a non-production IdP/tunnel decision; then re-open under SE-03 (`stable/mcp`,`stable/auth-resource`), SE-04 (`stable/editor-onboarding`,`stable/auth-ui`), SE-05 (`stable/editor-sync`).

## Expected Final Diff

Builder: ≈ 1 new module (~250 lines) + new test file + small edits (bridge ≤ 15 lines; tools ≤ 40; mcp_http ≤ 25; tool_descriptions ≈ 25; guide +≈ 120 lines). Editor: `mcp-bff.ts` +≈ 60 lines, login/session routes ≈ +10, `connection.ts`/`McpPanel.svelte` ≈ +30, `draft-client.ts` ≈ +4, `svelte.config.js` ≈ +6, new `tooling/local-demo/` (~400 lines), new unit/browser tests, docs. **Scope-drift indicators:** any edit under `core/`, `bomc/`, `schemas/`, `packages/`, `draft-protocol/store/scene/worker`, `draft_ws.py`, `owner_mcp.py`, `auth.py`, `app.py`; any change to an existing remote test's expectation; threshold/timeout edits; a ninth tool; persistence; a modified `.mcp.json`/Codex global config.

## Checkpoints (gates)

- **CP0** plan file + tracker synced; old PIDs identified. Fail → stop.
- **CP1** T-B1…T-B6 PASS + baseline 109 PASS. Fail → fix within WP1 only.
- **CP2** T-B7…T-B11 PASS; T-B7 demonstrably red on `eb28489` (record the failing run). 
- **CP3** T-E1…T-E6 PASS, Editor `bun test ./unit/mcp` ≥ 98 + new PASS, svelte-check 0/0.
- **CP4** launcher starts both processes, `/healthz` 200, Editor `/` 200, `claude`/`codex` probe reads revision 0 (REAL-CLIENT probe permitted here).
- **CP5** T-I1…T-I8 PASS on clean production build.
- **CP6** LF-4…LF-12 recorded per case.
- **CP7** summary + receipts exist; remote tips fetched and compared; push done; Notion/GitHub read back.
Every CP failure ⇒ continue only independent packages; record evidence; no redefinition of success.

## Stop Conditions

Stop and report (do not redesign) if: repository HEAD differs from `fa818f3`/`eb28489` before WP1 in a way that touches a MUST-change file; a required symbol in the C-contracts no longer exists; `LocalVerifier` cannot be injected into `create_app` (spike says it can); `__Host-` cookie refused in the target browser; the real clients cannot call a tool after one documented fix attempt; any change would require editing a FORBIDDEN area; the remote tip contains unrelated work in a file we must change; a test needs a raised timeout.

## Manual Gates

Owner **Kais** (Windows, after `node tooling/local-demo/launch.mjs`): (M1) open `http://localhost:5175`, one-click sign-in, press **Hubungkan draft live**; (M2) run the two agent commands printed by the launcher and watch the room build/revise/gain an opening — expected: counters "Revisi diterima = Revisi tergambar", one room, no duplicate walls; (M3) post an inbox request, expect `open` → `read` → `addressed` only after the redraw; (M4) human visual judgement of the room proportions/opening (subjective, **owner-decided**); (M5) physically toggle the machine network while the tab is open, expect paused state then recovery without duplicates (not automated); (M6) close the tab with a live draft → warning, Cancel keeps the model. Results are reported by the owner; none is claimed PASS by the agent.

## Executor Completion Report Requirements

Report: files actually changed per repo; material deviations from this plan (none permitted without a new version); every check run with counts and limits; REAL-CLIENT receipts with client versions and **measured** spawn→first-tool / transport / accepted→rendered times (separate model thinking from transport/render; no percentile from a single sample; no cloud-latency claim from localhost); LF/RS table; remaining unverified claims; final diff vs Expected Final Diff; commit SHAs, PR/readback; connectivity note (cloud inference; not air-gapped).

## Final adversarial pass (planner)

A literal-minded executor could: (a) enable local mode by default → prevented by L1/L6 fail-closed + tests T-E1; (b) leave the guide only in prompts → prevented: runner must not inject it (LF-5 requires success without it); (c) pass tests with a stub viewer but never show pixels → WP5 uses real Chromium pixel/DOM assertions and WP7 screenshots; (d) mark `addressed` on accept → T-B7/T-I3 assert `read` before ACK; (e) copy secrets into client configs → T-B6 regex scan; (f) edit remote contracts to "make 403 friendlier" → forbidden, listed as RS-2 deferred; (g) write temp to `C:` → T-L1 and TEMP/TMP rule; (h) kill unrelated processes by pattern → L12 requires exact recorded PID + command-line match.

Unproven at plan time: real model's ability to author a valid room from guide v2 alone (to be measured in WP6; failure is a recorded defect, not a plan change unless it needs a design change → new version); `Sec-Fetch-Site` behaviour of the Chromium pane on a same-origin link navigation (expected `same-origin`/`none`; a mismatch is a stop).
