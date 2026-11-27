(() => {
const $ = (id) => document.getElementById(id);
const RING_CIRC = 2 * Math.PI * 31; // 194.7787

let sessionId = '', loading = false, listSignature = '', breakdownSignature = '';
let selectedModelId = '', activeSessionId = '', lastSnapshot = null, modelBarSignature = '';
// 宿主通过 URL 把当前打开的会话 ID 交给 preload，自动模式据此跟随。
const conversationId = window.sidecar?.conversationId || '';

const fmt = (n) => n == null || !Number.isFinite(n) ? '—'
  : Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : Math.abs(n) >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : n.toLocaleString('en-US');
const set = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
const pad2 = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const when = (t) => t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const shortWhen = (t) => sameDay(t, Date.now())
  ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  : new Date(t).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
const shortStart = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay(t, Date.now())) return hm;
  const md = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  return hm === '00:00' ? md : `${md} ${hm}`;
};
const fullWhen = (t) => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const toDatetimeInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtSpan = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '';
  const mins = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;
  if (days > 0) return hours > 0 ? `${days}天${hours}时` : `${days}天`;
  if (hours > 0) return remMins > 0 ? `${hours}时${remMins}分` : `${hours}时`;
  return `${remMins}分`;
};
const pct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;
const ringPct = (n) => n == null ? '—' : (n >= 10 ? `${Math.round(n)}%` : `${n.toFixed(1)}%`);
const secs = (n) => n == null ? '—' : `${n.toFixed(2)} s`;
const usd = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.0001) return '<$0.0001';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const setHealth = (state, label) => {
  const el = $('health');
  el.className = `status ${state}`;
  el.title = label;
  el.setAttribute('aria-label', label);
};

const OTHER_SOURCES = { antigravity2: 'App 2', 'antigravity-ide': 'IDE', 'antigravity-cli': 'CLI' };
const AUTO_LABELS = { conversation: '当前会话（自动）', recent: '最近活动会话（自动）' };
const CEILING_TAGS = { configured: '预设', observed: '按用量升档' };
const ROLE_LABELS = { planner: '规划', executor: '执行' };
const NO_WORKSPACE = '未关联工作区';
const shortModelName = (name) => String(name || '')
  .replace(/^Gemini\s+4\s+(?=[A-Za-z])/i, '')
  .replace(/^Gemini\s+/i, '')
  .replace(/^Claude\s+/i, '')
  .replace(/^GPT-OSS\s+120B$/i, 'GPT-OSS')
  .trim() || String(name || '');
const sessionName = (s) => s.title || s.uuidShort;
const optionLabel = (s) => [sessionName(s), OTHER_SOURCES[s.source], shortWhen(s.modified)].filter(Boolean).join(' · ');

function buildGroups(items) {
  const groups = new Map();
  for (const s of items) {
    const name = s.workspace || NO_WORKSPACE;
    if (!groups.has(name)) {
      const g = document.createElement('optgroup');
      g.label = name;
      groups.set(name, g);
    }
    groups.get(name).append(new Option(optionLabel(s), s.id));
  }
  return [...groups.values()];
}

// 仅在列表内容变化且下拉框未被操作时重建，避免 2 秒轮询导致闪烁或弹层被关闭。
function updateSessions(items, auto, activeSnap) {
  const el = $('sessions');
  const curTitle = activeSnap ? [activeSnap.workspace, sessionName(activeSnap)].filter(Boolean).join(' · ') : '';
  const autoLabel = curTitle || AUTO_LABELS[auto] || AUTO_LABELS.recent;
  const sig = JSON.stringify([autoLabel, items.map(s => [s.id, s.workspace, optionLabel(s)])]);
  if (sig === listSignature || document.activeElement === el) return;
  listSignature = sig;
  if (!items.some(s => s.id === sessionId)) sessionId = '';
  el.replaceChildren(new Option(autoLabel, ''), ...buildGroups(items));
  el.value = sessionId;
  el.title = curTitle || autoLabel;
}

