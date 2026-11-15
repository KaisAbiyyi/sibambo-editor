# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001: ArchModule validator ESM import fix (unblocks the authoring browser regression)

ID **SIB-MCP-MODELING-001** · Version **1.6** · Date **2026-11-15 17:10 Asia/Jakarta** · Status **fix done · authoring browser regression 20/21 PASS (1 missing local fixture) · WP3 unchanged · Draft/Review, no merge, no self-approval**.

- **Supersedes:** [v1.5](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.5.md) **only** for the status of the existing authoring browser regression and the "Next action" item 2. Every other v1.5 record (WP3 contents, T-RB map, interpretations, User Test Card) stays as written.
- **Governing plan:** [master v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md). `tooling/testing/generate-arch-validators.ts` and its generated validator are in the plan's MUST-change surface (WP1A step 3).
- **Authority:** owner instruction in this session ("Yes, fix it here"), answering the v1.5 proposal for a separate fix.
- **Implementer:** Claude Code desktop, Claude Opus 5.5 (`claude-opus-5-5`), owner's local Windows machine, no subagents.
- **Revision history:** v1.5 WP3 · **v1.6 validator import fix (this file)**.

## Defect and fix

The WP1A generator (`5ec4e47`) emitted extensionless deep imports in `apps/editor/src/lib/arch/arch-module-v2.validator.generated.js`:
`import … from "ajv/dist/runtime/ucs2length"` and `"ajv/dist/runtime/equal"`.
The validator is reached from `authoring/model.ts` → `arch/metadata.ts`. Node ESM therefore failed with `ERR_MODULE_NOT_FOUND` in two places:
- Playwright's spec loader, so `tests/bomc-authoring.spec.ts` loaded 0 tests;
- Vite dev-server SSR of `/`.

The production build was not affected.

**Fix (commit `5a2fbd8e7cd483098247de480e665af29cc8afd2`):**
- `tooling/testing/generate-arch-validators.ts` now emits `ajv/dist/runtime/ucs2length.js` and `ajv/dist/runtime/equal.js`, with a comment explaining why.
- The validator was regenerated with `--write`.

ajv 8.20.0 has no `exports` map, and both files exist, so the explicit paths resolve in Node, Bun and Vite. The generated diff is exactly those two import lines. The schema SHA-256 is unchanged (`7e6baffb551ef64fee7ed9446ba4e14dfa2de189180d44276c1f4283dd88da7c`), so validation logic is identical.

**Not changed:** `apps/editor/src/lib/mcp/module-ir-validator.generated.js` and its generator `tooling/testing/generate-draft-validator.ts` have the same import pattern, but:
- the file is loaded only inside the bundled draft worker, so nothing fails today;
- it belongs to SE-05 (`stable/editor-sync`, `lib/mcp/**` READ-ONLY in v2.3).

## Evidence (fix tree = commit `5a2fbd8`, Windows, `TEMP/TMP=D:\projects\sibambo\scratch\mcp-wp3`)

| Check | Result |
|---|---|
| `bun tooling/testing/generate-arch-validators.ts` (currency check, also run by the E-L2 test) | exit 0 |
| `node --input-type=module -e "import('./src/lib/arch/arch-module-v2.validator.generated.js')"` | before: `ERR_MODULE_NOT_FOUND`; after: OK (`validate` is a function) |
| Editor units `./unit/authoring ./unit/arch ./unit/mcp ./unit/editor ./unit/agent` | **333 pass / 0 fail** |
| `bun run check` | 0 errors / 0 warnings |
| `bun run build` | PASS |
| **Existing authoring browser regression** `bun run test:authoring:browser mcp-wp3-esmfix-20261115` (Vite dev server + Chromium, includes the WP3 page/panel wiring) | **20 passed / 1 failed** of 21 |

**The one failure (environment, not code):** test 21, `keeps unsupported S2-current … in read-only viewer mode` (spec line 1679), needs the pinned fixture directory `D:\projects\sibambo\skps\model-eval-exports`. `tooling/testing/bomc-profile-fixtures.ts:74` fails with `ENOENT … lstat` because that directory does not exist on this machine. The production-build `viewer-recovery` spec fails for the same reason (v1.5).

**Evidence location:** `sibambo-editor/tooling/testing/results/mcp-wp3-esmfix-20261115/` (pre-existing untracked folder, not committed). The runner also created `D:\projects\sibambo\docs\worklogs\EDITOR-ACCELERATED-001\authoring-mcp-wp3-esmfix-20261115\`. The earlier blocked run left an empty `authoring-mcp-wp3-cp3-20261115\` there.

## Identities

| Item | Value |
|---|---|
| Branch | `work/mcp-modeling-001/phase-1` |
| Previous head | `e6063c710c4871220d37933aff8f54cb56211490` (v1.5 publication) |
| Fix commit | **`5a2fbd8e7cd483098247de480e665af29cc8afd2`** |
| Publication | the docs-only commit that adds this file (see PR [#25](https://github.com/KaisAbiyyi/sibambo-editor/pull/25)) |

## Next action

1. Independent review of PR #25 is still requested (it now also covers `5a2fbd8`); no approval is claimed.
2. Optional, owner: restore `D:\projects\sibambo\skps\model-eval-exports` (pinned BOMC profile fixtures). Then authoring test 21 and `viewer-recovery` can run.
3. WP4 (NOT SAFE FOR LOWER-CAPABILITY DELEGATION) after a fresh claim.

Manual owner tests: unchanged from the v1.5 User Test Card (all PENDING). This fix needs no extra owner test; the developer server (`bun run dev`) should now open the Editor page again.
