import type { Context } from '@deepseek-ai/cordis';

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
}

export declare const name: 'tool-result-trimmer';
export declare const Config: any;
export declare const ANSI_REGEX: RegExp;
export declare function stripAnsi(text: string): string;
export declare function apply(ctx: Context, config?: ToolResultTrimmerConfig): void;

declare const _default: {
  name: typeof name;
  Config: typeof Config;
  apply: typeof apply;
};

export default _default;
