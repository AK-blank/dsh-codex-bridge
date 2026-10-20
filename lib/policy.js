/**
 * Quota-aware model and reasoning-effort policy for the Codex bridge.
 *
 * The deployment preference is deliberately narrow:
 * - default: `gpt-6.1-sol` at `high` reasoning;
 * - fallback when either quota window has 10% or less left: `gpt-5.6-sol`;
 * - `gpt-6-astra` is never selected automatically and needs an explicit opt-in,
 *   because it burns the shared ChatGPT quota much faster.
 *
 * The module is pure: it takes the app-server catalog plus the rate-limit
 * snapshot and returns a recommendation or a validated explicit choice.
 */

/** Reasoning levels Codex may advertise, weakest first. */
export const EFFORT_LADDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Task buckets a caller can ask the policy to resolve. */
export const COMPLEXITIES = Object.freeze(['simple', 'standard', 'hard', 'critical']);

/** Quota levels, least to most constrained. */
export const BUDGET_LEVELS = Object.freeze(['normal', 'reserve', 'unknown', 'blocked']);

export const DEFAULT_CONFIG = Object.freeze({
  /** Executable to run. A bare name resolves through PATH. */
  codexCommand: 'codex',
  /** Optional CODEX_HOME override; empty inherits the host environment. */
  codexHome: '',
  /** How long one status snapshot stays fresh, in seconds. */
  statusCacheSeconds: 30,
  /** Sandbox used when the caller does not choose one. */
  defaultSandbox: 'read-only',
  /** Keep Codex session files out of ~/.codex/sessions. */
  ephemeral: true,
  /** Hard ceiling for one delegated run, in seconds. */
  maxTimeoutSeconds: 1800,
  /** Maximum answer characters returned to the model. */
  maxOutputChars: 16000,
  /** Weakest model this deployment will ever call. */
  minModel: 'gpt-5.6-sol',
  /** Normal default model while both quota windows are healthy. */
  defaultModel: 'gpt-6.1-sol',
  /** Expensive model that only runs after an explicit opt-in. */
  expensiveModel: 'gpt-6-astra',
  /** Weakest reasoning effort this deployment will ever use. */
  minEffort: 'medium',
  /** Default reasoning effort for ordinary work. */
  defaultEffort: 'high',
  /** Fall back to `minModel` when either window has this much (or less) left. */
  reservePercent: 10,
  /** Stop ordinary runs when either window is this much used. */
  stopPercent: 95,
});