function filterPlotHistory(hist) {
  if (!hist.length) return [];
  // 短回复（<0.5s）常一次性批量到达，单次 t/s 虚高会压扁波形图并拉偏表盘刻度。
  const sustained = hist.filter(h => h.streamSeconds == null || h.streamSeconds >= 0.5);
  const base = sustained.length >= 2 ? sustained : hist;
  if (base.length < 5) return base;
  const sorted = base.map(h => h.tps).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const clean = base.filter(h => h.tps <= med * 3);
  return clean.length >= 2 ? clean : base;
}

function renderSpeedGauge(p) {
  const tps = p.tps;
  set('tpsVal', tps == null ? '—' : (tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1)));
  set('tpsUnit', p.mode === 'effective' ? '估算' : 't/s');

  const hist = filterPlotHistory(p.history || []);
  const maxScale = Math.max(160, (tps || 0) * 1.15, ...hist.map(h => h.tps * 1.15));
  const ratio = tps == null ? 0 : Math.max(0, Math.min(1, tps / maxScale));
  const angle = -90 + ratio * 180;
  $('speedNeedle').setAttribute('transform', `rotate(${angle.toFixed(1)} 43 46)`);

  const tips = [];
  if (tps != null) {
    tips.push(p.mode === 'effective'
      ? `估算中位速度：${tps.toFixed(1)} tok/s（近 ${p.sampleCount} 次）`
      : `加权均速：${tps.toFixed(1)} tok/s（总输出 ÷ 总流式耗时，近 ${p.sampleCount} 次）`);
  }
  if (p.lastTps != null) tips.push(`本次：${p.lastTps.toFixed(1)} tok/s`);
  if (p.lastOutputTokens != null) {
    tips.push(`本次输出：${fmt(p.lastOutputTokens)} tok${p.durationSeconds != null ? ` · ${secs(p.durationSeconds)}` : ''}`);
  }
  $('speedGaugeWrap').title = tips.join('\n');

  const note = p.mode === 'effective'
    ? '未读到调用记录，按日志时间戳估算（含首字等待与思考，精度为秒）。'
    : '';
  set('speedNote', note);
  $('speedNote').hidden = !note;
}

function renderContextRingAndDetails(c) {
  const ceiling = c.ceiling || 1;
  const cacheShare = Math.max(0, Math.min(1, (c.cache || 0) / ceiling));
  const inputShare = Math.max(0, Math.min(1 - cacheShare, (c.input || 0) / ceiling));
  const bad = (c.percent || 0) >= 90;

  const cacheLen = cacheShare * RING_CIRC;
  const inputLen = inputShare * RING_CIRC;
  const ringCache = $('ringCache');
  const ringInput = $('ringInput');
  ringCache.setAttribute('stroke-dasharray', `${cacheLen.toFixed(2)} ${RING_CIRC.toFixed(2)}`);
  ringCache.setAttribute('stroke-dashoffset', '0');
  ringCache.setAttribute('stroke', bad ? 'var(--cs-red)' : 'var(--cs-blue)');

  ringInput.setAttribute('stroke-dasharray', `${inputLen.toFixed(2)} ${RING_CIRC.toFixed(2)}`);
  ringInput.setAttribute('stroke-dashoffset', `${(-cacheLen).toFixed(2)}`);
  ringInput.setAttribute('stroke', bad ? 'var(--cs-red)' : 'var(--cs-orange)');

  set('contextPct', ringPct(c.percent));
  const avail = c.used == null ? null : Math.max(0, ceiling - c.used);
  const lockCap = c.ceilingSource === 'session';
  $('ringBtn').disabled = lockCap;
  $('contextCap').disabled = lockCap;
  const capHint = lockCap ? '会话真实上限' : '点击切换预设上限（256k / 512k / 1M）';
  $('ringBtn').title = `上限：${fmt(ceiling)}\n可用：${fmt(avail)}\n${capHint}`;
  $('contextCap').title = capHint;

  set('contextUsed', fmt(c.used));
  set('contextCap', fmt(ceiling));
  set('contextSource', CEILING_TAGS[c.ceilingSource] || '');
  $('barCache').style.width = `${(cacheShare * 100).toFixed(2)}%`;
  $('barInput').style.width = `${(inputShare * 100).toFixed(2)}%`;
  $('segbar').dataset.level = bad ? 'bad' : '';

  set('detailCache', fmt(c.cache));
  set('detailInput', fmt(c.input));
  set('detailAvail', fmt(avail));
}

