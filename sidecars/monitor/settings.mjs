/**
 * 用户持久化设置（预设上下文上限 + 订阅方案/双周期额度池/月统计起算配置）。
 * 面板页面每次启动端口都会变，localStorage 无法跨重启保留，所以由后端持久化。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LIMIT_TIERS } from './metrics.mjs';

const FILE = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context-speed', 'settings.json');
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const PLANS = Object.freeze(['pro', 'ultra', 'free']);
const POOL_IDS = ['gemini', 'claude'];
const DEFAULT_SHORT_POOL = Object.freeze({ mode: 'triggered', anchorMs: null, cycleHours: 5 });
const DEFAULT_WEEK_POOL = Object.freeze({ mode: 'triggered', anchorMs: null, cycleHours: 168 });

export const DEFAULT_WINDOWS = Object.freeze({
  plan: 'pro',
  fiveHour: Object.freeze({
    gemini: { ...DEFAULT_SHORT_POOL },
    claude: { ...DEFAULT_SHORT_POOL },
  }),
  week: Object.freeze({
    gemini: { ...DEFAULT_WEEK_POOL },
    claude: { ...DEFAULT_WEEK_POOL },
  }),
  monthStartDay: 1,
  monthStartTime: '00:00',
});

const cache = new Map();

function sanitizeTime(value, fallback) {
  return typeof value === 'string' && HHMM_RE.test(value.trim()) ? value.trim() : fallback;
}

function sanitizeInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function sanitizePool(raw, base) {
  if (!raw || typeof raw !== 'object') return { ...base };
  const mode = raw.mode === 'after_reset' || raw.mode === 'triggered' ? raw.mode : base.mode;
  let anchorMs = base.anchorMs;
  if (raw.anchorMs === null || raw.anchorMs === '') {
    anchorMs = null;
  } else if (raw.anchorMs !== undefined) {
    const n = Number(raw.anchorMs);
    if (Number.isFinite(n) && n > 0) anchorMs = Math.round(n);
  }
  let cycleHours = base.cycleHours;
  if (raw.cycleHours !== undefined) {
    const c = Number(raw.cycleHours);
    if (Number.isFinite(c) && c >= 0 && c <= 720) cycleHours = c;
  }
  return { mode, anchorMs, cycleHours };
}

function clonePoolMap(map, fallbackPool) {
  const out = {};
  for (const id of POOL_IDS) out[id] = { ...(map?.[id] || fallbackPool) };
  return out;
}

function cloneWindows(w) {
  return {
    plan: w.plan,
    fiveHour: clonePoolMap(w.fiveHour, DEFAULT_SHORT_POOL),
    week: clonePoolMap(w.week, DEFAULT_WEEK_POOL),
    monthStartDay: w.monthStartDay,
    monthStartTime: w.monthStartTime,
  };
}

const isLegacyConfigured = (p) => Boolean(p && typeof p === 'object' && (p.anchorMs != null || p.mode === 'after_reset'));

/** 将旧版 3 池 / 单周期 settings.json 无缝迁移到新版双池双周期结构。 */
function migrateLegacyPools(rawPools, fiveHour, week) {
  const legacyGemini = [rawPools.gemini, rawPools.gemini_flash, rawPools.gemini_pro].find(isLegacyConfigured)
    ?? rawPools.gemini ?? rawPools.gemini_flash ?? rawPools.gemini_pro;
  const picks = { gemini: legacyGemini, claude: rawPools.claude };
  for (const id of POOL_IDS) {
    const src = picks[id];
    if (!src || typeof src !== 'object') continue;
    const ch = Number(src.cycleHours);
    if (Number.isFinite(ch) && ch > 0 && ch <= 24) {
      fiveHour[id] = sanitizePool(src, fiveHour[id]);
    } else {
      week[id] = sanitizePool(src, week[id]);
    }
  }
}

export function sanitizeWindows(raw, base = DEFAULT_WINDOWS) {
  const baseFiveHour = clonePoolMap(base.fiveHour, DEFAULT_SHORT_POOL);
  const baseWeek = clonePoolMap(base.week, DEFAULT_WEEK_POOL);
  if (!raw || typeof raw !== 'object') {
    return {
      plan: PLANS.includes(base.plan) ? base.plan : DEFAULT_WINDOWS.plan,
      fiveHour: baseFiveHour,
      week: baseWeek,
      monthStartDay: base.monthStartDay ?? DEFAULT_WINDOWS.monthStartDay,
      monthStartTime: base.monthStartTime ?? DEFAULT_WINDOWS.monthStartTime,
    };
  }

  let plan = PLANS.includes(base.plan) ? base.plan : DEFAULT_WINDOWS.plan;
  if (PLANS.includes(raw.plan)) plan = raw.plan;
  else if (raw.poolMode === 'merged_gemini' && !raw.fiveHour && !raw.week) plan = 'ultra';

  const fiveHour = {};
  const week = {};
  for (const id of POOL_IDS) {
    fiveHour[id] = sanitizePool(raw.fiveHour?.[id], baseFiveHour[id]);
    week[id] = sanitizePool(raw.week?.[id], baseWeek[id]);
  }
  if (!raw.fiveHour && !raw.week && raw.pools && typeof raw.pools === 'object') {
    migrateLegacyPools(raw.pools, fiveHour, week);
  }

  return {
    plan,
    fiveHour,
    week,
    monthStartDay: raw.monthStartDay !== undefined
      ? sanitizeInt(raw.monthStartDay, 1, 31, base.monthStartDay) : base.monthStartDay,
    monthStartTime: raw.monthStartTime !== undefined
      ? sanitizeTime(raw.monthStartTime, base.monthStartTime) : base.monthStartTime,
  };
}

function loadState(file = FILE) {
  const hit = cache.get(file);
  if (hit) return hit;
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('读取设置失败，使用默认值：', err.message);
  }
  const state = {
    contextLimit: LIMIT_TIERS.includes(parsed.contextLimit) ? parsed.contextLimit : LIMIT_TIERS[0],
    windows: sanitizeWindows(parsed.windows, DEFAULT_WINDOWS),
  };
  cache.set(file, state);
  return state;
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  cache.set(file, state);
  return state;
}

export function contextLimit(file = FILE) {
  return loadState(file).contextLimit;
}

/** 切到下一档并保存；写入失败时抛出，由接口层报告给界面。 */
export function cycleContextLimit(file = FILE) {
  const cur = loadState(file);
  const nextLimit = LIMIT_TIERS[(LIMIT_TIERS.indexOf(cur.contextLimit) + 1) % LIMIT_TIERS.length];
  saveState(file, { ...cur, contextLimit: nextLimit });
  return { contextLimit: nextLimit };
}

export function windowSettings(file = FILE) {
  return cloneWindows(loadState(file).windows);
}

export function updateWindowSettings(patch, file = FILE) {
  const cur = loadState(file);
  const nextWindows = sanitizeWindows(patch, cur.windows);
  saveState(file, { ...cur, windows: nextWindows });
  return { windows: cloneWindows(nextWindows) };
}