/** A refusal the tool layer can return as structured guidance instead of throwing. */
export class PolicyError extends Error {
  /**
   * @param {string} code stable machine code.
   * @param {string} message model-facing explanation.
   * @param {Record<string, unknown>} [details] optional structured context.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.details = details ?? {};
  }
}

function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Validate and normalize the raw Loader config.
 *
 * Unknown keys are ignored and out-of-range values are clamped so a bad patch
 * can never disable the quota guard or the model floor.
 *
 * @param {unknown} raw config from the Loader row.
 * @returns {typeof DEFAULT_CONFIG} a frozen, fully-populated config.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const minEffort = pick(input.minEffort, EFFORT_LADDER.slice(1), DEFAULT_CONFIG.minEffort);
  const defaultEffort = pick(input.defaultEffort, EFFORT_LADDER.slice(1), DEFAULT_CONFIG.defaultEffort);
  const cfg = {
    codexCommand: text(input.codexCommand, DEFAULT_CONFIG.codexCommand),
    codexHome: typeof input.codexHome === 'string' ? input.codexHome.trim() : DEFAULT_CONFIG.codexHome,
    statusCacheSeconds: clampNumber(input.statusCacheSeconds, DEFAULT_CONFIG.statusCacheSeconds, 1, 600),
    defaultSandbox: pick(input.defaultSandbox, ['read-only', 'workspace-write'], DEFAULT_CONFIG.defaultSandbox),
    ephemeral: typeof input.ephemeral === 'boolean' ? input.ephemeral : DEFAULT_CONFIG.ephemeral,
    maxTimeoutSeconds: clampNumber(input.maxTimeoutSeconds, DEFAULT_CONFIG.maxTimeoutSeconds, 30, 7200),
    maxOutputChars: clampNumber(input.maxOutputChars, DEFAULT_CONFIG.maxOutputChars, 1000, 60000),
    minModel: text(input.minModel, DEFAULT_CONFIG.minModel),
    defaultModel: text(input.defaultModel, DEFAULT_CONFIG.defaultModel),
    expensiveModel: text(input.expensiveModel, DEFAULT_CONFIG.expensiveModel),
    minEffort,
    defaultEffort: effortRank(defaultEffort) < effortRank(minEffort) ? minEffort : defaultEffort,
    reservePercent: clampNumber(input.reservePercent, DEFAULT_CONFIG.reservePercent, 1, 50),
    stopPercent: clampNumber(input.stopPercent, DEFAULT_CONFIG.stopPercent, 50, 100),
  };
  return Object.freeze(cfg);
}

/** @param {string} effort */
export function effortRank(effort) {
  return EFFORT_LADDER.indexOf(effort);
}

/**
 * Normalize `model/list` entries into catalog order.
 *
 * The app-server returns models in catalog priority order; `id` is the exact
 * `-m` value. Hidden entries are dropped here because they are not part of the
 * picker surface this bridge exposes.
 *
 * @param {unknown} rawModels the `data` field of `model/list`.
 * @returns {Array<{id:string,name:string,description:string,defaultEffort:string,efforts:string[],isDefault:boolean}>}
 */
export function normalizeModels(rawModels) {
  const list = Array.isArray(rawModels) ? rawModels : [];
  const models = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.id !== 'string' || entry.id === '' || entry.hidden === true) continue;
    if (seen.has(entry.id)) continue;
    const rawEfforts = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [];
    const efforts = [];
    for (const item of rawEfforts) {
      const effort = typeof item === 'string' ? item : item?.reasoningEffort;
      if (typeof effort === 'string' && effortRank(effort) >= 0 && !efforts.includes(effort)) efforts.push(effort);
    }
    if (efforts.length === 0) continue;
    seen.add(entry.id);
    models.push({
      id: entry.id,
      name: typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : entry.id,
      description: typeof entry.description === 'string' ? entry.description : '',
      defaultEffort: effortRank(entry.defaultReasoningEffort) >= 0 ? entry.defaultReasoningEffort : efforts[0],
      efforts,
      isDefault: entry.isDefault === true,
    });
  }
  return models;
}

function configuredModel(id, role, cfg) {
  return {
    id,
    name: id,
    description: 'configured model (not listed by the installed Codex CLI)',
    defaultEffort: cfg.defaultEffort,
    efforts: [...EFFORT_LADDER],
    isDefault: role === 'default',
    configured: true,
    listed: false,
    role,
    selectable: role !== 'other',
  };
}

/**
 * Build the deployment ladder: configured default, configured expensive model,
 * then the visible catalog. Only the three configured roles are selectable;
 * catalog models below the floor stay visible for context but cannot run.
 *
 * @param {ReturnType<typeof normalizeModels>} catalog
 * @param {typeof DEFAULT_CONFIG} cfg
 */
export function buildModelLadder(catalog, cfg) {
  const listed = new Map(catalog.map((model) => [model.id, model]));
  const ladder = [];
  const seen = new Set();
  const add = (id, role) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return null;
    const entry = listed.get(id);
    const model = entry
      ? { ...entry, configured: false, listed: true, role, selectable: role !== 'other' }
      : configuredModel(id, role, cfg);
    seen.add(id);
    ladder.push(model);
    return model;
  };
  add(cfg.defaultModel, 'default');
  add(cfg.expensiveModel, 'expensive');
  for (const model of catalog) add(model.id, model.id === cfg.minModel ? 'fallback' : 'other');
  if (!seen.has(cfg.minModel)) add(cfg.minModel, 'fallback');
  for (const model of ladder) {
    if (model.id === cfg.minModel && model.role === 'other') {
      model.role = 'fallback';
      model.selectable = true;
    }
  }
  return ladder;
}

