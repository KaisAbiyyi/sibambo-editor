# IMPLEMENTATION SUMMARY — local MCP + live viewer (master v1.6)

ID **SIB-LOCAL-MCP-LIVE-VIEWER-001** · Version **1.0** · Date **2026-11-14 Asia/Jakarta** · Status **LOCAL-FUNCTIONAL (LF) PASS on automated + real-client evidence; owner manual gates PENDING; remote/security (RS) DEFERRED; task stays Review, not Done.**

Governing: [MASTER IMPLEMENTATION PLAN SIB-TWO-PHASE-001 v1.6](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-14_SIB-TWO-PHASE-001_v1.6.md) (supersedes v1.5+D16 only for the local verdict and the combined-gate edge; Notion CURRENT page updated). Prior handoff: [handoff summary v1.0](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-LOCAL-MCP-LIVE-VIEWER-HANDOFF-001_v1.0.md); historical ledgers [acceptance v1.1](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-SE030405-LOCAL-ACCEPTANCE-001_v1.1.md), [SE-05 v1.2](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-TWO-PHASE-SE05-001_v1.2.md) are **unchanged and still valid within their original scope**.

Implementer: primary **Claude Code, model Claude Sonnet 5.5**; not on the AGENTS.md eligible-author list — eligibility rests on the owner's direct instruction for this session; equivalence to the floor is unverified. No subagents. Objective: Stable construction → live draft/ACK → (later) owner Save/reopen; this task covers only the local functional slice. Current phase: **local functional proven, awaiting owner visual/physical gates**. Next visible deliverable: the owner runs one launcher command and watches both agents on the same draft (steps below).

## Source identities

Builder `work/se-05/full-sync-20261113` base `eb28489ab8504e96eb1dde36f6bb1dce2d83eca4`; Editor same branch base `fa818f3f1e06b7e955e12b240206306fadb54338` (+ pre-existing untracked `tooling/testing/results/`, preserved, never staged). Final commit SHAs and remote readback: see the publication receipt `outputs/2026-11-14-local-mcp-live-viewer/receipt-publication.json` (a summary cannot contain its own commit). Runtime used for all real-client rows: Editor production build `fa818f3f`+task diff built by the launcher (`SIBAMBO_LOCAL_DEMO=1`), Builder working tree with the task diff, venv `outputs/2026-11-13-se05-full/ps51-acceptance-02/venv` (Python 3.13.12, `mcp 2.3.0`), Claude Code **2.1.322**, Codex **codex-cli 0.164.0**, Node v24.21.0, Bun 1.4.4, Chromium (Playwright) headless.

## Work packages

| WP | Status | Result |
|---|---|---|
| WP0 reclaim, plan, tracker | done | SE-05 claim v3 (reclaimed from Codex desktop per owner); v1.6 written and synced to Notion (master page, SE-05 row, SE-03 note — SE-03 claim owner left unchanged); old task-owned PIDs 42904/41420 verified by command line and stopped. |
| WP1 Builder local runner | done | `service/local_demo.py` (`LocalDemo`, `LocalVerifier`, client-config writer, loopback-only `main`), `bridge.py` secret-file, 12 new tests. |
| WP2 capability repair | done | `requestId` int/str normalisation (root cause of inbox staying `read`); `read_project(includeGuide)`; `inspect_module(includeIr)`; guide v2 (operation reference, room recipe, revising, owner requests); `INSTRUCTIONS`/descriptions; pinned guide hashes updated deliberately. |
| WP3 Editor local mode | done | `mcp-bff.ts` `localDemo()` fail-closed gate + `startLocalSession`, login/session routes, panel banner/prefill/login label, loopback `ws:` in `DraftClient` and CSP (build-time `SIBAMBO_LOCAL_DEMO`), 16 new unit tests. |
| WP4 launcher + runners | done | `tooling/local-demo/{launch,run-agent,live-acceptance,restart-check}.mjs`, README (Indonesian owner steps). |
| WP5 synthetic production-browser spec | **partial / deviation** | The planned scripted-client Playwright spec (`local-demo.spec.ts`) was **not written**; its rows are covered by the real-client harness `live-acceptance.mjs` (real Chromium + real clients) instead. No CI-runnable regression exists for the local-mode browser path yet. The existing remote-path browser suite was re-run (below). |
| WP6 real clients | done | See LF table. |
| WP7 viewer/lifecycle | done (agent-observed) | Screenshots on D:; human visual judgement pending. |
| WP8 summary/publication | see publication receipt | |

## Checks actually run

