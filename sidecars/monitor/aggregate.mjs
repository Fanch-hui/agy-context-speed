/**
 * 跨会话、双额度池（Gemini / Claude·GPT）与双周期（5 小时短周期 + 7 天周限额 + 本月）用量及等价 API 费用汇总。
 * 每个额度池周期均支持「首次调用才开始计时、不用不开始」的滚动机制及额外发放重置。
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRecentCalls } from './calls.mjs';
import { discoverSessions, extractTurns, readJsonlTail } from './metrics.mjs';
import { QUOTA_POOLS, aggregatePriced, modelPool, priceTurns } from './pricing.mjs';
import { DEFAULT_WINDOWS, sanitizeWindows } from './settings.mjs';

const DAY_MS = 86_400_000;
const sessionCache = new Map();

function safeMtime(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

function parseHHMM(raw) {
  if (typeof raw !== 'string') return [0, 0];
  const m = raw.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function monthAnchor(year, month, day, hh, mm) {
  return new Date(year, month, Math.min(day, daysInMonth(year, month)), hh, mm, 0, 0).getTime();
}

/** 计算「本月」的起止边界。 */
export function resolveMonthWindow(cfg = DEFAULT_WINDOWS, nowMs = Date.now()) {
  const nowDate = new Date(nowMs);
  const [mHour, mMin] = parseHHMM(cfg.monthStartTime);
  const mDay = Number.isInteger(cfg.monthStartDay) ? cfg.monthStartDay : 1;
  let mYear = nowDate.getFullYear();
  let mMonth = nowDate.getMonth();
  let monthStart = monthAnchor(mYear, mMonth, mDay, mHour, mMin);
  if (monthStart > nowMs) {
    mMonth -= 1;
    if (mMonth < 0) { mMonth = 11; mYear -= 1; }
    monthStart = monthAnchor(mYear, mMonth, mDay, mHour, mMin);
  }
  const nextMonth = mMonth === 11 ? 0 : mMonth + 1;
  const nextYear = mMonth === 11 ? mYear + 1 : mYear;
  const monthNext = monthAnchor(nextYear, nextMonth, mDay, mHour, mMin);

  return { startMs: monthStart, endMs: nowMs, nextMs: monthNext };
}

/**
 * 计算单个额度池的活动窗口：
 * - 周期到期或点击「重置」后，不会按固定钟表自动切入下一轮，而是等待该池首次实际调用才开始计时；
 * - 未配置锚点时，自动按历史调用序列推算当前正在进行的周期（5 小时或 7 天）。
 */
export function resolvePoolWindow(poolCfg = {}, sortedCallTimes = [], nowMs = Date.now(), defaultCycleHours = 168) {
  const cycleHours = Number.isFinite(poolCfg.cycleHours) && poolCfg.cycleHours >= 0
    ? poolCfg.cycleHours : defaultCycleHours;
  const periodMs = cycleHours > 0 ? cycleHours * 3_600_000 : 0;
  const mode = poolCfg.mode === 'after_reset' ? 'after_reset' : 'triggered';
  const anchorMs = Number.isFinite(poolCfg.anchorMs) ? poolCfg.anchorMs : null;
  const autoDetected = mode === 'triggered' && anchorMs == null;

  let winStart = null;
  if (mode === 'after_reset') {
    const startAfter = anchorMs ?? nowMs;
    const first = sortedCallTimes.find(t => t >= startAfter);
    if (first == null) {
      return {
        status: 'waiting', mode, cycleHours, startMs: null, endMs: nowMs,
        nextMs: null, elapsedMs: 0, remainingMs: periodMs, resetAtMs: startAfter, autoDetected: false,
      };
    }
    winStart = first;
  } else if (anchorMs != null) {
    if (anchorMs > nowMs) {
      return {
        status: 'waiting', mode, cycleHours, startMs: null, endMs: nowMs,
        nextMs: anchorMs, elapsedMs: 0, remainingMs: periodMs, resetAtMs: null, autoDetected: false,
      };
    }
    winStart = anchorMs;
  } else {
    if (!sortedCallTimes.length) {
      return {
        status: 'idle', mode, cycleHours, startMs: null, endMs: nowMs,
        nextMs: null, elapsedMs: 0, remainingMs: periodMs, resetAtMs: null, autoDetected: true,
      };
    }
    winStart = sortedCallTimes[0];
  }

  if (periodMs > 0) {
    let cursor = 0;
    while (winStart + periodMs <= nowMs) {
      const expiredAt = winStart + periodMs;
      while (cursor < sortedCallTimes.length && sortedCallTimes[cursor] < expiredAt) cursor++;
      if (cursor >= sortedCallTimes.length) {
        return {
          status: 'idle', mode, cycleHours, startMs: null, endMs: nowMs,
          nextMs: null, elapsedMs: 0, remainingMs: periodMs, resetAtMs: expiredAt, autoDetected,
        };
      }
      winStart = sortedCallTimes[cursor];
    }
  }

  const nextMs = periodMs > 0 ? winStart + periodMs : null;
  return {
    status: 'active',
    mode,
    cycleHours,
    startMs: winStart,
    endMs: nowMs,
    nextMs,
    elapsedMs: Math.max(0, nowMs - winStart),
    remainingMs: nextMs != null ? Math.max(0, nextMs - nowMs) : null,
    resetAtMs: mode === 'after_reset' ? anchorMs : null,
    autoDetected,
  };
}