function windowOf(raw, now) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const usedValue = typeof raw.usedPercent === 'number' && Number.isFinite(raw.usedPercent) ? raw.usedPercent : null;
  if (usedValue === null) return null;
  const usedPercent = Math.min(100, Math.max(0, Math.round(usedValue)));
  const resetsAt = typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) ? raw.resetsAt : null;
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowMinutes: typeof raw.windowDurationMins === 'number' && Number.isFinite(raw.windowDurationMins) ? raw.windowDurationMins : null,
    resetsAt,
    resetsInSeconds: resetsAt === null ? null : Math.max(0, resetsAt - Math.floor(now / 1000)),
  };
}

/**
 * Turn the account/rate-limit response into the bridge's quota view.
 *
 * @param {{
 *   rateLimits?: Record<string, unknown> | null,
 *   rateLimitResetCredits?: Record<string, unknown> | null,
 *   ordinaryUsageAllowed?: boolean | null,
 * }} response fields from `account/rateLimits/read`.
 * @param {number} now epoch milliseconds.
 */
export function readQuota(response, now) {
  const snapshot = response?.rateLimits && typeof response.rateLimits === 'object' ? response.rateLimits : {};
  const fiveHour = windowOf(snapshot.primary, now);
  const weekly = windowOf(snapshot.secondary, now);
  const creditsRaw = snapshot.credits && typeof snapshot.credits === 'object' ? snapshot.credits : null;
  const resetRaw = response?.rateLimitResetCredits && typeof response.rateLimitResetCredits === 'object' ? response.rateLimitResetCredits : null;
  const resetItems = Array.isArray(resetRaw?.credits)
    ? resetRaw.credits.slice(0, 5).map((item) => ({
      title: typeof item?.title === 'string' ? item.title : 'rate-limit reset',
      expiresAt: typeof item?.expiresAt === 'number' ? item.expiresAt : null,
    }))
    : [];
  return {
    fiveHour,
    weekly,
    ordinaryUsageAllowed: typeof response?.ordinaryUsageAllowed === 'boolean' ? response.ordinaryUsageAllowed : null,
    rateLimitReachedType: typeof snapshot.rateLimitReachedType === 'string' ? snapshot.rateLimitReachedType : null,
    credits: creditsRaw === null ? null : {
      hasCredits: creditsRaw.hasCredits === true,
      unlimited: creditsRaw.unlimited === true,
      balance: typeof creditsRaw.balance === 'string' ? creditsRaw.balance : null,
    },
    resetCredits: resetRaw === null ? null : {
      availableCount: typeof resetRaw.availableCount === 'number' ? resetRaw.availableCount : resetItems.length,
      items: resetItems,
    },
    planType: typeof snapshot.planType === 'string' ? snapshot.planType : null,
  };
}

/**
 * Classify the current quota.
 *
 * `normal`: both windows have more than the reserve left.
 * `reserve`: either window has `reservePercent` or less left; auto switches to
 *            the fallback model.
 * `blocked`: ordinary included usage is not allowed or a stop threshold was hit.
 * `unknown`: a window was missing; the bridge describes it and stays at the
 *            fallback recommendation.
 *
 * @param {ReturnType<typeof readQuota>} quota
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {{level: string, reasons: string[], fiveHourUsed: number|null, weeklyUsed: number|null, fiveHourLeft: number|null, weeklyLeft: number|null}}
 */
