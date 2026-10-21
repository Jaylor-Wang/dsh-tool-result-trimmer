# dsh-tool-result-trimmer

[![npm version](https://img.shields.io/npm/v/dsh-tool-result-trimmer?color=blue)](https://www.npmjs.com/package/dsh-tool-result-trimmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-result-trimmer.svg)](https://github.com/Jaylor-Wang/dsh-tool-result-trimmer/releases)
[![DeepSeek Harness Compatibility](https://img.shields.io/badge/DSH-compatible-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | [中文](README.zh.md)

**`dsh-tool-result-trimmer`** is a lightweight, zero-dependency Cordis plugin designed for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It hooks into the tool execution pipeline to eagerly trim oversized tool outputs (such as massive compiler errors, verbose test outputs, or long command logs) before they pollute the conversation session log and LLM context.

---

## Why `dsh-tool-result-trimmer`?

Traditional context optimization tools (like compaction pruners) act **passively**: they let massive tool outputs enter the session log and LLM memory first, and only attempt to prune or replace nodes when context compaction is triggered. This causes UI freezing, session log bloat, and compaction thrashing.

`dsh-tool-result-trimmer` solves this with an **eager pipeline approach**:

1. **Eager Trimming (Zero Log Bloat)**:
   Hooks directly into DSH's official `tools/post-execute` waterfall pipeline. Oversized results are trimmed *before* they are committed to session storage or context windows.
2. **Tail-Heavy Budgeting**:
   Most command failures, build errors, and test assertions display critical failure information and exit codes at the **tail** of the output. By default, `dsh-tool-result-trimmer` preserves **1,500 characters at the head** (arguments, initial states) and **5,000 characters at the tail** (stack traces, exit codes).
3. **Line-Aware Snapping**:
   Never cuts arbitrarily at character offsets. Instead, it snaps boundaries to adjacent newlines (`\n`). Code lines, JSON structures, and error messages remain syntactically complete without broken words or surrogate corruption.
4. **ANSI Escape Sequence Stripping**:
   Automatically identifies and scrubs terminal ANSI color codes (`\x1b[31m`), cursor controls, and line clearing sequences (`\x1b[2K`, `\x1b[1G`), eliminating token waste and noisy artifacts to keep terminal output crystal clear for LLMs.
5. **Zero-Side-Effect Safeguards**:
   - **File Read Protection**: Automatically bypasses `read` and `read_image` tools to avoid disrupting file inspection with line-number references.
   - **Rich Block Preservation**: Non-text blocks (e.g., images) are preserved completely untouched.

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
```

### Options

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Whether the trimmer is enabled. |
| `stripAnsi` | `boolean` | `true` | Whether to strip terminal ANSI escape codes and styling (saves tokens). |
| `thresholdChars` | `number` | `10000` | Safety threshold (in characters). Outputs below this threshold pass untouched with 0 overhead. |
| `headChars` | `number` | `1500` | Character budget for output head (keeps command invocation & starting context). |
| `tailChars` | `number` | `5000` | Character budget for output tail (keeps errors, stack traces, exit codes). |
| `excludeTools` | `string[]` | `['read', 'read_image']` | Tool names excluded from trimming. |

---

## What the Model Sees

When a tool output exceeds `thresholdChars`, the trimmer cleanly splices the head and tail, inserting a clear statistical notice:

```text
<cleanly preserved head output ending at newline>

[... tool output trimmed: omitted 45,210 characters (~1,280 lines) ...]

<cleanly preserved tail output starting at newline>
```

---

## License

[MIT](LICENSE) © [Jaylor Wang](https://github.com/Jaylor-Wang)
