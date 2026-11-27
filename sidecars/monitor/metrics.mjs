/** Read-only Antigravity JSONL telemetry. No network calls or application bundle access. */
import { openSync, closeSync, readSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSummaries } from './summaries.mjs';
import { readRecentCalls } from './calls.mjs';
import { aggregatePriced, priceTurns } from './pricing.mjs';
import { analyzeSpeed, buildContextSnapshot, buildModelViews, cacheHitRate, getWhen, isUserStep } from './models.mjs';

const ROOT_SUFFIXES = ['antigravity', 'antigravity2', 'antigravity-ide', 'antigravity-cli'];
const MAX_SESSIONS = 60;
const READ_TAIL = 8 * 1024 * 1024;
const MAX_LINES = 8000;
/** 预设上限档位：没有可靠来源时由用户选择，实际用量超出时按它自动升档。 */
export const LIMIT_TIERS = [256_000, 512_000, 1_000_000];
const ALIGN_SLACK = 4;

export function appRoots(home = homedir()) {
  return ROOT_SUFFIXES.map(name => ({ name, dir: join(home, '.gemini', name) }));
}

function safeStat(file) { try { return statSync(file); } catch { return null; } }

function readAnnotationTitle(file) {
  try {
    const txt = readFileSync(file, 'utf8').slice(0, 20_000);
    const matched = txt.match(/(?:^|\n)title\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!matched) return '';
    return matched[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').slice(0, 72).trim();
  } catch { return ''; }
}

function locateTranscript(rootDir, uuid) {
  const logs = join(rootDir, 'brain', uuid, '.system_generated', 'logs');
  const compact = join(logs, 'transcript.jsonl');
  const full = join(logs, 'transcript_full.jsonl');
  const compactStat = safeStat(compact), fullStat = safeStat(full);
  const file = compactStat?.size ? compact : (fullStat?.size ? full : null);
  if (!file) return null;
  const st = file === compact ? compactStat : fullStat;
  return {
    file,
    size: st.size,
    modified: Math.max(compactStat?.mtimeMs || 0, fullStat?.mtimeMs || 0),
  };
}

/** Discover local sessions; excludes subagents by default unless `includeSubagents` is true. */
export function discoverSessions(home = homedir(), { includeSubagents = false } = {}) {
  const found = [];
  for (const root of appRoots(home)) {
    const brain = join(root.dir, 'brain');
    if (!existsSync(brain)) continue;
    const summaries = readSummaries(root.dir);
    let entries;
    try { entries = readdirSync(brain, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9-]{12,100}$/i.test(entry.name)) continue;
      const summary = summaries.get(entry.name);
      const isSubagent = Boolean(summary?.parent);
      if (isSubagent && !includeSubagents) continue;
      const log = locateTranscript(root.dir, entry.name);
      if (!log) continue;
      const id = `${root.name}:${entry.name}`;
      found.push({
        id, source: root.name, rootDir: root.dir, uuid: entry.name,
        file: log.file, size: log.size, modified: log.modified,
        title: summary?.title || readAnnotationTitle(join(root.dir, 'annotations', `${entry.name}.pbtxt`)),
        workspace: summary?.workspace || '',
        isSubagent,
      });
    }
  }
  return found.sort((a, b) => b.modified - a.modified);
}

export function listSessions(home = homedir(), limit = MAX_SESSIONS) {
  return discoverSessions(home).slice(0, Math.max(1, Math.min(200, Number(limit) || MAX_SESSIONS)));
}

/** Safely read the tail of a (possibly very large) transcript without logging its contents. */
export function readJsonlTail(path, bytes = READ_TAIL) {
  const st = safeStat(path);
  if (!st?.isFile() || st.size === 0) return [];
  const len = Math.min(st.size, bytes);
  const offset = st.size - len;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, 'r');
  let received = 0;
  try {
    while (received < len) {
      const got = readSync(fd, buf, received, len - received, offset + received);
      if (!got) break;
      received += got;
    }
  } finally { closeSync(fd); }
  const raw = buf.subarray(0, received).toString('utf8');
  const partial = offset > 0;
  const start = partial ? raw.indexOf('\n') + 1 : 0;
  const tail = partial && start > 0 ? raw.slice(start) : (partial ? '' : raw);
  const lines = tail.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
  const out = [];
  for (const line of lines) {
    try { const item = JSON.parse(line); if (item && typeof item === 'object') out.push(item); }
    catch { /* The last line may still be in flight. */ }
  }
  return out;
}

