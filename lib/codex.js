/**
 * Process layer for the Codex bridge.
 *
 * Two independent channels are used:
 *
 * - `codex app-server` over stdio answers quota and model questions without
 *   spending model usage. `account/rateLimits/read` carries the 5-hour and
 *   weekly windows; `model/list` carries the exact `-m` ids and the reasoning
 *   levels each model supports.
 * - `codex exec --json` runs the task itself and streams JSONL events that
 *   carry the final agent message, token usage, and failures.
 *
 * Every function here is injectable/testable: no module-level state.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  COMPLEXITIES,
  buildModelLadder,
  computeBudget,
  normalizeModels,
  policyView,
  readQuota,
  recommend,
} from './policy.js';

const DEFAULT_STATUS_TIMEOUT_MS = 15000;
const STDERR_TAIL_CHARS = 4000;

function tail(text, limit = STDERR_TAIL_CHARS) {
  if (typeof text !== 'string') return '';
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function failure(code, message, extra) {
  const value = { ok: false, code, message };
  if (extra !== undefined) Object.assign(value, extra);
  return value;
}

function buildEnv(cfg) {
  const env = { ...process.env };
  if (cfg.codexHome !== '') env.CODEX_HOME = cfg.codexHome;
  return env;
}

function killTree(child, signal) {
  if (child === null || child === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the single-process kill.
  }
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function closeStream(stream) {
  try {
    stream?.end();
  } catch {
    // Already closed.
  }
}

/**
 * Read quota, account identity, and the model catalog from `codex app-server`.
 *
 * The query finishes as soon as the required responses (rate limits and model
 * list) arrive; the optional account response is allowed to be late.
 *
 * @param {ReturnType<import('./policy.js').resolveConfig>} cfg
 * @param {{timeoutMs?: number, now?: () => number}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export function queryCodexStatus(cfg, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : DEFAULT_STATUS_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let stderr = '';
    let timer = null;
    let rl = null;
    const results = { rate: null, account: null, models: null };
    const pending = new Set(['rate', 'models']);

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        rl?.close();
      } catch {
        // Already closed.
      }
      if (child !== null) {
        closeStream(child.stdin);
        killTree(child, 'SIGTERM');
        const force = setTimeout(() => killTree(child, 'SIGKILL'), 1500);
        force.unref?.();
      }
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const send = (message) => {
      if (child === null || child.stdin?.destroyed === true) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // The server exited between the check and the write.
      }
    };

    const buildStatus = () => {
      if (results.rate === null || results.models === null) return;
      const quota = readQuota(results.rate, now());
      const catalog = normalizeModels(results.models?.data);
      const models = buildModelLadder(catalog, cfg);
      const budget = computeBudget(quota, cfg);
      const recommendation = recommend(models, budget, cfg);
      const windows = {};
      for (const [key, value] of [['fiveHour', quota.fiveHour], ['weekly', quota.weekly]]) {
        if (value === null) continue;
        const window = {
          usedPercent: value.usedPercent,
          remainingPercent: value.remainingPercent,
        };
        if (value.windowMinutes !== null) window.windowMinutes = value.windowMinutes;
        if (value.resetsAt !== null) {
          window.resetsAt = new Date(value.resetsAt * 1000).toISOString();
          window.resetsAtUnix = value.resetsAt;
          window.resetsInSeconds = value.resetsInSeconds;
        }
        windows[key] = window;
      }
      const budgetValue = { level: budget.level, reasons: budget.reasons };
      if (budget.fiveHourUsed !== null) budgetValue.fiveHourUsed = budget.fiveHourUsed;
      if (budget.weeklyUsed !== null) budgetValue.weeklyUsed = budget.weeklyUsed;
      const credits = quota.credits === null ? null : {
        hasCredits: quota.credits.hasCredits,
        unlimited: quota.credits.unlimited,
        ...(quota.credits.balance === null ? {} : { balance: quota.credits.balance }),
      };
      const resetCredits = quota.resetCredits === null ? null : {
        availableCount: quota.resetCredits.availableCount,
        items: quota.resetCredits.items.map((item) => ({
          title: item.title,
          ...(item.expiresAt === null ? {} : { expiresAt: item.expiresAt }),
        })),
      };
      const status = {
        ok: true,
        checkedAt: new Date(now()).toISOString(),
        planType: quota.planType
          ?? (typeof results.account?.account?.planType === 'string' ? results.account.account.planType : null),
        accountType: typeof results.account?.account?.type === 'string' ? results.account.account.type : null,
        ordinaryUsageAllowed: quota.ordinaryUsageAllowed,
        windows,
        credits,
        resetCredits,
        models,
        budget: budgetValue,
        recommendation,
        policy: policyView(cfg, models),
      };
      // Drop null fields: the output schema and the model-facing text only need
      // what the backend actually reported.
      for (const key of ['planType', 'accountType', 'ordinaryUsageAllowed', 'credits', 'resetCredits']) {
        if (status[key] === null) delete status[key];
      }
      finish(status);
    };

    try {
      child = spawn(cfg.codexCommand, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildEnv(cfg),
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish(failure('CODEX_SPAWN_FAILED', `could not start ${cfg.codexCommand} app-server: ${error.message}`));
      return;
    }

    timer = setTimeout(() => {
      finish(failure('CODEX_TIMEOUT', `codex app-server did not answer within ${Math.round(timeoutMs / 1000)}s`, { stderrTail: tail(stderr) }));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        finish(failure('CODEX_NOT_FOUND', `Codex CLI not found (${cfg.codexCommand}). Install Codex or set codexCommand in the plugin config.`));
        return;
      }
      finish(failure('CODEX_SPAWN_FAILED', `could not start ${cfg.codexCommand} app-server: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      finish(failure('CODEX_EXIT', `codex app-server exited before answering (code ${String(code)}${signal ? `, signal ${signal}` : ''})`, {
        stderrTail: tail(stderr),
      }));
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString('utf8'));
    });

    rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (settled || line.trim() === '') return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message === null || typeof message !== 'object') return;
      // Server-initiated request: answer with method-not-found so the server
      // never waits on this short-lived client.
      if (message.id !== undefined && typeof message.method === 'string') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported by dsh-codex-bridge' } });
        return;
      }
      if (message.id === 1) {
        if (message.error !== undefined) {
          finish(failure('CODEX_PROTOCOL', `initialize failed: ${message.error.message ?? JSON.stringify(message.error)}`));
          return;
        }
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', id: 10, method: 'account/rateLimits/read', params: {} });
        send({ jsonrpc: '2.0', id: 11, method: 'account/read', params: {} });
        send({ jsonrpc: '2.0', id: 12, method: 'model/list', params: {} });
        return;
      }
      const kind = message.id === 10 ? 'rate' : message.id === 11 ? 'account' : message.id === 12 ? 'models' : null;
      if (kind === null) return;
      if (message.error !== undefined) {
        const text = message.error.message ?? JSON.stringify(message.error);
        if (kind === 'account') return; // optional; planType also comes from rate limits
        const lower = text.toLowerCase();
        if (lower.includes('auth') || lower.includes('login') || lower.includes('unauthorized')) {
          finish(failure('CODEX_AUTH', `Codex is not signed in: ${text}. Run \`codex login\` first.`, { stderrTail: tail(stderr) }));
          return;
        }
        finish(failure('CODEX_RPC', `codex app-server rejected ${kind === 'rate' ? 'account/rateLimits/read' : 'model/list'}: ${text}`, {
          stderrTail: tail(stderr),
        }));
        return;
      }
      results[kind] = message.result ?? null;
      pending.delete(kind);
      if (pending.size === 0) buildStatus();
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'dsh-codex-bridge', title: 'DSH Codex Bridge', version: '1.0.0' },
      },
    });
  });
}

function parseUsage(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    inputTokens: number(raw.input_tokens),
    cachedInputTokens: number(raw.cached_input_tokens),
    outputTokens: number(raw.output_tokens),
    reasoningOutputTokens: number(raw.reasoning_output_tokens),
  };
}

/**
 * Run one non-interactive Codex task.
 *
 * @param {ReturnType<import('./policy.js').resolveConfig>} cfg
 * @param {{
 *   task: string,
 *   model: string,
 *   effort: string,
 *   cwd: string,
 *   sandbox: string,
 *   timeoutMs: number,
 *   maxOutputChars: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export function runCodex(cfg, options) {
  const {
    task,
    model,
    effort,
    cwd,
    sandbox,
    timeoutMs,
    maxOutputChars,
    signal,
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timedOut = false;
    let aborted = false;
    let turnFailed = false;
    let threadId = null;
    let answer = '';
    let usage = null;
    let commandCount = 0;
    let fileChangeCount = 0;
    const errors = [];
    let stderr = '';
    let stdoutBuffer = '';
    let timer = null;
    let forceTimer = null;
    let rl = null;
    const outputFile = path.join(os.tmpdir(), `dsh-codex-${randomUUID()}.txt`);
    const startedAt = Date.now();

    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      killTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2500);
      forceTimer.unref?.();
    };

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      timer = null;
      forceTimer = null;
      signal?.removeEventListener?.('abort', onAbort);
      try {
        rl?.close();
      } catch {
        // Already closed.
      }
      try {
        fs.rmSync(outputFile, { force: true });
      } catch {
        // Best effort.
      }
    };

    const finish = (exitCode, closeSignal, spawnError) => {
      if (settled) return;
      settled = true;
      if (stdoutBuffer.trim() !== '') consumeEvent(stdoutBuffer.trim());
      stdoutBuffer = '';
      if (answer === '') {
        try {
          if (fs.existsSync(outputFile)) {
            const fromFile = fs.readFileSync(outputFile, 'utf8').trim();
            if (fromFile !== '') answer = fromFile;
          }
        } catch {
          // The message stream is the primary channel.
        }
      }
      cleanup();
      const answerChars = answer.length;
      const truncated = answerChars > maxOutputChars;
      const answerOut = truncated
        ? `${answer.slice(0, maxOutputChars)}\n\n[truncated: ${answerChars - maxOutputChars} more characters]`
        : answer;
      if (spawnError !== undefined) {
        errors.push(spawnError.message);
      }
      const ok = spawnError === undefined && !timedOut && !aborted && exitCode === 0 && !turnFailed;
      let code = null;
      if (!ok) {
        const blob = `${errors.join('\n')}\n${stderr}`.toLowerCase();
        if (spawnError?.code === 'ENOENT') code = 'CODEX_NOT_FOUND';
        else if (timedOut) code = 'CODEX_TIMEOUT';
        else if (aborted) code = 'CODEX_ABORTED';
        else if (blob.includes('usage limit') || blob.includes('rate limit') || blob.includes('quota')) code = 'CODEX_QUOTA';
        else if (blob.includes('not logged in') || blob.includes('login') || blob.includes('unauthorized')) code = 'CODEX_AUTH';
        else code = 'CODEX_FAILED';
      }
      resolve({
        ok,
        code,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: closeSignal ?? null,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        threadId,
        answer: answerOut,
        answerChars,
        truncated,
        usage,
        commandCount,
        fileChangeCount,
        errors: errors.slice(0, 5),
        stderrTail: tail(stderr),
        model,
        effort,
        cwd,
        sandbox,
      });
    };

    try {
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-s',
        sandbox,
        '-C',
        cwd,
        '-m',
        model,
        '-c',
        `model_reasoning_effort=${JSON.stringify(effort)}`,
        '--output-last-message',
        outputFile,
      ];
      if (cfg.ephemeral) args.push('--ephemeral');
      args.push('-');
      child = spawn(cfg.codexCommand, args, {
        cwd,
        env: buildEnv(cfg),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish(null, null, error);
      return;
    }

    child.on('error', (error) => {
      if (!settled) finish(null, null, error);
    });
    child.on('close', (exitCode, closeSignal) => {
      finish(exitCode, closeSignal);
    });
    child.stdin.on('error', () => {
      // The process can exit before consuming the whole prompt.
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString('utf8'));
    });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line !== '') consumeEvent(line);
        newline = stdoutBuffer.indexOf('\n');
      }
    });

    function consumeEvent(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event === null || typeof event !== 'object') return;
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id;
        return;
      }
      if (event.type === 'turn.completed') {
        usage = parseUsage(event.usage);
        return;
      }
      if (event.type === 'turn.failed') {
        turnFailed = true;
        const message = event.error?.message ?? event.message ?? 'turn failed';
        errors.push(String(message));
        return;
      }
      if (event.type === 'error') {
        const message = event.message ?? event.error?.message ?? 'error event';
        errors.push(String(message));
        return;
      }
      if (event.type !== 'item.completed' || event.item === null || typeof event.item !== 'object') return;
      const item = event.item;
      if ((item.type === 'agent_message' || item.type === 'assistant_message') && typeof item.text === 'string') {
        answer = item.text;
        return;
      }
      if (item.type === 'command_execution') {
        commandCount += 1;
        return;
      }
      if (item.type === 'file_change') {
        fileChangeCount += 1;
        return;
      }
      if (item.type === 'error' && typeof item.message === 'string') {
        errors.push(item.message);
      }
    }

    const seconds = Math.max(5, Math.min(cfg.maxTimeoutSeconds, timeoutMs));
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2500);
      forceTimer.unref?.();
    }, seconds * 1000);
    timer.unref?.();

    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child.stdin.write(task);
      child.stdin.end();
    } catch {
      // The spawn error path reports the failure.
    }
  });
}

/** Human-readable duration from seconds. */
export function formatSpan(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${Math.floor(total % 60)}s`;
  return `${total}s`;
}

/** Human-readable duration from milliseconds. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown';
  return formatSpan(ms / 1000);
}

function localTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function windowLine(label, window) {
  if (window === undefined || window === null) return `${label}: unavailable`;
  const parts = [`${window.usedPercent}% used`, `${window.remainingPercent}% left`];
  if (typeof window.resetsAt === 'string') {
    const suffix = typeof window.resetsInSeconds === 'number' ? `, in ${formatSpan(window.resetsInSeconds)}` : '';
    parts.push(`resets ${localTime(window.resetsAt)}${suffix}`);
  }
  return `${label}: ${parts.join(' · ')}`;
}

/**
 * Render the status tool result as compact model-facing text.
 *
 * @param {Record<string, unknown>} status
 * @returns {string}
 */
export function formatStatusText(status) {
  if (status?.ok !== true) {
    const lines = [`Codex quota unavailable (${status?.code ?? 'UNKNOWN'})`, String(status?.message ?? '')];
    if (typeof status?.hint === 'string' && status.hint !== '') lines.push(`Hint: ${status.hint}`);
    if (typeof status?.stderrTail === 'string' && status.stderrTail !== '') {
      lines.push('', 'stderr tail:', status.stderrTail);
    }
    return lines.filter((line) => line !== '').join('\n');
  }
  const lines = [];
  lines.push(`Codex quota — ChatGPT ${status.planType ?? 'unknown'} — checked ${localTime(status.checkedAt)}`);
  lines.push(windowLine('5-hour window', status.windows?.fiveHour));
  lines.push(windowLine('Weekly window', status.windows?.weekly));
  const credits = status.credits;
  if (credits !== undefined) {
    const creditText = credits.unlimited ? 'unlimited' : credits.hasCredits ? (credits.balance ?? 'available') : 'none';
    lines.push(`Credits: ${creditText}`);
  }
  const reset = status.resetCredits;
  if (reset !== undefined) {
    const expiries = Array.isArray(reset.items)
      ? reset.items.map((item) => (typeof item.expiresAt === 'number' ? new Date(item.expiresAt * 1000).toLocaleDateString() : null)).filter(Boolean)
      : [];
    const suffix = expiries.length > 0 ? ` (expires ${expiries.join(', ')})` : '';
    lines.push(`Full-reset credits: ${reset.availableCount}${suffix}`);
  }
  const budget = status.budget;
  if (budget !== undefined) {
    const reasons = Array.isArray(budget.reasons) && budget.reasons.length > 0 ? ` — ${budget.reasons.join('; ')}` : '';
    lines.push(`Budget: ${budget.level}${reasons}`);
  }
  const models = Array.isArray(status.models) ? status.models : [];
  const defaultModel = models.find((model) => model.role === 'default');
  const roleLabels = {
    default: 'default',
    expensive: 'expensive; explicit only',
    fallback: 'fallback floor',
  };
  lines.push(`Models (default ${defaultModel?.id ?? status.policy?.defaultModel ?? 'unknown'}; floor ${status.policy?.minModel ?? 'unknown'}):`);
  if (models.length === 0) {
    lines.push('  (no models reported)');
  } else {
    for (const model of models) {
      const flags = [];
      if (roleLabels[model.role] !== undefined) flags.push(roleLabels[model.role]);
      if (model.configured === true) flags.push('configured, not listed by CLI');
      if (model.selectable === false) flags.push('not selectable');
      lines.push(`  - ${model.id}${flags.length > 0 ? ` (${flags.join('; ')})` : ''}: ${model.efforts.join('/')}`);
    }
  }
  if (defaultModel?.listed === false) {
    lines.push(`Note: ${defaultModel.id} is configured but not listed by this Codex CLI; codex exec can still accept it and may warn about missing model metadata.`);
  }
  const rec = status.recommendation;
  if (rec !== undefined) {
    lines.push('Recommended by budget:');
    for (const complexity of COMPLEXITIES) {
      if (rec[complexity] !== undefined) lines.push(`  ${complexity}: ${rec[complexity].model} / ${rec[complexity].effort}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the delegate tool result.
 *
 * @param {Record<string, unknown>} run result returned by the tool.
 * @returns {string}
 */
export function formatRunText(run) {
  if (run?.ok !== true) {
    const lines = [`Codex FAILED (${run?.code ?? 'UNKNOWN'})`];
    if (typeof run?.model === 'string') {
      lines.push(`${run.model} / ${run.effort ?? 'unknown'} · ${formatDuration(run.durationMs)} · exit ${String(run.exitCode ?? 'n/a')}`);
    }
    if (typeof run?.message === 'string' && run.message !== '') lines.push('', run.message);
    if (Array.isArray(run?.errors) && run.errors.length > 0) {
      lines.push('', 'Errors:', ...run.errors.map((error) => `- ${error}`));
    }
    if (typeof run?.stderrTail === 'string' && run.stderrTail !== '') {
      lines.push('', 'stderr tail:', run.stderrTail);
    }
    if (typeof run?.answer === 'string' && run.answer !== '') {
      lines.push('', 'Partial answer:', run.answer);
    }
    return lines.join('\n');
  }
  const lines = [`Codex OK — ${run.model} / ${run.effort} — ${formatDuration(run.durationMs)} — exit 0`];
  const usage = run.usage;
  if (usage !== null && usage !== undefined) {
    const parts = [
      `input ${usage.inputTokens}`,
      usage.cachedInputTokens > 0 ? `cached ${usage.cachedInputTokens}` : null,
      `output ${usage.outputTokens}`,
      usage.reasoningOutputTokens > 0 ? `reasoning ${usage.reasoningOutputTokens}` : null,
    ].filter(Boolean);
    lines.push(`Tokens: ${parts.join(' · ')}`);
  }
  if (typeof run.commandCount === 'number' && run.commandCount > 0) lines.push(`Commands run: ${run.commandCount}`);
  if (typeof run.fileChangeCount === 'number' && run.fileChangeCount > 0) lines.push(`File changes: ${run.fileChangeCount}`);
  const quota = run.quotaAfter;
  if (quota !== undefined && quota !== null) {
    const five = quota.fiveHour !== undefined ? `${quota.fiveHour.usedPercent}% used` : 'n/a';
    const week = quota.weekly !== undefined ? `${quota.weekly.usedPercent}% used` : 'n/a';
    lines.push(`Quota after: 5h ${five} · week ${week}${quota.budgetLevel ? ` · ${quota.budgetLevel}` : ''}`);
  }
  if (typeof run.threadId === 'string' && run.threadId !== '') lines.push(`Thread: ${run.threadId}`);
  if (typeof run.answer === 'string' && run.answer !== '') {
    lines.push('', '--- answer ---', run.answer);
  } else {
    lines.push('', '(Codex returned no textual answer)');
  }
  return lines.join('\n');
}

/** Exported so the tool layer can render the same labels it sends. */
export const render = Object.freeze({
  status: formatStatusText,
  run: formatRunText,
});

/** Exported for tests that need the same set of task buckets. */
export { COMPLEXITIES };
