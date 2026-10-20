/**
 * DSH host plugin: a Codex CLI bridge.
 *
 * Two model-facing tools:
 * - `codex_status` reads the ChatGPT Codex quota and model catalog through
 *   `codex app-server` without spending model usage.
 * - `codex_delegate` runs one non-interactive `codex exec` task with an
 *   explicitly chosen or budget-derived model and reasoning effort.
 *
 * Registration is a plain host bundle: no client half, no peer dependencies,
 * and a hand-written config normalizer so the profile does not need a
 * compatible schemastery instance.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  COMPLEXITIES,
  PolicyError,
  resolveChoice,
  resolveConfig,
} from './policy.js';
import {
  formatRunText,
  formatStatusText,
  queryCodexStatus,
  runCodex,
} from './codex.js';

export const name = 'codex-bridge';

/** Hard dependencies: tool registration and the standing policy section. */
export const inject = ['tools', 'systemPrompt'];

const RUN_LOCK = Symbol.for('dsh-codex-bridge.run-lock');
const SECTION_ORDER = 2950;
const SECTION_NAME = 'tool:codex-bridge';
const MAX_TASK_CHARS = 200000;
const DEFAULT_RUN_TIMEOUT_SECONDS = 900;

const SECTION_TEXT = [
  '## Codex CLI delegation',
  '`codex_status` reads the Codex CLI\'s ChatGPT-plan quota (5-hour and weekly windows), available models, and the quota-aware recommendation without spending Codex usage. `codex_delegate` runs one self-contained Codex task with the model and reasoning effort you pick.',
  'Delegate only work that benefits from a second agent, an independent implementation, or a deep investigation; finish work you can do yourself directly. Check `codex_status` before an expensive run when quota may matter, and again after a limit error.',
  'Default to `gpt-6.1-sol` at reasoning effort `high`. Do not choose `gpt-6-astra` on your own: it burns the shared ChatGPT quota much faster, and it runs only when the user explicitly asks for it and you set `allow_expensive_model=true`. When either quota window has 10% or less left, use `gpt-5.6-sol` with `medium`. Never go below `gpt-5.6-sol` or `medium`; simple work may stay at `medium`.',
  'Codex cannot see this conversation: the task must carry the file paths, symptoms, constraints, and the exact deliverable. Treat its answer as a second opinion and verify claims and diffs before reporting them.',
].join('\n');

const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    usedPercent: { type: 'number' },
    remainingPercent: { type: 'number' },
    windowMinutes: { type: 'number' },
    resetsAt: { type: 'string' },
    resetsAtUnix: { type: 'number' },
    resetsInSeconds: { type: 'number' },
  },
};

const CHOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string' },
    effort: { type: 'string' },
  },
  required: ['model', 'effort'],
};

const ERROR_FIELDS = {
  code: { type: 'string', description: 'Stable failure code.' },
  message: { type: 'string', description: 'Human-readable failure reason.' },
  hint: { type: 'string', description: 'Suggested recovery action.' },
  stderrTail: { type: 'string', description: 'Tail of the Codex stderr stream.' },
};

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    ...ERROR_FIELDS,
    checkedAt: { type: 'string' },
    planType: { type: 'string' },
    accountType: { type: 'string' },
    ordinaryUsageAllowed: { type: 'boolean' },
    windows: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiveHour: WINDOW_SCHEMA,
        weekly: WINDOW_SCHEMA,
      },
    },
    credits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hasCredits: { type: 'boolean' },
        unlimited: { type: 'boolean' },
        balance: { type: 'string' },
      },
    },
    resetCredits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        availableCount: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              expiresAt: { type: 'number' },
            },
          },
        },
      },
    },
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          defaultEffort: { type: 'string' },
          efforts: { type: 'array', items: { type: 'string' } },
          isDefault: { type: 'boolean' },
          role: { type: 'string' },
          configured: { type: 'boolean' },
          listed: { type: 'boolean' },
          selectable: { type: 'boolean' },
        },
        required: ['id', 'efforts'],
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'string' },
        reasons: { type: 'array', items: { type: 'string' } },
        fiveHourUsed: { type: 'number' },
        weeklyUsed: { type: 'number' },
      },
      required: ['level', 'reasons'],
    },
    recommendation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        simple: CHOICE_SCHEMA,
        standard: CHOICE_SCHEMA,
        hard: CHOICE_SCHEMA,
        critical: CHOICE_SCHEMA,
      },
    },
    policy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minModel: { type: 'string' },
        defaultModel: { type: 'string' },
        expensiveModel: { type: 'string' },
        minEffort: { type: 'string' },
        defaultEffort: { type: 'string' },
        reservePercent: { type: 'number' },
        selectableModels: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    ...ERROR_FIELDS,
    model: { type: 'string' },
    effort: { type: 'string' },
    complexity: { type: 'string' },
    sandbox: { type: 'string' },
    cwd: { type: 'string' },
    durationMs: { type: 'number' },
    exitCode: { type: 'number' },
    signal: { type: 'string' },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    threadId: { type: 'string' },
    answer: { type: 'string' },
    truncated: { type: 'boolean' },
    answerChars: { type: 'number' },
    commandCount: { type: 'number' },
    fileChangeCount: { type: 'number' },
    errors: { type: 'array', items: { type: 'string' } },
    usage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inputTokens: { type: 'number' },
        cachedInputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        reasoningOutputTokens: { type: 'number' },
      },
    },
    quotaAfter: {
      type: 'object',
      additionalProperties: false,
      properties: {
        planType: { type: 'string' },
        budgetLevel: { type: 'string' },
        fiveHour: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usedPercent: { type: 'number' },
            remainingPercent: { type: 'number' },
          },
        },
        weekly: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usedPercent: { type: 'number' },
            remainingPercent: { type: 'number' },
          },
        },
      },
    },
  },
};