function getSessionPricedTurns(session) {
  const dbPath = join(session.rootDir, 'conversations', `${session.uuid}.db`);
  const stamp = `${session.file}:${session.size}:${session.modified}:${safeMtime(dbPath)}:${safeMtime(`${dbPath}-wal`)}`;
  const hit = sessionCache.get(session.id);
  if (hit?.stamp === stamp) return hit.turns;
  const steps = readJsonlTail(session.file);
  const calls = readRecentCalls(session.rootDir, session.uuid);
  const { turns } = extractTurns(steps, calls);
  const priced = priceTurns(turns, { fallbackWhen: session.modified, now: session.modified })
    .map(t => ({ ...t, sessionId: session.id }));
  sessionCache.set(session.id, { stamp, turns: priced });
  return priced;
}

function summarizeTurns(turns, extra = {}) {
  const sessions = new Set();
  for (const t of turns) {
    if (t.sessionId) sessions.add(t.sessionId);
  }
  return { ...extra, sessionCount: sessions.size, ...aggregatePriced(turns) };
}

function buildPoolWindow(poolConfigs, turnsByPool, timesByPool, defaultCycleHours, now) {
  const pools = [];
  const activeTurns = [];
  for (const def of QUOTA_POOLS) {
    const poolTurns = turnsByPool.get(def.id);
    const times = timesByPool.get(def.id);
    const cfg = poolConfigs?.[def.id] || { mode: 'triggered', anchorMs: null, cycleHours: defaultCycleHours };
    const win = resolvePoolWindow(cfg, times, now, defaultCycleHours);
    const inWindow = win.startMs != null
      ? poolTurns.filter(t => t.when >= win.startMs && t.when <= now)
      : [];
    activeTurns.push(...inWindow);
    pools.push({ id: def.id, name: def.name, hint: def.hint, ...summarizeTurns(inWindow, win) });
  }
  const activeStarts = pools.map(p => p.startMs).filter(v => v != null);
  return {
    startMs: activeStarts.length ? Math.min(...activeStarts) : null,
    endMs: now,
    pools,
    ...summarizeTurns(activeTurns),
  };
}

/** 汇总所有本地会话（含子代理）在 5 小时、本周（7 天）与本月的用量及等价 API 费用。 */
export function summarizeAllWindows({ home = homedir(), windows = DEFAULT_WINDOWS, now = Date.now() } = {}) {
  const cfg = sanitizeWindows(windows, DEFAULT_WINDOWS);
  const monthBounds = resolveMonthWindow(cfg, now);
  const anchorTimes = [
    ...Object.values(cfg.fiveHour),
    ...Object.values(cfg.week),
  ].map(p => p?.anchorMs).filter(v => Number.isFinite(v));
  const earliest = Math.min(monthBounds.startMs, ...anchorTimes, now - 35 * DAY_MS);

  const all = discoverSessions(home, { includeSubagents: true });
  const active = all.filter(s => s.modified >= earliest - DAY_MS);
  const allTurns = [];
  for (const session of active) {
    for (const turn of getSessionPricedTurns(session)) {
      if (turn.when != null && turn.when <= now) allTurns.push(turn);
    }
  }

  const turnsByPool = new Map(QUOTA_POOLS.map(def => [def.id, []]));
  const unpooledTurns = [];
  for (const turn of allTurns) {
    const pid = modelPool(turn.modelId);
    if (pid && turnsByPool.has(pid)) turnsByPool.get(pid).push(turn);
    else unpooledTurns.push(turn);
  }
  const timesByPool = new Map(QUOTA_POOLS.map(def => [
    def.id,
    turnsByPool.get(def.id).map(t => t.when).sort((a, b) => a - b),
  ]));

  const fiveHour = buildPoolWindow(cfg.fiveHour, turnsByPool, timesByPool, 5, now);
  const week = buildPoolWindow(cfg.week, turnsByPool, timesByPool, 168, now);
  const monthTurns = allTurns.filter(t => t.when >= monthBounds.startMs && t.when <= monthBounds.endMs);

  return {
    settings: cfg,
    hasFiveHour: cfg.plan !== 'free',
    fiveHour,
    week,
    month: summarizeTurns(monthTurns, monthBounds),
    unpooledCount: unpooledTurns.length,
  };
}
