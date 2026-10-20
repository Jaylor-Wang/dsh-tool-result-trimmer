# dsh-tool-result-trimmer

[![npm version](https://img.shields.io/npm/v/dsh-tool-result-trimmer?color=blue)](https://www.npmjs.com/package/dsh-tool-result-trimmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
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
3. **行吸附算法（Line-Aware Snapping · 绝不截断代码行）**：
   不按死板字符索引生硬切割，而是动态吸附到最近的换行符（`\n`）。保证头部在完整行末尾结束，尾部从新行行首开始，彻底杜绝半截单词、JSON/XML 语法破碎与 UTF-8 字符损坏。
4. **零副作用安全保护**：
   - **文件读取保护**：默认自动跳过 `read` 与 `read_image` 工具，保证文件查看行号与内容绝对精准。
   - **多模态内容保护**：图片等非文本块原样透传，不影响任何多模态交互。

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
    thresholdChars: 10000     # 触发裁剪的安全阈值（低于此值 0 开销原样放行）
    headChars: 1500           # 头部保留字符预算（观察命令入参与初始状态）
    tailChars: 5000           # 尾部保留字符预算（完整保留报错堆栈与退出码）
    excludeTools:             # 排除的工具列表，不参与裁剪
      - read
      - read_image
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用该修剪插件。 |
| `thresholdChars` | `number` | `10000` | 安全触发阈值（字符数）。输出小于等于该值时直接放行，0 额外损耗。 |
| `headChars` | `number` | `1500` | 头部保留字符预算（保留初始执行上下文）。 |
| `tailChars` | `number` | `5000` | 尾部保留字符预算（优先保留错误堆栈与退出状态）。 |
| `excludeTools` | `string[]` | `['read', 'read_image']` | 免于裁剪的工具列表。 |

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