export function numberOrNull(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  }
  return null;
}

export function durationSeconds(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string') {
      const m = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
      if (m) return Number(m[1]) / (m[2]?.toLowerCase() === 'ms' ? 1000 : 1);
    }
  }
  return null;
}

function collectTiming(step) {
  const parts = [step, step?.metadata, step?.chatModel, step?.metadata?.chatModel, step?.generatorMetadata?.chatModel];
  let stream = null, ttft = null;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    stream ??= durationSeconds(p.streamingDuration, p.streaming_duration, p.streamDuration);
    ttft ??= durationSeconds(p.timeToFirstToken, p.time_to_first_token, p.ttft);
  }
  return { stream, ttft };
}

function getUsage(step) {
  const nested = step?.chatModel?.usage || step?.metadata?.chatModel?.usage || step?.usage || {};
  const input = numberOrNull(step.input_tokens, nested.inputTokens, nested.input_tokens);
  const cached = numberOrNull(step.cache_read_tokens, nested.cacheReadTokens, nested.cache_read_tokens);
  const cacheWrite = numberOrNull(step.cache_write_tokens, nested.cacheWriteTokens, nested.cache_write_tokens);
  const output = numberOrNull(step.output_tokens, nested.outputTokens, nested.output_tokens);
  const thinking = numberOrNull(step.thinking_output_tokens, nested.thinkingOutputTokens, nested.thinking_output_tokens);
  const response = numberOrNull(step.response_output_tokens, nested.responseOutputTokens, nested.response_output_tokens);
  return { input, cached, cacheWrite, output, thinking, response };
}
function getStepModel(step) {
  const cm = step?.chatModel || step?.metadata?.chatModel || step?.generatorMetadata?.chatModel;
  const raw = step.model ?? cm?.model ?? step?.metadata?.model;
  const model = typeof raw === 'number' ? raw : null;
  const responseModel = (typeof raw === 'string' ? raw : '')
    || cm?.responseModel || cm?.response_model || step.response_model || step.responseModel || '';
  const responseModelFull = cm?.responseModelFull || cm?.response_model_full || '';
  const modelDisplayName = cm?.modelDisplayName || cm?.model_display_name || step.model_display_name || '';
  if (!model && !responseModel && !responseModelFull && !modelDisplayName) return null;
  return { model, responseModel, responseModelFull, modelDisplayName };
}
function contextCeiling(step) {
  const objects = [step?.metadata?.chatModel?.chatStartMetadata?.contextWindowMetadata,
    step?.chatModel?.chatStartMetadata?.contextWindowMetadata,
    step?.context_window_metadata, step];
  for (const p of objects) {
    const n = numberOrNull(p?.maxContextTokens, p?.max_context_tokens);
    if (n > 0) return n;
  }
  return null;
}

const sameCall = (turn, call) => (turn.input ?? 0) === (call.input ?? 0)
  && (turn.output ?? 0) === (call.output ?? 0) && (turn.cached ?? 0) === (call.cached ?? 0);

function applyCall(turn, call) {
  turn.timing = { stream: call.stream, ttft: call.ttft };
  turn.maxContext = call.maxContextTokens;
  if (call.cacheWrite != null) turn.cacheWrite ??= call.cacheWrite;
  if (call.model || call.responseModel || call.responseModelFull || call.modelDisplayName) {
    turn.modelInfo = {
      model: call.model,
      responseModel: call.responseModel,
      responseModelFull: call.responseModelFull,
      modelDisplayName: call.modelDisplayName,
    };
  }
}

/**
 * Copies measured timing, model info, and the real context limit from the host's call records
 * onto matching log turns. Skips empty aborted calls and resyncs across isolated mismatches
 * up to ALIGN_SLACK steps so mid-session compaction gaps do not orphan earlier calls.
 */
function attachCalls(turns, calls) {
  const usable = calls.filter(c => c.input != null || c.cached != null || c.output != null);
  let t = turns.length - 1, c = usable.length - 1;
  while (t >= 0 && c >= 0) {
    if (sameCall(turns[t], usable[c])) {
      applyCall(turns[t], usable[c]);
      t--; c--;
      continue;
    }
    let resynced = false;
    for (let dist = 1; dist <= ALIGN_SLACK && !resynced; dist++) {
      for (let dt = 0; dt <= dist; dt++) {
        const dc = dist - dt;
        if (t - dt >= 0 && c - dc >= 0 && sameCall(turns[t - dt], usable[c - dc])) {
          t -= dt; c -= dc;
          resynced = true;
          break;
        }
      }
    }
    if (!resynced) { t--; c--; }
  }
}

