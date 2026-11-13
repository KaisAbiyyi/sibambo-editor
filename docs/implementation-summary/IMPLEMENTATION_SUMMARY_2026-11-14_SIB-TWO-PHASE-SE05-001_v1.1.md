# IMPLEMENTATION SUMMARY — SE-05 FULL live draft integration

ID **SIB-TWO-PHASE-SE05-001** · Version **1.1** · Date **2026-11-14 Asia/Jakarta**. Status: **FULL source implementation / REVIEW; real owner acceptance remains open**. Supersedes [v1.0 partial stop](IMPLEMENTATION_SUMMARY_2026-11-13_SIB-TWO-PHASE-SE05-001_v1.0.md). Revision history: v1.1 implements the owner's FULL continuation, resolves the source blockers and publishes replacement cross-repository PRs; historical evidence is retained.

Implementer: Codex desktop, session `01a1d520-afe9-70f1-b2b2-ea496930ef77`, primary implementer and direct self-reviewer; no delegates or independent approval. Runtime identifies the Codex/GPT-6 family; precise deployed model provenance is unverified. The user's direct IMPLEMENT authority permits this implementation/self-review and is not represented as verified PLAN-author equivalence.

Governing scope: [master v1.5](https://app.notion.com/p/412c4a6aaf738117ac36c5101c01fae2), [accepted D16](https://app.notion.com/p/414c4a6aaf7381bcb9cacb726fc6258b), [SE-05](https://app.notion.com/p/412c4a6aaf7381e29bd5d6be758b2303), and the owner's subsequent instruction to fix every blocker, implement FULL and make new PRs. That instruction authorizes the bounded upstream owner/auth/wire corrections that the earlier receipt correctly stopped on. The explicit [compatibility contract](https://github.com/KaisAbiyyi/sibambo-bomc-builder/blob/eb28489ab8504e96eb1dde36f6bb1dce2d83eca4/docs/stable/SE05-DRAFT-CONTRACT.md) records those decisions; accepted actor/compiler internals and historical pins are preserved.

## Source and publication identities

| Repository | Inspected main base | Qualified runtime/source commit | Replacement PR |
| --- | --- | --- | --- |
| Editor | `4166e829840e393541506f4963995f193cc93d07` | `1292396c28fced0f831567f9c549a3c541056cee` | [Editor #24](https://github.com/KaisAbiyyi/sibambo-editor/pull/24) |
| Builder | `6e3990f4cc57a3b2e8eab431aa263003a69afc16` | `eb28489ab8504e96eb1dde36f6bb1dce2d83eca4` | [Builder #94](https://github.com/KaisAbiyyi/sibambo-bomc-builder/pull/94) |

Both branches: `work/se-05/full-sync-20261113`. Earlier checkpoints remain in history: Editor `fb7de70`, `3843bc9`, `9d0e12f`, `6dff27f`, `9ed77c2`, `7c05f9f`; Builder `df954d0`, `52025a2`. Final publication adds the current receipts, one timing attachment and CI trigger cleanup to Editor; the exact final HEAD/remote refs/checks are recorded in [publication-receipt.json](https://github.com/KaisAbiyyi/sibambo-editor/issues/16). This receipt must be read before claiming final hosted qualification. No merge, intentional deployment, account/tunnel activation, producer build or installation occurred. Existing Vercel auto-previews are separate from backend/live acceptance.

## Outstanding packages executed

| Package / acceptance | Status | Result |
| --- | --- | --- |
| Owner API and authenticated client compatibility | done | Public `se04-owner-mcp-v1` adapter, explicit POST open, signed `(issuer,sub,client)` identity, exact pairing/scopes, pause/revoke/logout, bounded inbox and correct ticket response. |
| UUID / numeric wire reconciliation | done | Random UUID per actor instance and complete numeric-operation digest over the preserved integer actor/legacy atomic transaction. Mandatory dependency CAS, exact replay and tombstone rules. |
| WebSocket / S8 / S10 | done | Origin/Host checks, first-message ticket, latest-primary/follower roles, visible presence, digest/revision ACK, no headless writes, render-pending/timeout behavior. |
| Worker/store/render/lifecycle | done | Exact-byte hashes and static public-schema validation off-thread; complete transactional staging, shared projection, atomic swap/rollback, exactly-once resource disposal, frame/RAF ACK, stale generation and epoch fencing. |
| P6 / P8 / X1 | done | 64-event/4 MiB peer queue, 128-event/8 MiB ring, bounded snapshot resync, exponential jitter with six retries, retained last model, dirty transition/unload handling and idle TTL. |
| SE-05.A owner request status | done | Status-only messages never increment project revision; typed context reaches agents; withdrawn requests are excluded; addressed requires the related render ACK. |
| D16 S7 | done, reused and integrated | Exact configured WSS CSP, frame/object/base protections, security headers, static generated validator without JavaScript eval, CSRF/session boundaries. |
| Checks / CI / handoff | done in source | Repeatable real TLS cross-repository harness and PowerShell 5.1 helper; Ubuntu/Windows qualification and Indonesian owner SOP. Final hosted verdict is in the publication receipt. |

## Concrete changed boundaries

Builder production: `service/draft_ws.py` owns tickets/channels/presence/queues/ACK/TTL; `owner_mcp.py` owns the public BFF adapter; `draft_wire.py` owns numeric-to-legacy mapping. `app.py`, `auth.py`, `tools.py` and `mcp_http.py` integrate those boundaries. `errors.py` and the draft error schema add `RENDER_PENDING`; hash-locked `wsproto==1.2.0` enables the actual application WebSocket. The original transport tests use an explicitly named legacy viewer test double; the new channel tests use the real strict default. The historical evidence generator projects its original 24-code receipt while the complete error catalogue independently covers the added code.

Editor production: `draft-protocol.ts`, `draft-store.ts`, `draft.worker.ts`, `draft-client.ts`, `draft-scene.ts` and the static generated schema validator implement the pipeline. `+page.svelte` owns candidate viewport transitions, draft state and disposal. `PreparedSceneViewport::setExternalDraftProjection` stages/swaps all targets before one frame, rolls back all targets on failure and retains draft bounds for explicit framing. BFF session/logout/request routes, `mcp-bff.ts`, `connection.ts`, `McpPanel.svelte`, `OwnerRequests.svelte`, local workspace CSS, `hooks.server.ts` and `svelte.config.js` supply authenticated entry and status.

Tooling: `run-se05.ts`, `generate-draft-validator.ts`, `se05-acceptance.ps1`, dedicated Playwright config and cross-repository CI. The generator compares the public Builder schema on the pinned checkout; LF-normalized schema SHA-256 is `3ca89523ff3239e1cb52e716ca3aebc8a30a9bbddbb512d4c3111188b57a66a5`. It emits static validation with safe CommonJS helper interop, never a browser schema compiler. The misplaced Bun unit test moved out of Playwright's directory. Historical DOM tests were corrected to the current footer, file-reset lifecycle and selectors; their fixture/hash expectations were not repinned.

Unchanged: Builder `core/`, compiler/BOMC bytes, accepted historical expected receipts, original importer/writer semantics, producer/E4 runtime, native installations, arbitrary local mesh editing and Experimental implementation. Pre-existing untracked Editor `tooling/testing/results/` was preserved and excluded from commits.

## Checks actually run and their limits

| Evidence | Result / scope |
| --- | --- |
| Builder selected regression run | 166 PASS across remote MCP/guide, draft operations, actor and four-room tests before the final conservative clock adjustment; final SE-05 suite below covers that adjustment. Protected predecessor CI runs on the final Builder commit. |
| Final Builder channel suite | **19 PASS**, actual loopback TLS, SDK MCP and WebSocket; includes pairing/revoke, same-human/different-client denial, expiry/reuse/origin/project negatives, numeric dependency CAS, complete idempotency, lost accepted HTTP receipt, primary/follower, timeout, bounded queue, logout and idle purge. |
| Editor portable units | **151 PASS**, including exact hash/schema/tombstone staging, two-target frame rollback/disposal and explicit draft framing without automatic camera movement. |
| Editor static/build | Svelte check **0 errors / 0 warnings**, package `tsc` PASS, Node production build PASS. Existing chunk/dynamic-import advisory messages remain; no bundle/performance certification is inferred. |
| Cross-repo production browser | **6/6 PASS** against the actual Builder/BFF/WSS/worker/viewport. Tests cover visible rendered geometry pixels after explicit framing, frame ACK, reconnect without duplication, corrupt/gap resync, roles, dirty cancel, request completion, delayed old-project response, exhausted retries and changed epoch retaining the old model. |
| Portable UI regressions | **17/17 PASS**: app build identity, model-title transition/rejection/close, onboarding/keyboard/responsive controls, security headers and Builder preview. Now included in hosted browser qualification. |
| Windows PowerShell 5.1 helper | Full preparation→unit/check/build→six actual browser tests PASS locally. Hosted Windows executes the same helper after the direct cross-repo run. |
| Historical byte/hash evidence | `examples.se03_evidence --check .../se03-expected.json` PASS; final Builder hosted predecessor jobs protect unchanged SE-01/02/03/compiler/interop pins. |
| Ticket measurement | Synthetic first-ticket HTTP latency **4.726 ms** in the recorded Node run; timing attachment is emitted by the final test. Real Vercel cold-start/tunnel timing is NOT_RUN. |
| Hosted matrix | Source runs: [Editor cross-repo](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43486995255), [Editor qualification](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43486995337), [original consumer](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43486994959), [legacy consumer](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43486995317); [Builder channel](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43485656342), [SE-03](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43485656459), [SE-01](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43485656227), [SE-02](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43485656229). Fresh final-HEAD states/URLs belong to the publication receipt, not assumptions from these links. |

Durable local evidence: `outputs/2026-11-13-se05-full/`, particularly `ps51-acceptance-02/`, `final-source/`, `portable-ui-final/`, `visible-pixels-framed/` and `ticket-metric/`. Diagnostics remain in `scratch/se05-full-20261113/`; all venvs, temp/cache, browsers, screenshots, logs and packages were directed to D:.

Failures retained and resolved: the initial real owner API 404/JSON/TTL/wire mismatch; same-subject client identity reuse; withdrawn inbox items; stale tickets through legacy pause; snapshot tombstone loss; omitted dependency CAS/incomplete numeric replay digest; generated-validator browser helper interop; stale file/footer test assumptions; explicit framing using an empty imported-scene bound. Windows repeated CI exposed a fine-clock expiry up to one coarse receiver tick over the strict 30s bound. Issuer and monotonic deadline now use **29.95s under the nominal 30s maximum**; BFF/browser still reject >30,000ms. A deterministic regression reproduces the former 30.015s case and passes the conservative fix. Initial workflow context/clean-checkout alias failures were fixed without weakening assertions.

The default historical full Editor suite was attempted and failed collection on unavailable exact pinned export/worklog inputs. Those corpus tests are **NOT_RUN / not qualified** here; they are not relabelled PASS. Missing data was not substituted, regenerated under a different identity or repinned. The portable, source-owned SE-05 and predecessor gates above are independently runnable and green only when their actual receipts say so. This report does not claim every historical or arbitrary-real-model test passed.

## Manual owner tests still required

Owner/operator **Kais**: follow [SE-05 Indonesian SOP](../owner-acceptance/SE-05.md), with the combined SE-03/04 real nonproduction Auth0 session.

1. Real Claude Code and Codex OAuth registrations, subject/client/code comparison, grant/read/write, pause/revoke and project isolation. Expected: each signed client needs its own consent; agent token cannot act as owner BFF. **NOT_RUN**.
2. Candidate HTTPS Editor + exact HTTPS/WSS service/tunnel, one synthetic room and revision, explicit framing, visible revision/ACK, owner request read/addressed/withdraw, two-tab primary/follower. Expected: one atomic model/revision; no viewer means no next write. **NOT_RUN**.
3. Disconnect/restore browser network, dirty New/Open/Close Cancel and actual reload/close warning, logout and restart. Expected: last good model remains, no duplicates, bounded retry/TTL, old tickets/epoch rejected; restart is not automatic restore. **NOT_RUN**.
4. Record real ticket/cold-start/tunnel timing and owner observations with exact service/UI commits and client/browser versions; no credentials, request text or model payload in public evidence. **NOT_RUN**.

These real-account/owner gates are separate from source completeness. Save/reopen of a live Builder draft is SE-07; explicit restore is SE-08. No unavailable Save button or local-authoring Save result is presented as their completion.

## Parent objective, phase and next deliverable

Parent objective: Stable remote agent construction → live owner view → explicit Save → original Editor reopen. Current phase: Phase 1, **SE-05 source delivered for review**. SE-00/01/02 are accepted predecessor milestones; SE-03/04 source is merged with real gates still Review. This continuation completes the source-owned SE-05 slice and corrects its upstream seams. SE-06 remains Blocked/Up Next until its prerequisites are accepted; its broader timeline, picking/observation, outside-view UX and rendering qualification remain distinct. SE-07…11 and the final Stable acceptance are outstanding. Experimental remains locked.

| Authoring roadmap item | Current evidence boundary |
| --- | --- |
| Reader/viewer readiness | Existing original-consumer/preview regression remains protected; no arbitrary-model certification added. |
| Progressive loading / boot | Existing importer unchanged; new bounded live staging is proven synthetically, not a new import/performance acceptance. |
| Canonical document / web writer | Existing local authoring writer preserved; live actor canonical IR and browser canonical strings are validated. |
| New / Save / reopen | Existing local workflow retained; remote live draft Save/reopen remains SE-07. |
| BOMC-to-SKP | Not implemented or newly qualified by this change. |
| Complex round-trip | Not qualified; native/user gates are not inferred from builds or pixels. |

Next user-visible deliverable: owner-qualified live construction on the candidate pair, followed by the separately authorized SE-06/07 slice. Definition of done for the next Save milestone is actual owner-triggered BOMC download from an exact live revision and successful original Editor reopen, with its own receipts. There is no invented overall percentage.
