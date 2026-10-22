import { trimToolContent, stripAnsi } from './trimmer.js';

export const name = 'tool-result-trimmer';

let Config;
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
  Config = z.object({
    enabled: z.boolean().default(true).description('是否启用即时工具结果修剪'),
    stripAnsi: z.boolean().default(true).description('是否自动剥离终端 ANSI 颜色与光标控制代码'),
    thresholdChars: z.number().step(1).min(100).default(10000).description('触发裁剪的字符阈值（超出后生效；建议大于 headChars + tailChars）'),
    headChars: z.number().step(1).min(0).default(1500).description('头部保留字符数（查看启动参数/初始状态）'),
    tailChars: z.number().step(1).min(0).default(5000).description('尾部保留字符数（保留完整报错堆栈与退出码）'),
    excludeTools: z.array(z.string()).default(['read', 'read_image']).description('排除的工具列表（不参与裁剪与清洗）')
  });
} catch {
  Config = {
    enabled: true,
    stripAnsi: true,
    thresholdChars: 10000,
    headChars: 1500,
    tailChars: 5000,
    excludeTools: ['read', 'read_image']
  };
}

export { Config, stripAnsi };

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

  if (thresholdChars < headChars + tailChars) {
    ctx.logger?.warn?.(
      `[tool-result-trimmer] thresholdChars (${thresholdChars}) is less than headChars + tailChars (${headChars + tailChars}). ` +
      `Outputs between threshold and budget sum will pass without trimming to protect required context.`
    );
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // 1. Run downstream handlers first
    const decision = await next();

    // 2. Safeguards: only process accepted outcomes that do not replace structured value
    if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) {
      return decision;
    }

    // 3. Skip excluded tools (e.g. read, read_image)
    if (exec && excludedSet.has(exec.name)) {
      return decision;
    }

    // 4. Resolve active content blocks
    const content = decision.content ?? result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return decision;
    }

    // 5. Clean ANSI and trim oversized text blocks in-place
    const trimmed = trimToolContent(content, {
      stripAnsi: stripAnsiEnabled,
      thresholdChars,
      headChars,
      tailChars
    });

    if (!trimmed.changed) {
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