/** 提取日志中的模型调用记录，并把调用库里的耗时、模型信息与上限配对到对应步上。 */
export function extractTurns(steps, calls = []) {
  let last = null, lastIdx = -1, limit = null;
  let sessionInput = 0, sessionCached = 0, sessionOutput = 0;
  let userTurns = 0, peak = 0;
  const turns = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isUserStep(s)) userTurns++;
    const c = contextCeiling(s);
    if (c) limit = c;
    const u = getUsage(s);
    if (u.input === null && u.cached === null && u.output === null) continue;
    if (u.input !== null || u.cached !== null) {
      last = { step: s, ...u }; lastIdx = i;
      peak = Math.max(peak, (u.input || 0) + (u.cached || 0));
    }
    sessionInput += u.input || 0;
    sessionCached += u.cached || 0;
    sessionOutput += u.output || 0;
    turns.push({
      stepIndex: s.step_index ?? i, when: getWhen(s), ...u,
      timing: collectTiming(s), modelInfo: getStepModel(s), index: i,
    });
  }
  if (!last && turns.length) {
    const item = turns[turns.length - 1];
    last = { step: steps[item.index], ...item }; lastIdx = item.index;
  }
  attachCalls(turns, calls);
  limit = turns.findLast(t => t.maxContext)?.maxContext || limit;
  return { turns, last, lastIdx, limit, sessionInput, sessionCached, sessionOutput, userTurns, peak };
}

const subCache = new Map();

function dbStamp(rootDir, uuid) {
  const dbPath = join(rootDir, 'conversations', `${uuid}.db`);
  const a = safeStat(dbPath), b = safeStat(`${dbPath}-wal`);
  return `${a?.mtimeMs || 0}:${a?.size || 0}|${b?.mtimeMs || 0}:${b?.size || 0}`;
}

function collectSubagents(rootDir, rootUuid) {
  const summaries = readSummaries(rootDir);
  if (!summaries.size) return [];
  const children = new Map();
  for (const [uuid, s] of summaries) {
    if (!s.parent) continue;
    if (!children.has(s.parent)) children.set(s.parent, []);
    children.get(s.parent).push(uuid);
  }
  const found = [];
  const queue = [...(children.get(rootUuid) || [])];
  const seen = new Set([rootUuid]);
  while (queue.length) {
    const uuid = queue.shift();
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const log = locateTranscript(rootDir, uuid);
    if (log) found.push({ uuid, log });
    for (const next of children.get(uuid) || []) queue.push(next);
  }
  return found;
}

function readSubagentUsage(rootDir, { uuid, log }, now) {
  const stamp = `${log.file}:${log.size}:${log.modified}:${dbStamp(rootDir, uuid)}`;
  const hit = subCache.get(`${rootDir}:${uuid}`);
  if (hit?.stamp === stamp) return hit.data;
  const { turns, sessionInput, sessionCached, sessionOutput } =
    extractTurns(readJsonlTail(log.file), readRecentCalls(rootDir, uuid));
  const priced = priceTurns(turns, { fallbackWhen: log.modified, now });
  const data = { input: sessionInput, cached: sessionCached, output: sessionOutput, calls: turns.length, priced };
  subCache.set(`${rootDir}:${uuid}`, { stamp, data });
  return data;
}

