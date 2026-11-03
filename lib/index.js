import { trimToolContent, stripAnsi, isBypassed, formatBanner } from './trimmer.js';
import { applySemanticReducers, isExecutionFailure, reduceGit, reducePackageManager, reduceTestOutput, reduceBuild, reduceLint } from './reducers/index.js';
import { writeSpillover, DEFAULT_SPILLOVER_CONFIG } from './spillover.js';
import { inspectStructuredOutput, summarizeArray } from './structured-output.js';
import { emitMetrics, textLength } from './metrics.js';
import { resolveToolOptions } from './tool-options.js';
import { findRecoveryNotices, preserveRecoveryNotices, saveRecoveryText } from './spill-recovery.js';

export const name = 'tool-result-trimmer';

let Config;
let schemaModule;
try {
  schemaModule = await import('@deepseek-ai/schemastery');
} catch (error) {
  // Only a missing optional peer permits fallback. Schema bugs must surface.
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("'@deepseek-ai/schemastery'")) throw error;
}
if (schemaModule) {
  const { default: z } = schemaModule;
  const ToolOverride = z.object({
    enabled: z.boolean().description('是否对此工具启用裁剪（设为 false 可完全禁用该工具的裁剪）'),
    stripAnsi: z.boolean().description('是否剥离此工具输出的 ANSI 颜色与控制代码'),
    thresholdChars: z.number().step(1).min(100).description('此工具触发裁剪的字符阈值'),
    headChars: z.number().step(1).min(0).description('此工具头部保留字符数'),
    tailChars: z.number().step(1).min(0).description('此工具尾部保留字符数')
  });

  const SemanticReducersConfig = z.object({
    enabled: z.boolean().default(true).description('是否启用命令感知语义压缩器'),
    git: z.boolean().default(true).description('是否启用 Git 输出语义精简（git status, git diff）'),
    packageManager: z.boolean().default(true).description('是否启用包管理器冗余日志压缩（npm, pnpm, yarn, pip）'),
    test: z.boolean().default(true).description('是否启用测试框架输出压缩（仅在测试全量通过时折叠用例）'),
    build: z.boolean().default(true).description('是否启用构建成功进度压缩'),
    lint: z.boolean().default(true).description('是否启用格式检查成功进度压缩')
  });

  const SpilloverConfig = z.object({
    enabled: z.boolean().default(true).description('是否启用截断原文存储（优先使用会话 spillStore）'),
    directory: z.string().default(null).description('本地回退日志目录（无可用会话存储时使用，默认系统临时目录下的 dsh-trimmed）'),
    maxFileBytes: z.number().step(1).min(1024).default(20000000).description('单个备份日志的最大字节数（默认 20MB）'),
    maxTotalBytes: z.number().step(1).min(1024).default(200000000).description('本地回退目录的最大总字节预算（默认 200MB）'),
    maxFiles: z.number().step(1).min(1).default(1000).description('本地回退目录的最大文件数量（默认 1000 个）'),
    ttlMs: z.number().step(1).min(1000).default(604800000).description('本地回退日志保留有效期（毫秒，默认 7 天）'),
    onSemanticReduction: z.boolean().default(false).description('是否在仅发生语义压缩且未发生机械截断时也落盘（默认 false）')
  });

  Config = z.object({
    enabled: z.boolean().default(true).description('是否启用即时工具结果修剪'),
    stripAnsi: z.boolean().default(true).description('是否自动剥离终端 ANSI 颜色与光标控制代码'),
    thresholdChars: z.number().step(1).min(100).default(10000).description('全局触发裁剪的字符阈值（超出后生效；建议大于 headChars + tailChars）'),
    headChars: z.number().step(1).min(0).default(1500).description('全局头部预算（bash 沿用；网页/MCP 默认将较大预算分配给头部）'),
    tailChars: z.number().step(1).min(0).default(5000).description('全局尾部预算（bash 沿用；网页/MCP 默认将较小预算分配给尾部）'),
    excludeTools: z.array(z.string()).default(['read', 'read_image']).description('排除的工具列表（不参与裁剪与清洗）'),
    overrides: z.dict(ToolOverride).default({}).description('针对特定工具的差异化配置与预算定制（如 bash, grep 等）'),
    semanticReducers: SemanticReducersConfig.default({}).description('命令感知语义压缩器设置'),
    spillover: SpilloverConfig.default({}).description('截断原文存储与本地回退设置'),
    structuredOutput: z.object({
      mode: z.union([z.const('preserve'), z.const('summary'), z.const('off')]).default('preserve').description('完整 JSON 保护模式')
    }).default({}).description('结构化输出保护设置'),
    metrics: z.object({
      enabled: z.boolean().default(false).description('是否记录不含原文的裁剪统计'),
      onEvent: z.function().description('可选统计回调（仅供程序调用）')
    }).default({}).description('可观测性设置')
  });
} else {
  Config = {
    enabled: true,
    stripAnsi: true,
    thresholdChars: 10000,
    headChars: 1500,
    tailChars: 5000,
    excludeTools: ['read', 'read_image'],
    overrides: {},
    semanticReducers: {
      enabled: true,
      git: true,
      packageManager: true,
      test: true,
      build: true,
      lint: true
    },
    spillover: { ...DEFAULT_SPILLOVER_CONFIG },
    structuredOutput: { mode: 'preserve' },
    metrics: { enabled: false }
  };
}