- Builder `unittest` (venv above, TEMP on D:): initial baseline **109 PASS** before changes; after changes the combined suites `test_remote_mcp, test_remote_mcp_guide, test_draft_ws, test_project_actor, test_local_demo, test_draft_operations` — result in `logs/builder-suite-final.log` copied to the receipt folder (count recorded in the publication receipt). `test_bmb023_mcp` + `test_bmb023_mcp_schema` (run from `tests/`, their own import style): **34 PASS, 1 skipped**. A first combined run failed only on the **deliberately changed** pinned guide expectations (`GUIDE_VERSION`, `se03-expected.json` hashes); these were updated in the same change, not relaxed elsewhere.
- **Regression proof:** `tests/test_local_demo.py::CapabilityTests::test_int_request_id_is_addressed_only_after_the_render_ack` **fails on `eb28489`** (`read` ≠ `addressed`; log `red-on-eb28489.txt`) and passes now.
- Editor `bun test ./unit/mcp`: **114 PASS / 0 FAIL** (98 baseline + 16 new, 377 expects). `bun run check`: **0 errors / 0 warnings** (1012 files).
- Existing remote-path production browser integration `bun run test:se05` (synthetic TLS IdP, real BFF/worker/viewport): **8 PASS** — shows the OIDC/wss path is unchanged. Limit: this rebuilt `apps/editor/build` in remote mode; the launcher re-stamps and rebuilds on the next start.
- No threshold/timeout was raised; no remote test expectation changed except the intentional guide pins.

## LF verdict ledger (clean end-to-end run `1794658039634`, fresh service epoch)

All rows below are **real Claude Code 2.1.322 / real Codex 0.164.0** (cloud-hosted inference) against one canonical actor, with a real headless Chromium viewer over plain loopback `ws://`. Receipts: `outputs/2026-11-14-local-mcp-live-viewer/1794658039634-live-acceptance-receipt.json` + per-client metadata files (metadata only; no raw model/tool payload, guide, owner text beyond the fixed test sentence, token or ticket saved).