function renderOutput(p, t) {
  const el = $('detailOutput');
  const totalOut = t.output || 0;
  const lastOut = p.lastOutputTokens;

  if (totalOut > 0 && lastOut != null && totalOut !== lastOut) {
    const main = document.createElement('span');
    main.textContent = fmt(totalOut);
    const sub = document.createElement('span');
    sub.className = 'kv-muted';
    sub.textContent = ` · 本次 ${fmt(lastOut)}`;
    el.replaceChildren(main, sub);
  } else if (totalOut > 0) {
    el.textContent = fmt(totalOut);
  } else if (lastOut != null) {
    el.textContent = fmt(lastOut);
  } else {
    el.textContent = '—';
  }

  const tips = [];
  if (totalOut > 0) {
    const subOut = t.subagents?.output || 0;
    tips.push(subOut > 0
      ? `整场输出：${fmt(totalOut)} tok（含子代理 ${fmt(subOut)}）`
      : `整场输出：${fmt(totalOut)} tok`);
  }
  if (lastOut != null) {
    const extra = [];
    if (p.lastThinkingTokens != null) extra.push(`思考 ${fmt(p.lastThinkingTokens)}`);
    if (p.lastResponseTokens != null) extra.push(`正文 ${fmt(p.lastResponseTokens)}`);
    tips.push(`最近一次：${fmt(lastOut)} tok${extra.length ? `（${extra.join(' · ')}）` : ''}`);
  }
  $('rowOutput').title = tips.join('\n');
}

function renderCacheHit(c, t) {
  const el = $('detailCacheHit');
  const sessionHit = t.cacheHitRate;
  const lastHit = c.cacheHitRate;

  if (sessionHit != null && lastHit != null) {
    const main = document.createElement('span');
    main.textContent = pct(sessionHit);
    const sub = document.createElement('span');
    sub.className = 'kv-muted';
    sub.textContent = ` · 本次 ${pct(lastHit)}`;
    el.replaceChildren(main, sub);
  } else if (sessionHit != null) {
    el.textContent = pct(sessionHit);
  } else if (lastHit != null) {
    const sub = document.createElement('span');
    sub.className = 'kv-muted';
    sub.textContent = `本次 ${pct(lastHit)}`;
    el.replaceChildren(sub);
  } else {
    el.textContent = '—';
  }

  const totalIn = (t.input || 0) + (t.cached || 0);
  const tips = [];
  if (sessionHit != null) tips.push(`整场会话：${pct(sessionHit)}（缓读 ${fmt(t.cached)} / 总输入 ${fmt(totalIn)}）`);
  if (lastHit != null) tips.push(`最近一次：${pct(lastHit)}（缓读 ${fmt(c.cache)} / 上下文 ${fmt(c.used)}）`);
  $('rowCacheHit').title = tips.join('\n');
}

