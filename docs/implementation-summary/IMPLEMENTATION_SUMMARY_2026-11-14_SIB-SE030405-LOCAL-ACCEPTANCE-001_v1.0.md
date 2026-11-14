# IMPLEMENTATION SUMMARY — SE-03/04/05 local acceptance preparation

ID **SIB-SE030405-LOCAL-ACCEPTANCE-001** · Version **1.0** · Date **2026-11-14 Asia/Jakarta** · Status **PARTIAL — both application runtimes ready locally; owner application login pending**.

New acceptance topic; no prior summary superseded. Governing source delivery: [SE-05 FULL summary v1.1](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-TWO-PHASE-SE05-001_v1.1.md), its [self-review v1.1](../implementation-review/IMPLEMENTATION_REVIEW_2026-11-14_SIB-TWO-PHASE-SE05-001_v1.1.md), active master SIB-TWO-PHASE-001 v1.5 and D16 E11. Implementer/operator: this Codex desktop session, without coding delegates; precise deployed model provenance unverified. No production source was changed by this acceptance preparation.

## Current owner direction

The owner explicitly corrected the staging scope on 14 November: **MCP and consumer Editor both run locally for now**. This supersedes the earlier D11 Vercel-Editor/Funnel arrangement for this session. Tailscale installation had been separately approved and completed by the owner before this correction; **no Funnel was opened**. Its status was read back as `{}`. No Vercel environment, alias, deployment or production branch was modified.

Auth0 remains the real managed identity service requested for acceptance. Claude Code and Codex retain their existing provider sign-ins. “Local” here describes application/model hosting, not an offline identity service or locally hosted language models. The original final remote/multi-machine Stable gate is deferred, not passed by loopback testing.

## Work packages and evidence

| Work package | Status | Actual result |
| --- | --- | --- |
| WP1 — local HTTPS/WSS runtime | done | Actual Builder service and adapter-node Editor, bound only to `127.0.0.1`. Verified HTTPS health and Editor HTTP 200 without disabling certificate checks. |
| WP2 — real managed identity setup | partial | Development tenant and three distinct app registrations created; local API, user-delegated grants and restricted tenant-claim Action configured. Owner application login is pending in the browser. |
| WP3 — real clients, pairing, scope, pause/revoke, isolation | not started | Provider CLI readiness verified; Sibambo OAuth and actual client MCP sessions still NOT_RUN. Codex test profile has exactly one enabled MCP server and disables shell/browser/apps/other MCP servers. Claude local registration and strict test config are prepared. |
| WP4 — agent room + revision + visible render/ACK | not started | No model inference, project construction or geometry mutation has been performed in this real session. |
| WP5 — two tabs, reconnect, logout, unsaved warning | not started | No live owner draft exists yet. Prior synthetic CI is separate evidence. |
| WP6 — receipts and real connection timing | partial | Local preflight receipt exists. Initial verified service HTTPS health request took 2476.76 ms; this is a health request, not OAuth, agent connection, render latency or a cloud cold-start measurement. |

## Runtime identities and configuration

