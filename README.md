# dsh-tool-result-trimmer

[![npm version](https://img.shields.io/npm/v/dsh-tool-result-trimmer?color=blue)](https://www.npmjs.com/package/dsh-tool-result-trimmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-result-trimmer.svg)](https://github.com/Jaylor-Wang/dsh-tool-result-trimmer/releases)
[![DeepSeek Harness Compatibility](https://img.shields.io/badge/DSH-compatible-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | [中文](README.zh.md)

**`dsh-tool-result-trimmer`** is a lightweight, zero-dependency Cordis plugin designed for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It hooks into the tool execution pipeline to eagerly trim oversized tool outputs, intelligently refine frequent command logs, protect structured JSON, and optionally persist recoverable raw text before polluting conversation session logs and LLM context.

---

## Why `dsh-tool-result-trimmer`?

Traditional context optimization tools (like compaction pruners) act **passively**: they let massive tool outputs enter the session log and LLM memory first, and only attempt to prune or replace nodes when context compaction is triggered. This causes UI freezing, session log bloat, and compaction thrashing.

`dsh-tool-result-trimmer` solves this with an **eager pipeline approach**:

1. **Eager Trimming (Zero Log Bloat)**:
   Hooks directly into DSH's official `tools/post-execute` waterfall pipeline. Oversized results are trimmed *before* they are committed to session storage or context windows.
2. **Tail-Heavy Budgeting**:
   Most command failures, build errors, and test assertions display critical failure information and exit codes at the **tail** of the output. By default, `dsh-tool-result-trimmer` preserves **1,500 characters at the head** (arguments, initial states) and **5,000 characters at the tail** (stack traces, exit codes).
3. **Command-Aware Semantic Reducers (Strict Fail-Open)**:
   Pre-processes verbose command outputs before mechanical trimming without risking data loss:
   - **Git Reducer**: Collapses clean `git status` to a single line; strips repetitive `(use "git add...")` guidance on dirty worktrees while preserving 100% of modified file lists; strips noisy `index` hash lines in `git diff`.
   - **Package Manager Reducer**: Scrubs progress spinners, peer deprecation notices, update announcements, and funding prompts in `npm`, `pnpm`, `yarn`, and `pip`, cleanly preserving package audits and vulnerability diagnostics.
   - **Test Reducer**: When all test suites pass cleanly (`node --test`, `vitest`, `pytest`, `cargo test`), collapses pages of individual passed ticks into a clean 1-line summary. **Strictly fails open on any test failure or non-zero exit code**, preserving every stack trace and assertion error.
   - **Build and Lint Reducers**: Conservatively remove recognized path-free Vite/Cargo/webpack progress or duplicate Prettier check progress after explicit success; warnings, errors, paths, and unrecognized output are retained.
4. **Structured JSON Protection**:
   Complete JSON outputs are preserved verbatim by default (`mode: preserve`) even above thresholds, avoiding broken syntax. Opt-in array summarization (`mode: summary`) safely samples large top-level arrays into valid, explicitly marked JSON summaries, or reverts to legacy trimming (`mode: off`).
5. **Controlled Recoverable Spillover**:
   Offloads truncated raw outputs to local disk by default (`spillover.enabled: true`) and annotates the banner with the absolute file path, enabling agents or developers to inspect full raw details on demand without re-running long operations. Includes atomic writes, bounded capacity limits, TTL expiration, and cross-process directory locking.
6. **Line-Aware Snapping**:
   Prefers nearby newlines (`\n`) and falls back to character boundaries when necessary, without splitting surrogate pairs.
7. **ANSI Escape Sequence Stripping**:
   Automatically identifies and scrubs terminal ANSI color codes (`\x1b[31m`), cursor controls, and line clearing sequences (`\x1b[2K`, `\x1b[1G`), eliminating token waste and noisy artifacts to keep terminal output crystal clear for LLMs.
8. **Zero-Side-Effect Safeguards**:
   - **File Read Protection**: Automatically bypasses `read` and `read_image` tools to avoid disrupting file inspection with line-number references.
   - **Rich Block Preservation**: Non-text blocks (e.g., images) are preserved completely untouched.
   - **Escape Hatch (Bypass)**: Immediate pass-through via inline directives (`# no-trim`) or environment flags (`DSH_TRIM_BYPASS=1`).

---

## Installation

### Via DSH Plugin CLI (Recommended)

```bash
dsh plugin --profile web add dsh-tool-result-trimmer
```

### Via npm / pnpm

```bash
npm install dsh-tool-result-trimmer
# or
pnpm add dsh-tool-result-trimmer
```

---

## Configuration

Add the plugin to your `cordis.patch.yml` or agent preset:

```yaml
- name: dsh-tool-result-trimmer
  config:
    enabled: true
    stripAnsi: true           # Strip terminal ANSI escape codes (default: true)
    thresholdChars: 10000     # Trigger trimming when output exceeds 10,000 chars
    headChars: 1500           # Characters retained at the head
    tailChars: 5000           # Characters retained at the tail
    excludeTools:             # Tools excluded from trimming
      - read
      - read_image
    overrides:                # Per-tool custom budgets and flags
      bash:
        thresholdChars: 15000
        headChars: 2000
        tailChars: 8000
      git:
        enabled: false        # Completely disable trimming for git
    semanticReducers:         # Command-aware semantic reducers control
      enabled: true           # Enable semantic reduction (default: true)
      git: true               # Git status & diff refinement
      packageManager: true    # npm / pnpm / yarn / pip noise filtering
      test: true              # Clean test suite folding with strict Fail-Open
      build: true             # Recognized successful build progress
      lint: true              # Recognized successful formatter progress
    structuredOutput:
      mode: preserve          # preserve (default), summary, or off
    metrics:
      enabled: false          # Opt-in counts only; logs through the Cordis logger
    spillover:                # Controlled disk spillover for full output recovery
      enabled: true           # Offload raw outputs to disk on truncation (default: true)
      directory: null         # Storage dir (null defaults to os.tmpdir()/dsh-trimmed)
      maxFileBytes: 20000000  # Max single file size (~20MB)
      maxTotalBytes: 200000000 # Max total disk budget (~200MB)
      maxFiles: 1000          # Max files to retain
      ttlMs: 604800000        # Retention TTL (7 days)
      onSemanticReduction: false # Also save semantic-only reductions and show a recovery path
```

### Options

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Whether the trimmer is enabled. |
| `stripAnsi` | `boolean` | `true` | Whether to strip terminal ANSI escape codes and styling (saves tokens). |
| `thresholdChars` | `number` | `10000` | Global safety threshold (in characters). Recommended to exceed `headChars + tailChars` (default 6500). Outputs below threshold or within budget sum pass through with zero object allocations. |
| `headChars` | `number` | `1500` | Global character budget for output head (keeps command invocation & starting context). |
| `tailChars` | `number` | `5000` | Global character budget for output tail (keeps errors, stack traces, exit codes). |
| `excludeTools` | `string[]` | `['read', 'read_image']` | Tool names excluded from trimming. |
| `overrides` | `Record<string, ToolOverride>` | `{}` | Per-tool budget overrides and toggles. Supports custom `thresholdChars`, `headChars`, `tailChars`, `stripAnsi`, or `enabled: false`. |
| `semanticReducers` | `object` | `{ enabled: true, ... }` | Command-aware semantic reducers settings (`enabled`, `git`, `packageManager`, `test`, `build`, `lint`). |
| `spillover` | `object` | `{ enabled: true, ... }` | Controlled disk spillover settings (`enabled`, `directory`, `maxFileBytes`, `maxTotalBytes`, `maxFiles`, `ttlMs`, `onSemanticReduction`). |
| `structuredOutput.mode` | `preserve \| summary \| off` | `preserve` | Protect complete JSON, opt into array summaries, or use legacy text trimming. |
| `metrics.enabled` | `boolean` | `false` | Emit privacy-preserving per-result metrics; disabled by default. |

---

## Metrics

When explicitly enabled, each accepted, non-excluded text result emits one event to the Cordis logger. Programmatic callers may instead pass `metrics.onEvent`; callback exceptions and rejected promises are ignored. Blocked, excluded and bypassed results do not emit events. With no logger or callback, no event is emitted.

Events contain only an allowlisted built-in reducer name (unknown names are reported as null), UTF-16 input/output text lengths, semantic/structured/mechanical flags, mechanical omitted characters and newline counts, and spillover/cleanup statuses and deletion count. Output length includes notices and paths already returned to the caller, but their text is never included in metrics. Cleanup `complete` means the bounded scan and admission completed without a failed deletion, not that all expired files have been removed. Lengths and counts can still reveal output size; enable logging only where that metadata is acceptable. No token estimation is performed.

---

## Escape Hatch (Bypass Mechanism)

When the model or user explicitly requires **100% untouched raw tool output** for deep debugging, several escape hatches are supported:

1. **Command environment prefix** (ideal for Bash commands):
   ```bash
   DSH_TRIM_BYPASS=1 npm test
   # or
   DSH_NO_TRIM=1 cargo check
   ```
2. **Inline comment directives** (natural and clean):
   ```bash
   git diff # no-trim
   # or
   node test.js // bypass-trim
   ```
3. **Tool argument flag**:
   Pass `bypassTrim: true` or `noTrim: true` in the tool call arguments.
4. **Global environment variable**:
   Set `DSH_TRIM_BYPASS=1` on the process to globally pass through all outputs untouched.

---

## What the Model Sees

Oversized ordinary text may be spliced at the head and tail with a statistical notice:

```text
<cleanly preserved head output ending at newline>

[... tool output trimmed: omitted 45,210 characters (~1,280 lines) ...]

<cleanly preserved tail output starting at newline>
```

When spillover is enabled (default) and storage succeeds, the banner provides the local path to the full raw text, allowing the agent or user to inspect details using `read` or `grep` without re-running long commands:

```text
[... tool output trimmed: omitted 45,210 characters (~1,280 lines); full output saved to /tmp/dsh-trimmed/trimmed-bash-a8f2c9.log ...]
```

Semantic reduction recognizes simple direct commands and known `npx` / `npm exec` / `pnpm exec` / `yarn exec` wrappers, including `.cmd` and `.exe`. Known option values such as `--filter`, `--prefix` and `--package` are consumed explicitly; unknown wrapper options and shell-call modes pass through. Package-manager filtering only applies to explicit package operations, so child tools and script aliases cannot bypass their own reducer switches. Git clean-status folding preserves exit markers and leaves unknown output intact. Test summaries require consistent pass totals and no cancellation or failure evidence. Progress filtering preserves diagnostics, unknown spinner output and POSIX/Windows paths. Shell chains, quoted commands and package script aliases are not inferred. Webpack support requires `--progress`, an explicit successful compilation line and narrowly recognized path-free progress lines; verified against real Webpack 5.112.2 output. TypeScript, ESLint, Ruff and Biome produce minimal or zero output on clean runs and require no success-path reduction; any diagnostic, error or non-zero exit state is preserved byte-for-byte. Semantic fail-open does not disable ordinary mechanical trimming; use a bypass directive when the full output is required.

Complete raw JSON is recognized before ANSI stripping and semantic reducers, using the separator-free text projection. The default `preserve` returns it unchanged, even above the threshold, so large results can still consume context. `summary` replaces only oversized, single-text-block top-level arrays with a marked JSON object containing `totalItems`, bounded `head` and `tail` samples, and `spilloverPath` (null when unavailable). It strictly protects failures and uncertain states by preserving the raw JSON verbatim, and also preserves the original when samples cannot fit, the summary does not save space, or numbers could lose precision during reserialization (including decimal/exponent forms). Objects, scalars and multi-text-block JSON remain unchanged. Summary samples can contain sensitive data; spillover saves the complete raw text when enabled. `off` restores legacy handling. Invalid JSON, extra logs, and ANSI-wrapped JSON are treated as ordinary text.

Text blocks are concatenated in order without inserting separators. Character budgets use UTF-16 code units; CRLF is preserved. Semantic reducers only process results containing exactly one text block. Spillover saves this projection before ANSI stripping or semantic reduction; images and other non-text blocks remain in the returned result.

Storage is enabled by default (can be disabled via `spillover.enabled: false`) and may contain sensitive output. Files use `0600` and newly created directories use `0700` on POSIX; Windows access follows the parent directory ACL, so choose a private directory. Each write checks capacity under a non-waiting directory lock shared by cooperating processes. Cleanup only touches exact plugin filenames, scans at most 4096 entries plus one overflow check, and deletes at most 128 files per call. A busy lock, incomplete scan, exhausted budget or disk error skips spillover and retains the usual omission banner. Cleanup runs on subsequent writes or explicit pruning; TTL is not a timer that deletes idle files. An abrupt process exit can leave `.dsh-trimmer.lock`; remove it only after verifying no writer is active.

`onSemanticReduction: true` also saves semantic-only reductions and appends a separate recovery notice. Its default is `false`; short outputs and ANSI-only changes perform no disk I/O.

---

## Validation

Run `npm test` and `npm run benchmark` for behavior and performance checks. `npm run typecheck` checks public declarations against the real optional Cordis peer using a locally available TypeScript compiler; both may be resolved through `NODE_PATH` when supplied by a host installation. Missing peers produce an explicit failure, and no dependencies are installed or declarations stubbed. The portable project configuration checks public declarations only; JavaScript files are validated separately through file diagnostics and behavioral tests.

## License

[MIT](LICENSE) © [Jaylor Wang](https://github.com/Jaylor-Wang)
