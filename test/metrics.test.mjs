import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSteps, getSnapshot, readJsonlTail } from '../sidecars/monitor/metrics.mjs';
import { decodeCall } from '../sidecars/monitor/calls.mjs';
import { activeRates, modelPool, priceCall, resolveModelId, summarizeCosts } from '../sidecars/monitor/pricing.mjs';
import { resolveMonthWindow, resolvePoolWindow, summarizeAllWindows } from '../sidecars/monitor/aggregate.mjs';
import { contextLimit, cycleContextLimit, updateWindowSettings, windowSettings } from '../sidecars/monitor/settings.mjs';
import { workspaceName } from '../sidecars/monitor/summaries.mjs';
import { queryCached } from '../sidecars/monitor/sqlite.mjs';

const ts = '2026-11-15T10:00:00.000Z';
function step(timeSec, fields) { return { created_at: new Date(Date.parse(ts) + timeSec*1000).toISOString(), ...fields }; }

test('uses actual input + cache and streaming TPS when present', () => {
  const steps = [
    step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'private' }),
    step(5, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 3000,
      output_tokens: 150, chatModel: { streamingDuration: '3s', timeToFirstToken: '0.8s',
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 10000 } } } }),
  ];
  const m = analyzeSteps(steps);
  assert.equal(m.context.used, 4000);
  assert.equal(m.context.ceiling, 10000);
  assert.equal(m.context.percent, 40);
  assert.equal(m.performance.tps, 50);
  assert.equal(m.performance.mode, 'streaming');
  assert.equal(m.performance.ttftSeconds, 0.8);
  assert.equal(m.totals.userTurns, 1);
});

test('estimates a call from its start to the next step of the same turn', () => {
  const m = analyzeSteps([
    step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT' }),
    step(0, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 90, cache_read_tokens: 10, output_tokens: 100 }),
    step(10, { source: 'MODEL', type: 'GENERIC' }),
  ]);
  assert.equal(m.context.used, 100);
  assert.equal(m.performance.tps, 10);
  assert.equal(m.performance.mode, 'effective');
  assert.equal(m.performance.durationSeconds, 10);
});

test('never measures across a user message, and times the final step by the last file write', () => {
  const steps = [
    step(0, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 1, output_tokens: 500 }),
    step(300, { source: 'USER_EXPLICIT', type: 'USER_INPUT' }),
    step(300, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 1, output_tokens: 80 }),
  ];
  assert.equal(analyzeSteps(steps).performance.mode, 'unavailable');
  const timed = analyzeSteps(steps, { endedAt: Date.parse(ts) + 304_000 }).performance;
  assert.deepEqual([timed.tps, timed.lastTps, timed.sampleCount], [20, 20, 1]);
});

test('headline speed is the median of recent calls, so one approval wait does not skew it', () => {
  const call = (start, seconds, output) => [
    step(start, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 1, output_tokens: output }),
    step(start + seconds, { source: 'MODEL', type: 'GENERIC' }),
  ];
  const m = analyzeSteps([...call(0, 10, 500), ...call(20, 10, 600), ...call(40, 400, 400), ...call(500, 1, 900)]);
  assert.equal(m.performance.tps, 50);
  assert.equal(m.performance.sampleCount, 3);
  assert.equal(m.performance.lastTps, null);
});

test('reports cache hit rate for the last call and for the session', () => {
  const m = analyzeSteps([
    step(0, { source: 'MODEL', input_tokens: 21000, cache_read_tokens: 0, output_tokens: 1 }),
    step(5, { source: 'MODEL', input_tokens: 2500, cache_read_tokens: 20000, output_tokens: 1 }),
  ]);
  assert.equal(m.context.cacheHitRate, 88.9);
  assert.equal(m.totals.cacheHitRate, 46);
});

test('not enough time metadata yields blank TPS', () => {
  const m = analyzeSteps([step(0, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 3, output_tokens: 40 })]);
  assert.equal(m.performance.tps, null);
  assert.equal(m.performance.mode, 'unavailable');
});

test('supports nested token usage and numeric strings', () => {
  const m = analyzeSteps([step(0, { type: 'PLANNER_RESPONSE', usage: { inputTokens: '200', cacheReadTokens: '33', outputTokens: '10' }, metadata: { streaming_duration: '250ms' } })]);
  assert.equal(m.context.used, 233);
  assert.equal(m.performance.tps, 40);
});