function hintFor(code) {
  switch (code) {
    case 'MODEL_NOT_SELECTABLE':
      return 'Call codex_status and pick one of its selectable models.';
    case 'EXPENSIVE_MODEL_GUARD':
      return 'Ask the user first; gpt-6-astra burns quota much faster. Only then set allow_expensive_model=true.';
    case 'QUOTA_BLOCKED':
      return 'Wait for the window to reset, or retry with allow_low_quota=true only if the user accepts the spend.';
    case 'CODEX_QUOTA':
      return 'Call codex_status; wait for the window to reset or use gpt-5.6-sol.';
    case 'CODEX_AUTH':
      return 'Run `codex login` in a terminal, then call codex_status again.';
    case 'CODEX_NOT_FOUND':
      return 'Install the Codex CLI or set codexCommand in the plugin config.';
    default:
      return undefined;
  }
}

function failure(code, message, extra) {
  return { ok: false, code, message, ...extra };
}

function compactWindow(window) {
  if (window === undefined || window === null) return undefined;
  return { usedPercent: window.usedPercent, remainingPercent: window.remainingPercent };
}

function compactQuota(status) {
  if (status?.ok !== true) return undefined;
  const out = {};
  if (typeof status.planType === 'string') out.planType = status.planType;
  if (typeof status.budget?.level === 'string') out.budgetLevel = status.budget.level;
  const five = compactWindow(status.windows?.fiveHour);
  if (five !== undefined) out.fiveHour = five;
  const week = compactWindow(status.windows?.weekly);
  if (week !== undefined) out.weekly = week;
  return Object.keys(out).length > 0 ? out : undefined;
}

function expandHome(value) {
  if (value === '~') return process.env.HOME ?? value;
  if (value.startsWith('~/')) return path.join(process.env.HOME ?? '', value.slice(2));
  return value;
}

function resolveCwd(requested, exec) {
  const sessionCwd = typeof exec?.agent?.session?.header?.cwd === 'string' && exec.agent.session.header.cwd !== ''
    ? exec.agent.session.header.cwd
    : process.cwd();
  const raw = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : sessionCwd;
  const absolute = path.resolve(sessionCwd, expandHome(raw));
  let info;
  try {
    info = fs.statSync(absolute);
  } catch {
    throw new PolicyError('CWD_INVALID', `working directory does not exist: ${absolute}`, { cwd: absolute });
  }
  if (!info.isDirectory()) throw new PolicyError('CWD_INVALID', `working directory is not a directory: ${absolute}`, { cwd: absolute });
  return absolute;
}

function clampTimeout(seconds, cfg) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return Math.min(DEFAULT_RUN_TIMEOUT_SECONDS, cfg.maxTimeoutSeconds);
  return Math.max(60, Math.min(cfg.maxTimeoutSeconds, Math.round(seconds)));
}