function analyzeStepsWithPriced(steps, options = {}) {
  const fallbackLimit = numberOrNull(options.defaultContextLimit) || 256_000;
  const { turns, lastIdx, limit, sessionInput, sessionCached, sessionOutput, userTurns } =
    extractTurns(steps, options.calls || []);
  const recorded = turns.length;
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const priced = priceTurns(turns, { fallbackWhen: options.endedAt, now: options.now });
  for (let i = 0; i < turns.length; i++) {
    turns[i].modelId = priced[i]?.modelId ?? null;
    turns[i].modelName = priced[i]?.rates?.name || priced[i]?.unrecognizedLabel || '';
  }
  const cost = aggregatePriced(priced);
  cost.primaryModels = cost.models;
  cost.primaryCalls = recorded;
  cost.subagentTotal = 0;
  return {
    priced,
    snapshot: {
      context: buildContextSnapshot(turns, { limit, fallbackLimit, limitTiers: LIMIT_TIERS }),
      performance: {
        ...analyzeSpeed(steps, turns, options.endedAt),
        lastOutputTokens: lastTurn?.output ?? null,
        lastThinkingTokens: lastTurn?.thinking ?? null,
        lastResponseTokens: lastTurn?.response ?? null,
      },
      totals: {
        input: sessionInput, cached: sessionCached, output: sessionOutput, modelCalls: recorded, userTurns,
        cacheHitRate: cacheHitRate(sessionInput, sessionCached),
        subagents: {
          count: 0, modelCalls: 0, input: 0, cached: 0, output: 0, totalTokens: 0,
          cost: null, costMode: 'unavailable', models: [], unpricedCalls: 0, unrecognizedModels: [],
        },
      },
      cost,
      models: buildModelViews(steps, turns, priced, {
        fallbackLimit, limitTiers: LIMIT_TIERS, sessionLimit: limit, endedAt: options.endedAt,
      }),
      recent: turns.slice(-12).reverse().map(t => ({
        when: t.when, output: t.output, input: t.input, cache: t.cached,
        tps: t.timing.stream ? Math.round(10 * (t.output || 0) / t.timing.stream) / 10 : null,
      })),
      lastStepIndex: lastIdx,
    },
  };
}

export function analyzeSteps(steps, options = {}) {
  return analyzeStepsWithPriced(steps, options).snapshot;
}

export function analyzeSession(session, options = {}) {
  const parsed = readJsonlTail(session.file);
  const { snapshot, priced: mainPriced } = analyzeStepsWithPriced(parsed, {
    ...options, endedAt: session.modified, calls: readRecentCalls(session.rootDir, session.uuid),
  });
  const subagents = collectSubagents(session.rootDir, session.uuid);
  if (subagents.length) {
    let subInput = 0, subCached = 0, subOutput = 0, subCalls = 0;
    const allSubPriced = [];
    for (const sub of subagents) {
      const s = readSubagentUsage(session.rootDir, sub, options.now);
      subInput += s.input; subCached += s.cached; subOutput += s.output; subCalls += s.calls;
      allSubPriced.push(...s.priced);
    }
    const primaryCost = snapshot.cost;
    const combined = aggregatePriced([...mainPriced, ...allSubPriced]);
    const subCost = aggregatePriced(allSubPriced);
    const t = snapshot.totals;
    t.input += subInput; t.cached += subCached; t.output += subOutput; t.modelCalls += subCalls;
    t.cacheHitRate = cacheHitRate(t.input, t.cached);
    t.subagents = {
      count: subagents.length, modelCalls: subCalls,
      input: subInput, cached: subCached, output: subOutput,
      totalTokens: subInput + subCached + subOutput,
      cost: subCost.total,
      costMode: subCost.mode,
      models: subCost.models,
      unpricedCalls: subCost.unpricedCalls,
      unrecognizedModels: subCost.unrecognizedModels,
    };
    combined.last = primaryCost.last;
    combined.lastModel = primaryCost.lastModel || combined.lastModel;
    combined.primaryModels = primaryCost.models;
    combined.primaryCalls = mainPriced.length;
    combined.subagentTotal = subCost.total ?? 0;
    snapshot.cost = combined;
  }
  return {
    session: {
      id: session.id, title: session.title || '', workspace: session.workspace, source: session.source,
      modified: session.modified, size: session.size, uuidShort: session.uuid.slice(0, 8),
      tailTruncated: session.size > READ_TAIL,
    },
    ...snapshot,
  };
}

/**
 * Safe entrypoint: both IDs are only ever matched against discovered sessions.
 * Priority: manually selected `id` → the host's open `conversationId` → most recently active.
 */
export function getSnapshot({ home = homedir(), id = '', conversationId = '', defaultContextLimit = 256_000 } = {}) {
  const all = discoverSessions(home);
  if (!all.length) return { status: 'empty', sessions: [], snapshot: null, message: '未找到 Antigravity 本地会话日志' };
  const opened = all.find(s => s.uuid === conversationId);
  const current = all.find(s => s.id === id) || opened || all[0];
  const sessions = all.slice(0, MAX_SESSIONS).map(s => ({
    id: s.id, source: s.source, modified: s.modified,
    title: s.title || '', workspace: s.workspace, uuidShort: s.uuid.slice(0, 8),
  }));
  return {
    status: 'ok', sessions, auto: opened ? 'conversation' : 'recent',
    snapshot: analyzeSession(current, { defaultContextLimit }),
  };
}
