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
  /** Whether to reduce recognized successful build progress. Default: true */
  build?: boolean;
  /** Whether to reduce recognized successful formatter progress. Default: true */
  lint?: boolean;
}

export interface SpilloverConfig {
  /** Persist trimmed raw output, preferring the host's session-owned spillStore. Default: true */
  enabled?: boolean;
  /** Local fallback directory when session storage is unavailable. Default: os.tmpdir()/dsh-trimmed */
  directory?: string | null;
  /** Maximum bytes for a single spillover log file. Default: 20000000 (20MB) */
  maxFileBytes?: number;
  /** Maximum cumulative bytes in the local fallback directory. Default: 200000000 (200MB) */
  maxTotalBytes?: number;
  /** Maximum number of local fallback files to retain. Default: 1000 */
  maxFiles?: number;
  /** Time-to-live for local fallback files in milliseconds. Default: 604800000 (7 days) */
  ttlMs?: number;
  /** Save raw text and append a recovery notice for semantic-only reductions. Default: false */
  onSemanticReduction?: boolean;
}

export interface StructuredOutputConfig {
  /** Preserve complete JSON by default; summary explicitly enables array summaries; off uses legacy text trimming. */
  mode?: 'preserve' | 'summary' | 'off';
}

export type StorageFailureReason =
  | 'invalid-config' | 'file-too-large' | 'lock-busy' | 'lock-invalid' | 'lock-owner-unknown'
  | 'lock-changed' | 'lock-recovery-blocked' | 'lock-unsupported' | 'scan-limit'
  | 'capacity' | 'cleanup-limit' | 'cleanup-io' | 'storage-io' | 'backend-error' | 'backend-response';

export interface StorageDiagnosticsConfig {
  /** Emit fixed storage reason codes through the logger, independently of metrics. Default: true */
  enabled?: boolean;
  /** Minimum interval for each reason per plugin instance in milliseconds. Default: 60000 */
  intervalMs?: number;
}

export interface SpilloverLockRepairOptions {
  /** Inspect only unless true. */
  apply?: boolean;
  /** Assert that all writers and recovery processes using this directory have stopped. */
  writersStopped?: boolean;
  /** Fingerprint returned by a previous inspection of the same unchanged directory artifacts. */
  fingerprint?: string;
}

export interface SpilloverLockRepairResult {
  status: 'inspected' | 'repaired' | 'refused';
  fingerprint?: string;
  artifacts?: Array<{ name: string; status: 'invalid' | 'live' | 'dead' | 'unknown' }>;
  removed: number;
  reason?: 'writers-not-stopped' | 'snapshot-changed' | 'owner-active-or-unknown' | 'scan-limit' | 'storage-io';
}

export interface TrimmerMetricsEvent {
  reducer: 'git' | 'packageManager' | 'test' | 'build' | 'lint' | null;
  originalChars: number;
  outputChars: number;
  semanticReduced: boolean;
  structuredSummary: boolean;
  mechanicalTrimmed: boolean;
  /** Mechanical omissions only, measured after ANSI and semantic processing. */
  omittedChars: number;
  /** Newline characters in the mechanically omitted segment. */
  omittedLines: number;
  spillover: 'not-attempted' | 'success' | 'failed';
  /** Selected storage backend; none for unattempted or pre-storage refusals. */
  spilloverBackend: 'none' | 'session' | 'local';
  /** Also reports cleanup degradation when the new output was saved successfully. */
  spilloverReason: StorageFailureReason | null;
  spilloverFallbackReason: 'missing-store' | 'missing-source' | null;
  /** Monotonic end-to-end storage attempt duration, including capability resolution. */
  spilloverDurationMs: number;
  cleanup: 'not-attempted' | 'complete' | 'failed';
  cleanupDeleted: number;
}

export interface MetricsConfig {
  /** Emit a privacy-preserving event for each processed text result. Default: false */
  enabled?: boolean;
  /** Programmatic observer; when absent, emit through the Cordis logger. */
  onEvent?: (event: TrimmerMetricsEvent) => void | Promise<void>;
}

export interface ToolResultTrimmerConfig {
  /** Whether the trimmer is enabled. Default: true */
  enabled?: boolean;
  /** Whether to strip ANSI colors and terminal cursor controls from outputs. Default: true */
  stripAnsi?: boolean;
  /** Character threshold above which trimming is triggered. Default: 10000 */
  thresholdChars?: number;
  /** Global head budget. Default: 1500; web/MCP tools use the larger of the two budgets for their head. */
  headChars?: number;
  /** Global tail budget. Default: 5000; web/MCP tools use the smaller of the two budgets for their tail. */
  tailChars?: number;
  /** Tool names excluded from trimming. Default: ['read', 'read_image'] */
  excludeTools?: string[];
  /** Exact tool-name overrides take priority over tool-family budgets; enabled: false delegates to the host. Default: {} */
  overrides?: Record<string, ToolOverrideConfig>;
  /** Command-aware semantic reducers configuration. Default: { enabled: true, git: true, packageManager: true, test: true, build: true, lint: true } */
  semanticReducers?: SemanticReducersConfig;
  /** Spillover offloading configuration for full raw output persistence. Default: { enabled: true, ... } */
  spillover?: SpilloverConfig;
  /** Structured JSON protection. Default: { mode: 'preserve' } */
  structuredOutput?: StructuredOutputConfig;
  /** Rate-limited storage diagnostics. Default: { enabled: true, intervalMs: 60000 } */
  diagnostics?: StorageDiagnosticsConfig;
  /** Opt-in aggregate metrics. Default: { enabled: false } */
  metrics?: MetricsConfig;
}

export declare const name: 'tool-result-trimmer';
export declare const Config: any;
export declare const ANSI_REGEX: RegExp;
export declare const ENV_BYPASS_REGEX: RegExp;
export declare const COMMENT_BYPASS_REGEX: RegExp;
export declare const DEFAULT_SPILLOVER_CONFIG: SpilloverConfig;
export declare function stripAnsi(text: string): string;
export declare function isBypassed(exec?: unknown): boolean;
export declare function isExecutionFailure(result?: unknown, text?: string): boolean;
export declare function applySemanticReducers(exec: unknown, text: string, result?: unknown, config?: ToolResultTrimmerConfig): { reduced: boolean; text: string; reducerName?: string };
export declare function reduceGit(exec: unknown, text: string, result?: unknown): string | null;
export declare function reducePackageManager(exec: unknown, text: string, result?: unknown): string | null;
export declare function reduceTestOutput(exec: unknown, text: string, result?: unknown): string | null;
export declare function reduceBuild(exec: unknown, text: string, result?: unknown): string | null;
export declare function reduceLint(exec: unknown, text: string, result?: unknown): string | null;
export declare function writeSpillover(rawText: string, spilloverConfig?: SpilloverConfig, exec?: unknown): string | null;
export declare function repairSpilloverLock(directory: string, options?: SpilloverLockRepairOptions): SpilloverLockRepairResult;
export declare function apply(ctx: Context, config?: ToolResultTrimmerConfig): void;

declare const _default: {
  name: typeof name;
  Config: typeof Config;
  apply: typeof apply;
};

export default _default;