export {
  Config,
  stripAnsi,
  isBypassed,
  isExecutionFailure,
  applySemanticReducers,
  reduceGit,
  reducePackageManager,
  reduceTestOutput,
  reduceBuild,
  reduceLint,
  writeSpillover,
  DEFAULT_SPILLOVER_CONFIG
};

/**
 * Apply the tool-result-trimmer Cordis plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled ?? true;
  if (!enabled) return;

  const stripAnsiEnabled = config.stripAnsi ?? true;
  const thresholdChars = config.thresholdChars ?? 10000;
  const headChars = config.headChars ?? 1500;
  const tailChars = config.tailChars ?? 5000;
  const excludeTools = config.excludeTools ?? ['read', 'read_image'];
  const excludedSet = new Set(excludeTools);
  const overrides = config.overrides ?? {};
  const toolDefaults = { stripAnsi: stripAnsiEnabled, thresholdChars, headChars, tailChars };

  // Global threshold warning
  if (thresholdChars < headChars + tailChars) {
    ctx.logger?.warn?.(
      `[tool-result-trimmer] thresholdChars (${thresholdChars}) is less than headChars + tailChars (${headChars + tailChars}). ` +
      `Outputs between threshold and budget sum will pass without trimming to protect required context.`
    );
  }

  // Per-tool overrides threshold warning
  for (const [tool, toolOverride] of Object.entries(overrides)) {
    if (!toolOverride || typeof toolOverride !== 'object' || toolOverride.enabled === false) continue;
    const { thresholdChars: tThresh, headChars: tHead, tailChars: tTail } = resolveToolOptions(tool, toolDefaults, toolOverride);
    if (tThresh < tHead + tTail) {
      ctx.logger?.warn?.(
        `[tool-result-trimmer] Tool override for "${tool}" has thresholdChars (${tThresh}) less than headChars + tailChars (${tHead + tTail}). ` +
        `Outputs between threshold and budget sum will pass without trimming to protect required context.`
      );
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // 1. Run downstream handlers first
    const decision = await next();

    // 2. Safeguards: only process accepted outcomes that do not replace structured value
    if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) {
      return decision;
    }

    // 3. Ring 1: Bypass check (Escape Hatch: DSH_TRIM_BYPASS=1, # no-trim, bypassTrim: true)
    if (isBypassed(exec)) {
      return decision;
    }

    // 4. Resolve tool-specific options (Per-Tool Overrides)
    const toolName = exec?.name;
    if (toolName && excludedSet.has(toolName)) {
      return decision;
    }

    const toolOverride = toolName ? overrides[toolName] : undefined;
    if (toolOverride?.enabled === false) {
      return decision;
    }

    const {
      stripAnsi: effectiveStripAnsi,
      thresholdChars: effectiveThreshold,
      headChars: effectiveHead,
      tailChars: effectiveTail
    } = resolveToolOptions(toolName, toolDefaults, toolOverride);

    // 5. Resolve active content blocks
    const content = decision.content ?? result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return decision;
    }

    const spilloverConfig = {
      ...DEFAULT_SPILLOVER_CONFIG,
      ...(config.spillover ?? {})
    };
    let metricsConfig;
    let metrics = null;
    try {
      metricsConfig = config.metrics;
      if (metricsConfig?.enabled === true && content.some(block => block?.type === 'text' && typeof block.text === 'string')) {
        metrics = {
          reducer: null,
          originalChars: textLength(content),
          outputChars: 0,
          semanticReduced: false,
          structuredSummary: false,
          mechanicalTrimmed: false,
          omittedChars: 0,
          omittedLines: 0,
          spillover: 'not-attempted',
          cleanup: 'not-attempted',
          cleanupDeleted: 0
        };
      }
    } catch { /* Metrics setup must not alter tool results. */ }
    const report = output => {
      if (metrics) {
        try {
          metrics.outputChars = textLength(output);
          emitMetrics(ctx, metricsConfig, metrics);
        } catch { /* Metrics must not alter tool results. */ }
      }
    };
    const originalText = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    const recoveryNotices = findRecoveryNotices(stripAnsi(originalText));
    const save = async text => {
      const saved = await saveRecoveryText(ctx, text, spilloverConfig, exec, metrics);
      if (metrics) metrics.spillover = saved ? 'success' : 'failed';
      return saved;
    };

    // Detect raw JSON before any reducer or ANSI processing can alter it.
    const structuredMode = config.structuredOutput?.mode ?? 'preserve';
    if (structuredMode !== 'off') {
      const structured = inspectStructuredOutput(content);
      if (structured) {
        if (structuredMode === 'summary' && structured.singleTextBlock && structured.text.length > effectiveThreshold) {
          // Failure and uncertain execution states MUST protect full JSON verbatim to prevent losing diagnostics
          if (!isExecutionFailure(result, structured.text)) {
            let summary = summarizeArray(structured.value, structured.text, effectiveHead, effectiveTail);
            if (summary) {
              if (spilloverConfig.enabled && recoveryNotices.length === 0) {
                const savedPath = await save(structured.text);
                if (savedPath) {
                  // A long path must not turn a useful summary into an expansion.
                  summary = summarizeArray(structured.value, structured.text, effectiveHead, effectiveTail, savedPath);
                }
              }
              if (summary) {
                const summarized = content.map(block => block?.type === 'text' && typeof block.text === 'string'
                  ? { ...block, text: summary }
                  : block);
                if (metrics) metrics.structuredSummary = true;
                report(summarized);
                return { ...decision, content: summarized };
              }
            }
          }
        }
        report(content);
        return decision;
      }
    }

    // Retain full unreduced raw text for spillover (pre-reduction) if spillover is enabled
    const preReductionText = spilloverConfig.enabled && recoveryNotices.length === 0 ? originalText : null;

    // 6. Ring 2: Command-aware Semantic Reducers (Fail-Open)
    let processedBlocks = content;
    let semanticReduced = false;

    if (exec?.arguments?.command && typeof exec.arguments.command === 'string') {
      const textBlocks = content.filter(b => b?.type === 'text' && typeof b.text === 'string');
      // Conservative Fail-Open: only apply semantic reduction to single-text-block results.
      // Multi-text-block results bypass semantic reduction to prevent silent block dropping
      // and preserve rich multi-part ordering perfectly for mechanical trimming.
      if (textBlocks.length === 1) {
        const rawText = textBlocks[0].text;
        const cleanText = effectiveStripAnsi ? stripAnsi(rawText) : rawText;

        const outcome = applySemanticReducers(exec, cleanText, result, config);
        if (outcome.reduced) {
          semanticReduced = true;
          if (metrics) {
            metrics.semanticReduced = true;
            metrics.reducer = ['git', 'packageManager', 'test', 'build', 'lint'].includes(outcome.reducerName)
              ? outcome.reducerName : null;
          }
          processedBlocks = content.map(block => {
            if (block?.type === 'text' && typeof block.text === 'string') {
              return { ...block, text: outcome.text };
            }
            return block;
          });
        }
      }
    }

    // 7. Ring 3: Mechanical Head/Tail trimming fallback
    const trimOptions = {
      stripAnsi: effectiveStripAnsi,
      thresholdChars: effectiveThreshold,
      headChars: effectiveHead,
      tailChars: effectiveTail
    };
    let trimmed = trimToolContent(processedBlocks, trimOptions);
    if (trimmed.totalOmittedChars && preReductionText) {
      // Keep the public trimming helpers synchronous; await storage only after a cut is known.
      const savedPath = await save(preReductionText);
      if (savedPath) trimmed = trimToolContent(processedBlocks, { ...trimOptions, savedPath });
    }

    // If only semantic reduction happened (no mechanical trimming) and onSemanticReduction is enabled
    if (semanticReduced && !trimmed.totalOmittedChars && spilloverConfig.enabled && spilloverConfig.onSemanticReduction && preReductionText) {
      const savedPath = await save(preReductionText);
      if (savedPath) {
        // A separate text block keeps recovery metadata outside reducer output.
        trimmed.content = [...trimmed.content, { type: 'text', text: formatBanner(0, 0, savedPath) }];
      }
    }

    if (trimmed.changed || semanticReduced) {
      trimmed.content = preserveRecoveryNotices(trimmed.content, recoveryNotices);
    }
    if (metrics) {
      metrics.mechanicalTrimmed = trimmed.totalOmittedChars > 0;
      metrics.omittedChars = trimmed.totalOmittedChars;
      metrics.omittedLines = trimmed.totalOmittedLines ?? 0;
    }
    report(trimmed.content);
    if (!trimmed.changed && !semanticReduced) {
      return decision;
    }

    return {
      ...decision,
      content: trimmed.content
    };
  }, { prepend: true });
}

export default {
  name,
  Config,
  apply
};