function renderSpeedChart(p) {
  const hist = filterPlotHistory(p.history || []);
  const avgLine = $('chartAvgLine');
  if (!hist.length) {
    $('chartArea').setAttribute('d', '');
    $('chartLine').setAttribute('d', '');
    avgLine.setAttribute('visibility', 'hidden');
    set('chartCaption', '等待记录');
    $('chartBox')._coords = [];
    return;
  }
  const maxVal = Math.max(60, p.tps || 0, ...hist.map(h => h.tps)) * 1.15;
  const W = 264, H = 56, padTop = 6, padBot = 2;
  const usableH = H - padTop - padBot;

  const coords = hist.map((pt, i) => {
    const x = hist.length === 1 ? W : (i / (hist.length - 1)) * W;
    const y = H - padBot - (Math.min(pt.tps, maxVal) / maxVal) * usableH;
    return { x, y, pt };
  });

  if (coords.length === 1) {
    const y = coords[0].y.toFixed(1);
    $('chartLine').setAttribute('d', `M 0 ${y} L ${W} ${y}`);
    $('chartArea').setAttribute('d', `M 0 ${H} L 0 ${y} L ${W} ${y} L ${W} ${H} Z`);
  } else {
    const lineD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
    $('chartLine').setAttribute('d', lineD);
    $('chartArea').setAttribute('d', `${lineD} L ${W} ${H} L 0 ${H} Z`);
  }

  if (p.tps != null) {
    const avgY = (H - padBot - (Math.min(p.tps, maxVal) / maxVal) * usableH).toFixed(1);
    avgLine.setAttribute('y1', avgY);
    avgLine.setAttribute('y2', avgY);
    avgLine.setAttribute('visibility', 'visible');
  } else {
    avgLine.setAttribute('visibility', 'hidden');
  }

  const peak = Math.max(...hist.map(h => h.tps));
  const prefix = p.mode === 'effective' ? '估算 · ' : '';
  set('chartCaption', `${prefix}近 ${hist.length} 次 · 峰 ${Math.round(peak)}`);
  $('chartBox')._coords = coords;
}

function setupChartHover() {
  const box = $('chartBox');
  const crosshair = $('chartCrosshair');
  const dot = $('chartDot');

  box.addEventListener('mousemove', (ev) => {
    const coords = box._coords;
    if (!coords || !coords.length) return;
    const rect = $('speedChart').getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 264;
    let nearest = coords[0], minDist = Infinity;
    for (const c of coords) {
      const d = Math.abs(c.x - relX);
      if (d < minDist) { minDist = d; nearest = c; }
    }
    crosshair.setAttribute('x1', nearest.x.toFixed(1));
    crosshair.setAttribute('x2', nearest.x.toFixed(1));
    crosshair.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', nearest.x.toFixed(1));
    dot.setAttribute('cy', nearest.y.toFixed(1));
    dot.setAttribute('visibility', 'visible');
    const p = nearest.pt;
    const parts = [`${p.tps.toFixed(1)} t/s`, `${fmt(p.outputTokens)} tok`];
    if (p.ttftSeconds != null) parts.push(`首字 ${p.ttftSeconds.toFixed(1)}s`);
    if (!selectedModelId && p.modelName && (lastSnapshot?.models?.length || 0) > 1) {
      parts.push(shortModelName(p.modelName));
    }
    set('chartHover', parts.join(' · '));
  });

  box.addEventListener('mouseleave', () => {
    crosshair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    set('chartHover', '');
  });
}

function makeKvRow(labelNode, valNodes, { sub = false, title = '', className = '' } = {}) {
  const row = document.createElement('div');
  row.className = [sub ? 'kv kv-sub' : 'kv', className].filter(Boolean).join(' ');
  if (title) row.title = title;
  const lbl = document.createElement('span');
  lbl.className = 'kv-label';
  if (typeof labelNode === 'string') lbl.textContent = labelNode;
  else for (const n of [].concat(labelNode)) lbl.append(n);
  const val = document.createElement('span');
  val.className = 'kv-val';
  for (const node of valNodes) val.append(node);
  row.append(lbl, val);
  return row;
}

function formatCostAndCalls(costText, calls, mutedCost = false, tps = null) {
  const nodes = [];
  if (tps != null) {
    const tpsSpan = document.createElement('span');
    tpsSpan.className = 'kv-muted';
    tpsSpan.textContent = `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} t/s · `;
    nodes.push(tpsSpan);
  }
  const costSpan = document.createElement('span');
  if (mutedCost) costSpan.className = 'kv-muted';
  costSpan.textContent = costText;
  const tail = document.createElement('span');
  tail.className = 'kv-muted';
  tail.textContent = ` · ${calls} 次`;
  nodes.push(costSpan, tail);
  return nodes;
}

