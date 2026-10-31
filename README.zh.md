# dsh-tool-result-trimmer

[![npm version](https://img.shields.io/npm/v/dsh-tool-result-trimmer?color=blue)](https://www.npmjs.com/package/dsh-tool-result-trimmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-result-trimmer.svg)](https://github.com/Jaylor-Wang/dsh-tool-result-trimmer/releases)
[![DeepSeek Harness 兼容性](https://img.shields.io/badge/DSH-compatible-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

**`dsh-tool-result-trimmer`** 是专为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis 打造的轻量级、零运行时依赖的**即时工具输出修剪插件**。它直接挂载在工具执行流水线上，在超大输出进入会话历史与 LLM 上下文之前实现即时裁剪、命令感知语义提纯、结构化 JSON 保护与可追溯磁盘恢复，从源头杜绝上下文污染。

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
   - **Build 与 Lint Reducer**：仅在明确成功时保守压缩可识别的不含路径的 Vite/Cargo/webpack 进度或重复 Prettier 检查提示，保留 warning、error、路径及未知输出。
4. **结构化 JSON 保护（Structured Output Protection）**：
   默认完整保留合法 JSON（`mode: preserve`），即便超出字符阈值也绝不暴力破坏语法结构；可选 `mode: summary` 安全采样超大顶层数组并生成合法的带标记 JSON 摘要；亦支持 `mode: off` 恢复旧版普通截断。
5. **受控可追溯持久化（Controlled Spillover）**：
   默认在裁剪发生时将完整原文原子写入本地磁盘（`spillover.enabled: true`），并在截断提示中回显恢复路径，方便 Agent 或开发者直接查看原文而无需重跑耗时任务；具备容量上限、文件数预算、TTL 过期清理及跨进程目录锁保护。
6. **行吸附算法（Line-Aware Snapping · 绝不截断代码行）**：
   优先吸附附近的换行符（`\n`），必要时回退到字符边界，并严格避免拆开 UTF-16 代理对。
7. **终端 ANSI 控制字符自动剥离（Clean Terminal Output）**：
   自动识别并清洗终端 ANSI 颜色转义码（`\x1b[31m` 等）、光标移动/清行控制序列（`\x1b[2K`、`\x1b[1G`）及窗口标题序列，杜绝无意义杂质字符浪费 Token，大幅提升模型对编译报错与日志信息的解析精度。
8. **零副作用安全保护**：
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

### 1. 开箱即用（推荐，零配置）

所有核心功能（即时首尾裁剪、ANSI 清理、命令语义压缩、结构化 JSON 保护以及本地 Spillover 落盘恢复）**默认全部启用，开箱即用无需任何额外配置**。

在你的 `cordis.patch.yml` 或自定义预设中仅需声明插件名称即可：

```yaml
- name: dsh-tool-result-trimmer
```

### 2. 高级自定义配置（可选）

如需定制字符预算、切换特定压缩器、修改落盘目录或指定单工具预算，仅需声明需要定制的字段即可（所有字段均为可选）：

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
      build: true             # 已识别的成功构建进度
      lint: true              # 已识别的成功格式检查进度
    structuredOutput:
      mode: preserve          # preserve（默认）、summary 或 off
    metrics:
      enabled: false          # 显式启用计数，通过 Cordis logger 输出
    spillover:                # 受控的截断内容本地落盘（Spillover）备份
      enabled: true           # 是否在发生机械裁剪时将完整原文落盘（默认 true）
      directory: null         # 存储目录（null 默认使用系统临时目录下的 dsh-trimmed）
      maxFileBytes: 20000000  # 单个备份文件最大字节数（约 20MB）
      maxTotalBytes: 200000000 # 备份目录总容量预算（约 200MB）
      maxFiles: 1000          # 备份文件最大数量上限（1000 个）
      ttlMs: 604800000        # 日志过期清理时间（7 天）
      onSemanticReduction: false # 仅语义压缩时也保存原文并提供恢复路径
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
| `semanticReducers` | `object` | `{ enabled: true, ... }` | 命令感知语义压缩器配置。包含 `enabled`、`git`、`packageManager`、`test`、`build`、`lint` 开关，可单独按需控制。 |
| `spillover` | `object` | `{ enabled: true, ... }` | 受控的截断日志本地落盘设置（`enabled`、`directory`、`maxFileBytes`、`maxTotalBytes`、`maxFiles`、`ttlMs`、`onSemanticReduction`）。 |
| `structuredOutput.mode` | `preserve \| summary \| off` | `preserve` | 保护完整 JSON、显式启用数组摘要，或使用旧版文本裁剪。 |
| `metrics.enabled` | `boolean` | `false` | 输出不含原文的逐结果统计；默认关闭。 |

---

## 统计

显式启用后，每个已接受且未排除的文本结果向 Cordis logger 输出一条事件。程序调用者也可提供 `metrics.onEvent` 回调替代日志；回调抛错或异步拒绝不会影响工具结果。拦截、排除和旁路的结果不产生事件；没有 logger 和回调时不会输出。

事件仅包含白名单内的内置 reducer 名称（未知名称记为 null）、输入/输出文本的 UTF-16 长度、语义/结构化/机械处理标记、机械省略字符数与换行数，以及落盘/清理状态和删除数量。输出长度包含已经返回给调用者的提示及路径长度，但统计不包含其文本。清理状态 `complete` 表示有界扫描与准入完成且没有删除失败，并不保证所有过期文件均已删除。长度与数量仍可能泄露输出规模，请仅在接受此类元数据的环境中启用。不进行 token 估算。

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

普通文本超出 `thresholdChars` 后可能被首尾拼接，并插入统计横幅：

```text
<完整的一行行头部启动日志>

[... tool output trimmed: omitted 45,210 characters (~1,280 lines) ...]

<从换行开始的完整错误堆栈与退出码>
```

在落盘启用（默认启用）且保存成功时，横幅中会提供完整原始文本的本地路径。模型或开发者无需重新运行长耗时命令，即可使用 `read` 或 `grep` 检索日志：

```text
[... tool output trimmed: omitted 45,210 characters (~1,280 lines); full output saved to /tmp/dsh-trimmed/trimmed-bash-a8f2c9.log ...]
```

语义压缩只识别简单的直接命令及已知的 `npx`、`npm exec`、`pnpm exec`、`yarn exec` 包装，包括 `.cmd` 和 `.exe`；明确消费 `--filter`、`--prefix`、`--package` 等已知选项值，未知包装选项和 shell-call 模式原样放行。包管理器过滤仅应用于明确的包操作，子工具和脚本别名不能绕过自身 reducer 开关。Git 干净状态摘要保留退出标记，遇未知输出保留原文；测试摘要要求通过数一致，且无取消或失败证据；进度过滤保留诊断、未知 spinner 输出及 POSIX/Windows 路径。不推断 shell 命令链、带引号命令或包脚本别名。webpack 仅在 `--progress`、明确编译成功且出现严格匹配的无路径进度行时压缩；已通过 Webpack 5.112.2 真实输出样例验证。TypeScript、ESLint、Ruff 和 Biome 经实测成功时输出极小或为空，无需成功态压缩；其任何诊断、错误及非零退出状态均逐字节完整保留。语义 Fail-Open 不会关闭普通机械裁剪；需要完整输出时使用旁路标记。

结构化保护在 ANSI 清理和语义压缩之前识别原始文本投影中的完整 JSON。默认 `preserve` 原样保留，即使超出阈值也可能占用较大上下文。`summary` 仅将超阈值、单文本 block 的顶层数组替换为带标记的 JSON 对象，包含 `totalItems`、受预算限制的 `head` 和 `tail` 样本，以及 `spilloverPath`（不可用时为 null）。在执行失败或状态不确定时严格原样保留完整 JSON；当样本无法放入预算、摘要不能节省空间或数值重序列化可能丢失精度（包括小数和指数形式）时同样保留原文。对象、标量及多文本 block JSON 均保留原文。摘要样本可能包含敏感数据；启用落盘时会保存完整原始文本。`off` 恢复旧版处理。非法 JSON、带额外日志或 ANSI 包装的 JSON 按普通文本处理。

多个文本 block 按原顺序直接拼接，不额外插入分隔符。字符预算按 UTF-16 代码单元计算，保留 CRLF。语义压缩仅处理恰好包含一个文本 block 的结果。落盘保存 ANSI 清理和语义压缩之前的上述文本投影；图片等非文本 block 保留在返回结果中。

落盘功能默认开启（可配置 `spillover.enabled: false` 关闭），文件可能包含敏感输出。POSIX 文件权限为 `0600`，新建目录为 `0700`；Windows 权限遵循父目录 ACL，请选择私有目录。每次写入前在跨进程共享的目录锁内检查容量，锁被占用时立即降级。清理只处理完整匹配插件文件名的文件，每次最多扫描 4096 个条目并额外检查一次是否溢出，最多删除 128 个文件。目录过大、容量不足、锁被占用或磁盘错误时跳过落盘，仍返回普通截断横幅。清理由后续写入或显式调用触发，TTL 不会在空闲时定时删除文件。进程异常退出可能留下 `.dsh-trimmer.lock`，确认没有写入进程后再移除。

显式设置 `onSemanticReduction: true` 后，仅语义压缩也会保存原文，并追加独立的恢复提示；默认值为 `false`。短输出和仅 ANSI 清理不执行磁盘 I/O。

---

## 验证

使用 `npm test` 和 `npm run benchmark` 验证行为与性能。`npm run typecheck` 使用已有 TypeScript 编译器和真实的可选 Cordis peer 检查公开声明；宿主提供的两者可通过 `NODE_PATH` 解析。缺失依赖会明确失败，不安装依赖、不伪造声明。项目配置不含本机绝对路径，仅检查公开声明；JavaScript 另行通过文件级诊断与行为测试验证。

## 开源协议

[MIT](LICENSE) © [Jaylor Wang](https://github.com/Jaylor-Wang)
