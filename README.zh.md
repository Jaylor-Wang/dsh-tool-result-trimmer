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
   识别并复用 bash 或官方 spill-policy 已有的恢复提示；新增存储优先使用宿主按会话管理的 `ctx.spillStore`，保留定位符和读取指引。独立使用时回退到具备原子写入、容量上限、TTL 清理和跨进程锁的本地文件（`spillover.enabled: true` 默认启用）。
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

如果你是通过 DSH 插件市场（Web 界面）或 `dsh plugin add` 安装的，插件已作为 Bundle 自动装载并生效。**无需修改或添加任何 `cordis.patch.yml` 配置。**

### 2. 高级自定义配置（可选）

如需定制字符预算、切换特定压缩器、修改落盘目录或指定单工具预算，仅需在你的 profile `cordis.patch.yml` 中通过插件唯一 ID `tool-result-trimmer` 覆盖需要定制的字段（未声明字段自动沿用默认值）：

```yaml
- id: tool-result-trimmer
  config:
    thresholdChars: 15000     # 触发裁剪的安全阈值（默认 10000）
    headChars: 2000           # 头部保留字符预算（默认 1500）
    tailChars: 8000           # 尾部保留字符预算（默认 5000）
    overrides:                # 针对特定工具的差异化预算或独立开关
      bash:
        thresholdChars: 20000
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
    spillover:                # 受控的截断内容本地落盘备份
      enabled: true           # 是否在发生机械裁剪时将完整原文落盘（默认 true）
      directory: null         # 存储目录（null 默认使用系统临时目录下的 dsh-trimmed）
      maxFileBytes: 20000000  # 单个备份文件最大字节数（约 20MB）
      maxTotalBytes: 200000000 # 备份目录总容量预算（约 200MB）
      maxFiles: 1000          # 备份文件最大数量上限（1000 个）
      ttlMs: 604800000        # 日志过期清理时间（7 天）
      onSemanticReduction: false # 仅语义压缩时也保存原文并提供恢复路径
```

> **注意**：如果插件已通过 DSH 安装（已作为 bundle 装载），**请勿**在 `cordis.patch.yml` 中添加 `- name: dsh-tool-result-trimmer`，直接使用 `- id: tool-result-trimmer` 进行属性覆盖即可，避免重复注册实例化。

### 3. 自定义预设或纯 Cordis 环境（高级）

如果你正在自建独立的 Agent Preset，或在脱离 DSH profile bundle 体系的纯 Cordis 环境中使用，可通过包名显式声明引入：