function makeModelBreakdownRow(m, sub = true, modelView = null, clickable = false, selected = false) {
  const perf = modelView?.performance;
  const ctx = modelView?.context;
  const hit = modelView?.totals?.cacheHitRate;
  const roleLabel = modelView?.role ? ROLE_LABELS[modelView.role] : '';
  const speedParts = [];
  if (perf?.tps != null) speedParts.push(`速度 ${perf.tps.toFixed(1)} t/s`);
  if (perf?.ttftMedianSeconds != null) speedParts.push(`首字中位 ${secs(perf.ttftMedianSeconds)}`);
  if (hit != null) speedParts.push(`缓存命中 ${pct(hit)}`);
  const rateLine = m.rates
    ? `\n费率：入 $${m.rates.input} / 缓 $${m.rates.cached} / 出 $${m.rates.output}（每 1M）`
    : '';
  const title = [
    `${m.name}${roleLabel ? `（${roleLabel}）` : ''} · ${m.calls} 次调用`,
    speedParts.join(' · '),
    ctx?.used != null ? `上下文 ${fmt(ctx.used)} / ${fmt(ctx.ceiling)}` : '',
    `入 ${fmt(m.inputTokens)} · 缓 ${fmt(m.cachedTokens)} · 出 ${fmt(m.outputTokens)}${rateLine}`,
  ].filter(Boolean).join('\n');

  const lblNodes = [document.createTextNode(m.name)];
  if (roleLabel) {
    const tag = document.createElement('span');
    tag.className = 'role-tag';
    tag.textContent = roleLabel;
    lblNodes.push(tag);
  }
  const row = makeKvRow(
    lblNodes,
    formatCostAndCalls(usd(m.total), m.calls, false, clickable ? perf?.tps : null),
    {
      sub,
      title,
      className: clickable ? (selected ? 'kv-click kv-selected' : 'kv-click') : '',
    }
  );
  if (clickable) {
    row.addEventListener('click', () => {
      selectedModelId = selectedModelId === m.id ? '' : m.id;
      syncModelTabSelection();
      if (lastSnapshot) renderActiveView(lastSnapshot);
    });
  }
  return row;
}

