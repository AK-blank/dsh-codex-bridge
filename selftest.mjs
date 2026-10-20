#!/usr/bin/env node
/**
 * Offline contract + policy self-test for dsh-codex-bridge.
 *
 * Default run is fully offline and spends no Codex usage. Flags:
 *   --live       also read the real Codex quota/model catalog (no model usage)
 *   --live-exec  also run a tiny real `codex exec` task (spends a little quota)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EFFORT_LADDER,
  PolicyError,
  buildModelLadder,
  computeBudget,
  normalizeModels,
  policyView,
  readQuota,
  recommend,
  resolveChoice,
  resolveConfig,
} from './lib/policy.js';
import {
  formatRunText,
  formatSpan,
  formatStatusText,
  queryCodexStatus,
  runCodex,
} from './lib/codex.js';
import { apply, internals } from './lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = new Set(process.argv.slice(2));
const live = argv.has('--live') || argv.has('--live-exec');
const liveExec = argv.has('--live-exec');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const value = fn();
    if (value === false) throw new Error('returned false');
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const value = await fn();
    if (value === false) throw new Error('returned false');
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectThrows(fn, code) {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof PolicyError)) throw new Error(`expected PolicyError, got ${error?.name ?? typeof error}: ${error?.message}`);
    if (error.code !== code) throw new Error(`expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// Package contract
// ---------------------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const patchPath = path.join(here, pkg.dsh?.bundle?.patch ?? '');
const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';

check('package name is dsh-codex-bridge', () => expectEqual(pkg.name, 'dsh-codex-bridge'));
check('bundle patch is declared and exists', () => expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml' && patch !== '', 'missing dsh.bundle.patch or file'));
check('patch inserts the codex-bridge row', () => {
  expect(patch.includes('- id: codex-bridge'), 'row id missing');
  expect(patch.includes('name: dsh-codex-bridge'), 'row name missing');
});
check('host-only bundle declares no peer dependencies', () => expect(pkg.peerDependencies === undefined, 'peerDependencies must stay absent'));
check('host-only bundle declares no client half', () => expect(pkg.dsh?.client === undefined, 'dsh.client must stay absent'));
check('exports cover entry, patch, package.json and locales', () => {
  expect(pkg.exports['.'] === './lib/index.js', 'entry export');
  expect(pkg.exports['./cordis.patch.yml'] === './cordis.patch.yml', 'patch export');
  expect(pkg.exports['./locale/*.json'] === './locale/*.json', 'locale export');
});
check('files[] ships the runtime and metadata', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'icon.svg', 'locale/*.json']) {
    expect(pkg.files.includes(entry), `files[] is missing ${entry}`);
  }
});
check('icon exists and is a small SVG', () => {
  const icon = fs.readFileSync(path.join(here, 'icon.svg'));
  expect(icon.length > 0 && icon.length < 256 * 1024, `icon size ${icon.length}`);
  expect(icon.toString('utf8').startsWith('<svg'), 'icon is not SVG');
});
check('locale files carry meta title and description', () => {
  for (const lang of ['en', 'zh']) {
    const meta = JSON.parse(fs.readFileSync(path.join(here, 'locale', `${lang}.json`), 'utf8'));
    expect(typeof meta.meta?.title === 'string' && meta.meta.title !== '', `${lang} title`);
    expect(typeof meta.meta?.description === 'string' && meta.meta.description !== '', `${lang} description`);
  }
});
check('runtime imports no DSH package', () => {
  for (const file of ['index.js', 'policy.js', 'codex.js']) {
    const source = fs.readFileSync(path.join(here, 'lib', file), 'utf8');
    expect(!source.includes("from '@deepseek-ai/"), `${file} imports a DSH package`);
  }
});
check('runtime files are syntax-valid ESM', () => {
  for (const file of ['index.js', 'policy.js', 'codex.js']) {
    const source = fs.readFileSync(path.join(here, 'lib', file), 'utf8');
    expect(source.includes('export '), `${file} has no exports`);
  }
});

// ---------------------------------------------------------------------------
// Policy: model ladder and quota
// ---------------------------------------------------------------------------

const now = Date.UTC(2026, 9, 21, 1, 0, 0);
const catalogFixture = [
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6-Astra',
    description: 'Frontier',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: EFFORT_LADDER.map((effort) => ({ reasoningEffort: effort, description: effort })),
  },
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    hidden: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: EFFORT_LADDER.map((effort) => ({ reasoningEffort: effort })),
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: EFFORT_LADDER.slice(0, 4).map((effort) => ({ reasoningEffort: effort })),
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: EFFORT_LADDER.slice(0, 5).map((effort) => ({ reasoningEffort: effort })),
  },
  {
    id: 'hidden-model',
    hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  },
];
const catalog = normalizeModels(catalogFixture);
const cfg = resolveConfig({});
const ladder = buildModelLadder(catalog, cfg);

check('config defaults match the deployment preference', () => {
  expectEqual(cfg.defaultModel, 'gpt-6.1-sol');
  expectEqual(cfg.minModel, 'gpt-5.6-sol');
  expectEqual(cfg.expensiveModel, 'gpt-6-astra');
  expectEqual(cfg.minEffort, 'medium');
  expectEqual(cfg.defaultEffort, 'high');
  expectEqual(cfg.reservePercent, 10);
  expectEqual(cfg.defaultSandbox, 'read-only');
});
check('config clamps low effort and out-of-range reserves', () => {
  expectEqual(resolveConfig({ minEffort: 'low' }).minEffort, 'medium');
  expectEqual(resolveConfig({ minEffort: 'high', defaultEffort: 'medium' }).defaultEffort, 'high');
  const tight = resolveConfig({ maxTimeoutSeconds: 1, maxOutputChars: 10, reservePercent: 90 });
  expectEqual(tight.maxTimeoutSeconds, 30);
  expectEqual(tight.maxOutputChars, 1000);
  expectEqual(tight.reservePercent, 50);
});
check('normalizeModels hides hidden entries and keeps catalog order', () => {
  expectEqual(catalog.length, 4);
  expectEqual(catalog[0].id, 'gpt-6-astra');
  expectEqual(catalog[1].id, 'gpt-5.6-sol');
});
check('ladder puts the configured default first and marks roles', () => {
  expectEqual(ladder.length, 5);
  expectEqual(ladder[0].id, 'gpt-6.1-sol');
  expectEqual(ladder[0].role, 'default');
  expectEqual(ladder[0].configured, true);
  expectEqual(ladder[0].listed, false);
  expectEqual(ladder[0].selectable, true);
  expectEqual(ladder[0].efforts.length, EFFORT_LADDER.length);
  expectEqual(ladder[1].id, 'gpt-6-astra');
  expectEqual(ladder[1].role, 'expensive');
  expectEqual(ladder[1].selectable, true);
  expectEqual(ladder[2].id, 'gpt-5.6-sol');
  expectEqual(ladder[2].role, 'fallback');
  expectEqual(ladder[3].id, 'gpt-5.6-terra');
  expectEqual(ladder[3].role, 'other');
  expectEqual(ladder[3].selectable, false);
});
check('ladder adds a configured fallback when the catalog omits it', () => {
  const withoutFallback = normalizeModels(catalogFixture.filter((model) => model.id !== 'gpt-5.6-sol'));
  const fallbackLadder = buildModelLadder(withoutFallback, cfg);
  const fallback = fallbackLadder.find((model) => model.id === 'gpt-5.6-sol');
  expect(fallback !== undefined, 'fallback missing');
  expectEqual(fallback.role, 'fallback');
  expectEqual(fallback.configured, true);
  expectEqual(fallback.selectable, true);
});
check('policyView exposes the configured roles', () => {
  const view = policyView(cfg, ladder);
  expectEqual(view.defaultModel, 'gpt-6.1-sol');
  expectEqual(view.minModel, 'gpt-5.6-sol');
  expectEqual(view.expensiveModel, 'gpt-6-astra');
  expectEqual(view.defaultEffort, 'high');
  expectEqual(view.reservePercent, 10);
  expectEqual(view.selectableModels.join(','), 'gpt-6.1-sol,gpt-6-astra,gpt-5.6-sol');
});

function quotaFixture(five, week, extra = {}) {
  return {
    rateLimits: {
      primary: { usedPercent: five, windowDurationMins: 300, resetsAt: now / 1000 + 9000 },
      secondary: { usedPercent: week, windowDurationMins: 10080, resetsAt: now / 1000 + 500000 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
      rateLimitReachedType: null,
    },
    ordinaryUsageAllowed: true,
    rateLimitResetCredits: { availableCount: 2, credits: [{ title: 'Full reset', expiresAt: now / 1000 + 86400 }] },
    ...extra,
  };
}

check('readQuota computes remaining percent and reset countdown', () => {
  const quota = readQuota(quotaFixture(35, 5), now);
  expectEqual(quota.fiveHour.usedPercent, 35);
  expectEqual(quota.fiveHour.remainingPercent, 65);
  expectEqual(quota.fiveHour.resetsInSeconds, 9000);
  expectEqual(quota.resetCredits.availableCount, 2);
});
check('computeBudget: normal above the reserve', () => expectEqual(computeBudget(readQuota(quotaFixture(35, 5), now), cfg).level, 'normal'));
check('computeBudget: reserve at 9% left', () => expectEqual(computeBudget(readQuota(quotaFixture(91, 5), now), cfg).level, 'reserve'));
check('computeBudget: reserve on the weekly window', () => expectEqual(computeBudget(readQuota(quotaFixture(5, 91), now), cfg).level, 'reserve'));
check('computeBudget: blocked at the stop threshold', () => expectEqual(computeBudget(readQuota(quotaFixture(96, 5), now), cfg).level, 'blocked'));
check('computeBudget: missing window is unknown', () => {
  const fixture = quotaFixture(10, 10);
  fixture.rateLimits.secondary = null;
  expectEqual(computeBudget(readQuota(fixture, now), cfg).level, 'unknown');
});
check('computeBudget: ordinaryUsageAllowed=false wins', () => {
  const fixture = quotaFixture(10, 10, { ordinaryUsageAllowed: false });
  expectEqual(computeBudget(readQuota(fixture, now), cfg).level, 'blocked');
});

const normalBudget = computeBudget(readQuota(quotaFixture(35, 5), now), cfg);
const reserveBudget = computeBudget(readQuota(quotaFixture(91, 5), now), cfg);
const blockedBudget = computeBudget(readQuota(quotaFixture(96, 5), now), cfg);

check('recommendation: normal defaults to 6.1-sol/high', () => {
  const rec = recommend(ladder, normalBudget, cfg);
  expectEqual(rec.simple.model, 'gpt-6.1-sol');
  expectEqual(rec.simple.effort, 'medium');
  expectEqual(rec.standard.model, 'gpt-6.1-sol');
  expectEqual(rec.standard.effort, 'high');
  expectEqual(rec.hard.model, 'gpt-6.1-sol');
  expectEqual(rec.hard.effort, 'high');
  expectEqual(rec.critical.model, 'gpt-6.1-sol');
  expectEqual(rec.critical.effort, 'xhigh');
});
check('recommendation: reserve falls back to 5.6-sol', () => {
  const rec = recommend(ladder, reserveBudget, cfg);
  expectEqual(rec.simple.model, 'gpt-5.6-sol');
  expectEqual(rec.standard.model, 'gpt-5.6-sol');
  expectEqual(rec.standard.effort, 'medium');
  expectEqual(rec.hard.model, 'gpt-5.6-sol');
  expectEqual(rec.critical.effort, 'high');
});
check('recommendation: astra never appears automatically', () => {
  for (const budget of [normalBudget, reserveBudget, blockedBudget]) {
    const rec = recommend(ladder, budget, cfg);
    for (const complexity of ['simple', 'standard', 'hard', 'critical']) {
      expect(rec[complexity].model !== 'gpt-6-astra', `${budget.level}/${complexity} selected astra`);
    }
  }
});

// ---------------------------------------------------------------------------
// Policy: explicit choices and guards
// ---------------------------------------------------------------------------

function choose(overrides) {
  return resolveChoice({
    ladder,
    budget: normalBudget,
    cfg,
    complexity: 'standard',
    model: 'auto',
    effort: 'auto',
    ...overrides,
  });
}

check('auto/standard on normal resolves to 6.1-sol/high', () => {
  const choice = choose({});
  expectEqual(choice.model, 'gpt-6.1-sol');
  expectEqual(choice.effort, 'high');
  expectEqual(choice.source, 'auto');
  expectEqual(choice.role, 'default');
});
check('auto/standard on reserve resolves to 5.6-sol/medium', () => {
  const choice = choose({ budget: reserveBudget });
  expectEqual(choice.model, 'gpt-5.6-sol');
  expectEqual(choice.effort, 'medium');
});
check('explicit 5.6-sol is accepted while normal', () => {
  const choice = choose({ model: 'gpt-5.6-sol', effort: 'high' });
  expectEqual(choice.model, 'gpt-5.6-sol');
  expectEqual(choice.effort, 'high');
});
check('explicit 6.1-sol is still accepted while reserve', () => {
  const choice = choose({ budget: reserveBudget, model: 'gpt-6.1-sol', effort: 'high' });
  expectEqual(choice.model, 'gpt-6.1-sol');
});
check('astra is refused without an explicit opt-in', () => {
  const error = expectThrows(() => choose({ model: 'gpt-6-astra', effort: 'high' }), 'EXPENSIVE_MODEL_GUARD');
  expect(error.message.includes('allow_expensive_model'), 'guard names the opt-in');
});
check('astra is accepted with the explicit opt-in', () => {
  const choice = choose({ model: 'gpt-6-astra', effort: 'high', allowExpensiveModel: true });
  expectEqual(choice.model, 'gpt-6-astra');
  expectEqual(choice.role, 'expensive');
});
check('astra still needs the blocked-quota opt-in', () => {
  expectThrows(() => choose({ model: 'gpt-6-astra', effort: 'high', allowExpensiveModel: true, budget: blockedBudget }), 'QUOTA_BLOCKED');
});
check('models below the floor are not selectable', () => {
  const error = expectThrows(() => choose({ model: 'gpt-5.6-terra' }), 'MODEL_NOT_SELECTABLE');
  expect(error.message.includes('gpt-5.6-sol'), 'selectable list is named');
});
check('unknown models are refused with the selectable list', () => {
  const error = expectThrows(() => choose({ model: 'does-not-exist' }), 'UNKNOWN_MODEL');
  expect(error.message.includes('gpt-6.1-sol'), 'selectable models in the message');
});
check('effort below medium is refused', () => expectThrows(() => choose({ effort: 'low' }), 'BELOW_EFFORT_FLOOR'));
check('effort not supported by the model is refused', () => {
  const limitedCatalog = normalizeModels([
    ...catalogFixture.filter((model) => model.id !== 'gpt-5.6-sol'),
    {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      hidden: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: EFFORT_LADDER.slice(0, 4).map((effort) => ({ reasoningEffort: effort })),
    },
  ]);
  const limitedLadder = buildModelLadder(limitedCatalog, cfg);
  expectThrows(() => resolveChoice({
    ladder: limitedLadder,
    budget: normalBudget,
    cfg,
    complexity: 'standard',
    model: 'gpt-5.6-sol',
    effort: 'max',
  }), 'EFFORT_UNSUPPORTED');
});
check('blocked quota refuses before spending', () => expectThrows(() => choose({ budget: blockedBudget }), 'QUOTA_BLOCKED'));
check('allow_low_quota unlocks the conservative fallback', () => {
  const choice = choose({ budget: blockedBudget, allowLowQuota: true });
  expectEqual(choice.model, 'gpt-5.6-sol');
  expectEqual(choice.effort, 'medium');
});
check('allow_low_quota does not unlock models below the floor', () => {
  expectThrows(() => choose({ budget: blockedBudget, allowLowQuota: true, model: 'gpt-5.6-terra' }), 'MODEL_NOT_SELECTABLE');
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const statusFixture = {
  ok: true,
  checkedAt: new Date(now).toISOString(),
  planType: 'plus',
  ordinaryUsageAllowed: true,
  windows: {
    fiveHour: { usedPercent: 35, remainingPercent: 65, windowMinutes: 300, resetsAt: new Date(now + 9_000_000).toISOString(), resetsAtUnix: now / 1000 + 9000, resetsInSeconds: 9000 },
    weekly: { usedPercent: 5, remainingPercent: 95, windowMinutes: 10080, resetsAt: new Date(now + 500_000_000).toISOString(), resetsAtUnix: now / 1000 + 500000, resetsInSeconds: 500000 },
  },
  credits: { hasCredits: false, unlimited: false, balance: '0' },
  resetCredits: { availableCount: 2, items: [{ title: 'Full reset', expiresAt: now / 1000 + 86400 }] },
  models: ladder,
  budget: normalBudget,
  recommendation: recommend(ladder, normalBudget, cfg),
  policy: policyView(cfg, ladder),
};

check('status rendering shows both windows, roles and the recommendation', () => {
  const text = formatStatusText(statusFixture);
  expect(text.includes('5-hour window: 35% used'), text);
  expect(text.includes('Weekly window: 5% used'), text);
  expect(text.includes('Budget: normal'), text);
  expect(text.includes('Models (default gpt-6.1-sol; floor gpt-5.6-sol)'), text);
  expect(text.includes('gpt-6.1-sol (default; configured, not listed by CLI)'), text);
  expect(text.includes('gpt-6-astra (expensive; explicit only)'), text);
  expect(text.includes('gpt-5.6-sol (fallback floor)'), text);
  expect(text.includes('gpt-5.6-terra (not selectable)'), text);
  expect(text.includes('Note: gpt-6.1-sol is configured but not listed'), text);
  expect(text.includes('standard: gpt-6.1-sol / high'), text);
});
check('status rendering shows the reserve recommendation', () => {
  const text = formatStatusText({
    ...statusFixture,
    budget: reserveBudget,
    recommendation: recommend(ladder, reserveBudget, cfg),
  });
  expect(text.includes('Budget: reserve'), text);
  expect(text.includes('standard: gpt-5.6-sol / medium'), text);
});
check('status rendering handles failure', () => {
  const text = formatStatusText({ ok: false, code: 'CODEX_NOT_FOUND', message: 'missing', hint: 'install it' });
  expect(text.includes('Codex quota unavailable'), text);
  expect(text.includes('install it'), text);
});
check('run rendering shows the answer and quota', () => {
  const text = formatRunText({
    ok: true,
    model: 'gpt-6.1-sol',
    effort: 'high',
    durationMs: 42_000,
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 5, reasoningOutputTokens: 0 },
    commandCount: 1,
    fileChangeCount: 0,
    quotaAfter: { budgetLevel: 'normal', fiveHour: { usedPercent: 36, remainingPercent: 64 }, weekly: { usedPercent: 5, remainingPercent: 95 } },
    threadId: 'thread-1',
    answer: 'OK',
  });
  expect(text.includes('Codex OK'), text);
  expect(text.includes('--- answer ---'), text);
  expect(text.includes('OK'), text);
  expect(text.includes('Quota after'), text);
});
check('run rendering handles failure without an answer', () => {
  const text = formatRunText({ ok: false, code: 'CODEX_QUOTA', message: 'limit reached', model: 'gpt-6.1-sol', effort: 'high', durationMs: 1000, exitCode: 1, errors: ['usage limit'], stderrTail: 'usage limit' });
  expect(text.includes('Codex FAILED'), text);
  expect(text.includes('limit reached'), text);
});
check('formatSpan renders days, hours, minutes', () => {
  expectEqual(formatSpan(9000), '2h 30m');
  expectEqual(formatSpan(6 * 86400 + 3600), '6d 1h');
  expectEqual(formatSpan(42), '42s');
});

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

check('apply registers exactly two tools and the policy section', () => {
  const tools = [];
  const sections = [];
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
  };
  const dispose = apply(ctx, {});
  expectEqual(tools.length, 2);
  expectEqual(tools[0].name, 'codex_status');
  expectEqual(tools[1].name, 'codex_delegate');
  for (const tool of tools) {
    expectEqual(tool.parameters.type, 'object');
    expectEqual(tool.output.schema.type, 'object');
    expect(typeof tool.output.render === 'function', `${tool.name} render`);
    expect(typeof tool.execute === 'function', `${tool.name} execute`);
  }
  expectEqual(sections.length, 1);
  expectEqual(sections[0].name, internals.SECTION_NAME);
  expectEqual(sections[0].order, internals.SECTION_ORDER);
  expect(sections[0].text.includes('gpt-6.1-sol'), 'section names the default model');
  expect(sections[0].text.includes('gpt-5.6-sol'), 'section names the reserve model');
  expect(sections[0].text.includes('allow_expensive_model'), 'section names the astra opt-in');
  dispose();
});
check('delegate schema requires task and constrains sandbox/effort', () => {
  const tools = [];
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    systemPrompt: { section: () => () => {} },
  };
  apply(ctx, {});
  const delegate = tools.find((tool) => tool.name === 'codex_delegate');
  expect(delegate.parameters.required.includes('task'), 'task is required');
  expect(delegate.parameters.properties.sandbox.enum.join(',') === 'read-only,workspace-write', 'sandbox enum');
  expect(delegate.parameters.properties.reasoning_effort.enum.includes('medium'), 'medium allowed');
  expect(!delegate.parameters.properties.reasoning_effort.enum.includes('low'), 'low rejected');
  expect(delegate.parameters.properties.allow_expensive_model !== undefined, 'astra opt-in exposed');
});

// ---------------------------------------------------------------------------
// Live checks
// ---------------------------------------------------------------------------

if (live) {
  await checkAsync('live: codex app-server reports quota and the configured ladder', async () => {
    const status = await queryCodexStatus(resolveConfig({}));
    if (status.ok !== true) throw new Error(`${status.code}: ${status.message}`);
    expect(status.windows?.fiveHour?.usedPercent >= 0, 'five-hour window');
    expect(status.windows?.weekly?.usedPercent >= 0, 'weekly window');
    const defaultModel = status.models.find((model) => model.role === 'default');
    const fallback = status.models.find((model) => model.role === 'fallback');
    const expensive = status.models.find((model) => model.role === 'expensive');
    expectEqual(defaultModel.id, cfg.defaultModel);
    expectEqual(fallback.id, cfg.minModel);
    expect(expensive !== undefined, 'expensive role present');
    expectEqual(expensive.id, cfg.expensiveModel);
    expectEqual(defaultModel.selectable, true);
    expectEqual(fallback.selectable, true);
    expectEqual(expensive.selectable, true);
    expect(status.budget.level === 'normal' || status.budget.level === 'reserve', `unexpected budget ${status.budget.level}`);
    const rec = status.recommendation.standard;
    expectEqual(rec.model, status.budget.level === 'normal' ? cfg.defaultModel : cfg.minModel);
    expectEqual(rec.effort, status.budget.level === 'normal' ? cfg.defaultEffort : 'medium');
    console.log(`     quota: 5h ${status.windows.fiveHour.usedPercent}% used, week ${status.windows.weekly.usedPercent}% used, budget ${status.budget.level}`);
    console.log(`     ladder: ${status.models.map((model) => `${model.id}(${model.role}${model.listed ? '' : ',configured'})`).join(', ')}`);
    console.log(`     standard: ${rec.model} / ${rec.effort}`);
  });

  await checkAsync('live: missing executable is classified as CODEX_NOT_FOUND', async () => {
    const status = await queryCodexStatus(resolveConfig({ codexCommand: 'dsh-codex-bridge-not-installed' }), { timeoutMs: 5000 });
    expect(status.ok === false, 'expected failure');
    expectEqual(status.code, 'CODEX_NOT_FOUND');
  });
}

if (liveExec) {
  await checkAsync('live: codex exec returns a final answer and usage', async () => {
    const status = await queryCodexStatus(resolveConfig({}));
    if (status.ok !== true) throw new Error(`status failed: ${status.code}`);
    const choice = resolveChoice({
      ladder: status.models,
      budget: status.budget,
      cfg,
      complexity: 'standard',
      model: 'auto',
      effort: 'auto',
    });
    const run = await runCodex(resolveConfig({ maxTimeoutSeconds: 300 }), {
      task: 'Reply with exactly: OK',
      model: choice.model,
      effort: choice.effort,
      cwd: here,
      sandbox: 'read-only',
      timeoutMs: 180,
      maxOutputChars: 2000,
    });
    if (run.ok !== true) throw new Error(`${run.code}: ${run.errors.join('; ')} ${run.stderrTail}`);
    expect(run.answer.trim().includes('OK'), `answer was ${JSON.stringify(run.answer)}`);
    expect(run.usage !== null, 'usage is present');
    console.log(`     ran ${run.model}/${run.effort} in ${(run.durationMs / 1000).toFixed(1)}s, answered ${JSON.stringify(run.answer.trim())}`);
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed} passed, ${failures.length} failed${live ? ' (live checks included)' : ''}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n${failure.name}\n${failure.error instanceof Error ? failure.error.stack : failure.error}`);
  }
  process.exitCode = 1;
}
