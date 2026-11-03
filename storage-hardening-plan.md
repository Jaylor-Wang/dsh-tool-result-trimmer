# Storage hardening plan

Scope: add fixed storage failure reasons and rate-limited diagnostics, publish fully initialized directory locks atomically, and provide an offline inspection/recovery command. Retain bounded synchronous local scans and existing quotas; expose backend selection, fallback reasons, and timings for deciding whether asynchronous storage is warranted.

Exit criteria: real child-process crashes before and after lock publication cannot leave a newly published empty lock; live/replaced locks and quotas remain protected. Offline recovery defaults to inspection, requires an explicit stopped-writers declaration and matching snapshot, and preserves logs/unrelated files. Metrics and diagnostic messages contain only fixed enums and counts/timings, with observer failures isolated from tool results.

Existing user changes: preserve 深度分析报告.md without editing it. Do not bump versions, commit, publish, change installed profiles, or start services.

## Steps

1. Use ast-grep outlines and call-site queries to inspect storage and observation contracts. Implement shared reason/timing state and per-plugin diagnostic rate limiting.
2. Extract directory lock coordination, atomically publish initialized candidates, and add bounded offline lock inspection/recovery with a packaged CLI.
3. Integrate metrics/configuration/types, document backend ratios and recovery prerequisites, and add targeted crash/concurrency/diagnostic/CLI coverage.
4. Run file diagnostics, related behavioral tests, the full suite and public declaration checks. Inspect the final diff and record results here.

## Verification

Completed all four steps.

- Full suite: 217 tests passed (201 existing plus 16 new), zero failures/skips, using the installed real optional host peers via NODE_PATH. The final full run also includes the existing benchmark.
- Public declarations: npm run typecheck passed against the installed real Cordis peer. File-level LSP diagnostics passed for all changed JavaScript. The declaration file's standalone language-server check cannot resolve the repository's absent optional Cordis dependency; the project typecheck supplies that actual dependency explicitly and passed.
- Real child-process tests cover exits before metadata, before publication, after publication and during reaping. Existing concurrent writers and capacity checks continue to pass. Offline tests cover invalid/live/unknown owners, changed fingerprints, inspection bounds, exact artifact selection, partial deletion failure, and CLI paths containing spaces.
- Metrics/diagnostic coverage includes fixed failure categories, monotonic rate limiting, disabled metrics, throwing/rejecting observers, inaccessible diagnostic configuration, local fallback reasons and session outcomes without duplicate writes.
- npm pack --dry-run confirms the CLI and both new runtime modules are included; no package was published and version bumped to 2.7.0.
- Task-scoped git diff --check passed. The pre-existing user-edited 深度分析报告.md produces whitespace findings in an unscoped check; it was preserved untouched.

Operational boundaries: local storage now requires hard-link support and otherwise reports lock-unsupported. Legacy/malformed locks and abandoned recovery claims require explicit offline inspection and repair; no age-based deletion was added. Metrics measure backend selection and elapsed attempt time, but no live profile installation or production traffic measurement was performed. Synchronous scan and deletion budgets remain unchanged.
