import { trimToolContent, stripAnsi, isBypassed } from './trimmer.js';
import { applySemanticReducers, reduceGit, reducePackageManager, reduceTestOutput } from './reducers/index.js';

export const name = 'tool-result-trimmer';

let Config;
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
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
    test: z.boolean().default(true).description('是否启用测试框架输出压缩（仅在测试全量通过时折叠用例）')
  });

  Config = z.object({
    enabled: z.boolean().default(true).description('是否启用即时工具结果修剪'),
    stripAnsi: z.boolean().default(true).description('是否自动剥离终端 ANSI 颜色与光标控制代码'),
    thresholdChars: z.number().step(1).min(100).default(10000).description('全局触发裁剪的字符阈值（超出后生效；建议大于 headChars + tailChars）'),
    headChars: z.number().step(1).min(0).default(1500).description('全局头部保留字符数（查看启动参数/初始状态）'),
    tailChars: z.number().step(1).min(0).default(5000).description('全局尾部保留字符数（保留完整报错堆栈与退出码）'),
    excludeTools: z.array(z.string()).default(['read', 'read_image']).description('排除的工具列表（不参与裁剪与清洗）'),
    overrides: z.dict(ToolOverride).default({}).description('针对特定工具的差异化配置与预算定制（如 bash, grep 等）'),
    semanticReducers: SemanticReducersConfig.default({}).description('命令感知语义压缩器设置')
  });
} catch {
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
      test: true
    }
  };
}

export { Config, stripAnsi, isBypassed, applySemanticReducers, reduceGit, reducePackageManager, reduceTestOutput };

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
    const tThresh = toolOverride.thresholdChars ?? thresholdChars;
    const tHead = toolOverride.headChars ?? headChars;
    const tTail = toolOverride.tailChars ?? tailChars;
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

    const effectiveStripAnsi = toolOverride?.stripAnsi ?? stripAnsiEnabled;
    const effectiveThreshold = toolOverride?.thresholdChars ?? thresholdChars;
    const effectiveHead = toolOverride?.headChars ?? headChars;
    const effectiveTail = toolOverride?.tailChars ?? tailChars;

    // 5. Resolve active content blocks
    const content = decision.content ?? result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return decision;
    }

    // 6. Ring 2: Command-aware Semantic Reducers (Fail-Open)
    let processedBlocks = content;
    let semanticReduced = false;

    if (exec?.arguments?.command && typeof exec.arguments.command === 'string') {
      const textBlocks = content.filter(b => b?.type === 'text' && typeof b.text === 'string');
      if (textBlocks.length > 0) {
        const fullRawText = textBlocks.map(b => b.text).join('\n');
        const cleanText = effectiveStripAnsi ? stripAnsi(fullRawText) : fullRawText;

        const outcome = applySemanticReducers(exec, cleanText, result, config);
        if (outcome.reduced) {
          semanticReduced = true;
          let inserted = false;
          processedBlocks = [];
          for (const block of content) {
            if (block?.type === 'text') {
              if (!inserted) {
                processedBlocks.push({ ...block, text: outcome.text });
                inserted = true;
              }
            } else {
              processedBlocks.push(block);
            }
          }
        }
      }
    }

    // 7. Ring 3: Mechanical Head/Tail trimming fallback
    const trimmed = trimToolContent(processedBlocks, {
      stripAnsi: effectiveStripAnsi,
      thresholdChars: effectiveThreshold,
      headChars: effectiveHead,
      tailChars: effectiveTail
    });

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
