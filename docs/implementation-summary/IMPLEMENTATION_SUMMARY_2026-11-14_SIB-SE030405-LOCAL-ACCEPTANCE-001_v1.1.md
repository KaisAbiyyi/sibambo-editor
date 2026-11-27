# IMPLEMENTATION SUMMARY — real local SE-03/04/05 acceptance

ID **SIB-SE030405-LOCAL-ACCEPTANCE-001** · Version **1.1** · Date **2026-11-14 Asia/Jakarta** · Status **PARTIAL / combined gate FAIL — Codex construction demonstrated; Claude pairing blocked**.

Supersedes [preparation v1.0](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-SE030405-LOCAL-ACCEPTANCE-001_v1.0.md). Governing: SIB-TWO-PHASE-001 v1.5 + accepted D16; [SE-05 source summary v1.2](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-TWO-PHASE-SE05-001_v1.2.md). Operator: primary Codex desktop session, no coding delegates; exact deployed model provenance unverified. Revision history: v1.1 adds actual Auth0/native-client/browser outcomes and the reconnect correction; historical failures remain recorded.

## Scope and work packages

The owner's latest direction is **both MCP and consumer Editor local**. Actual HTTPS/WSS runtimes use real Auth0; real Codex and Claude Code use their existing provider accounts. No public tunnel was opened, and no Vercel configuration or deployment was intentionally changed. Auth0/provider traffic is external; this is not an offline-LLM claim. Public/multi-machine Stable acceptance remains deferred.

| WP | Status | Evidence |
| --- | --- | --- |
| 1 local HTTPS/WSS | done | Loopback-only production Editor and actual Builder service; certificate validation retained. |
| 2 real identity | done | Development Auth0, distinct owner/Codex/Claude clients, S256/native callbacks, audience and tenant claim; actual application and native-client OAuth completed. |
| 3 pairing/access | partial | Codex correct-code approval, wrong-code rejection, exact signed client/read+write grant, other-project argument rejection, pause and revoke PASS. Claude bootstrap reports needs-auth and does not present its pairing code. |
| 4 construction/revision | done for Codex | One floor/four-wall room, one stable module, revisions 1 then 2; owner inbox read; actual visible render and server ACK 2. Claude construction NOT_RUN. |
| 5 browser lifecycle | partial | Two-tab roles, reconnect after real owner-session renewal, logout retention, dirty warning/Cancel PASS. Physical network interruption and native browser beforeunload remain manual/NOT_RUN. |
| 6 receipts/timing | done | Metadata-only receipts distinguish actual, synthetic, FAIL and NOT_RUN. No raw tool/model payload, owner request body, bearer, OAuth code or ticket saved. |

## Real outcomes

- **Codex 0.164.0**, existing ChatGPT login: real OAuth and exact client identity succeeded. Initial ungranted startup returned 403 with a comparison code. A wrong code was rejected; the matching code created exactly the requested read/write grant. Same-human subject across owner and native app was verified without exposing the subject in receipts.
- The first authorized read succeeded at project revision 0. An attempted `projectId=se030405-other` through the selected URL returned `INVALID_REQUEST`; this proves argument/URL confinement, not a second-tenant or alternate-URL experiment.
- Owner pause made real `acquire_writer` return `PAUSED_BY_OWNER`. After resume, Codex created `room/acceptance/empty-room` at revision 1 and revised it to 2 after reading the owner inbox. The UI showed one module throughout. Final actual `validate_draft` returned **valid=true, compiled=true, 30 faces, 60 triangles**.
- Owner status readback was **Revisi diterima: 2 · Revisi tergambar: 2**. Both tabs displayed 2/2. The most recently attached tab became primary; the earlier tab became a read-only follower. This is actual browser/service evidence; subjective architectural fidelity is not certified.
- Revoking Codex's grant made that same native client, without replacing its OAuth token, fail bootstrap with 403 before a tool call. Fresh code comparison then restored the same exact grant and authorized validation worked again.
- Logout returned the owner panel to its login link, paused writes, and kept the last revision-2 frame in the tab. The close-draft warning appeared; **Cancel** retained the same revision/module count.

The native revision request remains **read**, not **addressed**: that agent's transaction did not associate its `requestId`. Geometry revision succeeded, but native request-completion acceptance is still open. The existing synthetic integration proves association becomes addressed only after the matching render ACK; that is supporting evidence, not a substitute for the native run.

## Real reconnect defect and delivered correction

After a long pause and owner reauthentication in another tab, the old DraftClient retained its initial CSRF in `DraftOptions`. Explicit reconnect reused it and exhausted retries while retaining the last frame. This was an actual FAIL.

Editor source **833f9560b8d4f66683ab36f4ef273679d3287857** corrects the existing reconnect boundary: obtain the current, strictly scoped BFF session before each reconnect ticket; stop on HTTP 401/403 or a scope mismatch; preserve the model. Transient failures retain bounded backoff. No OAuth/grant/CSRF validation, project scope, ACK, digest, geometry or volatile-storage rule was relaxed.