function renderDetailsTail(p, t, k, modelViews = []) {
  set('detailTtft', p.ttftSeconds != null ? secs(p.ttftSeconds) : (p.ttftMedianSeconds != null ? `中位 ${secs(p.ttftMedianSeconds)}` : '—'));
  $('rowTtft').title = p.ttftMedianSeconds != null ? `近 20 次首字中位：${secs(p.ttftMedianSeconds)}` : '';

  const primaryModels = k.primaryModels || k.models || [];
  const sub = t.subagents || { count: 0, modelCalls: 0, models: [] };
  const subModels = sub.models || [];
  const hasSub = sub.count > 0 || sub.modelCalls > 0;
  const primaryCalls = k.primaryCalls ?? (t.modelCalls - (sub.modelCalls || 0));
  const primaryUnpriced = Math.max(0, primaryCalls - primaryModels.reduce((s, m) => s + m.calls, 0));
  const multiPrimary = modelViews.length > 1;
  const modelMap = new Map(modelViews.map(v => [v.id, v]));

  const sig = JSON.stringify([
    k.mode, k.total, k.last, t.modelCalls, primaryCalls, primaryUnpriced,
    multiPrimary ? selectedModelId : '',
    primaryModels.map(m => {
      const mv = modelMap.get(m.id);
      return [m.id, m.calls, m.total, mv?.role || '', mv?.performance?.tps ?? null];
    }),
    sub.count, sub.modelCalls, sub.cost, sub.unpricedCalls,
    subModels.map(m => [m.id, m.calls, m.total]),
    k.unrecognizedModels,
  ]);
  if (sig !== breakdownSignature) {
    breakdownSignature = sig;
    const totalTip = [
      `输入 ${fmt(t.input)} (${usd(k.input)})`,
      `缓存 ${fmt(t.cached)} (${usd(k.cached)})`,
      `输出 ${fmt(t.output)} (${usd(k.output)})`,
      k.last != null ? `本次调用：${usd(k.last)}` : '',
      k.cacheSaved > 0 ? `缓存节省：${usd(k.cacheSaved)}` : '',
    ].filter(Boolean).join('\n');

    const rows = [];
    if (!hasSub && primaryModels.length <= 1 && primaryUnpriced === 0) {
      const m = primaryModels[0];
      const name = m?.name || (t.modelCalls ? '未识别模型' : '本会话');
      const costStr = m ? usd(m.total) : usd(k.total);
      rows.push(makeKvRow(name, formatCostAndCalls(costStr, t.modelCalls, !m && k.total == null), { title: totalTip }));
    } else {
      rows.push(makeKvRow('本会话', formatCostAndCalls(usd(k.total), t.modelCalls, k.total == null), { title: totalTip }));
      for (const m of primaryModels) {
        rows.push(makeModelBreakdownRow(m, true, modelMap.get(m.id), multiPrimary, selectedModelId === m.id));
      }
      if (primaryUnpriced > 0) {
        rows.push(makeKvRow('未计价调用', formatCostAndCalls('—', primaryUnpriced, true), { sub: true }));
      }
      if (hasSub) {
        const subTip = [
          `子代理 ${sub.count} 个 · 共 ${sub.modelCalls} 次调用`,
          `入 ${fmt(sub.input)} · 缓 ${fmt(sub.cached)} · 出 ${fmt(sub.output)}`,
        ].join('\n');
        rows.push(makeKvRow(
          `子代理 (${sub.count} 个)`,
          formatCostAndCalls(usd(sub.cost ?? k.subagentTotal), sub.modelCalls, sub.cost == null && !k.subagentTotal),
          { title: subTip }
        ));
        for (const m of subModels) rows.push(makeModelBreakdownRow(m, true));
        if ((sub.unpricedCalls || 0) > 0) {
          rows.push(makeKvRow('未计价调用', formatCostAndCalls('—', sub.unpricedCalls, true), { sub: true }));
        }
      }
    }
    $('sessionBreakdown').replaceChildren(...rows);
  }

  let costNote = '';
  if (k.mode === 'unavailable' && t.modelCalls > 0) {
    costNote = k.unrecognizedModels?.length
      ? `未收录模型费率：${k.unrecognizedModels.join('、')}`
      : '未读到调用记录里的模型信息，无法计算价格。';
  } else if (k.mode === 'partial') {
    costNote = k.unrecognizedModels?.length
      ? `未收录部分模型费率（${k.unrecognizedModels.join('、')}），金额仅计入已识别的 ${k.pricedCalls}/${k.totalCalls} 次。`
      : `部分调用未能匹配模型记录，金额仅计入已识别的 ${k.pricedCalls}/${k.totalCalls} 次。`;
  }
  set('costNote', costNote);
  $('costNote').hidden = !costNote;
}

