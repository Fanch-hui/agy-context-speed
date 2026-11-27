/**
 * 全会话汇总面板（5 小时短周期 / 7 天周限额 / 本月）与订阅方案、双池校准设置抽屉。
 * 采用经典脚本挂载（而非 ES Module），兼容 Sidecar WebView 对 module 脚本的限制。
 */
(() => {
const MODEL_DOTS = ['dot-blue', 'dot-orange', 'dot-green', 'dot-purple', 'dot-teal'];
const POOL_DOTS = { gemini: 'dot-blue', claude: 'dot-orange' };

const SCOPE_SPEC = {
  fiveHour: {
    label: '5时',
    defaultCycle: 5,
    cycles: [['5', '5 时'], ['6', '6 时'], ['12', '12 时'], ['24', '24 时'], ['0', '不循环']],
    firstUnit: '时', firstMax: '24', firstStep: '1', firstAria: '小时',
    secondUnit: '分', secondMax: '59', secondStep: '1', secondAria: '分钟',
    toMs: (a, b) => (a * 60 + b) * 60_000,
    splitMins: (mins) => [Math.floor(mins / 60), mins % 60],
  },
  week: {
    label: '本周',
    defaultCycle: 168,
    cycles: [['168', '7 天'], ['336', '14 天'], ['0', '不循环']],
    firstUnit: '天', firstMax: '30', firstStep: '1', firstAria: '天数',
    secondUnit: '时', secondMax: '23.9', secondStep: '0.5', secondAria: '小时',
    toMs: (a, b) => (a * 24 + b) * 3_600_000,
    splitMins: (mins) => [Math.floor(mins / 1440), Math.round(((mins % 1440) / 60) * 10) / 10],
  },
};

function createWindowsPanel({
  $, set, fmt, usd, shortStart, fullWhen, toDatetimeInput, fmtSpan, saveWindows,
}) {
  let activeWindow = null;
  let userPickedTab = false;
  let calScope = 'week';
  let lastWindows = null;
  let modelsSignature = '';
  let poolCfgSignature = '';

  const poolCostText = (p) => (p.total != null ? usd(p.total) : (p.tokens?.total > 0 ? '—' : '$0.00'));
  const isEditing = (container) => {
    const active = document.activeElement;
    return Boolean(active && container.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT'));
  };

  function poolStatusLabel(p) {
    if (p.status === 'waiting') return p.mode === 'after_reset' ? '已重置 · 待激活' : '待激活';
    if (p.status === 'idle') return '未计时';
    const parts = [];
    if (p.autoDetected) parts.push('推算');
    if (p.remainingMs != null) parts.push(`剩 ${fmtSpan(p.remainingMs)}`);
    else parts.push(`已用 ${fmtSpan(p.elapsedMs)}`);
    return parts.join(' · ');
  }

  function resetPool(scope, poolId) {
    const now = Date.now();
    if (scope === 'week') {
      saveWindows({
        week: { [poolId]: { mode: 'after_reset', anchorMs: now } },
        fiveHour: { [poolId]: { mode: 'after_reset', anchorMs: now } },
      });
    } else {
      saveWindows({ fiveHour: { [poolId]: { mode: 'after_reset', anchorMs: now } } });
    }
  }

  function syncTabButtons() {
    for (const el of document.querySelectorAll('.seg-tab[data-win]')) {
      const active = el.dataset.win === activeWindow;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    }
    for (const el of document.querySelectorAll('.seg-tab[data-cal]')) {
      const active = el.dataset.cal === calScope;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    }
  }

  function openWindowSettings(targetScope) {
    if (targetScope === 'fiveHour' || targetScope === 'week') calScope = targetScope;
    const panel = $('winSettings');
    if (panel.hidden) {
      panel.hidden = false;
      $('toggleWinSettings').setAttribute('aria-expanded', 'true');
    }
    syncTabButtons();
    if (lastWindows) syncWindowInputs(lastWindows);
  }

  function buildPoolConfigEl(p, scope) {
    const spec = SCOPE_SPEC[scope];
    const wrap = document.createElement('div');
    wrap.className = 'pool-cfg';
    wrap.dataset.pool = p.id;

    const head = document.createElement('div');
    head.className = 'pool-cfg-head';
    const title = document.createElement('span');
    title.textContent = p.name;
    title.title = p.hint || '';
    const actions = document.createElement('div');
    actions.className = 'pool-cfg-actions';

    const cycle = document.createElement('select');
    cycle.ariaLabel = `${p.name} ${spec.label}刷新周期`;
    for (const [val, label] of spec.cycles) cycle.append(new Option(label, val));
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mini-btn';
    resetBtn.textContent = '重置';
    resetBtn.title = scope === 'week'
      ? '清零周限额与 5 时窗口，等待下一次调用重新计时'
      : '清零 5 时窗口，等待下一次调用重新计时';
    actions.append(cycle, resetBtn);
    head.append(title, actions);

    const relRow = document.createElement('div');
    relRow.className = 'win-row';
    const kind = document.createElement('select');
    kind.ariaLabel = `${p.name} 校准方式`;
    kind.append(new Option('已用', 'elapsed'), new Option('距刷新', 'remaining'));
    const first = document.createElement('input');
    first.type = 'number'; first.min = '0'; first.max = spec.firstMax; first.step = spec.firstStep; first.placeholder = '0';
    first.ariaLabel = `${p.name} ${spec.firstAria}`;
    const firstUnit = document.createElement('span');
    firstUnit.textContent = spec.firstUnit;
    const second = document.createElement('input');
    second.type = 'number'; second.min = '0'; second.max = spec.secondMax; second.step = spec.secondStep; second.placeholder = '0';
    second.ariaLabel = `${p.name} ${spec.secondAria}`;
    const secondUnit = document.createElement('span');
    secondUnit.textContent = spec.secondUnit;
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button'; applyBtn.className = 'mini-btn'; applyBtn.textContent = '校准';
    relRow.append(kind, first, firstUnit, second, secondUnit, applyBtn);

    const dtRow = document.createElement('div');
    dtRow.className = 'win-row';
    const dtLbl = document.createElement('span');
    dtLbl.className = 'pool-lbl'; dtLbl.textContent = '起点';
    const dt = document.createElement('input');
    dt.type = 'datetime-local';
    dt.ariaLabel = `${p.name} ${spec.label}起始时间`;
    dtRow.append(dtLbl, dt);

    cycle.addEventListener('change', () => {
      const ch = Number(cycle.value);
      kind.options[1].disabled = ch === 0;
      if (ch === 0 && kind.value === 'remaining') kind.value = 'elapsed';
      saveWindows({ [scope]: { [p.id]: { cycleHours: ch } } });
    });
    resetBtn.addEventListener('click', () => resetPool(scope, p.id));
    applyBtn.addEventListener('click', () => {
      if (first.value === '' && second.value === '') return;
      const offsetMs = spec.toMs(Math.max(0, Number(first.value) || 0), Math.max(0, Number(second.value) || 0));
      const ch = Number(cycle.value);
      const now = Date.now();
      const anchorMs = kind.value === 'remaining' && ch > 0
        ? now - Math.max(0, ch * 3_600_000 - offsetMs)
        : now - offsetMs;
      first.value = ''; second.value = '';
      saveWindows({ [scope]: { [p.id]: { mode: 'triggered', anchorMs, cycleHours: ch } } });
    });
    kind.addEventListener('change', () => { if (lastWindows) syncWindowInputs(lastWindows); });
    dt.addEventListener('change', () => {
      const ms = new Date(dt.value).getTime();
      if (Number.isFinite(ms) && ms > 0) saveWindows({ [scope]: { [p.id]: { mode: 'triggered', anchorMs: ms } } });
    });

    wrap._refs = { cycle, kind, first, second, dt };
    wrap.append(head, relRow, dtRow);
    return wrap;
  }

  function syncWindowInputs(winData) {
    if (!winData || $('winSettings').hidden) return;
    const cfg = winData.settings || {};
    const scope = winData.hasFiveHour && calScope === 'fiveHour' ? 'fiveHour' : 'week';
    const spec = SCOPE_SPEC[scope];
    const pools = winData[scope]?.pools || [];

    const sig = `${scope}:${pools.map(p => p.id).join(',')}`;
    if (sig !== poolCfgSignature) {
      poolCfgSignature = sig;
      $('poolConfigs').replaceChildren(...pools.map(p => buildPoolConfigEl(p, scope)));
    }
    if (!isEditing($('winSettings'))) {
      $('planMode').value = cfg.plan || 'pro';
      $('monthDay').value = String(cfg.monthStartDay ?? 1);
      $('monthTime').value = cfg.monthStartTime || '00:00';
    }
    for (const el of $('poolConfigs').children) {
      if (isEditing(el)) continue;
      const p = pools.find(item => item.id === el.dataset.pool);
      if (!p || !el._refs) continue;
      const { cycle, kind, first, second, dt } = el._refs;
      const cycleStr = String(p.cycleHours ?? spec.defaultCycle);
      if (!Array.from(cycle.options).some(o => o.value === cycleStr)) {
        cycle.append(new Option(`${cycleStr} 时`, cycleStr));
      }
      cycle.value = cycleStr;
      kind.options[1].disabled = Number(cycle.value) === 0;
      if (Number(cycle.value) === 0 && kind.value === 'remaining') kind.value = 'elapsed';
      dt.value = p.startMs ? toDatetimeInput(p.startMs) : '';
      if (p.status === 'active') {
        const refMs = kind.value === 'remaining' && p.remainingMs != null ? p.remainingMs : p.elapsedMs;
        const mins = Math.max(0, Math.round((refMs || 0) / 60_000));
        const [a, b] = spec.splitMins(mins);
        first.placeholder = String(a);
        second.placeholder = String(b);
      } else {
        first.placeholder = '0'; second.placeholder = '0';
      }
    }
  }

  function buildRankRow(m, idx, showDot = true) {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const left = document.createElement('span');
    left.className = 'rank-name';
    if (showDot) {
      const dot = document.createElement('i');
      dot.className = `dot ${MODEL_DOTS[idx % MODEL_DOTS.length]}`;
      left.append(dot);
    }
    const name = document.createElement('span');
    name.textContent = m.name;
    left.append(name);

    const right = document.createElement('span');
    right.className = 'rank-right';
    const tok = document.createElement('span');
    tok.className = 'rank-tok';
    tok.textContent = fmt(m.totalTokens);
    const cost = document.createElement('span');
    cost.className = 'rank-cost';
    cost.textContent = usd(m.total);
    right.append(tok, cost);

    row.title = `${m.name} · ${m.calls} 次调用\n入 ${fmt(m.inputTokens)} · 缓 ${fmt(m.cachedTokens)} · 出 ${fmt(m.outputTokens)}`;
    row.append(left, right);
    return row;
  }

  function buildPoolBlock(p, scope, companion, hasFiveHour) {
    const block = document.createElement('div');
    block.className = 'pool-block';

    const head = document.createElement('div');
    head.className = 'pool-head';
    const title = document.createElement('div');
    title.className = 'pool-title';
    const dot = document.createElement('i');
    dot.className = `dot ${POOL_DOTS[p.id] || 'dot-blue'}`;
    const name = document.createElement('span');
    name.textContent = p.name;
    name.title = p.hint || '';

    const status = document.createElement('button');
    status.type = 'button';
    status.className = 'pool-status';
    status.textContent = poolStatusLabel(p);
    const tips = [];
    if (p.startMs) {
      tips.push(`起算：${fullWhen(p.startMs)}`);
      if (p.nextMs) tips.push(`预计重置：${fullWhen(p.nextMs)}`);
      tips.push(`${p.sessionCount || 0} 会话 · ${p.totalCalls || 0} 次`);
    }
    if (companion && hasFiveHour) {
      const otherLabel = scope === 'fiveHour' ? '本周' : '5时';
      tips.push(`${otherLabel}：${poolStatusLabel(companion)} · ${poolCostText(companion)}`);
    }
    tips.push('点击校准时间');
    status.title = tips.join('\n');
    status.addEventListener('click', () => openWindowSettings(scope));
    title.append(dot, name, status);

    const right = document.createElement('div');
    right.className = 'pool-right';
    const cost = document.createElement('b');
    cost.textContent = poolCostText(p);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pool-reset-btn';
    reset.textContent = '重置';
    const resetTip = scope === 'week'
      ? `清零 ${p.name} 周限额与 5 时窗口，等待下次调用重新计时`
      : `清零 ${p.name} 5 时窗口，等待下次调用重新计时`;
    reset.dataset.tip = resetTip;
    reset.ariaLabel = resetTip;
    reset.addEventListener('click', () => resetPool(scope, p.id));
    right.append(cost, reset);
    head.append(title, right);
    block.append(head);

    if (p.models?.length) {
      const list = document.createElement('div');
      list.className = 'pool-models';
      list.append(...p.models.map((m, i) => buildRankRow(m, i, false)));
      block.append(list);
    }
    return block;
  }

  function updateTabTooltips(winData) {
    for (const key of ['fiveHour', 'week', 'month']) {
      const w = winData[key];
      const tab = document.querySelector(`.seg-tab[data-win="${key}"]`);
      if (!w || !tab) continue;
      const tok = w.tokens || {};
      const usage = `入 ${fmt(tok.input || 0)} · 缓 ${fmt(tok.cached || 0)} · 出 ${fmt(tok.output || 0)}`;
      if (key === 'month') {
        const lines = [`起算：${fullWhen(w.startMs)}`];
        if (w.nextMs) lines.push(`下次重置：${fullWhen(w.nextMs)}`);
        lines.push(`${w.sessionCount || 0} 会话 · ${w.totalCalls || 0} 次`, usage);
        tab.title = lines.join('\n');
      } else {
        const pools = w.pools || [];
        tab.title = [...pools.map(p => `${p.name}：${poolStatusLabel(p)} · ${poolCostText(p)}`), usage].join('\n');
      }
    }
  }

  function render(winData) {
    if (!winData) return;
    lastWindows = winData;
    const hasFiveHour = winData.hasFiveHour !== false && winData.settings?.plan !== 'free';

    if (activeWindow == null) {
      activeWindow = hasFiveHour && winData.settings?.plan === 'ultra' ? 'fiveHour' : 'week';
      calScope = activeWindow;
    }
    if (!hasFiveHour && activeWindow === 'fiveHour') activeWindow = 'week';
    if (!hasFiveHour && calScope === 'fiveHour') calScope = 'week';

    const fiveHourTab = document.querySelector('.seg-tab[data-win="fiveHour"]');
    if (fiveHourTab) fiveHourTab.hidden = !hasFiveHour;
    $('calScopeRow').hidden = !hasFiveHour;
    syncTabButtons();
    syncWindowInputs(winData);
    updateTabTooltips(winData);

    const cur = winData[activeWindow];
    if (!cur) return;
    set('winTotalCost', poolCostText(cur));
    $('winTotalCost').title = `总计 ${fmt(cur.tokens?.total || 0)} tok · ${cur.totalCalls || 0} 次调用`;

    if (activeWindow === 'month') {
      set('winMeta', shortStart(cur.startMs));
      const models = cur.models || [];
      const sig = JSON.stringify(['month', models.map(m => [m.id, m.calls, m.total, m.totalTokens])]);
      if (sig !== modelsSignature) {
        modelsSignature = sig;
        const list = $('winModels');
        if (!models.length) {
          const empty = document.createElement('div');
          empty.className = 'rank-empty';
          empty.textContent = '本月暂无已识别模型的调用';
          list.replaceChildren(empty);
        } else {
          list.replaceChildren(...models.map((m, i) => buildRankRow(m, i, true)));
        }
      }
    } else {
      const pools = cur.pools || [];
      const otherKey = activeWindow === 'fiveHour' ? 'week' : 'fiveHour';
      const otherPools = winData[otherKey]?.pools || [];
      set('winMeta', pools.length ? `${pools.filter(p => p.status === 'active').length}/${pools.length} 池` : '');
      const sig = JSON.stringify([
        activeWindow, hasFiveHour,
        pools.map(p => [p.id, poolStatusLabel(p), p.totalCalls, p.total, p.tokens?.total, p.models.map(m => [m.id, m.calls, m.total])]),
        otherPools.map(p => [p.id, poolStatusLabel(p), p.total]),
      ]);
      if (sig !== modelsSignature) {
        modelsSignature = sig;
        $('winModels').replaceChildren(...pools.map(p =>
          buildPoolBlock(p, activeWindow, otherPools.find(o => o.id === p.id), hasFiveHour)));
      }
    }

    const note = cur.unpricedCalls > 0
      ? (cur.unrecognizedModels?.length
        ? `另有 ${cur.unpricedCalls} 次调用未收录费率（${cur.unrecognizedModels.join('、')}），未计入汇总。`
        : `另有 ${cur.unpricedCalls} 次调用未匹配到模型记录，未计入汇总。`)
      : '';
    set('winNote', note);
    $('winNote').hidden = !note;
  }

  function bindEvents() {
    const dayEl = $('monthDay');
    if (!dayEl.options.length) {
      for (let d = 1; d <= 31; d++) dayEl.append(new Option(`${d} 日`, String(d)));
    }
    $('toggleWinSettings').addEventListener('click', () => {
      const panel = $('winSettings');
      panel.hidden = !panel.hidden;
      $('toggleWinSettings').setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden && lastWindows) syncWindowInputs(lastWindows);
    });
    for (const tab of document.querySelectorAll('.seg-tab[data-win]')) {
      tab.addEventListener('click', () => {
        userPickedTab = true;
        activeWindow = tab.dataset.win;
        if (activeWindow === 'fiveHour' || activeWindow === 'week') calScope = activeWindow;
        syncTabButtons();
        if (lastWindows) render(lastWindows);
      });
    }
    for (const tab of document.querySelectorAll('.seg-tab[data-cal]')) {
      tab.addEventListener('click', () => {
        calScope = tab.dataset.cal;
        syncTabButtons();
        if (lastWindows) syncWindowInputs(lastWindows);
      });
    }
    $('planMode').addEventListener('change', () => {
      const nextPlan = $('planMode').value;
      if (nextPlan === 'free') {
        if (activeWindow === 'fiveHour') activeWindow = 'week';
        calScope = 'week';
      } else if (!userPickedTab) {
        activeWindow = nextPlan === 'ultra' ? 'fiveHour' : 'week';
        calScope = activeWindow;
      }
      saveWindows({ plan: nextPlan });
    });
    $('monthDay').addEventListener('change', () => saveWindows({ monthStartDay: Number($('monthDay').value) }));
    $('monthTime').addEventListener('change', () => { if ($('monthTime').value) saveWindows({ monthStartTime: $('monthTime').value }); });
  }

  bindEvents();
  return { render };
}

window.__agyWindowsUI = createWindowsPanel;
})();
