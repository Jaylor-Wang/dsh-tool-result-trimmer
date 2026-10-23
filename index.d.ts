import type { Context } from '@deepseek-ai/cordis';

export interface ToolOverrideConfig {
  /** Whether trimming is enabled for this specific tool. Default: true */
  enabled?: boolean;
  /** Whether to strip ANSI colors and terminal cursor controls from this tool's output. */
  stripAnsi?: boolean;
  /** Character threshold above which trimming is triggered for this tool. */
  thresholdChars?: number;
  /** Retained character budget for head for this tool. */
  headChars?: number;
  /** Retained character budget for tail for this tool. */
  tailChars?: number;
}

export interface SemanticReducersConfig {
  /** Whether to enable command-aware semantic reducers. Default: true */
  enabled?: boolean;
  /** Whether to enable Git output reduction (git status, git diff). Default: true */
  git?: boolean;
  /** Whether to enable package manager output reduction (npm, pnpm, yarn, pip). Default: true */
  packageManager?: boolean;
  /** Whether to enable test output reduction on clean passes. Default: true */
  test?: boolean;
}

export interface ToolResultTrimmerConfig {
  /** Whether the trimmer is enabled. Default: true */
  enabled?: boolean;
  /** Whether to strip ANSI colors and terminal cursor controls from outputs. Default: true */
  stripAnsi?: boolean;
  /** Character threshold above which trimming is triggered. Default: 10000 */
  thresholdChars?: number;
  /** Retained character budget for head (command args / start state). Default: 1500 */
  headChars?: number;
  /** Retained character budget for tail (stack traces / exit codes). Default: 5000 */
  tailChars?: number;
  /** Tool names excluded from trimming. Default: ['read', 'read_image'] */
  excludeTools?: string[];
  /** Per-tool budget overrides and configuration. Default: {} */
  overrides?: Record<string, ToolOverrideConfig>;
  /** Command-aware semantic reducers configuration. Default: { enabled: true, git: true, packageManager: true, test: true } */
  semanticReducers?: SemanticReducersConfig;
}

export declare const name: 'tool-result-trimmer';
export declare const Config: any;
export declare const ANSI_REGEX: RegExp;
export declare const ENV_BYPASS_REGEX: RegExp;
export declare const COMMENT_BYPASS_REGEX: RegExp;
export declare function stripAnsi(text: string): string;
export declare function isBypassed(exec?: unknown): boolean;
export declare function applySemanticReducers(exec: unknown, text: string, result?: unknown, config?: ToolResultTrimmerConfig): { reduced: boolean; text: string; reducerName?: string };
export declare function reduceGit(exec: unknown, text: string, result?: unknown): string | null;
export declare function reducePackageManager(exec: unknown, text: string, result?: unknown): string | null;
export declare function reduceTestOutput(exec: unknown, text: string, result?: unknown): string | null;
export declare function apply(ctx: Context, config?: ToolResultTrimmerConfig): void;

declare const _default: {
  name: typeof name;
  Config: typeof Config;
  apply: typeof apply;
};

export default _default;