export function computeBudget(quota, cfg) {
  const reasons = [];
  const five = quota.fiveHour?.usedPercent ?? null;
  const week = quota.weekly?.usedPercent ?? null;
  const fiveLeft = quota.fiveHour?.remainingPercent ?? null;
  const weekLeft = quota.weekly?.remainingPercent ?? null;

  if (quota.rateLimitReachedType !== null) {
    return { level: 'blocked', reasons: [`the backend reports ${quota.rateLimitReachedType}`], fiveHourUsed: five, weeklyUsed: week, fiveHourLeft: fiveLeft, weeklyLeft: weekLeft };
  }
  if (quota.ordinaryUsageAllowed === false) {
    return { level: 'blocked', reasons: ['ordinary included usage is not allowed right now'], fiveHourUsed: five, weeklyUsed: week, fiveHourLeft: fiveLeft, weeklyLeft: weekLeft };
  }
  if (five === null || week === null) {
    return { level: 'unknown', reasons: ['at least one quota window was missing from the backend snapshot'], fiveHourUsed: five, weeklyUsed: week, fiveHourLeft: fiveLeft, weeklyLeft: weekLeft };
  }
  if (five >= cfg.stopPercent) reasons.push(`5-hour window is ${five}% used (stop threshold ${cfg.stopPercent}%)`);
  if (week >= cfg.stopPercent) reasons.push(`weekly window is ${week}% used (stop threshold ${cfg.stopPercent}%)`);
  if (reasons.length > 0) {
    return { level: 'blocked', reasons, fiveHourUsed: five, weeklyUsed: week, fiveHourLeft: fiveLeft, weeklyLeft: weekLeft };
  }
  if (fiveLeft !== null && fiveLeft <= cfg.reservePercent) {
    reasons.push(`5-hour window has ${fiveLeft}% left (fallback at ${cfg.reservePercent}% or less)`);
  }
  if (weekLeft !== null && weekLeft <= cfg.reservePercent) {
    reasons.push(`weekly window has ${weekLeft}% left (fallback at ${cfg.reservePercent}% or less)`);
  }
  if (reasons.length > 0) {
    return { level: 'reserve', reasons, fiveHourUsed: five, weeklyUsed: week, fiveHourLeft: fiveLeft, weeklyLeft: weekLeft };
  }
  return {
    level: 'normal',
    reasons: [`5-hour window ${five}% used and weekly window ${week}% used are above the fallback reserve`],
    fiveHourUsed: five,
    weeklyUsed: week,
    fiveHourLeft: fiveLeft,
    weeklyLeft: weekLeft,
  };
}

function findRole(ladder, role, fallbackIndex) {
  return ladder.find((model) => model.role === role) ?? ladder[fallbackIndex] ?? null;
}

function supportedEffort(model, desired, cfg) {
  const minimum = Math.max(0, effortRank(cfg.minEffort));
  let best = null;
  for (const effort of model.efforts) {
    const rank = effortRank(effort);
    if (rank < minimum) continue;
    if (rank <= effortRank(desired)) {
      if (best === null || rank > effortRank(best)) best = effort;
    }
  }
  if (best !== null) return best;
  let weakest = null;
  for (const effort of model.efforts) {
    if (effortRank(effort) < minimum) continue;
    if (weakest === null || effortRank(effort) < effortRank(weakest)) weakest = effort;
  }
  return weakest ?? model.efforts[0];
}

/**
 * Recommend a model/effort pair per task bucket for the current budget.
 *
 * @param {ReturnType<typeof buildModelLadder>} ladder
 * @param {ReturnType<typeof computeBudget>} budget
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {Record<string, {model: string, effort: string}>}
 */
export function recommend(ladder, budget, cfg) {
  const defaultModel = findRole(ladder, 'default', 0);
  const fallbackModel = findRole(ladder, 'fallback', ladder.length - 1);
  if (defaultModel === null || fallbackModel === null) {
    return Object.fromEntries(COMPLEXITIES.map((complexity) => [complexity, { model: cfg.minModel, effort: cfg.minEffort }]));
  }
  const normal = {
    simple: [defaultModel, cfg.defaultEffort],
    standard: [defaultModel, cfg.defaultEffort],
    hard: [defaultModel, cfg.defaultEffort],
    critical: [defaultModel, cfg.defaultEffort],
  };
  const conservative = {
    simple: [fallbackModel, 'medium'],
    standard: [fallbackModel, 'medium'],
    hard: [fallbackModel, 'medium'],
    critical: [fallbackModel, 'high'],
  };
  const table = budget.level === 'normal' ? normal : conservative;
  const result = {};
  for (const complexity of COMPLEXITIES) {
    const [model, effort] = table[complexity];
    result[complexity] = { model: model.id, effort: supportedEffort(model, effort, cfg) };
  }
  return result;
}

/**
 * Validate a caller's explicit or automatic model/effort choice.
 *
 * Explicit choices are never silently downgraded. Astra needs an explicit
 * `allowExpensiveModel`, and a blocked quota needs `allowLowQuota`; the model
 * floor and effort floor are absolute.
 *
 * @param {{
 *   ladder: ReturnType<typeof buildModelLadder>,
 *   budget: ReturnType<typeof computeBudget>,
 *   cfg: typeof DEFAULT_CONFIG,
 *   complexity: string,
 *   model: string,
 *   effort: string,
 *   allowLowQuota?: boolean,
 *   allowExpensiveModel?: boolean,
 * }} input
 * @returns {{model: string, effort: string, complexity: string, source: 'auto'|'explicit', budgetLevel: string, role: string}}
 */