- Editor source `112932513d48ac4102769ab108684b91b695a44f`, existing [Draft PR #24](https://github.com/KaisAbiyyi/sibambo-editor/pull/24). Production adapter-node rebuild with `SE05_DRAFT_WS_ORIGIN=wss://localhost:8765` passed. The browser footer reports `Build 11293251 · clean`.
- Builder source `eb28489ab8504e96eb1dde36f6bb1dce2d83eca4`, existing [Draft PR #94](https://github.com/KaisAbiyyi/sibambo-bomc-builder/pull/94). Uses the actual `service.app.create_app`, Auth0 JWKS verifier and strict draft channel; no mock issuer or fixture tokens.
- Editor `https://localhost:5175`; service `https://localhost:8765`; MCP resource `https://localhost:8765/mcp`; project endpoint `https://localhost:8765/mcp?project=se030405-local`; draft origin `wss://localhost:8765`. Listener PIDs when recorded: Editor `27992`, Builder `42904`. Controlled terminal sessions: Editor `27156`, Builder `45906`.
- Service Host allowlist is exactly `localhost:8765,127.0.0.1:8765`; Origin allowlist exactly `https://localhost:5175`. Both listeners were verified on `127.0.0.1`, not LAN addresses.
- Auth0 issuer `https://dev-fmtv4fa0q3mpsjql.us.auth0.com/`; dashboard label **DEVELOPMENT**. Discovery verified issuer/JWKS, S256 support and issuer-bound authorization responses. S256 support alone is not proof that all other PKCE methods are rejected.
- Owner client `BFtUlCldaVZustv9DZXdovlWQhHJ1hEp`; Claude Code native client `DxwRHVUCka1rrTs8NZn3D9IulLMbJJRb`; Codex native client `sHhm2meJv0dnjoYB1dMdtK2tAvl8dP3z`. Owner callback/logout/web origin were changed from the earlier preview to exact localhost URLs. Claude callback is `http://localhost:53531/callback`; Codex callback is `http://127.0.0.1:53532/callback`.
- Auth0 API `6af7e3c16c2d9fa8f6e15e9e`, identifier `https://localhost:8765/mcp`, RS256/Auth0 JWT profile. Maximum/implicit token lifetime 3600 seconds; skip-consent and offline access disabled; user-delegated access is per-app; client-credentials access is denied to all apps. Three task app grants were created. Auth0 automatically created an unused Test Application `VkPKFj4fCvFahutIFapoTTmAjU6pu5w8`; it was not used or given a task grant.
- Auth0 Action `2104a2f8-44dd-4f27-961b-f8ccf10d04bc`, **Sibambo SE030405 Local Tenant**, Node 22. UI readback showed **Action is up to date**, then the Post Login flow showed **All changes are live** after binding. It adds `https://localhost:8765/claims/tenant=se030405-local` only for the exact local API and the three listed clients. It does not mint access tokens or log events. Source is preserved in the acceptance output directory. Resource Parameter Compatibility and Include Issuer switches were already enabled; DCR/CIMD registration remained disabled.
- CLI readiness: Claude Code 2.1.322, existing first-party Pro login; Codex 0.164.0, existing ChatGPT login. These facts do not prove successful Sibambo OAuth/tool use. Codex config overrides are per-invocation; global config was not rewritten. Claude's task registration uses the isolated D: acceptance workspace.

## Local TLS and secret handling

The owner approved a temporary localhost test certificate. Only that certificate was added to `CurrentUser/Root`; thumbprint **83AE01F4F4A31617AA76E6DB7B82CED3A4E8ECCD**, SHA-256 **c820de5a08db9cb7b6b6fd303fe539fceaff0d6b3fa54b6eaf673138c1499156**, expiry **2026-11-16 11:26:31 WIB**. It is a server certificate, not a CA, with localhost/loopback SANs. Its key and the BFF environment are in separate D: folders with inheritance removed and access restricted to the current user and SYSTEM. Secret values were transferred directly to the private runtime file without printing them or changing tracked `.env` files.

The in-app browser initially rejected the local certificate. The agent did not bypass the warning; the owner handled it and reported that the Editor was visible. Browser observation then confirmed the actual Editor and clean build footer. A subsequent click on **Masuk dengan OIDC** reached the real Auth0 login for **Sibambo Editor SE030405 Acceptance**. This application login is separate from the already completed administrator-dashboard login and is still awaiting the owner's completion.

All generated scripts, private configuration, keys, build logs, installer/logs and receipts are under D:. No bearer, OAuth code, WebSocket ticket, unsaved model payload or owner request text belongs in the public receipt. Raw client tool output must be filtered in memory before saving any later acceptance metadata. Real client runs must use Codex `--ephemeral` and Claude `--no-session-persistence` with the restricted MCP profiles.

## Checks and limits

- Local production rebuild PASS; Node launcher syntax PASS.
- Actual service HTTPS `/healthz` returned `{ok:true}`. Editor `/` returned 200 and BFF session reported configured. CSP `connect-src` contains only self and exact `wss://localhost:8765`.
- Unauthenticated real MCP POST returned 401 with protected-resource metadata. Metadata identifies `https://localhost:8765/mcp` and the actual Auth0 issuer. This proves fail-closed discovery, not authenticated tools.
- Codex profile validation PASS: only `sibambo_local_acceptance` enabled. Initial profile attempts were rejected before any model run because a plugin override lacked a transport and then because an unrelated server remained enabled; both were corrected without altering global user configuration.
- A background-process launch was blocked by command policy. The local service was instead launched in a controlled foreground terminal session. It was verified by its loopback listener and HTTPS response.
- No new source/unit/browser suite was run or claimed necessary for configuration-only changes. Existing source qualification remains in SE-05 summary v1.1. No source merge, producer/E4 build, installation or certification was performed.

Evidence: [first local preflight receipt](../../outputs/2026-11-14-se030405-real-acceptance/receipt-01-local-preflight.json). Supporting screenshots and Action source are beside it. Private material remains under `scratch/se030405-real-20261114/private/` and `local-tls/`; do not publish those folders.

## Next owner steps and cleanup

1. **Owner Kais:** complete application login/consent in the existing Editor tab. Expected: return to `https://localhost:5175` with the owner connection controls. If its short login flow expired, start a fresh login from the local Editor; never paste codes/passwords into chat.
2. **Operator with Kais:** open synthetic project `se030405-local`, connect the viewer, complete each native client's OAuth, compare signed client/code and explicitly grant read/write. Verify read-only, pause/revoke and other-project denial before construction.
3. **Real client + owner:** build and revise one synthetic room, explicitly frame it, observe accepted/rendered revisions and ACK. Then perform two-tab, reconnect, unsaved-warning and logout checks. Save/reopen and restore are still SE-07/08.
4. **Operator:** preserve metadata-only PASS/FAIL/NOT_RUN and actual local connection timings. Local tests cannot pass the deferred public/multi-machine gate.
5. **Operator after the acceptance session ends:** stop only the two task-owned sessions, remove only the listed temporary certificate from `CurrentUser/Root`, remove the task-owned private BFF environment and obsolete key, and remove the task-specific Claude registration. Retain public receipts. Do not reset/uninstall Tailscale or alter unrelated user configuration.

Parent objective remains Stable agent construction → live owner view → explicit Save → original Editor reopen. Current phase is **local real-account acceptance preparation**, with SE-05 source already delivered and live gates still Review. The next user-visible deliverable is one real-agent room and revision visible in the local Editor with matching render ACK and a truthful receipt. SE-06 onward and Experimental are not started by this preparation.