| Row | Verdict | Evidence / limit |
|---|---|---|
| LF-1+2 one command, sign-in, attach, no Auth0/tunnel/cert | PASS | `launch.mjs` → `LOCAL DEMO READY`; one-click "Masuk (demo lokal)"; viewer "Viewer utama · revisi 0/0". Sec-Fetch/host checks and `__Host-` cookie work on `http://localhost` (Chromium). |
| LF-3 client configs secret-free | PASS | regex scan: no 64-hex, no owner token (also T-B6). |
| LF-4 Claude discovers 8 tools, reads, receives guide v2 via MCP | PASS | 9.8 s total, first tool at 4.6 s; guide **not** in the prompt. |
| LF-5 Claude builds room, viewer accepted=rendered=1, one module | PASS | 18.5 s total; `apply_operation` 121 ms client-observed. Agent declared sizes **internal**. |
| LF-5b dimensions from committed IR | PASS | wall thickness 0.15, height 2.7, centre-line span 4.15 × 3.15, internal clear **4.0 × 3.0** (agent's declared interpretation; compiled bounds include half-thickness). Plan wording "4.0 × 3.0 bounds" is clarified: either interpretation is accepted **only if declared and measured**. |
| LF-6 Codex reads/inspects (`includeIr`) same canonical room | PASS | 30 faces / 60 triangles, valid+compiled; first tool at ~15.9 s (Codex startup + model). |
| LF-7 owner inbox → Codex revision with `requestId` → `addressed` after ACK | PASS | request id `1`; UI showed `open` before, `addressed` after viewer rendered rev 2 (counters 2/2). Prior native FAIL (requestId omitted) is root-caused (tool description/guide silent, integer id vs string schema) and repaired. |
| LF-8 one window added by Claude, rendered rev 3, still one module | PASS | 1.0 × 1.2 m, sill 0.9, south wall; module count 1; 86 faces/172 triangles reported by Codex's later read. |
| LF-9 both clients read+validate same final draft | PASS | both revision 3, valid/compiled. |
| LF-10 writer contention | PASS (real Codex; holder is a **scripted** bridge client acting as the Claude principal) | `LEASE_HELD`. Two simultaneously active *real* writers were not run. |
| LF-11a pause / resume | PASS | real Codex `PAUSED_BY_OWNER`; after resume lease granted (that run's own final outcome parsed `pass`). |
| LF-11b two tabs | PASS | latest primary, earlier follower, both rev 3 / one module. |
| LF-11c reload + reattach | PASS | server snapshot restores rev 3, one module, no duplicate walls. |
| LF-11d emulated network drop | **INCONCLUSIVE** | harness recorded PASS but the existing socket was never observed to drop (status stayed live while "offline"). Not claimed. Forced WS drop/reconnect is covered by the existing synthetic browser tests (8 PASS) and the earlier real renewal (294 ms, historical); **physical offline remains a manual gate.** |
| LF-11e server restart | PASS by screenshot inspection; automated criterion invalid | `restart-check` receipt `1794658431122` is FAIL because its WebGL pixel heuristic is invalid (canvas readback blank); screenshot shows the retained room+window and "Epoch server berubah…"; epoch changed; new server empty (old model **not** restored). Script corrected; the FAIL receipt is retained. |
| LF-12 accepted == rendered | PASS | 3/3 in DOM and panel. |

**Retained failed/earlier attempts (not overwritten):** (a) hidden browser pane → Codex `revise-inbox` blocked `NO_ACTIVE_VIEWER` (receipt `1794657298927`): a hidden/throttled tab is correctly not an active viewer; fix = use a visible viewer (harness). (b) Three harness-startup failures (`1794657397771`, `…438175`, `…476620`). (c) Run `1794657512952` (before prompt/parse fixes): LF-6, LF-8, LF-9, LF-11a FAIL from the harness **prompt wording** ("never print the guide" while the tool result contains it) and a JSON-extraction weakness in `run-agent.mjs`; second-tab harness error. Both fixed and the full run repeated clean. (d) LF-11e harness criterion above.

## Timing (single samples, localhost; model thinking is cloud-hosted)

Client-observed tool time is small: `read_project` ≈ tens of ms; `apply_operation` 121–177 ms (Claude/Codex) including preflight/validation, **not** including the viewer's ACK; whole-run time is dominated by model inference (e.g. Claude build 18.5 s of which 18.2 s outside tool calls; Codex revise 62.3 s of which 61.5 s outside). Spawn→first tool: Claude 3.6–6.4 s, Codex 12.1–15.9 s. No percentile, no accepted→ACK latency (not measured server-side), no cloud/serverless claim.

## Deviations from the plan (disclosed)

1. Issuer string is URL-shaped `http://127.0.0.1/sibambo-local-demo` (the MCP SDK rejects a bare string); same identity role as plan L3.
2. WP5 spec not delivered (above).
3. Row T-I3 "request is `read` immediately before ACK" is proven only at unit level (T-B7); in the browser run only `open` before and `addressed` after were observed.
4. `read_owner_requests` etc. unchanged; no ninth tool; no Save/persistence.

## Deferred security backlog (RS rows — NOT RUN, not converted)

RS-1 Auth0/OIDC/PKCE owner login · RS-2 Claude native pairing bootstrap vs EdgeGuard 403 (**remains the recorded FAIL of the remote path**, origin SE-03/SE-04) · RS-3 tenant/alternate-URL isolation · RS-4 read-only grant matrix · RS-5 HTTPS/WSS + real tunnel · RS-6 pentest/hardening · RS-7 physical offline/native unload. Activation: owner lifts the deferral and decides a non-production IdP/tunnel; then re-open under SE-03/SE-04/SE-05 locks. Local demo mode is **not** a security posture; remote code is untouched.

## Connectivity and security notes

Model inference by Claude/Codex is cloud (their existing account logins; API-key env vars stripped for the runs). Everything else is loopback; nothing was published or tunneled; Vercel/Tailscale/Auth0 untouched. Local demo has no network authentication beyond: owner secret (BFF only), per-client bridge secret in a private D: file, loopback binds, host/Sec-Fetch checks, existing CSRF/Origin.

## Manual owner gates (owner **Kais**; none claimed)

Follow `tooling/local-demo/README.md`: M1 sign-in + attach; M2 run `run-agent.mjs claude build` then `codex verify`; expected one room, counters equal, no duplicates; M3 post an inbox request then `codex revise-inbox`: expect `open`→`read`→`addressed` only after redraw; M4 **visual judgement** of proportions/window (yours); M5 physically cut/restore the network with the tab open: expect paused then recovery without duplicate walls; M6 close the tab with a live draft: warning, **Batal** keeps the model; keep the tab visible while agents run.

## Unresolved / next

Unverified: physical network drop, native beforeunload, human visual fidelity, two simultaneous real writers, first-502 root cause (not reproduced in this task), CI regression for local mode (WP5 gap). Not done by design: Save/reopen (SE-07), restore (SE-08), Experimental (stays locked), any RS row. Next action: owner gates above; then decide whether to lift the security deferral or continue with SE-06/SE-07 under the existing board (SE-03+SE-05 Now/Review, SE-04 owner-held off focus, SE-06 Blocked/Up Next, Last Done SE-00/01/02).

## Cleanup performed

Stopped the verified task-owned old runtimes (PIDs 42904, 41420) and the new launcher runtimes. See the publication receipt for the final cleanup list (agent configs/bridge secrets are removed by the launcher on stop; the old Auth0 private config/key and temporary localhost certificate entry are handled per the ledger, with any item left in place named there).