```yaml
- name: dsh-tool-result-trimmer
  config:
    thresholdChars: 10000
    spillover:
      enabled: true
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
| `overrides` | `Record<string, ToolOverride>` | `{}` | 按工具完整名称匹配，优先于工具类别默认预算。支持 `thresholdChars`、`headChars`、`tailChars`、`stripAnsi`；`enabled: false` 跳过插件，交由宿主策略处理。 |
| `semanticReducers` | `object` | `{ enabled: true, ... }` | 命令感知语义压缩器配置。包含 `enabled`、`git`、`packageManager`、`test`、`build`、`lint` 开关，可单独按需控制。 |
| `spillover` | `object` | `{ enabled: true, ... }` | 受控的截断日志本地落盘设置（`enabled`、`directory`、`maxFileBytes`、`maxTotalBytes`、`maxFiles`、`ttlMs`、`onSemanticReduction`）。 |
| `structuredOutput.mode` | `preserve \| summary \| off` | `preserve` | 保护完整 JSON、显式启用数组摘要，或使用旧版文本裁剪。 |
| `metrics.enabled` | `boolean` | `false` | 输出不含原文的逐结果统计；默认关闭。 |
| `diagnostics.enabled` | `boolean` | `true` | 记录固定的存储失败/降级原因，独立于统计开关。 |
| `diagnostics.intervalMs` | `number` | `60000` | 每个插件实例中，同一原因的最小日志间隔；使用单调时钟。 |

---

默认工具预算：`bash` 和其他未分类工具沿用全局头部 1500 / 尾部 5000。通过 `bash` 执行的字面量 `mcporter call exa.web_search_exa` / `exa.web_fetch_exa`，以及目标主机为 `r.jina.ai` 的单 URL `curl` 命令，也采用头部优先预算；shell 命令链、变量展开、其他网址和其他 bash 命令仍使用 bash 默认预算。`web`、`web_`、`web-`、`web.` 开头的工具、`fetch` 及 `mcp__`、`mcp_`、`mcp-`、`mcp.` 开头的工具将两个全局预算中的较大值用于头部、较小值用于尾部（默认 5000 / 1500，总预算不变）。工具名按类别边界匹配，不把 `webhook` 等名称归入网页工具。显式 `overrides` 的每个字段优先，未覆盖字段使用对应类别默认值。如希望官方 spill-policy 独立处理某个网页/MCP 工具，请对其完整名称设置 `enabled: false`。

## 统计

显式启用后，每个已接受且未排除的文本结果向 Cordis logger 输出一条事件。程序调用者也可提供 `metrics.onEvent` 回调替代日志；回调抛错或异步拒绝不会影响工具结果。拦截、排除和旁路的结果不产生事件；没有 logger 和回调时不会输出。

事件仅包含白名单内的内置 reducer 名称（未知名称记为 null）、输入/输出文本的 UTF-16 长度、语义/结构化/机械处理标记、机械省略字符数与换行数，以及落盘/清理状态和删除数量。输出长度包含已经返回给调用者的提示及路径长度，但统计不包含其文本。清理状态 `complete` 表示有界扫描与准入完成且没有删除失败，并不保证所有过期文件均已删除。长度与数量仍可能泄露输出规模，请仅在接受此类元数据的环境中启用。不进行 token 估算。

---

存储观测新增 `spilloverBackend`（`none`、`session`、`local`）、`spilloverFallbackReason`（`missing-store`、`missing-source` 或 null）、`spilloverReason`（固定原因码或 null）和 `spilloverDurationMs`（单调时钟测得的整次存储尝试耗时）。未尝试存储时后端为 `none`、原因为 null、耗时为零。本地回退比例按 `local 次数 / (local 次数 + session 次数)` 计算；耗时分位数应按后端和成功/失败分别统计。测试不代表生产比例。本地扫描仍为有界同步操作；耗时包含能力查询、锁、清理与写盘，并非单独的扫描耗时。

原因码包括 `invalid-config`、`file-too-large`、`lock-busy`、`lock-invalid`、`lock-owner-unknown`、`lock-changed`、`lock-recovery-blocked`、`lock-unsupported`、`scan-limit`、`capacity`、`cleanup-limit`、`cleanup-io`、`storage-io`、`backend-error`、`backend-response`。写入成功但清理降级时也可携带原因码。诊断仅记录固定原因及后端，不含异常消息、路径、命令、原文或会话/调用 ID。同一原因默认每 60 秒至多记录一次；设置 `diagnostics.enabled: false` 可关闭诊断而保留统计。

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

在存储启用（默认启用）且保存成功时，横幅提供完整原文的定位符及后端读取指引。本地回退存储返回可供 `read` 或 `grep` 使用的路径：

```text
[... tool output trimmed: omitted 45,210 characters (~1,280 lines); full output saved to /tmp/dsh-trimmed/trimmed-bash-a8f2c9.log ...]
```

语义压缩只识别简单的直接命令及已知的 `npx`、`npm exec`、`pnpm exec`、`yarn exec` 包装，包括 `.cmd` 和 `.exe`；明确消费 `--filter`、`--prefix`、`--package` 等已知选项值，未知包装选项和 shell-call 模式原样放行。包管理器过滤仅应用于明确的包操作，子工具和脚本别名不能绕过自身 reducer 开关。Git 干净状态摘要保留退出标记，遇未知输出保留原文；测试摘要要求通过数一致，且无取消或失败证据；进度过滤保留诊断、未知 spinner 输出及 POSIX/Windows 路径。支持末尾独立的 `2>&1` 和一次前置 `cd X &&`（目录可使用字面量引号），两者可组合。相对目录结合调用参数 `workdir` 解析，不读取插件进程的当前目录；未提供 `workdir` 时保留相对目录。其他命令链、变量/命令替换、额外重定向、带引号的实际命令参数及包脚本别名仍不推断。webpack 仅在 `--progress`、明确编译成功且出现严格匹配的无路径进度行时压缩；已通过 Webpack 5.112.2 真实输出样例验证。TypeScript、ESLint、Ruff 和 Biome 经实测成功时输出极小或为空，无需成功态压缩；其任何诊断、错误及非零退出状态均逐字节完整保留。语义 Fail-Open 不会关闭普通机械裁剪；需要完整输出时使用旁路标记。

结构化保护在 ANSI 清理和语义压缩之前识别原始文本投影中的完整 JSON。默认 `preserve` 原样保留，即使超出阈值也可能占用较大上下文。`summary` 仅将超阈值、单文本 block 的顶层数组替换为带标记的 JSON 对象，包含 `totalItems`、受预算限制的 `head` 和 `tail` 样本，以及 `spilloverPath`（不可用时为 null）。在执行失败或状态不确定时严格原样保留完整 JSON；当样本无法放入预算、摘要不能节省空间或数值重序列化可能丢失精度（包括小数和指数形式）时同样保留原文。对象、标量及多文本 block JSON 均保留原文。摘要样本可能包含敏感数据；启用落盘时会保存完整原始文本。`off` 恢复旧版处理。非法 JSON、带额外日志或 ANSI 包装的 JSON 按普通文本处理。

多个文本 block 按原顺序直接拼接，不额外插入分隔符。字符预算按 UTF-16 代码单元计算，保留 CRLF。语义压缩仅处理恰好包含一个文本 block 的结果。落盘保存 ANSI 清理和语义压缩之前的上述文本投影；图片等非文本 block 保留在返回结果中。

完整的 `[output truncated; full output: …]` 提示行和结尾的官方 spill-policy 提示会保留，即使尾部预算不足也不会丢失。插件直接复用其中的恢复位置及读取指引，不再保存已经截断的预览；关闭新增落盘时也保留已有提示。这只是文本约定识别，不认证来源，也不检查定位符是否仍可访问。

新增存储优先调用 `ctx.spillStore.saveText`，传入产生结果的会话 ID、工具名和调用 ID；定位符按原样展示，并保留 `retrievalHint`。JSON 数组摘要将定位符放入 `spilloverPath`，后端提供读取指引时增加 `spilloverRetrievalHint`。`maxFileBytes` 对两种存储均生效；会话存储的保留策略由后端管理，`directory`、`maxTotalBytes`、`maxFiles`、`ttlMs` 仅约束本地回退目录。缺少存储能力或会话/来源信息时使用本地存储。后端报错时仍正常裁剪，不宣称保存成功，也不再尝试第二次写入。

本地回退落盘默认开启（可配置 `spillover.enabled: false` 关闭），文件可能包含敏感输出。POSIX 文件权限为 `0600`，新建目录为 `0700`；Windows 权限遵循父目录 ACL，请选择私有目录。每次写入前在跨进程共享的目录锁内检查容量，锁被占用时立即降级。清理只处理完整匹配插件文件名的文件，每次最多扫描 4096 个条目并额外检查一次是否溢出，最多删除 128 个文件。目录过大、容量不足、锁被占用或磁盘错误时跳过落盘，仍返回普通截断横幅。清理由后续写入或显式调用触发，TTL 不会在空闲时定时删除文件。锁文件记录 PID 和随机所有权标记；先完整写入唯一候选文件并关闭，再通过独占硬链接发布，不覆盖已有锁。发布前进程退出只会留下未使用的候选文件，不会发布空锁；发布后进程退出则保留完整元数据。这保障进程中断场景，不承诺文件系统损坏或断电后的持久性。本地写入要求文件系统支持硬链接；不支持时跳过落盘并记录诊断。后续写入或清理仅在 `process.kill(pid, 0)` 明确返回 `ESRCH` 时回收。回收使用同一代锁的独占硬链接及文件身份复核，避免多个回收者误删新锁。仍存活的 PID（包括 PID 复用）、权限错误、旧版空锁或损坏元数据均保守跳过，不按文件年龄强删。回收进程异常退出留下的 `.reap-*` 协调文件及未使用候选文件可通过下方离线命令处理。

### 离线锁检查与恢复

安装后的命令为 `dsh-trimmer-lock`，默认只检查。在源码仓库中可用 `node scripts/spill-lock.js`。建议显式传入配置中的本地回退目录；省略时使用默认临时目录。

```bash
node scripts/spill-lock.js --directory "PATH_TO_SPILL_DIRECTORY"
```

执行恢复前，停止共享该目录的所有写入和回收进程，再次检查并复制返回的 `fingerprint`，仅对同一份未变化的快照应用恢复：

```bash
node scripts/spill-lock.js --directory "PATH_TO_SPILL_DIRECTORY" --apply --writers-stopped --fingerprint HASH_FROM_INSPECTION
```

`--writers-stopped` 是操作者声明，不是自动证明所有潜在写入者均已停止。命令拒绝处理存活或无法确认状态的所有者、非普通文件的锁对象、已变化的快照及超过 4096 项的目录。只删除严格匹配的锁、候选和回收协调文件，保留日志和无关文件；旧版空锁或损坏元数据需要此显式离线操作，不提供按年龄强制覆盖。恢复结束前应保持相关进程停止，因为可移植文件系统没有附带文件身份条件的删除操作。程序接口为 `repairSpilloverLock(directory, options)`。

显式设置 `onSemanticReduction: true` 后，仅语义压缩也会保存原文，并追加独立的恢复提示；默认值为 `false`。短输出和仅 ANSI 清理不执行磁盘 I/O。

---

## 验证

使用 `npm test` 和 `npm run benchmark` 验证行为与性能。`npm run typecheck` 使用已有 TypeScript 编译器和真实的可选 Cordis peer 检查公开声明；宿主提供的两者可通过 `NODE_PATH` 解析。缺失依赖会明确失败，不安装依赖、不伪造声明。项目配置不含本机绝对路径，仅检查公开声明；JavaScript 另行通过文件级诊断与行为测试验证。

## 开源协议

[MIT](LICENSE) © [Jaylor Wang](https://github.com/Jaylor-Wang)
