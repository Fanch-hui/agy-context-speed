/**
 * 等价 API 价格计算：按模型真实响应标识、展示名称或枚举匹配官方按量费率（USD / 1M tokens）。
 * 本地只读静态费率表，不发网络请求。
 */

const ARGON_INTRO_END = Date.UTC(2026, 11, 1); // 2026-12-01 00:00:00 UTC
const FLASH3_INTRO_END = Date.UTC(2027, 0, 1); // 2027-01-01 00:00:00 UTC

export const MODEL_CATALOG = {
  'gemini-4-hydrogen': { name: 'Gemini 4 Hydrogen', input: 1.5, cached: 0.075, output: 7.5 },
  'gemini-4-argon': {
    name: 'Gemini 4 Argon',
    schedule: [
      { until: ARGON_INTRO_END, input: 2.0, cached: 0.1, output: 10.0 },
      { input: 4.0, cached: 0.2, output: 20.0 },
    ],
  },
  'gemini-4-carbon': {
    name: 'Gemini 4 Carbon',
    schedule: [
      { until: ARGON_INTRO_END, input: 2.0, cached: 0.1, output: 10.0 },
      { input: 4.0, cached: 0.2, output: 20.0 },
    ],
  },
  'gemini-4-neon': { name: 'Gemini 4 Neon', input: 3.0, cached: 0.15, output: 15.0 },
  'gemini-3.8-flash': {
    name: 'Gemini 3.8 Flash',
    schedule: [
      { until: FLASH3_INTRO_END, input: 0.75, cached: 0.075, output: 3.75 },
      { input: 1.5, cached: 0.15, output: 7.5 },
    ],
  },
  'gemini-3.7-flash': {
    name: 'Gemini 3.7 Flash',
    schedule: [
      { until: FLASH3_INTRO_END, input: 0.75, cached: 0.075, output: 3.75 },
      { input: 1.5, cached: 0.15, output: 7.5 },
    ],
  },
  'gemini-3.6-flash': {
    name: 'Gemini 3.6 Flash',
    schedule: [
      { until: FLASH3_INTRO_END, input: 0.75, cached: 0.075, output: 3.75 },
      { input: 1.5, cached: 0.15, output: 7.5 },
    ],
  },
  'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', input: 1.5, cached: 0.15, output: 9.0 },
  'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash-Lite', input: 0.3, cached: 0.03, output: 2.5 },
  'gemini-3.1-pro': {
    name: 'Gemini 3.1 Pro',
    tiers: [
      { upTo: 200_000, input: 2.0, cached: 0.2, output: 12.0 },
      { upTo: Infinity, input: 4.0, cached: 0.4, output: 18.0 },
    ],
  },
  'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash-Lite', input: 0.25, cached: 0.025, output: 1.5 },
  'gemini-3-flash': { name: 'Gemini 3 Flash', input: 0.5, cached: 0.05, output: 3.0 },
  'gemini-2.5-pro': {
    name: 'Gemini 2.5 Pro',
    tiers: [
      { upTo: 200_000, input: 1.25, cached: 0.125, output: 10.0 },
      { upTo: Infinity, input: 2.5, cached: 0.25, output: 15.0 },
    ],
  },
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', input: 0.3, cached: 0.03, output: 2.5 },
  'gemini-2.5-flash-lite': { name: 'Gemini 2.5 Flash-Lite', input: 0.1, cached: 0.01, output: 0.4 },
  'claude-opus-5-5': { name: 'Claude Opus 5.5', input: 4.0, cached: 0.2, cacheWrite: 5.0, output: 20.0 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', input: 2.0, cached: 0.1, cacheWrite: 2.5, output: 10.0 },
  'claude-haiku-5-5': {
    name: 'Claude Haiku 5.5',
    tiers: [
      { upTo: 100_000, input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
      { upTo: Infinity, input: 0.5, cached: 0.05, cacheWrite: 0.625, output: 2.5 },
    ],
  },
  'claude-opus-4-8': { name: 'Claude Opus 4.8', input: 5.0, cached: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-opus-4-6': { name: 'Claude Opus 4.6', input: 5.0, cached: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', input: 3.0, cached: 0.3, cacheWrite: 3.75, output: 15.0 },
  'claude-opus-4-5': { name: 'Claude Opus 4.5', input: 5.0, cached: 0.5, cacheWrite: 6.25, output: 25.0 },
  'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5', input: 3.0, cached: 0.3, cacheWrite: 3.75, output: 15.0 },
  'claude-haiku-4-5': { name: 'Claude Haiku 4.5', input: 1.0, cached: 0.1, cacheWrite: 1.25, output: 5.0 },
  'claude-opus-4': { name: 'Claude Opus 4', input: 15.0, cached: 1.5, cacheWrite: 18.75, output: 75.0 },
  'claude-sonnet-4': { name: 'Claude Sonnet 4', input: 3.0, cached: 0.3, cacheWrite: 3.75, output: 15.0 },
  'gpt-oss-120b': { name: 'GPT-OSS 120B', input: 0.15, cached: 0.075, output: 0.6 },
};

