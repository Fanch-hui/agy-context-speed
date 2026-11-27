/**
 * Per-model and Orchestrator (planner / executor) telemetry views.
 * Pure helpers shared by metrics.mjs for both overall session snapshots and per-model breakdowns.
 */
import { aggregatePriced } from './pricing.mjs';

const SPEED_SAMPLE = 20;
const MIN_ESTIMATE_SECONDS = 2;
const MAX_ESTIMATE_SECONDS = 600;

export const isUserStep = (step) => step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT';
const ratio = (part, whole) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : null);
const round1 = (n) => Math.round(n * 10) / 10;

/** `input_tokens` excludes cached tokens, so the prompt total is input + cache read. */
export const cacheHitRate = (input, cached) => ratio(cached || 0, (input || 0) + (cached || 0));

export function getWhen(step) {
  const raw = step.created_at ?? step.createdAt ?? step.metadata?.createdAt;
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How long one model call took. Logs only carry each step's start time at 1 s resolution, so
 * without a streaming duration the end is taken from whatever follows: the next step of the
 * same turn, or the file's last write for the final step.
 */
export function callSeconds(steps, turn, endedAt) {
  if (turn.timing.stream) return turn.timing.stream;
  const next = steps[turn.index + 1];
  const end = next ? (isUserStep(next) ? null : getWhen(next)) : endedAt;
  if (!end || !turn.when) return null;
  const seconds = (end - turn.when) / 1000;
  return seconds >= MIN_ESTIMATE_SECONDS && seconds <= MAX_ESTIMATE_SECONDS ? seconds : null;
}

/**
 * Speed over the recent calls. With measured streaming durations it is total output over
 * total streaming time; with only estimated durations it is the median.
 */
export function analyzeSpeed(steps, turns, endedAt) {
  const calls = turns.filter(t => t.output > 0)
    .map(t => ({ turn: t, seconds: callSeconds(steps, t, endedAt) }));
  const timed = calls.filter(c => c.seconds);
  const streamed = timed.filter(c => c.turn.timing.stream).slice(-SPEED_SAMPLE);
  const sample = streamed.length ? streamed : timed.slice(-SPEED_SAMPLE);
  const sum = (pick) => sample.reduce((total, c) => total + pick(c), 0);
  const tps = streamed.length ? sum(c => c.turn.output) / sum(c => c.seconds)
    : sample.length ? median(sample.map(c => c.turn.output / c.seconds)) : null;
  const firstTokens = turns.map(t => t.timing.ttft).filter(v => v != null).slice(-SPEED_SAMPLE);
  const last = calls.at(-1);
  const history = sample.map(c => ({
    tps: round1(c.turn.output / c.seconds),
    outputTokens: c.turn.output,
    ttftSeconds: c.turn.timing.ttft ?? null,
    streamSeconds: Math.round(c.seconds * 100) / 100,
    whenMs: c.turn.when ?? null,
    modelId: c.turn.modelId ?? null,
    modelName: c.turn.modelName ?? '',
  }));
  return {
    tps: tps === null ? null : round1(tps),
    mode: streamed.length ? 'streaming' : sample.length ? 'effective' : 'unavailable',
    sampleCount: sample.length,
    lastTps: last?.seconds ? round1(last.turn.output / last.seconds) : null,
    durationSeconds: last?.seconds ?? null,
    ttftSeconds: last?.turn.timing.ttft ?? null,
    ttftMedianSeconds: firstTokens.length ? median(firstTokens) : null,
    history,
  };
}

/** Compute context window metrics from a sequence of turns. */
export function buildContextSnapshot(turns, { limit = null, fallbackLimit = 256_000, limitTiers = [256_000, 512_000, 1_000_000] } = {}) {
  const last = turns.findLast(t => t.input !== null || t.cached !== null) || turns[turns.length - 1] || null;
  let peak = 0;
  for (const t of turns) {
    if (t.input !== null || t.cached !== null) {
      peak = Math.max(peak, (t.input || 0) + (t.cached || 0));
    }
  }
  const used = last ? (last.input || 0) + (last.cached || 0) : null;
  // 只有预设值才会被推翻：用量超过它说明真实上限更高，升到能容纳峰值的最近一档。
  const raised = !limit && peak > fallbackLimit ? (limitTiers.find(tier => tier >= peak) ?? peak) : null;
  const effectiveLimit = limit || raised || fallbackLimit;
  return {
    used,
    ceiling: effectiveLimit,
    ceilingSource: limit ? 'session' : raised ? 'observed' : 'configured',
    percent: used === null ? null : Math.round((10000 * used) / effectiveLimit) / 100,
    input: last?.input ?? null,
    cache: last?.cached ?? null,
    cacheHitRate: last ? cacheHitRate(last.input, last.cached) : null,
    updatedAt: last ? last.when : null,
  };
}

function stepToolNames(step) {
  const calls = step?.tool_calls || step?.toolCalls || [];
  if (!Array.isArray(calls)) return [];
  return calls.map(c => c?.name || c?.tool_name || c?.type || '').filter(Boolean);
}

/** Detect Orchestrator planner / executor roles from plan-mode handoff tools and route metadata. */
export function detectModelRoles(steps, turns, turnModels) {
  const roles = new Map();
  for (let i = 0; i < turns.length; i++) {
    const id = turnModels[i]?.id;
    if (!id) continue;
    const tools = stepToolNames(steps[turns[i].index]);
    if (tools.includes('exit_plan_mode')) {
      roles.set(id, 'planner');
      const nextId = turnModels[i + 1]?.id;
      if (nextId && nextId !== id) roles.set(nextId, 'executor');
    }
    if (tools.includes('enter_plan_mode')) {
      roles.set(id, 'executor');
      const nextId = turnModels[i + 1]?.id;
      if (nextId && nextId !== id) roles.set(nextId, 'planner');
    }
  }
  for (let i = 0; i < turns.length; i++) {
    const id = turnModels[i]?.id;
    if (!id || roles.has(id)) continue;
    const info = turns[i].modelInfo;
    if (/orchestrator\s*\(/i.test(info?.modelDisplayName || '')) {
      roles.set(id, 'planner');
    } else if ((info?.responseModel || '').toLowerCase() === 'gemini-flash-worker-agy') {
      roles.set(id, 'executor');
    }
  }
  return roles;
}

const roleRank = (role) => (role === 'planner' ? 0 : role === 'executor' ? 1 : 2);

/** Build per-model telemetry views ordered as planner → executor → other models. */
export function buildModelViews(steps, turns, priced, {
  fallbackLimit = 256_000,
  limitTiers = [256_000, 512_000, 1_000_000],
  sessionLimit = null,
  endedAt = null,
} = {}) {
  const turnModels = turns.map((_, i) => {
    const p = priced[i];
    if (p?.modelId) return { id: p.modelId, name: p.rates?.name || p.modelId };
    if (p?.unrecognizedLabel) return { id: `raw:${p.unrecognizedLabel}`, name: p.unrecognizedLabel };
    return null;
  });

  const groups = new Map();
  let activeModelId = null;
  for (let i = 0; i < turns.length; i++) {
    const tm = turnModels[i];
    if (!tm) continue;
    activeModelId = tm.id;
    let g = groups.get(tm.id);
    if (!g) {
      g = { id: tm.id, name: tm.name, turns: [], priced: [], input: 0, cached: 0, output: 0 };
      groups.set(tm.id, g);
    }
    const t = turns[i];
    g.turns.push(t);
    g.priced.push(priced[i]);
    g.input += t.input || 0;
    g.cached += t.cached || 0;
    g.output += t.output || 0;
  }

  const roles = detectModelRoles(steps, turns, turnModels);
  const views = [];
  for (const g of groups.values()) {
    const lastTurn = g.turns[g.turns.length - 1];
    const modelLimit = g.turns.findLast(t => t.maxContext)?.maxContext || sessionLimit;
    views.push({
      id: g.id,
      name: g.name,
      role: roles.get(g.id) || null,
      isActive: g.id === activeModelId,
      calls: g.turns.length,
      context: buildContextSnapshot(g.turns, { limit: modelLimit, fallbackLimit, limitTiers }),
      performance: {
        ...analyzeSpeed(steps, g.turns, endedAt),
        lastOutputTokens: lastTurn?.output ?? null,
        lastThinkingTokens: lastTurn?.thinking ?? null,
        lastResponseTokens: lastTurn?.response ?? null,
      },
      totals: {
        input: g.input,
        cached: g.cached,
        output: g.output,
        modelCalls: g.turns.length,
        cacheHitRate: cacheHitRate(g.input, g.cached),
      },
      cost: aggregatePriced(g.priced),
    });
  }
  return views.sort((a, b) => roleRank(a.role) - roleRank(b.role));
}