function acquireRunLock(cfg) {
  const current = globalThis[RUN_LOCK];
  if (current !== undefined) {
    const age = Date.now() - (typeof current === 'number' ? current : 0);
    if (age < (cfg.maxTimeoutSeconds + 120) * 1000) return false;
  }
  globalThis[RUN_LOCK] = Date.now();
  return true;
}

function releaseRunLock() {
  delete globalThis[RUN_LOCK];
}

function describeRunFailure(run, timeoutSeconds) {
  if (run.timedOut === true) return `Codex timed out after ${timeoutSeconds}s.`;
  if (run.aborted === true) return 'Codex run was aborted.';
  if (run.exitCode !== null && run.exitCode !== undefined) return `Codex exited with code ${run.exitCode}.`;
  return 'Codex did not complete.';
}

/** Build the two tools and their shared runtime around one Loader row. */
function createRuntime(cfg) {
  let cache = null;
  let cachedAt = 0;
  let inflight = null;
  let stopped = false;

  const getStatus = async (force) => {
    if (stopped) return failure('BRIDGE_STOPPED', 'the Codex bridge plugin is no longer active');
    if (!force && cache !== null && Date.now() - cachedAt < cfg.statusCacheSeconds * 1000) return cache;
    if (inflight !== null) return inflight;
    inflight = queryCodexStatus(cfg)
      .then((status) => {
        if (status.ok === true && !stopped) {
          cache = status;
          cachedAt = Date.now();
        }
        return status;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const invalidate = () => {
    cache = null;
    cachedAt = 0;
  };

  return {
    getStatus,
    invalidate,
    stop() {
      stopped = true;
      cache = null;
      cachedAt = 0;
    },
  };
}

/**
 * Apply the host plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {unknown} config raw Loader row config.
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const runtime = createRuntime(cfg);

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: SECTION_TEXT,
  });

  ctx.tools.register({
    name: 'codex_status',
    description: 'Read the Codex CLI\'s ChatGPT-plan quota: 5-hour and weekly windows, reset times, credits, available models, and the quota-aware recommendation (gpt-6.1-sol/high by default; gpt-5.6-sol reserve when a window has 10% or less left). Costs no Codex usage. Call it before an expensive delegation when quota matters, and after a run reports a limit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Read past the 30-second cache instead of reusing the last snapshot.',
        },
      },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatStatusText(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Read Codex quota', kind: 'read' }),
    async execute(args) {
      return runtime.getStatus(args?.refresh === true);
    },
  });

  ctx.tools.register({
    name: 'codex_delegate',
    description: 'Run one non-interactive Codex CLI task in a chosen working directory and return its final answer, token usage, thread id, and the quota left afterwards. Codex sees only the task text and files under the working directory, so the task must be self-contained. A run can take minutes; choose model=auto and reasoning_effort=auto to let the current quota and complexity pick for you. Auto uses gpt-6.1-sol/high normally and gpt-5.6-sol when a window is at 10% or less; gpt-6-astra needs allow_expensive_model=true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'Complete instructions for Codex: goal, relevant absolute paths, symptoms, constraints, and the exact deliverable. Codex has no access to this conversation.',
        },
        complexity: {
          type: 'string',
          enum: COMPLEXITIES,
          description: 'How hard the task is; used only when model or reasoning_effort is auto. Default standard.',
        },
        model: {
          type: 'string',
          description: 'auto, or a selectable model id from codex_status. gpt-6-astra additionally requires allow_expensive_model=true.',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['auto', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'auto, or an explicit level. The deployment minimum still applies.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for Codex; defaults to this session\'s working directory. Relative paths resolve against it.',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write'],
          description: 'read-only for analysis and review (default); workspace-write only when Codex must edit files under cwd.',
        },
        timeout_seconds: {
          type: 'number',
          description: `Wall-clock limit for the run; 60 to ${cfg.maxTimeoutSeconds} seconds. Default 900.`,
        },
        allow_low_quota: {
          type: 'boolean',
          description: 'Bypass the blocked-quota guard for this run. Only set it when the user explicitly accepts spending while ordinary usage is blocked.',
        },
        allow_expensive_model: {
          type: 'boolean',
          description: 'Required for an explicit gpt-6-astra run. Only set it when the user explicitly asks for the expensive model.',
        },
      },
    },
    output: {
      schema: RUN_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatRunText(value) }],
    },
    timeoutMs: (cfg.maxTimeoutSeconds + 120) * 1000,
    presentCall: (args) => ({
      card: 'generic',
      title: `Run Codex (${typeof args?.complexity === 'string' ? args.complexity : 'standard'})`,
      kind: 'execute',
    }),
    async execute(args, exec) {
      try {
        const task = typeof args?.task === 'string' ? args.task : '';
        if (task.trim() === '') return failure('INVALID_TASK', 'task must be a non-empty string');
        if (task.length > MAX_TASK_CHARS) {
          return failure('TASK_TOO_LARGE', `task is ${task.length} characters; the limit is ${MAX_TASK_CHARS}`);
        }
        const complexity = COMPLEXITIES.includes(args?.complexity) ? args.complexity : 'standard';
        const model = typeof args?.model === 'string' && args.model !== '' ? args.model : 'auto';
        const effort = typeof args?.reasoning_effort === 'string' && args.reasoning_effort !== '' ? args.reasoning_effort : 'auto';
        const sandbox = args?.sandbox === 'workspace-write' ? 'workspace-write' : args?.sandbox === 'read-only' ? 'read-only' : cfg.defaultSandbox;
        const timeoutSeconds = clampTimeout(args?.timeout_seconds, cfg);
        const cwd = resolveCwd(args?.cwd, exec);

        const status = await runtime.getStatus(false);
        if (status.ok !== true) {
          return failure(status.code ?? 'STATUS_UNAVAILABLE', `cannot read Codex quota: ${status.message ?? 'unknown error'}`, {
            hint: hintFor(status.code),
            ...(typeof status.stderrTail === 'string' ? { stderrTail: status.stderrTail } : {}),
          });
        }
        const choice = resolveChoice({
          ladder: status.models ?? [],
          budget: status.budget,
          cfg,
          complexity,
          model,
          effort,
          allowLowQuota: args?.allow_low_quota === true,
          allowExpensiveModel: args?.allow_expensive_model === true,
        });
        if (!acquireRunLock(cfg)) {
          return failure('CODEX_BUSY', 'another Codex run is already in progress; wait for it to finish', {
            hint: 'Retry after the running codex_delegate call returns.',
          });
        }
        let run;
        try {
          run = await runCodex(cfg, {
            task,
            model: choice.model,
            effort: choice.effort,
            cwd,
            sandbox,
            timeoutMs: timeoutSeconds,
            maxOutputChars: cfg.maxOutputChars,
            signal: exec.signal,
          });
        } finally {
          releaseRunLock();
          runtime.invalidate();
        }
        const statusAfter = await runtime.getStatus(true).catch(() => null);
        const quotaAfter = compactQuota(statusAfter);
        const common = {
          model: choice.model,
          effort: choice.effort,
          complexity: choice.complexity,
          sandbox,
          cwd,
          durationMs: run.durationMs,
          ...(typeof run.exitCode === 'number' ? { exitCode: run.exitCode } : {}),
          ...(typeof run.signal === 'string' ? { signal: run.signal } : {}),
          timedOut: run.timedOut === true,
          aborted: run.aborted === true,
          ...(typeof run.threadId === 'string' ? { threadId: run.threadId } : {}),
          answer: run.answer,
          truncated: run.truncated === true,
          answerChars: run.answerChars,
          commandCount: run.commandCount,
          fileChangeCount: run.fileChangeCount,
          errors: run.errors,
          ...(run.usage !== null && run.usage !== undefined ? { usage: run.usage } : {}),
          ...(quotaAfter !== undefined ? { quotaAfter } : {}),
        };
        if (run.ok !== true) {
          return {
            ok: false,
            code: run.code ?? 'CODEX_FAILED',
            message: describeRunFailure(run, timeoutSeconds),
            ...(hintFor(run.code) !== undefined ? { hint: hintFor(run.code) } : {}),
            ...common,
            stderrTail: run.stderrTail,
          };
        }
        return { ok: true, ...common };
      } catch (error) {
        if (error instanceof PolicyError) {
          return failure(error.code, error.message, { hint: hintFor(error.code) });
        }
        return failure('CODEX_BRIDGE_ERROR', error instanceof Error ? error.message : String(error));
      }
    },
  });

  return () => runtime.stop();
}

/** Exported for the offline self-test. */
export const internals = Object.freeze({
  SECTION_NAME,
  SECTION_ORDER,
  SECTION_TEXT,
  STATUS_SCHEMA,
  RUN_OUTPUT_SCHEMA,
  compactQuota,
  resolveCwd,
  clampTimeout,
});