const NAME_PATTERNS = [
  [/gemini[-_.\s]?4[-_.\s]?hydrogen|orchestrator\s*\(hydrogen\)/i, 'gemini-4-hydrogen'],
  [/gemini[-_.\s]?4[-_.\s]?argon|orchestrator\s*\(argon\)/i, 'gemini-4-argon'],
  [/gemini[-_.\s]?4[-_.\s]?carbon|orchestrator\s*\(carbon\)/i, 'gemini-4-carbon'],
  [/gemini[-_.\s]?4[-_.\s]?neon|orchestrator\s*\(neon\)/i, 'gemini-4-neon'],
  [/gemini[-_.\s]?3\.8[-_.\s]?flash/i, 'gemini-3.8-flash'],
  [/gemini[-_.\s]?3\.7[-_.\s]?flash/i, 'gemini-3.7-flash'],
  [/gemini[-_.\s]?3\.6[-_.\s]?flash/i, 'gemini-3.6-flash'],
  [/gemini[-_.\s]?3\.5[-_.\s]?flash[-_.\s]?lite/i, 'gemini-3.5-flash-lite'],
  [/gemini[-_.\s]?3\.5[-_.\s]?flash|^gemini-3-flash-a$/i, 'gemini-3.5-flash'],
  [/gemini[-_.\s]?3\.1[-_.\s]?flash[-_.\s]?lite/i, 'gemini-3.1-flash-lite'],
  [/gemini[-_.\s]?3(?:\.1|\.0)?[-_.\s]?pro/i, 'gemini-3.1-pro'],
  [/gemini[-_.\s]?3(?:\.0)?[-_.\s]?flash/i, 'gemini-3-flash'],
  [/gemini[-_.\s]?2\.5[-_.\s]?flash[-_.\s]?lite/i, 'gemini-2.5-flash-lite'],
  [/gemini[-_.\s]?2\.5[-_.\s]?flash/i, 'gemini-2.5-flash'],
  [/gemini[-_.\s]?2\.5[-_.\s]?pro/i, 'gemini-2.5-pro'],
  [/claude.*opus.*5[._-]5|orchestrator\s*\(opus\s*5[._-]5\)/i, 'claude-opus-5-5'],
  [/claude.*sonnet.*5[._-]5|orchestrator\s*\(sonnet\s*5[._-]5\)/i, 'claude-sonnet-5-5'],
  [/claude.*haiku.*5[._-]5/i, 'claude-haiku-5-5'],
  [/claude.*opus.*4[._-]8/i, 'claude-opus-4-8'],
  [/claude.*opus.*4[._-]6/i, 'claude-opus-4-6'],
  [/claude.*sonnet.*4[._-]6/i, 'claude-sonnet-4-6'],
  [/claude.*opus.*4[._-]5/i, 'claude-opus-4-5'],
  [/claude.*sonnet.*4[._-]5/i, 'claude-sonnet-4-5'],
  [/claude.*haiku.*4[._-]5/i, 'claude-haiku-4-5'],
  [/(?:claude[-_.\s]*4[-_.\s]*opus|claude[-_.\s]*opus[-_.\s]*4(?:[._-]1)?)(?=$|\s|\(|@|-20\d{2})/i, 'claude-opus-4'],
  [/(?:claude[-_.\s]*4[-_.\s]*sonnet|claude[-_.\s]*sonnet[-_.\s]*4)(?=$|\s|\(|@|-20\d{2})/i, 'claude-sonnet-4'],
  [/gpt[-_.\s]?oss[-_.\s]?120b/i, 'gpt-oss-120b'],
];

const ROUTE_ALIASES = {
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-orchestrator-g1-pro': 'gemini-4-argon',
  'gemini-flash-worker-agy': 'gemini-4-hydrogen',
};

const ENUM_TO_ID = {
  246: 'gemini-2.5-pro',
  281: 'claude-sonnet-4',
  282: 'claude-sonnet-4',
  290: 'claude-opus-4',
  291: 'claude-opus-4',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash',
  329: 'gemini-2.5-flash',
  330: 'gemini-2.5-flash-lite',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5',
  342: 'gpt-oss-120b',
  1016: 'gemini-3.1-pro',
  1026: 'claude-opus-4-6',
  1035: 'claude-sonnet-4-6',
  1036: 'gemini-3.1-pro',
  1071: 'gemini-3.6-flash',
  1132: 'gemini-3.5-flash',
  1264: 'gemini-3.6-flash',
  1298: 'gemini-3.7-flash',
  1300: 'gemini-3.7-flash',
  1318: 'gemini-3.8-flash',
  1319: 'gemini-3.8-flash',
  1320: 'gemini-3.8-flash',
  1400: 'claude-opus-5-5',
  1401: 'claude-opus-5-5',
  1402: 'claude-opus-5-5',
  1404: 'claude-sonnet-5-5',
  1405: 'claude-sonnet-5-5',
  1417: 'gemini-4-argon',
  1418: 'gemini-4-argon',
  1419: 'gemini-4-argon',
  1526: 'gemini-4-hydrogen',
  1528: 'gemini-4-hydrogen',
  1533: 'gemini-4-neon',
  1535: 'gemini-4-neon',
  1668: 'gemini-4-argon',
  1669: 'gemini-4-hydrogen',
};

const stripModelPath = (raw) => String(raw || '')
  .trim()
  .replace(/^(?:publishers\/[^/]+\/)?models\//i, '');

export function matchModelName(raw) {
  const cleaned = stripModelPath(raw);
  if (!cleaned) return null;
  for (const [pattern, id] of NAME_PATTERNS) {
    if (pattern.test(cleaned)) return id;
  }
  return null;
}

/** 根据调用携带的响应模型、展示名称和枚举值解析规范模型 ID。 */
export function resolveModelId(info) {
  if (!info) return null;
  if (typeof info === 'string') {
    const cleaned = stripModelPath(info);
    return matchModelName(cleaned) || ROUTE_ALIASES[cleaned.toLowerCase()] || null;
  }
  if (typeof info === 'number') return ENUM_TO_ID[info] || null;
  const resp = stripModelPath(info.responseModel);
  const full = stripModelPath(info.responseModelFull);
  return matchModelName(full)
    || matchModelName(resp)
    || matchModelName(info.modelDisplayName)
    || ROUTE_ALIASES[resp.toLowerCase()]
    || ENUM_TO_ID[info.model]
    || null;
}

/** 根据模型 ID、上下文总长度和调用时间确定当前生效的百万 token 费率。 */
export function activeRates(modelId, promptTokens = 0, whenMs = Date.now()) {
  const spec = MODEL_CATALOG[modelId];
  if (!spec) return null;
  const time = Number.isFinite(whenMs) ? whenMs : Date.now();
  const base = spec.schedule
    ? (spec.schedule.find(s => !s.until || time < s.until) ?? spec.schedule.at(-1))
    : spec;
  const tier = base.tiers
    ? (base.tiers.find(t => promptTokens <= t.upTo) ?? base.tiers.at(-1))
    : base;
  return {
    id: modelId,
    name: spec.name,
    input: tier.input,
    cached: tier.cached,
    cacheWrite: tier.cacheWrite ?? tier.input * 1.25,
    output: tier.output,
  };
}

/** 计算单次调用的等价 API 费用与缓存节省金额（USD）。 */
export function priceCall(turn, modelId, fallbackTime) {
  const input = turn.input || 0;
  const cached = turn.cached || 0;
  const cacheWrite = turn.cacheWrite || 0;
  const output = turn.output || 0;
  const rates = activeRates(modelId, input + cached + cacheWrite, turn.when ?? fallbackTime);
  if (!rates) return null;
  const inputCost = (input / 1e6) * rates.input;
  const cacheCost = (cached / 1e6) * rates.cached + (cacheWrite / 1e6) * rates.cacheWrite;
  const outputCost = (output / 1e6) * rates.output;
  const cacheSaved = (cached / 1e6) * (rates.input - rates.cached)
    - (cacheWrite / 1e6) * (rates.cacheWrite - rates.input);
  return {
    rates,
    input: inputCost,
    cached: cacheCost,
    output: outputCost,
    total: inputCost + cacheCost + outputCost,
    cacheSaved: Math.max(0, cacheSaved),
  };
}

function unknownLabel(info) {
  if (!info) return '';
  if (typeof info === 'string') return stripModelPath(info);
  const disp = stripModelPath(info.modelDisplayName);
  const id = stripModelPath(info.responseModelFull) || stripModelPath(info.responseModel);
  if (disp && id && disp.toLowerCase() !== id.toLowerCase()) return `${disp} (${id})`;
  return disp || id || (info.model ? `#${info.model}` : '');
}

/**
 * 仅在相邻已知调用指明同一模型（或整场仅出现单一已知模型）时，为孤立未配对的调用补全模型归属，
 * 避免跨模型切换时把一次调用误算成另一种价格。
 */
function resolveTurnModels(turns) {
  const direct = turns.map(t => resolveModelId(t.modelInfo));
  const uniqueKnown = [...new Set(direct.filter(Boolean))];
  return direct.map((id, i) => {
    if (id) return { id, inferred: false };
    if (!turns[i].modelInfo && uniqueKnown.length === 1) {
      return { id: uniqueKnown[0], inferred: true };
    }
    if (!turns[i].modelInfo && uniqueKnown.length > 1) {
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) { if (direct[j]) { prev = direct[j]; break; } }
      for (let j = i + 1; j < direct.length; j++) { if (direct[j]) { next = direct[j]; break; } }
      if (prev && prev === next) return { id: prev, inferred: true };
    }
    return { id: null, inferred: false };
  });
}

/** 逐条计算每次调用的模型归属、token 用量与等价 API 费用。 */
export function priceTurns(turns, options = {}) {
  const fallbackTime = options.now ?? Date.now();
  const fallbackWhen = options.fallbackWhen ?? null;
  const resolved = resolveTurnModels(turns);
  return turns.map((turn, i) => {
    const { id, inferred } = resolved[i];
    const input = turn.input || 0;
    const cached = turn.cached || 0;
    const output = turn.output || 0;
    const when = turn.when ?? fallbackWhen;
    if (!id) {
      return {
        when, input, cached, output, modelId: null, rates: null,
        inputCost: 0, cacheCost: 0, outputCost: 0, totalCost: 0, cacheSaved: 0,
        inferred: false, unrecognizedLabel: unknownLabel(turn.modelInfo),
      };
    }
    const priced = priceCall(turn, id, fallbackTime);
    return {
      when, input, cached, output, modelId: priced ? id : null, rates: priced?.rates ?? null,
      inputCost: priced?.input ?? 0, cacheCost: priced?.cached ?? 0,
      outputCost: priced?.output ?? 0, totalCost: priced?.total ?? 0,
      cacheSaved: priced?.cacheSaved ?? 0,
      inferred, unrecognizedLabel: priced ? '' : unknownLabel(turn.modelInfo),
    };
  });
}

/** 汇总已计价调用列表的总用量、分模型明细与等价 API 费用。 */
export function aggregatePriced(entries) {
  let input = 0, cached = 0, output = 0, cacheSaved = 0, total = 0;
  let inputTokens = 0, cachedTokens = 0, outputTokens = 0;
  let pricedCalls = 0, inferredCalls = 0, lastCost = null, lastModel = null;
  const byModel = new Map();
  const unrecognized = new Set();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    inputTokens += e.input;
    cachedTokens += e.cached;
    outputTokens += e.output;
    if (!e.modelId || !e.rates) {
      if (e.unrecognizedLabel) unrecognized.add(e.unrecognizedLabel);
      continue;
    }
    pricedCalls++;
    if (e.inferred) inferredCalls++;
    input += e.inputCost;
    cached += e.cacheCost;
    output += e.outputCost;
    cacheSaved += e.cacheSaved;
    total += e.totalCost;
    if (i === entries.length - 1) lastCost = e.totalCost;
    lastModel = e.rates;
    const item = byModel.get(e.modelId) ?? {
      id: e.modelId, name: e.rates.name, calls: 0, total: 0,
      inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0,
      inputCost: 0, cacheCost: 0, outputCost: 0, cacheSaved: 0, rates: e.rates,
    };
    item.calls++;
    item.total += e.totalCost;
    item.inputTokens += e.input;
    item.cachedTokens += e.cached;
    item.outputTokens += e.output;
    item.totalTokens += e.input + e.cached + e.output;
    item.inputCost += e.inputCost;
    item.cacheCost += e.cacheCost;
    item.outputCost += e.outputCost;
    item.cacheSaved += e.cacheSaved;
    item.rates = e.rates;
    byModel.set(e.modelId, item);
  }

  const totalCalls = entries.length;
  const unpricedCalls = totalCalls - pricedCalls;
  const mode = pricedCalls === 0 ? 'unavailable' : unpricedCalls > 0 ? 'partial' : 'exact';
  const models = [...byModel.values()].sort((a, b) => b.total - a.total);
  return {
    mode,
    total: pricedCalls ? total : null,
    last: lastCost,
    input: pricedCalls ? input : null,
    cached: pricedCalls ? cached : null,
    output: pricedCalls ? output : null,
    cacheSaved: pricedCalls ? cacheSaved : null,
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    pricedCalls,
    totalCalls,
    inferredCalls,
    unpricedCalls,
    lastModel,
    models,
    unrecognizedModels: [...unrecognized],
  };
}

/** 汇总整场会话的等价 API 价格、单模型明细与覆盖情况。 */
export function summarizeCosts(turns, options = {}) {
  return aggregatePriced(priceTurns(turns, options));
}

const CLAUDE_POOL = new Set([
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6',
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  'claude-opus-4', 'claude-sonnet-4', 'gpt-oss-120b',
]);

/** 最新 Antigravity 统一双池：全部 Gemini 共享一池，Claude / GPT 独立一池（Pro 与 Ultra 一致）。 */
export const QUOTA_POOLS = Object.freeze([
  { id: 'gemini', name: 'Gemini', hint: 'Neon · Carbon · Hydrogen · Argon' },
  { id: 'claude', name: 'Claude / GPT', hint: 'Claude · GPT-OSS' },
]);

/** 返回规范模型所属的额度池 ID；未识别模型返回 null。 */
export function modelPool(modelId) {
  if (!modelId || !(modelId in MODEL_CATALOG)) return null;
  return CLAUDE_POOL.has(modelId) ? 'claude' : 'gemini';
}