Four regression tests first failed on the old behavior. After correction: **155 unit tests PASS**, Svelte check **0 errors/0 warnings**, generated-validator check PASS, **8 production BFF/TLS/worker/viewport browser tests PASS**, local production build PASS. One initial CSP subprocess timed out under the existing 5-second limit; unchanged focused and full reruns passed at the same limit. No threshold was raised.

The corrected clean production build `833f9560` was then tested with real Auth0: connect revision 2, complete another actual owner login in a separate tab, then reconnect the already mounted draft. It returned **live / primary / 2/2 / one module in 294 ms observed elapsed**, with no geometry mutation. This is a single local observation, not a percentile or cloud cold-start result.

## Claude blocker and stop boundary

**Claude Code 2.1.322** completed real OAuth using its distinct approved native client. Stored-credential metadata matched issuer, audience, client and tenant, with an unexpired token. The backend owner view showed a pending request from that signed client. However, native startup and native health reporting classified the endpoint as **needs authentication**, exposed no construction tools and did not present the comparison code. A bounded print probe was stopped after 251349 ms with zero tool calls; raw diagnostics were discarded in memory.

`service/mcp_http.py::EdgeGuard` enforces project read capability before passing any MCP request to the official SDK. An ungranted valid client receives HTTP 403 and the pairing body. Codex presents that body; Claude's tested flow does not. Current service tests explicitly require capability-less metadata requests to return 403. Moving authorization after metadata discovery would change that contract and therefore requires **REVIEW/PLAN**, plus a separately tested compatibility path. It was not silently implemented during acceptance. The operator did not approve Claude using a code read from server internals, a synthetic identity or a copied bearer.

Earlier Claude OAuth diagnostics emitted an issuer-stamp warning. The later stored entry does have the expected issuer; full client issuer-isolation behavior is not established by that metadata check. No issuer-isolation PASS is claimed.

## Failures retained and limits

- First owner callback: expired/invalid transaction 403 after an operator delay; a fresh flow succeeded. Transaction lifetime was not widened. Fresh-flow observed 41541 ms includes operator time.
- First owner project-open: upstream 502; retry after restarting only the task-owned Editor succeeded. Root cause was not reproduced and remains unresolved. No speculative production fix is attributed to this.
- Codex initially could not dispatch tools because Code Mode was disabled and then its eight task tools lacked explicit client approval. Per-invocation configuration was corrected; global Codex settings were untouched. Shell/browser/apps/other MCP servers stayed disabled. Claude used strict MCP configuration and no session persistence.
- Read-only grant selection was not exercised: current pairing requests exactly read+write. Other-tenant isolation, writer contention between both clients, physical offline/online recovery, native unload, broad real-client security, cloud/serverless performance, Save/reopen, restore and SE-11 remain NOT_RUN.

## Identities, evidence and next action

Builder remains **eb28489ab8504e96eb1dde36f6bb1dce2d83eca4**, [Draft #94](https://github.com/KaisAbiyyi/sibambo-bomc-builder/pull/94). Editor repair is on [Draft #24](https://github.com/KaisAbiyyi/sibambo-editor/pull/24); final publication identity/checks are in the receipt. Local endpoints remain `https://localhost:5175`, `https://localhost:8765/mcp?project=se030405-local`, `wss://localhost:8765/draft`.

Workspace evidence directory: `D:/projects/sibambo/outputs/2026-11-14-se030405-real-acceptance/`. Read `receipt-03-real-clients.json`, `receipt-04-publication.json`, the timestamped metadata files and `reconnect-qualification-01/run.json`. Screenshots include `codex-room-revision-1.png`, `codex-room-revision-2.png`, `unsaved-draft-warning.png` and `fixed-reconnect-revision-2.png`. Private runtime material is excluded from publication.

Next: qualified **REVIEW/PLAN of the Claude pre-grant compatibility boundary**, then rerun only failed/unproven rows. Real native request association must also be demonstrated with `requestId`. Do not repeat successful construction to disguise these missing gates.

Manual owner **Kais**, after the compatibility repair: verify the ordinary Claude flow presents the matching code and only approved tools; request a revision and expect matching accepted/rendered revisions plus addressed inbox status; interrupt/restore browser networking and expect no duplicate walls; cancel native unload and expect retention. Human visual acceptance remains the owner's decision.

Parent objective remains Stable agent construction → live owner view → owner Save/reopen. Current phase is **real local acceptance, incomplete**. SE-03/SE-05 remain Review; owner-held SE-04 remains off focus, SE-06 Blocked/Up Next, Experimental locked. Next user-visible deliverable: both real clients can pair and revise this same local draft, with a complete receipt. No Done, merge, remote acceptance or live Save/reopen claim.

Task-owned runtimes and temporary localhost trust are retained while this interrupted acceptance continues. At session closure, stop only task-owned processes, remove the exact certificate thumbprint from v1.0, remove task-owned private config/key and Claude project registration, and retain public receipts. Do not reset Tailscale or unrelated client configuration.