test('discovers local sessions and never trusts a caller-provided file path', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-test-'));
  try {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const base = join(home, '.gemini', 'antigravity', 'brain', uuid, '.system_generated', 'logs');
    mkdirSync(base, { recursive: true });
    const row = step(0, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 1024, cache_read_tokens: 2048, output_tokens: 20 });
    writeFileSync(join(base, 'transcript.jsonl'), JSON.stringify(row) + '\n');
    const result = getSnapshot({ home, id: '../secret' });
    assert.equal(result.status, 'ok');
    assert.equal(result.sessions.length, 1);
    assert.equal(result.snapshot.context.used, 3072);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('skips incomplete JSONL tail lines', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-test-'));
  try {
    const f = join(home, 'log.jsonl');
    writeFileSync(f, '{"source":"MODEL","input_tokens":10}\n{"source":');
    assert.equal(readJsonlTail(f).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('follows the open conversation, hides subagents, and labels sessions from the summary db', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = mkdtempSync(join(tmpdir(), 'agy-test-'));
  try {
    const root = join(home, '.gemini', 'antigravity');
    const ids = { open: 'aaaaaaaa-0000-0000-0000-000000000001', child: 'bbbbbbbb-0000-0000-0000-000000000002', recent: 'cccccccc-0000-0000-0000-000000000003' };
    const tokens = { open: 111, child: 222, recent: 333 };
    for (const [key, uuid] of Object.entries(ids)) {
      const logs = join(root, 'brain', uuid, '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      const file = join(logs, 'transcript.jsonl');
      writeFileSync(file, JSON.stringify(step(0, { source: 'MODEL', input_tokens: tokens[key], output_tokens: 1 })) + '\n');
      // The open conversation is the oldest file, so "most recent" alone would not pick it.
      const age = { open: 300, child: 200, recent: 100 }[key];
      utimesSync(file, new Date(Date.now() - age * 1000), new Date(Date.now() - age * 1000));
    }
    const db = new DatabaseSync(join(root, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, parent_conversation_id text)');
    const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
    insert.run(ids.open, 'Open one', '', '["file:///tmp/my%20proj"]', '');
    insert.run(ids.child, '', '', '["file:///tmp/my%20proj"]', ids.open);
    insert.run(ids.recent, '', 'first line\nsecond', '', '');
    db.close();

    const followed = getSnapshot({ home, conversationId: ids.open });
    assert.equal(followed.auto, 'conversation');
    assert.equal(followed.snapshot.context.used, 111);
    assert.deepEqual(followed.sessions.map(s => [s.title, s.workspace]), [['first line', ''], ['Open one', 'my proj']]);

    const fallback = getSnapshot({ home, conversationId: 'not-a-known-conversation' });
    assert.equal(fallback.auto, 'recent');
    assert.equal(fallback.snapshot.context.used, 333);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('raises the ceiling to the next tier once usage proves the preset too small', () => {
  const at = (tokens, options) => analyzeSteps([step(0, { source: 'MODEL', input_tokens: tokens, output_tokens: 1 })], options).context;
  const within = at(200_000);
  assert.deepEqual([within.ceiling, within.ceilingSource], [256_000, 'configured']);
  const over = at(300_000);
  assert.deepEqual([over.ceiling, over.ceilingSource, over.percent], [512_000, 'observed', 58.59]);
  assert.equal(at(300_000, { defaultContextLimit: 512_000 }).ceilingSource, 'configured');
  assert.equal(at(2_000_000).ceiling, 2_000_000);
  const recorded = analyzeSteps([step(0, { source: 'MODEL', input_tokens: 300_000, output_tokens: 1, max_context_tokens: 256_000 })]).context;
  assert.deepEqual([recorded.ceiling, recorded.ceilingSource], [256_000, 'session']);
});

test('keeps the raised ceiling after compaction shrinks the context again', () => {
  const m = analyzeSteps([
    step(0, { source: 'MODEL', input_tokens: 400_000, output_tokens: 1 }),
    step(5, { source: 'MODEL', input_tokens: 60_000, output_tokens: 1 }),
  ]);
  assert.equal(m.context.used, 60_000);
  assert.equal(m.context.ceiling, 512_000);
});

// Minimal protobuf writer, independent of the reader under test.
const varint = (n) => { const out = []; for (; n >= 128; n = Math.floor(n / 128)) out.push((n % 128) | 128); out.push(n); return out; };
const num = (field, n) => [...varint(field * 8), ...varint(n)];
const msg = (field, ...parts) => { const body = parts.flat(); return [...varint(field * 8 + 2), ...varint(body.length), ...body]; };
const str = (field, text) => text ? msg(field, [...Buffer.from(text, 'utf8')]) : [];
const genMetadata = ({ input, output, cached, cacheWrite, ttft, stream, max, model = 1526, responseModel = '', displayName = '' }) => Uint8Array.from(msg(1,
  num(3, model),
  msg(4, num(1, model), input != null ? num(2, input) : [], output != null ? num(3, output) : [], cacheWrite ? num(4, cacheWrite) : [], cached ? num(5, cached) : [], msg(7, num(1, 9))),
  msg(9, num(1, 608), msg(10, num(1, 30000), num(4, max))),
  msg(11, num(1, Math.floor(ttft)), num(2, Math.round((ttft % 1) * 1e9))),
  msg(12, num(1, Math.floor(stream)), num(2, Math.round((stream % 1) * 1e9))),
  str(19, responseModel),
  str(21, displayName)));

test('decodes a call record: tokens, model, first-token delay, streaming time and the real limit', () => {
  const call = decodeCall(genMetadata({
    input: 2610, output: 65, cached: 19526, cacheWrite: 120, ttft: 6.5, stream: 0.25, max: 512000,
    model: 1528, responseModel: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (XHigh)',
  }));
  assert.deepEqual(call, {
    input: 2610, cached: 19526, cacheWrite: 120, output: 65, ttft: 6.5, stream: 0.25, maxContextTokens: 512000,
    model: 1528, responseModel: 'gemini-4-hydrogen', responseModelFull: '', modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
  });
  assert.equal(decodeCall(genMetadata({ input: 1, output: 2, ttft: 1, stream: 1, max: 5 })).cached, null);
  assert.throws(() => decodeCall(Uint8Array.from([0x0a, 0x7f, 0x01])));
});

test('reads timing, model and the real limit from the conversation db instead of estimating', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = mkdtempSync(join(tmpdir(), 'agy-test-'));
  try {
    const root = join(home, '.gemini', 'antigravity');
    const uuid = 'dddddddd-0000-0000-0000-000000000004';
    const logs = join(root, 'brain', uuid, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(root, 'conversations'));
    const calls = [
      { input: 21000, output: 100, ttft: 2, stream: 0.1, max: 512000, responseModel: 'gemini-4-hydrogen' },
      { input: 2500, output: 900, cached: 20000, ttft: 4, stream: 9.9, max: 512000, responseModel: 'gemini-4-hydrogen' },
    ];
    writeFileSync(join(logs, 'transcript.jsonl'), calls.flatMap((c, i) => [
      step(i * 60, { source: 'USER_EXPLICIT', type: 'USER_INPUT' }),
      step(i * 60, { source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: c.input, cache_read_tokens: c.cached || 0, output_tokens: c.output }),
    ]).map(row => JSON.stringify(row)).join('\n') + '\n');
    const db = new DatabaseSync(join(root, 'conversations', `${uuid}.db`));
    db.exec('CREATE TABLE gen_metadata (idx integer primary key, data blob)');
    // One extra, newer record the log has not caught up with yet.
    [...calls, { input: 7, output: 7, ttft: 9, stream: 9, max: 512000 }]
      .forEach((c, i) => db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(i, genMetadata(c)));
    db.close();

    const { context, performance, cost } = getSnapshot({ home }).snapshot;
    assert.deepEqual([context.ceiling, context.ceilingSource, context.used], [512000, 'session', 22500]);
    assert.equal(performance.mode, 'streaming');
    assert.equal(performance.tps, 100);
    assert.deepEqual([performance.ttftSeconds, performance.ttftMedianSeconds, performance.durationSeconds], [4, 3, 9.9]);
    // Call 1: 21k * 1.5/1M + 100 * 7.5/1M = 0.03225
    // Call 2: 2.5k * 1.5/1M + 20k * 0.075/1M + 900 * 7.5/1M = 0.012
    assert.equal(cost.mode, 'exact');
    assert.ok(Math.abs(cost.total - 0.04425) < 1e-9);
    assert.ok(Math.abs(cost.last - 0.012) < 1e-9);
    assert.ok(Math.abs(cost.cacheSaved - 0.0285) < 1e-9);
    assert.equal(cost.models[0].name, 'Gemini 4 Hydrogen');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolves model ids from response model, display name, route alias, and enum', () => {
  assert.equal(resolveModelId({ responseModel: 'gemini-3.8-flash-n', model: 1016 }), 'gemini-3.8-flash');
  assert.equal(resolveModelId({ responseModel: 'gemini-3-flash-a', modelDisplayName: 'Gemini 3.5 Flash (High)' }), 'gemini-3.5-flash');
  assert.equal(resolveModelId({ responseModel: 'gemini-pro-default', modelDisplayName: 'Gemini 3.1 Pro (High)' }), 'gemini-3.1-pro');
  assert.equal(resolveModelId({ responseModel: 'gemini-flash-worker-agy', modelDisplayName: 'Gemini Flash' }), 'gemini-4-hydrogen');
  assert.equal(resolveModelId({ responseModel: 'gemini-pro-orchestrator-g1-pro', modelDisplayName: 'Orchestrator (Argon)' }), 'gemini-4-argon');
  assert.equal(resolveModelId({ responseModel: 'publishers/anthropic/models/claude-opus-4-6-thinking' }), 'claude-opus-4-6');
  assert.equal(resolveModelId({ responseModel: 'gemini-4-neon', modelDisplayName: 'Gemini 4 Neon (Medium)' }), 'gemini-4-neon');
  assert.equal(resolveModelId({ modelDisplayName: 'Orchestrator (Gemini 4 Neon)' }), 'gemini-4-neon');
  assert.equal(resolveModelId({ modelDisplayName: 'Orchestrator (Neon)' }), 'gemini-4-neon');
  assert.equal(resolveModelId({ modelDisplayName: 'Orchestrator (Claude Opus 5.5)' }), 'claude-opus-5-5');
  assert.equal(resolveModelId({ responseModel: 'claude-sonnet-4@20250514' }), 'claude-sonnet-4');
  assert.equal(resolveModelId({ model: 1533 }), 'gemini-4-neon');
  assert.equal(resolveModelId({ model: 1535 }), 'gemini-4-neon');
  assert.equal(resolveModelId({ responseModel: 'gemini-4-carbon', modelDisplayName: 'Gemini 4 Carbon (High)' }), 'gemini-4-carbon');
  assert.equal(resolveModelId({ modelDisplayName: 'Orchestrator (Carbon)' }), 'gemini-4-carbon');
  assert.equal(modelPool('gemini-4-neon'), 'gemini');
  assert.equal(modelPool('gemini-4-carbon'), 'gemini');
  assert.equal(modelPool('gemini-4-argon'), 'gemini');
  assert.equal(modelPool('gemini-4-hydrogen'), 'gemini');
  assert.equal(modelPool('claude-opus-5-5'), 'claude');
  assert.equal(modelPool('gpt-oss-120b'), 'claude');
  assert.equal(modelPool('unknown-model-x'), null);
  assert.deepEqual(activeRates('gemini-4-neon', 900_000), {
    id: 'gemini-4-neon', name: 'Gemini 4 Neon', input: 3.0, cached: 0.15, cacheWrite: 3.75, output: 15.0,
  });
  assert.equal(resolveModelId({ model: 1401 }), 'claude-opus-5-5');
  assert.equal(resolveModelId({ model: 1402 }), 'claude-opus-5-5');
  assert.equal(resolveModelId({ model: 1026 }), 'claude-opus-4-6');
  assert.equal(resolveModelId({ responseModel: 'claude-opus-4-7' }), null);
  assert.equal(resolveModelId({ responseModel: 'unknown-model-x' }), null);
});

test('applies tiered context pricing, scheduled rates, and cache write pricing', () => {
  const proLow = priceCall({ input: 50_000, cached: 100_000, output: 1_000 }, 'gemini-3.1-pro');
  assert.ok(Math.abs(proLow.total - (0.1 + 0.02 + 0.012)) < 1e-9);

  const proHigh = priceCall({ input: 50_000, cached: 200_000, output: 1_000 }, 'gemini-3.1-pro');
  assert.ok(Math.abs(proHigh.total - (0.2 + 0.08 + 0.018)) < 1e-9);

  const haikuSmall = activeRates('claude-haiku-5-5', 50_000);
  const haikuLarge = activeRates('claude-haiku-5-5', 150_000);
  assert.deepEqual([haikuSmall.input, haikuLarge.input], [0.1, 0.5]);

  const argonIntro = activeRates('gemini-4-argon', 10_000, Date.UTC(2026, 10, 17));
  const argonStd = activeRates('gemini-4-argon', 10_000, Date.UTC(2026, 11, 1));
  assert.deepEqual([argonIntro.input, argonIntro.output, argonStd.input, argonStd.output], [2.0, 10.0, 4.0, 20.0]);

  const claude = priceCall({ input: 1_000_000, cached: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }, 'claude-opus-4-6');
  assert.ok(Math.abs(claude.total - (5 + 0.5 + 6.25 + 25)) < 1e-9);
});

test('resyncs across aborted db calls and compaction gaps, and summarizes mixed-model costs', () => {
  const steps = [
    step(0, { source: 'MODEL', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 100 }),
    step(10, { source: 'MODEL', input_tokens: 2000, cache_read_tokens: 1000, output_tokens: 200 }),
    step(20, { source: 'MODEL', input_tokens: 5000, cache_read_tokens: 0, output_tokens: 500 }),
    step(30, { source: 'MODEL', input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 100 }),
  ];
  const calls = [
    { input: 1000, cached: null, output: 100, stream: 1, ttft: 0.5, responseModel: 'claude-opus-4-6-thinking' },
    { input: 2000, cached: 1000, output: 200, stream: 2, ttft: 0.5, responseModel: 'claude-opus-4-6-thinking' },
    // Step at t=20 (5000/0/500) is missing from db (e.g. compaction gap), followed by match and trailing empty aborted calls.
    { input: 1000, cached: 4000, output: 100, stream: 1, ttft: 0.5, responseModel: 'claude-opus-4-6-thinking' },
    { input: null, cached: null, output: null, stream: 0, ttft: 0 },
    { input: null, cached: null, output: null, stream: 0, ttft: 0 },
  ];
  const m = analyzeSteps(steps, { calls });
  assert.equal(m.performance.mode, 'streaming');
  assert.equal(m.performance.sampleCount, 3);
  assert.equal(m.cost.mode, 'exact');
  assert.equal(m.cost.pricedCalls, 4);
  assert.equal(m.cost.inferredCalls, 1);

  const mixed = summarizeCosts([
    { input: 1_000_000, cached: 0, output: 0, modelInfo: { responseModel: 'gemini-4-hydrogen' } },
    { input: 100_000, cached: 0, output: 0, modelInfo: null },
    { input: 1_000_000, cached: 0, output: 0, modelInfo: { responseModel: 'claude-opus-4-6' } },
  ]);
  assert.equal(mixed.mode, 'partial');
  assert.equal(mixed.pricedCalls, 2);
  assert.equal(mixed.unpricedCalls, 1);
  assert.ok(Math.abs(mixed.total - 6.5) < 1e-9);
  assert.ok(Math.abs(mixed.last - 5.0) < 1e-9);
  assert.deepEqual(mixed.models.map(item => item.name), ['Claude Opus 4.6', 'Gemini 4 Hydrogen']);

  const trailingUnknown = summarizeCosts([
    { input: 1_000_000, cached: 0, output: 0, modelInfo: { responseModel: 'gemini-4-hydrogen' } },
    { input: 100_000, cached: 0, output: 0, modelInfo: { responseModel: 'unknown-future-model' } },
  ]);
  assert.equal(trailingUnknown.mode, 'partial');
  assert.equal(trailingUnknown.last, null);
  assert.deepEqual(trailingUnknown.unrecognizedModels, ['unknown-future-model']);

  // Orchestrator mode: main planner (Neon XHigh) + offloaded fast executor (Hydrogen XHigh)
  const orchestrator = summarizeCosts([
    { input: 1_000_000, cached: 0, output: 0, modelInfo: { model: 1535 } },
    { input: 1_000_000, cached: 0, output: 0, modelInfo: { model: 1528 } },
  ]);
  assert.equal(orchestrator.mode, 'exact');
  assert.ok(Math.abs(orchestrator.total - 4.5) < 1e-9);
  assert.deepEqual(orchestrator.models.map(m => [m.id, m.calls]), [
    ['gemini-4-neon', 1],
    ['gemini-4-hydrogen', 1],
  ]);
});

test('computes usage-triggered 5-hour and 7-day pool windows, extra-grant resets, and monthly window', () => {
  const hour = 3_600_000;
  const day = 86_400_000;
  const now = new Date(2026, 10, 17, 10, 30, 0, 0).getTime(); // Tue Nov 17 2026 10:30
  const cal = resolveMonthWindow({ monthStartDay: 20, monthStartTime: '08:00' }, now);
  assert.equal(cal.startMs, new Date(2026, 9, 20, 8, 0, 0, 0).getTime());

  const febNow = new Date(2026, 2, 10, 12, 0, 0, 0).getTime();
  const febCal = resolveMonthWindow({ monthStartDay: 31, monthStartTime: '00:00' }, febNow);
  assert.equal(febCal.startMs, new Date(2026, 1, 28, 0, 0, 0, 0).getTime());

  // Usage-triggered 7d window: expires at t0 + 7d, stays idle while unused, restarts on first later call.
  const t0 = now - 10 * day;
  const idleAfterExpire = resolvePoolWindow({ mode: 'triggered', anchorMs: t0, cycleHours: 168 }, [t0, t0 + day], now);
  assert.equal(idleAfterExpire.status, 'idle');
  assert.equal(idleAfterExpire.startMs, null);

  const tRestart = now - 2 * day; // used again 2 days ago (after 7d expired at t0 + 7d)
  const restarted = resolvePoolWindow({ mode: 'triggered', anchorMs: t0, cycleHours: 168 }, [t0, tRestart, now - hour], now);
  assert.equal(restarted.status, 'active');
  assert.equal(restarted.startMs, tRestart);
  assert.equal(restarted.nextMs, tRestart + 7 * day);
  assert.equal(restarted.elapsedMs, 2 * day);

  // Usage-triggered 5h window: auto-detect skips overnight idle gap and anchors to morning first call.
  const morningStart = now - 2 * hour;
  const shortWin = resolvePoolWindow({}, [now - 20 * hour, now - 18 * hour, morningStart, now - 30 * 60_000], now, 5);
  assert.equal(shortWin.status, 'active');
  assert.equal(shortWin.startMs, morningStart);
  assert.equal(shortWin.nextMs, morningStart + 5 * hour);
  assert.equal(shortWin.remainingMs, 3 * hour);
  assert.equal(shortWin.autoDetected, true);

  // Extra-grant reset: waits until first call >= resetAt before starting clock.
  const resetAt = now - hour;
  const waiting = resolvePoolWindow({ mode: 'after_reset', anchorMs: resetAt, cycleHours: 168 }, [now - 2 * hour], now);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.startMs, null);
  const activated = resolvePoolWindow({ mode: 'after_reset', anchorMs: resetAt, cycleHours: 168 }, [now - 1800_000], now);
  assert.equal(activated.status, 'active');
  assert.equal(activated.startMs, now - 1800_000);
});

test('persists plan & dual-window pool settings and migrates legacy 3-pool settings.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-settings-'));
  try {
    const file = join(home, 'settings.json');
    assert.equal(contextLimit(file), 256_000);
    const updated = updateWindowSettings({
      plan: 'ultra',
      fiveHour: { gemini: { mode: 'after_reset', anchorMs: 1_794_920_000_000, cycleHours: 5 } },
      week: { claude: { mode: 'triggered', anchorMs: 1_794_800_000_000, cycleHours: 168 } },
      monthStartDay: 15, monthStartTime: '09:00',
    }, file);
    assert.equal(updated.windows.plan, 'ultra');
    assert.equal(updated.windows.fiveHour.gemini.mode, 'after_reset');
    assert.equal(updated.windows.fiveHour.claude.cycleHours, 5);
    assert.equal(updated.windows.week.claude.anchorMs, 1_794_800_000_000);
    const cycled = cycleContextLimit(file);
    assert.equal(cycled.contextLimit, 512_000);
    updateWindowSettings({ plan: 'invalid', monthStartTime: 'bad', monthStartDay: 0 }, file);
    const saved = windowSettings(file);
    assert.deepEqual([saved.plan, saved.monthStartDay, saved.monthStartTime], ['ultra', 15, '09:00']);
    assert.equal(saved.fiveHour.gemini.anchorMs, 1_794_920_000_000);

    // Legacy 3-pool settings.json migration: preserves gemini_flash weekly anchor & monthStartDay
    const legacyFile = join(home, 'legacy-settings.json');
    writeFileSync(legacyFile, JSON.stringify({
      contextLimit: 512_000,
      windows: {
        poolMode: 'split',
        pools: {
          gemini_pro: { mode: 'after_reset', anchorMs: 1_795_497_769_119, cycleHours: 168 },
          gemini_flash: { mode: 'triggered', anchorMs: 1_795_496_716_713, cycleHours: 168 },
          gemini: { mode: 'triggered', anchorMs: null, cycleHours: 168 },
          claude: { mode: 'triggered', anchorMs: 1_795_490_000_000, cycleHours: 5 },
        },
        monthStartDay: 3, monthStartTime: '00:00',
      },
    }));
    const migrated = windowSettings(legacyFile);
    assert.equal(migrated.plan, 'pro');
    assert.equal(migrated.week.gemini.anchorMs, 1_795_496_716_713);
    assert.equal(migrated.fiveHour.claude.anchorMs, 1_795_490_000_000);
    assert.equal(migrated.fiveHour.claude.cycleHours, 5);
    assert.equal(migrated.monthStartDay, 3);

    // Legacy merged_gemini maps to ultra
    const legacyUltraFile = join(home, 'legacy-ultra.json');
    writeFileSync(legacyUltraFile, JSON.stringify({
      windows: { poolMode: 'merged_gemini', pools: { gemini: { mode: 'triggered', anchorMs: 1_795_400_000_000, cycleHours: 168 } } },
    }));
    const migratedUltra = windowSettings(legacyUltraFile);
    assert.equal(migratedUltra.plan, 'ultra');
    assert.equal(migratedUltra.week.gemini.anchorMs, 1_795_400_000_000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('includes descendant subagents in session totals, session cost, and unified 2-pool dual-window summaries', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = mkdtempSync(join(tmpdir(), 'agy-agg-'));
  try {
    const now = new Date(2026, 10, 17, 10, 30, 0, 0).getTime();
    const writeSession = (source, uuid, rows, dbCalls) => {
      const root = join(home, '.gemini', source);
      const logs = join(root, 'brain', uuid, '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      mkdirSync(join(root, 'conversations'), { recursive: true });
      writeFileSync(join(logs, 'transcript.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const db = new DatabaseSync(join(root, 'conversations', `${uuid}.db`));
      db.exec('CREATE TABLE gen_metadata (idx integer primary key, data blob)');
      dbCalls.forEach((c, i) => db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(i, genMetadata(c)));
      db.close();
      utimesSync(join(logs, 'transcript.jsonl'), new Date(now), new Date(now));
    };

    const mainId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const subId = 'bbbbbbbb-2222-2222-2222-222222222222';
    const cliId = 'cccccccc-3333-3333-3333-333333333333';

    // Primary session: Nov 10 Hydrogen ($1.5), Nov 16 Opus 4.6 ($5.0), Nov 17 09:45 Hydrogen ($1.5)
    writeSession('antigravity', mainId, [
      { created_at: new Date(2026, 10, 10, 12, 0).toISOString(), source: 'MODEL', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 },
      { created_at: new Date(2026, 10, 16, 12, 0).toISOString(), source: 'MODEL', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 },
      { created_at: new Date(2026, 10, 17, 9, 45).toISOString(), source: 'MODEL', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 },
    ], [
      { input: 1_000_000, output: 0, ttft: 1, stream: 1, max: 512000, responseModel: 'gemini-4-hydrogen' },
      { input: 1_000_000, output: 0, ttft: 1, stream: 1, max: 512000, responseModel: 'claude-opus-4-6-thinking' },
      { input: 1_000_000, output: 0, ttft: 1, stream: 1, max: 512000, responseModel: 'gemini-4-hydrogen' },
    ]);
    // Subagent of mainId: Nov 17 10:00 Opus 4.6 ($5.0)
    writeSession('antigravity', subId, [
      { created_at: new Date(2026, 10, 17, 10, 0).toISOString(), source: 'MODEL', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 },
    ], [
      { input: 1_000_000, output: 0, ttft: 1, stream: 1, max: 512000, responseModel: 'claude-opus-4-6-thinking' },
    ]);
    const sdb = new DatabaseSync(join(home, '.gemini', 'antigravity', 'conversation_summaries.db'));
    sdb.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, parent_conversation_id text)');
    sdb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(mainId, 'Main', '', '[]', '');
    sdb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(subId, 'Sub', '', '[]', mainId);
    sdb.close();

    // CLI session: Nov 16 14:00 Argon ($2.0 intro), Nov 17 10:15 Carbon ($2.0 intro) — both share unified Gemini pool!
    writeSession('antigravity-cli', cliId, [
      { created_at: new Date(2026, 10, 16, 14, 0).toISOString(), source: 'MODEL', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 },
      { created_at: new Date(2026, 10, 17, 10, 15).toISOString(), source: 'MODEL', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 },
    ], [
      { input: 1_000_000, output: 0, ttft: 1, stream: 1, max: 512000, responseModel: 'gemini-4-argon' },
      { input: 1_000_000, output: 0, ttft: 1, stream: 1, max: 512000, responseModel: 'gemini-4-carbon' },
    ]);

    // 1) Current session snapshot for mainId MUST include subagent subId in totals & cost, while keeping main's last call cost!
    const snap = getSnapshot({ home, conversationId: mainId }).snapshot;
    assert.equal(snap.totals.input, 4_000_000);
    assert.equal(snap.totals.modelCalls, 4);
    assert.deepEqual([snap.totals.subagents.count, snap.totals.subagents.modelCalls, snap.totals.subagents.totalTokens], [1, 1, 1_000_000]);
    assert.deepEqual(snap.cost.primaryModels.map(m => [m.name, m.calls]), [['Claude Opus 4.6', 1], ['Gemini 4 Hydrogen', 2]]);
    assert.deepEqual(snap.totals.subagents.models.map(m => [m.name, m.calls]), [['Claude Opus 4.6', 1]]);
    assert.ok(Math.abs(snap.totals.subagents.cost - 5.0) < 1e-9);
    assert.ok(Math.abs(snap.cost.total - 13.0) < 1e-9);
    assert.ok(Math.abs(snap.cost.subagentTotal - 5.0) < 1e-9);
    assert.ok(Math.abs(snap.cost.last - 1.5) < 1e-9);

    // 2) Unified 2-pool dual-window aggregation (Pro: 5h + 7d):
    // - 5h Gemini auto-detects Nov 17 09:45 -> includes Nov 17 Hydrogen ($1.5) + Nov 17 Carbon ($2.0) = $3.5
    // - 5h Claude auto-detects Nov 17 10:00 -> includes Nov 17 subId Opus ($5.0) = $5.0
    // - 7d Gemini anchored 5d2h ago -> includes Nov 16 Argon ($2.0) + Nov 17 Hydrogen ($1.5) + Nov 17 Carbon ($2.0) = $5.5 (excludes Nov 10 Hydrogen)
    // - 7d Claude reset at Nov 17 09:50 -> includes Nov 17 subId Opus ($5.0) (excludes Nov 16 Opus)
    const fiveDaysTwoHoursAgo = now - (5 * 24 + 2) * 3_600_000;
    const proCfg = {
      plan: 'pro',
      fiveHour: {
        gemini: { mode: 'triggered', anchorMs: null, cycleHours: 5 },
        claude: { mode: 'triggered', anchorMs: null, cycleHours: 5 },
      },
      week: {
        gemini: { mode: 'triggered', anchorMs: fiveDaysTwoHoursAgo, cycleHours: 168 },
        claude: { mode: 'after_reset', anchorMs: new Date(2026, 10, 17, 9, 50).getTime(), cycleHours: 168 },
      },
      monthStartDay: 1, monthStartTime: '00:00',
    };
    const res = summarizeAllWindows({ home, windows: proCfg, now });
    assert.equal(res.hasFiveHour, true);
    assert.equal(res.fiveHour.pools.length, 2);
    assert.deepEqual(res.fiveHour.pools.map(p => [p.id, p.status, p.total]), [
      ['gemini', 'active', 3.5],
      ['claude', 'active', 5.0],
    ]);
    assert.ok(Math.abs(res.fiveHour.total - 8.5) < 1e-9);

    assert.equal(res.week.pools.length, 2);
    assert.deepEqual(res.week.pools.map(p => [p.id, p.status, p.total]), [
      ['gemini', 'active', 5.5],
      ['claude', 'active', 5.0],
    ]);
    assert.ok(Math.abs(res.week.total - 10.5) < 1e-9);

    // Month includes all calls: Nov 10 Hydrogen ($1.5) + Nov 16 Opus ($5.0) + Nov 16 Argon ($2.0) + Nov 17 Hydrogen ($1.5) + Nov 17 Opus ($5.0) + Nov 17 Carbon ($2.0) = $17.0
    assert.ok(Math.abs(res.month.total - 17.0) < 1e-9);

    // Free plan disables 5-hour tab while keeping weekly 2-pool summary
    const freeRes = summarizeAllWindows({ home, windows: { ...proCfg, plan: 'free' }, now });
    assert.equal(freeRes.hasFiveHour, false);
    assert.ok(Math.abs(freeRes.week.total - 10.5) < 1e-9);

    // Ultra plan enables both 5-hour and weekly 2-pool summaries
    const ultraRes = summarizeAllWindows({ home, windows: { ...proCfg, plan: 'ultra' }, now });
    assert.equal(ultraRes.hasFiveHour, true);
    assert.ok(Math.abs(ultraRes.fiveHour.total - 8.5) < 1e-9);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('parses Windows, UNC, WSL, and POSIX workspace URIs uniformly', () => {
  assert.equal(workspaceName('["file:///C:/Users/Alice/my%20proj"]'), 'my proj');
  assert.equal(workspaceName('["file:///c%3A/Users/Alice/my-app/"]'), 'my-app');
  assert.equal(workspaceName('["file:///C:%5CUsers%5CAlice%5Cwin-app"]'), 'win-app');
  assert.equal(workspaceName('["file:///C:/"]'), 'C:');
  assert.equal(workspaceName('["file://fileserver/share/repo"]'), 'repo');
  assert.equal(workspaceName('["C:\\\\Users\\\\Alice\\\\raw-win\\\\"]'), 'raw-win');
  assert.equal(workspaceName('["vscode-remote://wsl+ubuntu/home/alice/wsl-proj"]'), 'wsl-proj');
  assert.equal(workspaceName('["file:///C:/work/main", "file:///D:/work/extra"]'), 'main +1');
  assert.equal(workspaceName('["not-a-path"]'), '');
  assert.equal(workspaceName(''), '');
  assert.equal(workspaceName('[]'), '');
});

test('invalidates SQLite query cache when WAL/DB size changes even with identical mtime', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'agy-sqlite-'));
  let db;
  try {
    const dbPath = join(dir, 'test.db');
    const fixedTime = new Date(2026, 10, 20, 12, 0, 0, 0);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, \'alpha\');');
    utimesSync(dbPath, fixedTime, fixedTime);
    utimesSync(`${dbPath}-wal`, fixedTime, fixedTime);

    const readRows = () => queryCached(dbPath, 'SELECT id, name FROM items ORDER BY id', rows => rows.map(r => r.name));
    assert.deepEqual(readRows(), ['alpha']);

    db.exec('INSERT INTO items VALUES (2, \'beta\');');
    utimesSync(dbPath, fixedTime, fixedTime);
    utimesSync(`${dbPath}-wal`, fixedTime, fixedTime);

    assert.deepEqual(readRows(), ['alpha', 'beta']);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
