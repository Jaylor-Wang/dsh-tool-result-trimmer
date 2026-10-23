# dsh-tool-result-trimmer

[![npm version](https://img.shields.io/npm/v/dsh-tool-result-trimmer?color=blue)](https://www.npmjs.com/package/dsh-tool-result-trimmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-result-trimmer.svg)](https://github.com/Jaylor-Wang/dsh-tool-result-trimmer/releases)
[![DeepSeek Harness 兼容性](https://img.shields.io/badge/DSH-compatible-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

**`dsh-tool-result-trimmer`** 是专为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis 打造的轻量级、零运行时依赖的**即时工具输出修剪插件**。它直接挂载在工具执行流水线上，在超大输出（如编译报错海量输出、冗长测试日志、长命令滚屏）进入会话历史与 LLM 上下文之前实现即时裁剪，从源头杜绝上下文污染。

---

## 为什么需要 `dsh-tool-result-trimmer`？

传统上下文优化（如压缩阶段的修剪插件）属于**事后被动补救**：巨量输出已先完整写入 Session 日志和内存，等到上下文接近上限时才通过复杂的事件重放做节点替换，容易造成界面卡顿、日志膨胀与压缩抖动。

`dsh-tool-result-trimmer` 采用**“治未病”的主动流水线截断**：

1. **时机提前（Eager Trim · 零日志死重）**：
   直接挂载于 DSH 官方 `tools/post-execute` 瀑布流流水线。超长结果在进入持久化日志、提交给模型上下文之前就已经被裁剪完毕。
2. **权重倒置（Tail-Heavy · 强化尾部）**：
   命令行与编译测试的最关键报错信息（断言失败、异常堆栈、Exit Code）永远在末尾。默认策略：**头部保留 1,500 字符**（查看命令启动入参与初始状态），**尾部保留 5,000 字符**（完整保留关键报错与原因）。
3. **命令感知语义压缩器（Semantic Reducers · 严格 Fail-Open）**：
   内置针对高频开发命令的智能提纯器。在进入截断前优先提纯信息，**遇错严格放行（Fail-Open）**：
   - **Git Reducer**：干净工作区一键收敛为单行，脏工作区自动剥离 `(use "git add...")` 样板提示，100% 完整保留修改文件列表；剥离 `git diff` 无效的 `index` 哈希行。
   - **Package Manager Reducer**：自动过滤 `npm`/`pnpm`/`yarn`/`pip` 进度条、peer deprecation 杂讯、funding 提示与升级提醒，完整保留安装包统计与漏洞审计。
   - **Test Reducer**：当且仅当测试全量通过时（`node --test`, `vitest`, `pytest`, `cargo test` 等），将数百行冗长打勾日志折叠为单行摘要；一旦有任何用例失败，**绝不压缩，完整保留所有报错堆栈与断言现场**。
4. **行吸附算法（Line-Aware Snapping · 绝不截断代码行）**：
   不按死板字符索引生硬切割，而是动态吸附到最近的换行符（`\n`）。保证头部在完整行末尾结束，尾部从新行行首开始，彻底杜绝半截单词、JSON/XML 语法破碎与 UTF-8 字符损坏。
5. **终端 ANSI 控制字符自动剥离（Clean Terminal Output）**：
   自动识别并清洗终端 ANSI 颜色转义码（`\x1b[31m` 等）、光标移动/清行控制序列（`\x1b[2K`、`\x1b[1G`）及窗口标题序列，杜绝无意义杂质字符浪费 Token，大幅提升模型对编译报错与日志信息的解析精度。
6. **零副作用安全保护**：
   - **文件读取保护**：默认自动跳过 `read` 与 `read_image` 工具，保证文件查看行号与内容绝对精准。
   - **多模态内容保护**：图片等非文本块原样透传，不影响任何多模态交互。
   - **紧急逃生机制（Bypass）**：支持命令内标记（`# no-trim`、`DSH_TRIM_BYPASS=1`）快速全量放行。

---

## 安装

### 通过 DSH 插件命令安装（推荐）

```bash
dsh plugin --profile web add dsh-tool-result-trimmer
```

### 通过 npm / pnpm 安装

```bash
npm install dsh-tool-result-trimmer
# 或
pnpm add dsh-tool-result-trimmer
```

---

## 配置使用

在你的 `cordis.patch.yml` 或自定义预设中添加：

```yaml
- name: dsh-tool-result-trimmer
  config:
    enabled: true
    stripAnsi: true           # 自动剥离终端 ANSI 颜色与光标控制序列（默认 true）
    thresholdChars: 10000     # 触发裁剪的安全阈值（低于此值 0 开销原样放行）
    headChars: 1500           # 头部保留字符预算（观察命令入参与初始状态）
    tailChars: 5000           # 尾部保留字符预算（完整保留报错堆栈与退出码）
    excludeTools:             # 排除的工具列表，不参与裁剪与清洗
      - read
      - read_image
    overrides:                # 针对特定工具的差异化预算或独立开关
      bash:
        thresholdChars: 15000
        headChars: 2000
        tailChars: 8000
      git:
        enabled: false        # 单独对此工具关闭裁剪
    semanticReducers:         # 命令感知语义压缩器控制
      enabled: true           # 是否启用语义压缩（默认 true）
      git: true               # Git 状态与差异提纯
      packageManager: true    # npm / pnpm / yarn / pip 冗余过滤
      test: true              # 测试全通折叠与严格 Fail-Open
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用该修剪插件。 |
| `stripAnsi` | `boolean` | `true` | 是否自动剥离终端 ANSI 颜色与光标控制字符（大幅节省 Token）。 |
| `thresholdChars` | `number` | `10000` | 全局安全触发阈值（字符数）。建议配置大于 `headChars + tailChars`（默认 6500）。输出小于等于该值或未超出保留预算总和时直接放行，零对象分配。 |
| `headChars` | `number` | `1500` | 全局头部保留字符预算（保留初始执行上下文）。 |
| `tailChars` | `number` | `5000` | 全局尾部保留字符预算（优先保留错误堆栈与退出状态）。 |
| `excludeTools` | `string[]` | `['read', 'read_image']` | 免于裁剪与清洗的工具列表。 |
| `overrides` | `Record<string, ToolOverride>` | `{}` | 分工具差异化配置字典。支持单独设置特定工具的 `thresholdChars`、`headChars`、`tailChars`、`stripAnsi`，或设置 `enabled: false` 彻底跳过该工具。 |
| `semanticReducers` | `object` | `{ enabled: true, ... }` | 命令感知语义压缩器配置。包含 `enabled`、`git`、`packageManager`、`test` 开关，可单独按需控制。 |

---

## 紧急逃生通道（Bypass 机制）

当大模型或用户在特定调试场景下需要**获取完整原始输出（完全不被裁剪和清洗）**时，支持以下几种逃生方式：

1. **命令前缀环境变量**（最适合 Bash 命令）：
   ```bash
   DSH_TRIM_BYPASS=1 npm test
   # 或
   DSH_NO_TRIM=1 cargo check
   ```
2. **命令内联注释指令**（自然且直观）：
   ```bash
   git diff # no-trim
   # 或
   node test.js // bypass-trim
   ```
3. **工具调用参数声明**：
   在工具参数对象中传入 `bypassTrim: true` 或 `noTrim: true`。
4. **全局进程环境变量**：
   设置环境变量 `DSH_TRIM_BYPASS=1`，全局放行所有工具输出。

---

## 模型视角呈现

当工具输出超出 `thresholdChars` 时，修剪器将优雅拼接首尾，并插入包含统计信息的清晰横幅：

```text
<完整的一行行头部启动日志>

[... tool output trimmed: omitted 45,210 characters (~1,280 lines) ...]

<从换行开始的完整错误堆栈与退出码>
```

---

## 开源协议

[MIT](LICENSE) © [Jaylor Wang](https://github.com/Jaylor-Wang)
