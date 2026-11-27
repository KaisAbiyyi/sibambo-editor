# IMPLEMENTATION SUMMARY — SE-05 real-session reconnect correction

ID **SIB-TWO-PHASE-SE05-001** · Version **1.2** · Date **2026-11-14 Asia/Jakarta** · Status **source correction qualified / combined real acceptance PARTIAL**.

Supersedes [source v1.1](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-TWO-PHASE-SE05-001_v1.1.md). Governing master v1.5 + D16 and the owner's FULL/blocker-fix continuation. This material update records a newly observed real-session regression; previous source milestones and historical evidence remain valid within their original limits. Implementer: primary Codex desktop, precise model provenance unverified, no coding delegates.

## Outstanding work and delivered patch

Parent objective: Stable construction → live draft/ACK → owner Save/reopen. SE-05's original synchronization, security headers, wire mapping, worker validation, viewport swap, bounded queues/retry, roles and owner-request channel are already delivered in v1.1 and were not reimplemented.

Actual local testing found that a mounted DraftClient reused its original CSRF after another tab renewed the owner login. Reconnect exhausted retries although a valid new owner session existed. Commit **833f9560b8d4f66683ab36f4ef273679d3287857** repairs this existing lifecycle boundary:

- `connection.ts::McpHttpError` retains HTTP status without exposing response bodies. `ticket(..., refreshSession)` reads the current same-origin session for reconnect, verifies contract/project and uses its CSRF. Disconnected/missing-CSRF responses produce a clear login-expired error before a ticket POST.
- `draft-client.ts::connect`, scheduled retry and `reconnectNow` request fresh session state for reconnect. Authentication/access/scope failures stop visibly; transient failures retain the original bounded retry policy. Last committed model and generation fencing remain intact.
- `unit/mcp/connection.test.ts`, new `unit/mcp/draft-client.test.ts` and `tests/draft-sync.spec.ts` protect credential renewal, terminal 401/403, missing/other project, retained geometry and real production BFF reconnect.

| WP | Status | Current result |
| --- | --- | --- |
| Original SE-05 source packages | done | v1.1, unchanged except the bounded reconnect correction above. |
| Real-session reconnect repair | done | Four tests first failed; corrected source passed unit and actual browser regressions. |
| Real corrected localhost runtime | done | Clean build 833f9560, real Auth0 renewal in another tab, explicit retry returned live 2/2/one module in 294 ms observed elapsed. |
| Combined SE-03/04/05 owner gate | partial | Actual Codex construction/revision/ACK/security/lifecycle evidence; Claude bootstrap remains blocked. |
| Publication | partial until receipt | Repair and summaries target existing Draft #24; final ref/check state is recorded separately in the publication receipt. |

## Verification actually run

- Svelte check: **0 errors, 0 warnings**.
- Editor/MCP unit corpus: **155 PASS, 0 FAIL**, 526 assertions, 21 files.
- Generated validator check: PASS, unchanged schema SHA `3ca89523ff3239e1cb52e716ca3aebc8a30a9bbddbb512d4c3111188b57a66a5`.
- Production BFF → synthetic TLS Builder → actual worker/viewport: **8 PASS**, including renewed session and expired-login retention. These remain synthetic identity fixtures, separate from the real Auth0 session.
- Production localhost build: PASS. Existing bundling warnings remain; no threshold, hash pin, fixture, compiler or actor semantics changed.
- One initial CSP subprocess hit its existing 5-second unit timeout. Unchanged focused and full reruns passed under the same timeout; retained as a failed attempt, not a changed limit.
- Real clients: Codex built/revised one module, server/UI ACK reached 2, final validation valid/compiled with 30 faces/60 triangles. Actual pairing/pause/revoke, two-tab roles, dirty Cancel and logout retention observed. Full matrix and historical failures: [local acceptance summary v1.1](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-SE030405-LOCAL-ACCEPTANCE-001_v1.1.md).

No Builder source change, producer package/install, merge, intentional deployment or release. Existing Builder #94 remains at `eb28489ab8504e96eb1dde36f6bb1dce2d83eca4`. Preserve unrelated untracked `tooling/testing/results/`.

## Remaining failure and handoff

Claude's actual OAuth succeeds, but its ungranted MCP bootstrap reports needs-auth and hides the pairing body. Current `EdgeGuard` deliberately returns 403 before MCP dispatch and existing tests freeze that boundary. Changing pre-grant discovery requires REVIEW/PLAN; do not weaken access checks or approve a code obtained from server internals. Native inbox completion remains read because the successful revision omitted request association. Initial real upstream 502 was not reproduced; root cause remains open.

Manual owner **Kais**, after compatibility repair: pair both real clients through the ordinary code-comparison flow; verify actual request association/ACK, physical offline/online recovery and native unload cancellation. Expected: no unauthorized writes or duplicate geometry, previous frame retained on failure. Existing real PASS rows need not be rerun unless their runtime changes. Save/reopen SE-07, restore SE-08 and final SE-11 remain separate.

Current phase: **local real acceptance / Review**. Next visible deliverable: both real clients revise the same local draft with matching accepted/rendered state and a complete receipt. Experimental remains locked. Publication does not close this manual/live gate.