export function resolveChoice(input) {
  const { ladder, budget, cfg } = input;
  const complexity = COMPLEXITIES.includes(input.complexity) ? input.complexity : 'standard';
  if (ladder.length === 0) throw new PolicyError('NO_MODELS', 'the Codex model ladder is empty; cannot choose a model');
  const autoModel = input.model === 'auto';
  const autoEffort = input.effort === 'auto';
  const rec = recommend(ladder, budget, cfg);
  const requestedModel = autoModel ? rec[complexity].model : input.model;
  const requestedEffort = autoEffort ? rec[complexity].effort : input.effort;
  const entry = ladder.find((model) => model.id === requestedModel);
  if (entry === undefined) {
    const selectable = ladder.filter((model) => model.selectable).map((model) => model.id);
    throw new PolicyError(
      'UNKNOWN_MODEL',
      `unknown model ${JSON.stringify(requestedModel)}; selectable models: ${selectable.join(', ')}`,
      { selectableModels: selectable },
    );
  }
  if (!entry.selectable) {
    const selectable = ladder.filter((model) => model.selectable).map((model) => model.id);
    throw new PolicyError(
      'MODEL_NOT_SELECTABLE',
      `${requestedModel} is below the floor or not a configured role; selectable models: ${selectable.join(', ')}`,
      { selectableModels: selectable },
    );
  }
  if (entry.role === 'expensive' && input.allowExpensiveModel !== true) {
    throw new PolicyError(
      'EXPENSIVE_MODEL_GUARD',
      `${requestedModel} consumes the shared ChatGPT quota much faster and is never selected automatically; set allow_expensive_model=true only when the user explicitly asks for it`,
      { model: requestedModel },
    );
  }
  if (budget.level === 'blocked' && input.allowLowQuota !== true) {
    throw new PolicyError(
      'QUOTA_BLOCKED',
      `Codex ordinary usage is blocked: ${budget.reasons.join('; ')}. Wait for the window to reset, or retry with allow_low_quota=true if you accept the risk.`,
      { level: budget.level, reasons: budget.reasons },
    );
  }
  const effort = typeof requestedEffort === 'string' ? requestedEffort : '';
  if (effortRank(effort) < 0) {
    throw new PolicyError('INVALID_EFFORT', `unknown reasoning effort ${JSON.stringify(effort)}`, { allowed: EFFORT_LADDER });
  }
  if (effortRank(effort) < effortRank(cfg.minEffort)) {
    throw new PolicyError(
      'BELOW_EFFORT_FLOOR',
      `${effort} is below this deployment's minimum reasoning effort ${cfg.minEffort}; use ${cfg.minEffort} or higher`,
      { minEffort: cfg.minEffort },
    );
  }
  if (!entry.efforts.includes(effort)) {
    throw new PolicyError(
      'EFFORT_UNSUPPORTED',
      `${entry.id} does not support reasoning effort ${effort}; supported: ${entry.efforts.join(', ')}`,
      { supported: entry.efforts },
    );
  }
  return {
    model: entry.id,
    effort,
    complexity,
    source: autoModel && autoEffort ? 'auto' : 'explicit',
    budgetLevel: budget.level,
    role: entry.role,
  };
}

/**
 * Build the compact policy object returned by the status tool.
 *
 * @param {typeof DEFAULT_CONFIG} cfg
 * @param {ReturnType<typeof buildModelLadder>} ladder
 */
export function policyView(cfg, ladder) {
  return {
    minModel: cfg.minModel,
    defaultModel: cfg.defaultModel,
    expensiveModel: cfg.expensiveModel,
    minEffort: cfg.minEffort,
    defaultEffort: cfg.defaultEffort,
    reservePercent: cfg.reservePercent,
    selectableModels: ladder.filter((model) => model.selectable).map((model) => model.id),
  };
}