function syncModelTabSelection() {
  for (const btn of $('modelTabs').children) {
    const active = btn.dataset.model === selectedModelId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
}

function makeModelTab(id, label, tip, isActiveModel = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'seg-tab';
  btn.role = 'tab';
  btn.dataset.model = id;
  btn.title = tip;
  if (isActiveModel) {
    const dot = document.createElement('i');
    dot.className = 'live-dot';
    btn.append(dot);
  }
  btn.append(document.createTextNode(label));
  btn.addEventListener('click', () => {
    if (selectedModelId === id) return;
    selectedModelId = id;
    syncModelTabSelection();
    if (lastSnapshot) renderActiveView(lastSnapshot);
  });
  return btn;
}

function renderModelBar(models) {
  const bar = $('modelBar');
  if (!models || models.length <= 1) {
    bar.hidden = true;
    modelBarSignature = '';
    return;
  }
  bar.hidden = false;
  const sig = JSON.stringify(models.map(m => [
    m.id, m.role, m.isActive, m.calls, m.performance?.tps, m.context?.used, m.cost?.total,
  ]));
  if (sig !== modelBarSignature) {
    modelBarSignature = sig;
    const tabs = [makeModelTab('', '全部', '查看全会话合并指标')];
    for (const m of models) {
      const roleLabel = m.role ? ROLE_LABELS[m.role] : '';
      const label = roleLabel ? `${roleLabel} ${shortModelName(m.name)}` : shortModelName(m.name);
      const tip = [
        roleLabel ? `${m.name}（${roleLabel}）` : m.name,
        m.performance?.tps != null ? `速度：${m.performance.tps.toFixed(1)} tok/s` : '',
        m.performance?.ttftMedianSeconds != null ? `首字中位：${secs(m.performance.ttftMedianSeconds)}` : '',
        m.totals?.cacheHitRate != null ? `缓存命中：${pct(m.totals.cacheHitRate)}` : '',
        m.context?.used != null ? `上下文：${fmt(m.context.used)} / ${fmt(m.context.ceiling)}` : '',
        `${m.calls} 次调用 · ${usd(m.cost?.total)}`,
      ].filter(Boolean).join('\n');
      tabs.push(makeModelTab(m.id, label, tip, m.isActive));
    }
    $('modelTabs').replaceChildren(...tabs);
  }
  syncModelTabSelection();
}

function renderActiveView(s) {
  const view = selectedModelId ? s.models?.find(m => m.id === selectedModelId) : null;
  const target = view || s;
  set('freshness', `更新 ${when(target.context.updatedAt || s.context.updatedAt)}`);
  renderSpeedGauge(target.performance);
  renderContextRingAndDetails(target.context);
  renderOutput(target.performance, target.totals);
  renderCacheHit(target.context, target.totals);
  renderSpeedChart(target.performance);
  renderDetailsTail(target.performance, s.totals, s.cost || {}, s.models || []);
}

function render(json) {
  if (json.status !== 'ok' || !json.snapshot) {
    setHealth('', '暂无数据');
    $('emptyBanner').hidden = false;
    set('emptyBanner', json.message || '请先在 Antigravity 中运行一次会话');
    $('modelBar').hidden = true;
    lastSnapshot = null;
    return;
  }
  $('emptyBanner').hidden = true;
  setHealth('ready', '本地连接');
  const s = json.snapshot;
  const sid = s.session?.id || '';
  if (sid !== activeSessionId) {
    activeSessionId = sid;
    selectedModelId = '';
  }
  const models = s.models || [];
  if (models.length <= 1 || (selectedModelId && !models.some(m => m.id === selectedModelId))) {
    selectedModelId = '';
  }
  lastSnapshot = s;
  renderModelBar(models);
  renderActiveView(s);
}

async function saveWindows(patch) {
  try {
    const r = await fetch('/api/settings/windows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await refresh();
  } catch (e) { set('error', `保存时间设置失败：${String(e?.message || e).slice(0, 80)}`); }
}

const windowsPanel = window.__agyWindowsUI({
  $, set, fmt, usd, shortStart, fullWhen, toDatetimeInput, fmtSpan, saveWindows,
});

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const r = await fetch('/api/telemetry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, conversationId }), cache: 'no-store',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const result = await r.json();
    updateSessions(result.sessions || [], result.auto, result.snapshot?.session);
    render(result);
    windowsPanel.render(result.windows);
    set('error', '');
  } catch (e) {
    setHealth('error', '连接失败');
    set('error', String(e?.message || e).slice(0, 90));
  } finally {
    loading = false;
  }
}

const cycleLimit = async () => {
  try {
    const r = await fetch('/api/context-limit/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    refresh();
  } catch (e) { set('error', `切换上限失败：${String(e?.message || e).slice(0, 80)}`); }
};

setupChartHover();
$('sessions').addEventListener('change', () => { sessionId = $('sessions').value; $('sessions').blur(); refresh(); });
$('refresh').addEventListener('click', refresh);
$('contextCap').addEventListener('click', cycleLimit);
$('ringBtn').addEventListener('click', cycleLimit);

window.addEventListener('error', (ev) => {
  setHealth('error', '脚本错误');
  set('error', String(ev?.message || '页面初始化异常').slice(0, 90));
});

refresh();
window.setInterval(refresh, 2000);
})();
