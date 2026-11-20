(() => {
  'use strict';

  const MINUTE = 60_000;
  const DAY = 24 * 60;
  const MAX_RESETS = 3;
  const EPSILON = 1e-7;
  const SERVICE_ERROR = '计算服务暂时不可用，请重试。';
  const failedChoice = { error: '备选时段检查失败，可以重试。' };
  const canAdjust = choice => Boolean(choice && !choice.pending);
  const copy = window.ResetwiseCopy;
  const { t } = copy;
  const get = id => document.getElementById(id);
  const form = get('settings');
  const announcements = get('announcements');
  const addReset = get('add-reset');
  const continuousOnly = get('renew-continuous-only');
  const cardFields = get('cards');
  const resultBody = get('result-body');
  const resultStatus = get('result-status');
  const recalculate = get('recalculate');
  const ticketActions = get('ticket-actions');
  const adjustmentPanel = get('plan-adjustment');
  const restorePlan = get('restore-plan');
  const usageDetails = get('usage-details');
  const planChart = get('plan-chart');
  const chartTooltip = get('plan-chart-tooltip');
  const resultsPanel = planChart.closest('.results');
  const planShortcut = get('plan-shortcut');
  const exampleButton = get('load-example');
  const languageButton = get('language-toggle');
  const pendingRequests = new Map();
  const prefilledTimes = new Map();
  let prefilledZone;
  let dayFormat, fullDateFormat, clockFormat, offsetClockFormat, percentFormat;
  let nextAnnouncement = 0;
  let nextCard = 0;
  let revision = 0;
  let example = true;
  let lastPlan = null;
  let originalPlan = null;
  let activeChoices = null;
  let adjustment = null;
  let chartTipAnchor = null;
  let chartTipTimer;
  let lastError = null;
  let statusLabels = ['正在载入示例', '正在计算'];

  const mode = () => form.elements.mode.value;
  const number = id => get(id).valueAsNumber;
  const text = (id, value) => { get(id).textContent = value; };
  const quotaPercent = value => value > 0 && value < 0.01 ? '<0.01%' : percentFormat.format(value / 100);
  const dateAt = at => new Date(at * MINUTE);
  function dateLabel(at, clock = clockFormat) {
    const date = dateAt(at);
    const formatter = date.getFullYear() === new Date().getFullYear() ? dayFormat : fullDateFormat;
    return formatter.format(date) + ' ' + clock.format(date);
  }
  function windowLabel(period) {
    const start = dateAt(period.start);
    const end = dateAt(period.end);
    const offsetChanges = start.getTimezoneOffset() !== end.getTimezoneOffset()
      || [period.start, period.end].some(at =>
        dateAt(at - DAY).getTimezoneOffset() !== dateAt(at + DAY).getTimezoneOffset());
    const clock = offsetChanges ? offsetClockFormat : clockFormat;
    const from = dateLabel(period.start, clock);
    if (period.start === period.end) return from;
    if (start.toDateString() === end.toDateString()) {
      return from + '–' + clock.format(end);
    }
    return from + ' – ' + dateLabel(period.end, clock);
  }
  function localValue(date) {
    const pad = number => String(number).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function dateFromInput(id) {
    const value = get(id).value;
    const imported = prefilledTimes.get(id);
    return imported?.value === value ? dateAt(imported.at) : new Date(value);
  }
  function timestamp(id) {
    const field = get(id);
    const value = field.value;
    if (!value || field.disabled) return null;
    const date = dateFromInput(id);
    if (Number.isNaN(date.getTime()) || localValue(date) !== value) {
      throw Object.assign(new RangeError('请输入该时区中有效的日期和分钟。'), { field: id });
    }
    return date.getTime() / MINUTE;
  }

  function showFields(id, enabled) {
    const element = get(id);
    element.hidden = !enabled;
    for (const field of element.querySelectorAll('input, select')) field.disabled = !enabled;
  }

  function syncForm() {
    const healthy = mode() === 'healthy';
    const short = get('short-enabled').checked;
    const ios = get('subscription-ios').checked;
    const grace = ios ? number('grace-days') : 0;
    const renew = get('subscription-renew').checked;
    const days = get('renew-days').value;
    const recorded = dateFromInput('snapshot').getTime();
    const paidEnd = dateFromInput('subscription-end');
    const endDay = paidEnd.getDate();
    const expiry = paidEnd.getTime() + Math.round(grace * DAY) * MINUTE;
    const current = !(expiry <= (Number.isFinite(recorded) ? recorded : Math.floor(Date.now() / MINUTE) * MINUTE));
    const count = announcements.children.length;
    showFields('awake-hours', healthy);
    showFields('weekly-fields', current);
    showFields('long-start-field', current);
    showFields('short-fields', short);
    showFields('short-balance-field', short && current);
    showFields('short-refresh-field', short && current);
    showFields('grace-fields', ios);
    showFields('renew-fields', renew);
    const monthEnd = endDay < 31 && endDay === new Date(paidEnd.getFullYear(), paidEnd.getMonth() + 1, 0).getDate();
    showFields('billing-day-field', renew && current && !days && (monthEnd || (prefilledZone && get('billing-day').value)));
    exampleButton.textContent = t(example ? '填写我的额度' : '载入示例');
    text('short-note', t(short ? '已启用' : '未启用'));
    const subscriptionNotes = [];
    if (ios) subscriptionNotes.push(grace > 0 ? t('iOS · +{days} 天', { days: grace }) : 'iOS');
    if (renew) {
      const term = days ? t('续订 {days} 天', { days }) : t('按月续订');
      subscriptionNotes.push(continuousOnly.checked ? t('只连续续订') : term);
    }
    text('subscription-note', subscriptionNotes.join(' · '));
    text('reset-note', `${count} / ${MAX_RESETS}`);
    addReset.disabled = count >= MAX_RESETS;
    [...announcements.children].forEach((row, index) => {
      row.querySelector('legend').textContent = t('公告 {number}', { number: index + 1 });
      row.querySelector('button').setAttribute('aria-label', t('移除公告 {number}', { number: index + 1 }));
    });
    [...cardFields.children].forEach((row, index) => {
      const number = index + 1;
      row.querySelector('label span').textContent = t('第 {number} 张到期', { number });
      const remove = row.querySelector('button');
      remove.hidden = cardFields.children.length === 1;
      remove.setAttribute('aria-label', t('移除第 {number} 张重置卡', { number }));
    });
  }

  function formInput() {
    const extraReset = announcements.children[MAX_RESETS];
    if (extraReset) {
      throw Object.assign(new RangeError(`最多可添加 ${MAX_RESETS} 条自动重置公告。`),
        { field: extraReset.querySelector('[data-key="time"]').id });
    }
    for (const field of form.elements) {
      if (!field.willValidate || field.validity.valid) continue;
      let message = '请检查此项的值。';
      if (field.validity.badInput) message = '请输入有效的数值或日期。';
      else if (field.validity.valueMissing) message = '请填写此项。';
      else if (field.validity.rangeUnderflow) message = '此项最小为 {min}。';
      else if (field.validity.rangeOverflow) message = '此项最大为 {max}。';
      else if (field.validity.stepMismatch) {
        message = field.type === 'number' ? '请填写整数。' : '请输入精确到分钟的时间。';
      }
      throw Object.assign(new RangeError(message), { field: field.id, values: { min: field.min, max: field.max } });
    }

    function minutes(id) {
      const [hour, minute] = get(id).value.split(':').map(Number);
      return hour * 60 + minute;
    }

    const billingDay = get('billing-day');
    return {
      timeZone: prefilledZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      snapshot: timestamp('snapshot') ?? Math.floor(Date.now() / MINUTE),
      mode: mode(),
      hours: [minutes('awake-start'), minutes('awake-end')],
      subscription: {
        end: timestamp('subscription-end'),
        channel: get('subscription-ios').checked ? 'ios' : 'web',
        graceDays: get('grace-days').disabled ? 0 : number('grace-days'),
        renew: get('subscription-renew').checked,
        allowLapse: continuousOnly.disabled || !continuousOnly.checked,
        renewDays: get('renew-days').value ? number('renew-days') : null,
        billingDay: billingDay.disabled || !billingDay.value ? null : billingDay.valueAsNumber,
      },
      long: {
        start: timestamp('long-start'),
        end: timestamp('long-end'),
        remaining: number('long-left'),
      },
      short: get('short-enabled').checked ? {
        end: timestamp('short-end'),
        amount: number('short-amount'),
        remaining: number('short-left'),
      } : null,
      card: { restart: !get('card-preserve').checked },
      cards: [...cardFields.querySelectorAll('input')].map(field => ({ until: timestamp(field.id), field: field.id })),
      resets: [...announcements.children].map(row => ({
        at: timestamp(row.querySelector('[data-key="time"]').id),
      })),
    };
  }

  function addCard(value = '') {
    const row = get('card-template').content.firstElementChild.cloneNode(true);
    const input = row.querySelector('input');
    input.id = 'card-until-' + ++nextCard;
    input.value = value;
    row.querySelector('button').addEventListener('click', () => {
      row.remove();
      changed();
      get('add-card').focus();
    });
    copy.apply(row);
    cardFields.append(row);
    return input;
  }

  function addAnnouncement() {
    const row = get('announcement-template').content.firstElementChild.cloneNode(true);
    const timeInput = row.querySelector('[data-key="time"]');
    timeInput.id = 'announcement-' + ++nextAnnouncement;
    row.querySelector('button').addEventListener('click', () => {
      row.remove();
      changed();
      const target = addReset.disabled ? announcements.lastElementChild.querySelector('button') : addReset;
      target.focus();
    });
    copy.apply(row);
    announcements.append(row);
    return timeInput;
  }

  function clearError() {
    lastError = null;
    const error = get('form-error');
    if (error.dataset.field) {
      const field = get(error.dataset.field);
      field?.removeAttribute('aria-invalid');
      field?.removeAttribute('aria-errormessage');
      delete error.dataset.field;
    }
    error.hidden = true;
  }

  function drawStatus() {
    resultStatus.textContent = t(statusLabels[0]);
    text('shortcut-label', t(statusLabels[1]));
  }

  function setStatus(desktop, mobile = desktop) {
    statusLabels = [desktop, mobile];
    drawStatus();
  }

  function drawError() {
    if (!lastError) return;
    const { message, values, field, service } = lastError;
    text('form-error', t(service || get(field) ? message : '计算失败。请检查输入后重新计算。', values));
  }

  function showError(error) {
    lastError = error;
    resultBody.setAttribute('aria-busy', 'false');
    resultBody.dataset.stale = 'true';
    setStatus(error.service && !error.field ? '待计算' : '请检查计算条件');
    recalculate.hidden = resultBody.hidden;
    const notice = get('form-error');
    const field = get(error.field);
    drawError();
    notice.hidden = false;
    if (field) {
      const group = field.closest('details');
      if (group) group.open = true;
      notice.dataset.field = field.id;
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-errormessage', notice.id);
      field.focus();
    } else {
      console.error(error);
    }
  }

  function changed() {
    revision++;
    resetAdjustment();
    clearError();
    syncForm();
    resultBody.setAttribute('aria-busy', 'false');
    resultBody.dataset.stale = 'true';
    setStatus('待计算');
    recalculate.hidden = resultBody.hidden;
  }

  function scopeText(scope) {
    return t({ 1: '周额度', 2: '5 小时额度', 3: '周额度和 5 小时额度' }[scope] ?? '');
  }

  const cardName = number => t('第 {number} 张重置卡', { number });
  const renewalLabel = kind => t(kind === 'restart' ? '转免费后重新订阅' : '连续续订');
  const gainHundredths = gain => Math.sign(gain) * Math.round(Math.abs(gain) * 100);

  function cardGainLabel(gain) {
    const sign = gain > EPSILON ? '+' : gain < -EPSILON ? '−' : '';
    return t('真实额度 {value}', { value: sign + quotaPercent(sign ? Math.abs(gain) : 0) });
  }

  function actionsFor(result) {
    const totalGain = result.total - result.baseline;
    let cumulativeGain = 0;
    let displayedHundredths = 0;
    const actions = result.cards.map((card, index) => {
      // Round the cumulative gain so the displayed differences still add up.
      cumulativeGain += card.gain;
      const rounded = gainHundredths(index === result.cards.length - 1 ? totalGain : cumulativeGain);
      const gain = cardGainLabel((rounded - displayedHundredths) / 100);
      displayedHundredths = rounded;
      return {
        key: card.number, at: card.at, title: t('使用第 {number} 张重置卡', { number: card.number }),
        value: windowLabel(card.window),
        detail: card.window.start === card.window.end ? '' : t('示例时刻 {time}', { time: dateLabel(card.at) }),
        gain,
      };
    });
    const renewal = result.renewal;
    if (renewal) {
      const restart = renewal.kind === 'restart';
      actions.push({ key: 'renewal', at: restart ? renewal.at : null, title: renewalLabel(renewal.kind),
        value: restart ? t('{time} 起', { time: dateLabel(renewal.at) }) : '',
        detail: t(restart ? '若已开启自动续订，先关闭。确认转为免费后再订阅。' : '额度与刷新时间沿用原周期。') });
    }
    return actions.sort((left, right) => (left.at ?? Infinity) - (right.at ?? Infinity));
  }

  function drawAdjustment() {
    for (const [request, isCurrent] of pendingRequests) if (!isCurrent()) request.abort();
    restorePlan.hidden = !originalPlan || lastPlan.result === originalPlan;
    let trigger;
    for (const button of ticketActions.querySelectorAll('.ticket-adjust')) {
      const choices = activeChoices?.get(button.dataset.action);
      const selected = button.dataset.action === String(adjustment?.action);
      const checking = selected && (choices?.[-1]?.pending || choices?.[1]?.pending);
      button.hidden = !checking && !canAdjust(choices?.[-1]) && !canAdjust(choices?.[1]);
      const open = !button.hidden && selected;
      button.setAttribute('aria-expanded', String(open));
      if (open) trigger = button;
    }
    adjustmentPanel.hidden = !trigger;
    if (!trigger) {
      if (adjustmentPanel.previousElementSibling !== ticketActions) ticketActions.after(adjustmentPanel);
      return;
    }
    const row = trigger.closest('li');
    if (adjustmentPanel.parentElement !== row) row.append(adjustmentPanel);

    const { pending, preview, message } = adjustment;
    const sides = (preview?.choices ?? activeChoices).get(trigger.dataset.action);
    for (const [direction, id, label, retry] of [
      [-1, 'adjust-earlier', '更早', '重试更早'], [1, 'adjust-later', '更晚', '重试更晚'],
    ]) {
      const button = get(id);
      const choice = sides[direction];
      button.disabled = pending || !canAdjust(choice);
      if (adjustment.action === 'renewal') {
        const method = renewalLabel(direction < 0 ? 'continue' : 'restart');
        button.textContent = choice?.error ? t('重试 · {action}', { action: method }) : method;
      } else {
        button.textContent = t(choice?.error ? retry : label);
      }
    }
    get('adjust-preview').hidden = !preview;
    get('adjust-use').disabled = pending;
    const feedback = preview ? [t('可用额度仍为 {value}', { value: quotaPercent(preview.result.total) })] : [];
    const failure = sides[-1]?.error ?? sides[1]?.error;
    if (pending) feedback.push(t('正在载入备选方案…'));
    else if (message) feedback.push(t(message));
    else if (sides[-1]?.pending || sides[1]?.pending) feedback.push(t('正在检查其他时段…'));
    else if (failure) feedback.push(t(failure));
    text('adjust-message', feedback.join(' · '));
    if (!preview) return;

    const active = new Map(actionsFor(lastPlan.result).map(action => [action.key, action]));
    const changes = actionsFor(preview.result).filter(next => {
      const current = active.get(next.key);
      return current.at !== next.at || current.title !== next.title || current.value !== next.value || current.gain !== next.gain;
    });
    if (preview.result.end !== lastPlan.result.end) {
      changes.push({ title: t('订阅可用至'), value: dateLabel(preview.result.end) });
    }
    get('adjust-changes').replaceChildren(...changes.flatMap(({ title, value, gain, detail }) => {
      const name = document.createElement('dt');
      const time = document.createElement('dd');
      name.textContent = title;
      time.textContent = value || detail || '';
      if (gain) time.append(document.createElement('br'), gain);
      return [name, time];
    }));
  }

  function resetAdjustment() {
    originalPlan = null;
    activeChoices = null;
    adjustment = null;
    drawAdjustment();
  }

  function prepareChoices(result, actions, choices, isCurrent, directions = [-1, 1]) {
    const jobs = [];
    const pending = { pending: true };
    for (const action of actions) {
      const key = String(action);
      if (!choices.has(key)) choices.set(key, {});
      const sides = choices.get(key);
      for (const direction of directions) {
        if (sides[direction] !== undefined) continue;
        sides[direction] = pending;
        jobs.push({ action, direction });
      }
    }
    if (!jobs.length) return;
    function finish(error) {
      const failure = error?.message ? { error: error.message } : failedChoice;
      for (const { action, direction } of jobs) {
        const sides = choices.get(String(action));
        if (sides[direction] === pending) sides[direction] = failure;
      }
      drawAdjustment();
    }
    requestPlan({ operation: 'choices', plan: result.planToken, jobs }, isCurrent, finish, error => {
      console.error(error);
      finish(error);
    }, ({ action, direction, choice, error }) => {
      const sides = choices.get(String(action));
      if (sides?.[direction] !== pending) return;
      if (error) sides[direction] = error.message ? { error: error.message } : failedChoice;
      else if (typeof choice === 'string') sides[direction] = { candidate: choice };
      else sides[direction] = choice === null ? null : failedChoice;
      drawAdjustment();
    });
  }

  function prepareActiveChoices(result, choices = new Map()) {
    activeChoices = choices;
    const actions = result.cards.map(card => card.number);
    if (result.renewal) actions.push('renewal');
    prepareChoices(result, actions, choices, () => activeChoices === choices);
  }

  function toggleAdjustment(action) {
    const choices = activeChoices?.get(String(action));
    if (adjustment?.action !== action && !canAdjust(choices?.[-1]) && !canAdjust(choices?.[1])) return;
    adjustment = adjustment?.action === action ? null : { action, preview: null, pending: false };
    drawAdjustment();
  }

  function closeAdjustment() {
    const trigger = ticketActions.querySelector('.ticket-adjust[aria-expanded="true"]');
    adjustment = null;
    drawAdjustment();
    trigger?.focus();
  }

  function findAdjustment(direction) {
    const edit = adjustment;
    if (!edit || edit.pending) return;
    const { result } = lastPlan;
    const key = String(edit.action);
    const base = edit.preview?.result ?? result;
    const choices = edit.preview?.choices ?? activeChoices;
    const sides = choices.get(key);
    const choice = sides?.[direction];
    if (!canAdjust(choice)) return;
    const navigation = get(direction < 0 ? 'adjust-earlier' : 'adjust-later');
    const restoreFocus = document.activeElement === navigation;
    edit.message = '';

    if (choice.error) {
      sides[direction] = undefined;
      prepareChoices(base, [edit.action], choices,
        () => activeChoices === choices || adjustment?.preview?.choices === choices, [direction]);
      drawAdjustment();
      return;
    }

    function showAlternate(alternate) {
      edit.pending = false;
      if (alternate === result) {
        edit.preview = null;
      } else {
        // The plan we just came from is already a verified choice in the reverse direction.
        const nextChoices = new Map([[key, { [-direction]: { result: base } }]]);
        const preview = { result: alternate, choices: nextChoices };
        edit.preview = preview;
        prepareChoices(alternate, [edit.action], nextChoices, () => activeChoices === nextChoices || adjustment?.preview === preview);
      }
      drawAdjustment();
      if (restoreFocus && (document.activeElement === document.body || document.activeElement === navigation)) {
        const target = navigation.disabled ? adjustmentPanel.querySelector('button:not(:disabled)') : navigation;
        target?.focus({ preventScroll: true });
      }
    }
    if (choice.result) {
      showAlternate(choice.result);
      return;
    }
    edit.pending = true;
    drawAdjustment();
    requestPlan({ operation: 'describe', plan: base.planToken, candidate: choice.candidate },
      () => adjustment === edit, showAlternate, error => {
        edit.pending = false;
        edit.message = error.message;
        drawAdjustment();
        console.error(error);
      });
  }

  function renderPlanTimeline(result, input, actions) {
    const hours = get('plan-steps-hours');
    hours.hidden = input.mode !== 'healthy';
    if (!hours.hidden) {
      const [open, close] = input.hours;
      const clock = minutes => [Math.floor(minutes / 60), minutes % 60]
        .map(value => String(value).padStart(2, '0')).join(':');
      hours.textContent = t(close < open ? '每天 {from}–次日 {to}' : '每天 {from}–{to}', {
        from: clock(open), to: clock(close),
      });
    }
    const steps = [];
    let index = 0;
    let phaseStart = result.start;
    function usageUntil(at) {
      const windows = result.usageWindows;
      let total = 0;
      while (index < windows.length && windows[index].start < at) total += windows[index++].amount;
      if (total > EPSILON) steps.push({ phase: true, title: windowLabel({ start: phaseStart, end: at }),
        value: t('阶段用量 {value}', { value: quotaPercent(total) }) });
      phaseStart = at;
    }
    for (const action of actions) {
      usageUntil(action.at);
      steps.push(action);
    }
    usageUntil(result.end);

    const template = get('plan-step-template');
    get('plan-steps-list').replaceChildren(...steps.map(({ key, title, value, detail, gain, phase }) => {
      const row = template.content.firstElementChild.cloneNode(true);
      row.className = phase ? 'plan-phase' : key === 'renewal' ? 'plan-node renewal' : 'plan-node card';
      row.querySelector('strong').textContent = title;
      const valueLabel = row.querySelector('.step-value');
      valueLabel.textContent = value;
      valueLabel.hidden = !value;
      const note = row.querySelector('.step-detail');
      note.textContent = detail || gain || '';
      if (detail && gain) note.append(document.createElement('br'), gain);
      note.hidden = !note.textContent;
      return row;
    }));
  }

  function renderPlanRows(events, usageWindows) {
    const rows = new Map(usageWindows.map(period => [period.start, { period, events: [] }]));
    for (const event of events) {
      if (!rows.has(event.at)) rows.set(event.at, { events: [] });
      rows.get(event.at).events.push(event);
    }
    const body = document.createDocumentFragment();
    for (const [at, { period, events: labels }] of [...rows].sort(([left], [right]) => left - right)) {
      const row = document.createElement('tr');
      const when = document.createElement('th');
      when.scope = 'row';
      when.textContent = windowLabel(period ?? { start: at, end: at });
      if (labels.length) {
        const milestones = document.createElement('div');
        milestones.className = 'plan-milestones';
        for (const event of labels) {
          const label = document.createElement('span');
          label.className = 'timeline-name ' + event.type;
          label.textContent = event.title;
          milestones.append(label);
        }
        when.append(milestones);
      }
      row.append(when);
      row.insertCell().textContent = period ? quotaPercent(period.amount) : '';
      body.append(row);
    }
    get('plan-rows').replaceChildren(body);
  }

  function chartScale(start, end, periods) {
    const folds = [];
    let cursor = start;
    const edge = 3 * 60;
    if (periods.length) {
      for (const period of [...periods, { start: end, end }]) {
        const gap = period.start - cursor;
        // Keep a short stretch at the original scale next to each operation.
        if (gap >= 3 * DAY) folds.push({ start: cursor + edge, end: period.start - edge, saved: gap - DAY });
        cursor = Math.max(cursor, period.end);
      }
    }
    const length = end - start - folds.reduce((total, fold) => total + fold.saved, 0);
    function position(at) {
      let offset = at - start;
      for (const fold of folds) {
        if (at <= fold.start) break;
        offset -= fold.saved * Math.min(1, (at - fold.start) / (fold.end - fold.start));
      }
      return offset * 100 / length;
    }
    return { folds, position };
  }

  function fitChartTicks() {
    const axis = get('plan-chart-axis');
    const width = axis.clientWidth;
    if (!width || axis.childElementCount < 3) return;
    const ticks = [...axis.children];
    const gap = 5;
    let right = ticks[0].offsetWidth + gap;
    const limit = width - ticks.at(-1).offsetWidth - gap;
    for (const tick of ticks.slice(1, -1)) {
      tick.hidden = false;
      const center = Number(tick.dataset.position) * width / 100;
      const half = tick.offsetWidth / 2;
      tick.hidden = center - half < right || center + half > limit;
      if (!tick.hidden) right = center + half + gap;
    }
  }

  function placeChartTooltip() {
    if (!chartTipAnchor) return;
    const anchor = chartTipAnchor.getBoundingClientRect();
    const chart = planChart.getBoundingClientRect();
    const viewport = resultsPanel.getBoundingClientRect();
    const gap = 7;
    const margin = 6;
    const center = (anchor.left + anchor.right) / 2 - chart.left - planChart.clientLeft;
    const left = Math.max(margin, Math.min(center - chartTooltip.offsetWidth / 2,
      planChart.clientWidth - chartTooltip.offsetWidth - margin));
    const above = anchor.top - Math.max(viewport.top, 0);
    const below = Math.min(viewport.bottom, window.innerHeight) - anchor.bottom;
    const showAbove = above >= chartTooltip.offsetHeight + gap || above > below;
    const top = (showAbove ? anchor.top - chartTooltip.offsetHeight - gap : anchor.bottom + gap)
      - chart.top - planChart.clientTop;
    chartTooltip.style.left = left + 'px';
    chartTooltip.style.top = top + 'px';
  }

  function hideChartTooltip() {
    clearTimeout(chartTipTimer);
    chartTipAnchor?.removeAttribute('aria-describedby');
    chartTipAnchor = null;
    chartTooltip.hidden = true;
  }

  function releaseChartTooltip(mark) {
    if (mark !== chartTipAnchor || mark.matches(':focus-visible')) return;
    clearTimeout(chartTipTimer);
    chartTipTimer = setTimeout(hideChartTooltip, 160);
  }

  function attachChartTooltip(mark, title, time, quota = '') {
    mark.setAttribute('aria-label', title);
    function show() {
      clearTimeout(chartTipTimer);
      chartTipAnchor?.removeAttribute('aria-describedby');
      chartTipAnchor = mark;
      text('plan-chart-tooltip-title', title);
      text('plan-chart-tooltip-time', time);
      const quotaLine = get('plan-chart-tooltip-quota');
      quotaLine.textContent = quota;
      quotaLine.hidden = !quota;
      chartTooltip.hidden = false;
      mark.setAttribute('aria-describedby', chartTooltip.id);
      placeChartTooltip();
    }
    mark.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') show();
    });
    mark.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'touch') releaseChartTooltip(mark);
    });
    mark.addEventListener('focus', show);
    mark.addEventListener('blur', () => {
      if (!mark.matches(':hover')) releaseChartTooltip(mark);
    });
    mark.addEventListener('click', show);
  }

  function renderPlanChart(result, actions) {
    const { start, end, cards, renewal } = result;
    const actionDetails = new Map(actions.map(action => [action.key, action]));
    const periods = cards.map(({ number, window }) => ({
      key: number, label: t('第 {number} 张', { number }), kind: 'card', start: window.start,
      end: Math.min(window.end + 1, end),
    }));
    if (renewal?.kind === 'restart') {
      periods.push({ key: 'renewal', label: t('续订'), kind: 'renewal', start: renewal.at, end: renewal.at });
    }
    periods.sort((left, right) => left.start - right.start);
    const { folds, position } = chartScale(start, end, periods);
    const routine = { label: t('常规使用'), kind: 'routine', start, end,
      time: windowLabel({ start, end }) + ' · ' + quotaPercent(result.total) };
    const labels = [];
    const tracks = [];
    for (const period of periods.length ? periods : [routine]) {
      const label = document.createElement('span');
      label.textContent = period.label;
      labels.push(label);
      const track = document.createElement('div');
      track.className = 'plan-chart-track';
      const mark = document.createElement('button');
      mark.type = 'button';
      const from = position(period.start);
      const to = position(period.end);
      mark.className = 'plan-chart-mark ' + (period.start === period.end ? 'plan-chart-point ' : 'plan-chart-bar ') + period.kind;
      mark.style.setProperty('--chart-at', from + '%');
      mark.style.setProperty('--chart-width', to - from + '%');
      const action = actionDetails.get(period.key);
      attachChartTooltip(mark, action?.title ?? period.label, action?.value ?? period.time, action?.gain);
      track.append(mark);
      tracks.push(track);
    }
    get('plan-chart-labels').replaceChildren(...labels);
    get('plan-chart-tracks').replaceChildren(...tracks);
    get('plan-chart-folds').replaceChildren(...folds.map(fold => {
      const band = document.createElement('span');
      band.className = 'plan-chart-fold';
      const left = position(fold.start);
      band.style.left = left + '%';
      band.style.width = position(fold.end) - left + '%';
      band.title = windowLabel(fold);
      return band;
    }));
    get('plan-chart-note').hidden = !folds.length;

    const sameDay = dateAt(start).toDateString() === dateAt(end).toDateString();
    const labelAt = at => (sameDay ? clockFormat : dayFormat).format(dateAt(at));
    const seen = new Set([labelAt(start), labelAt(end)]);
    const anchors = periods.length ? periods.flatMap(period => [period.start, period.end]) : [Math.floor((start + end) / 2)];
    const ticks = [start];
    for (const at of anchors.sort((left, right) => left - right)) {
      const label = labelAt(at);
      if (at > start && at < end && !seen.has(label)) {
        seen.add(label);
        ticks.push(at);
      }
    }
    ticks.push(end);
    get('plan-chart-axis').replaceChildren(...ticks.map(at => {
      const tick = document.createElement('span');
      const offset = position(at);
      tick.className = 'plan-chart-tick';
      tick.dataset.position = offset;
      tick.style.setProperty('--chart-at', offset + '%');
      tick.textContent = labelAt(at);
      tick.title = dateLabel(at);
      return tick;
    }));
    fitChartTicks();
  }

  function renderUsageDetails(result, input) {
    const events = [{ at: result.start, type: 'start', title: t('推演开始') }];
    if (input.long.start !== null && result.start < result.accessEnd) {
      events.push({ at: input.long.start, type: 'start', title: t('本轮周额度开始') });
    }
    for (const event of result.events) {
      if (event.type === 'renewal' && event.kind === 'continue') continue;
      const title = t({ cycle: '{quota}刷新', announced: '公告重置 · {quota}', card: '使用第 {number} 张重置卡重置额度',
        lapse: '转为免费', renewal: '重新订阅 · 额度重置' }[event.type], {
        quota: scopeText(event.scope), number: event.number,
      });
      events.push({ ...event, type: event.type === 'cycle' && event.scope === 2 ? 'short' : event.type, title });
    }
    input.cards.forEach(({ until: at }, index) => {
      events.push({ at, type: 'card-expiry', title: t('第 {number} 张重置卡到期', { number: index + 1 }) });
    });
    const hasGrace = input.subscription.end < result.accessEnd
      && (result.renewal?.kind !== 'continue' || result.renewal.grace);
    if (hasGrace) {
      events.push({ at: input.subscription.end, type: 'grace', title: t('订阅到期 · 开始宽限期') });
    }
    events.push({ at: result.end, type: 'end', title: t('订阅可用期结束') });

    renderPlanRows(events, result.usageWindows);
  }

  function renderPlanDetail(result, input, actions) {
    hideChartTooltip();
    const panel = get('plan-detail');
    panel.hidden = result.start >= result.end;
    if (panel.hidden) return;

    const exampleNote = get('usage-scenario');
    exampleNote.hidden = result.cards.length < 2;
    exampleNote.textContent = t('每张卡的时段以其他操作按示例时刻为准。');
    renderPlanChart(result, actions);
    renderPlanTimeline(result, input, actions.filter(action => action.at !== null));
    if (usageDetails.open) renderUsageDetails(result, input);
  }

  function drawPlan(result, input) {
    const actions = actionsFor(result);
    const expired = result.start >= result.end;
    text('recommendation', t(expired ? '订阅已到期' : '安排 {used} / {total} 张', {
      used: result.cards.length, total: input.cards.length,
    }));
    const unused = result.unusedCards.map(cardName).join(t('、'));
    text('recommendation-detail', t('未安排 {cards}', { cards: unused }));
    get('recommendation-detail').hidden = !unused;
    ticketActions.hidden = !actions.length;
    ticketActions.replaceChildren(...actions.map(action => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const value = document.createElement('strong');
      const timing = document.createElement('div');
      timing.className = 'ticket-action-time';
      const adjust = document.createElement('button');
      adjust.type = 'button';
      adjust.className = 'ticket-adjust';
      adjust.dataset.action = action.key;
      const renewal = action.key === 'renewal';
      adjust.textContent = t(renewal ? '更换续订方式' : '调整');
      if (!renewal) adjust.setAttribute('aria-label', t('调整时段 · {action}', { action: action.title }));
      adjust.setAttribute('aria-controls', adjustmentPanel.id);
      adjust.addEventListener('click', () => toggleAdjustment(action.key));
      label.textContent = action.title;
      if (action.gain) {
        const gain = document.createElement('span');
        gain.className = 'ticket-card-gain';
        gain.textContent = action.gain;
        gain.title = t('按示例时刻逐张加入，计入自然刷新变化');
        label.append(gain);
      }
      value.textContent = action.value;
      value.hidden = !action.value;
      timing.append(value, adjust);
      row.append(label, timing);
      return row;
    }));
    const gain = gainHundredths(result.total - result.baseline) / 100;
    const gainLabel = gain > EPSILON ? '+' + quotaPercent(gain) : '';
    get('gain-metric').hidden = gain <= EPSILON;
    get('shortcut-gain').hidden = gain <= EPSILON;
    text('gain', gainLabel);
    text('access-end', dateLabel(result.end));
    get('comparison').hidden = expired;
    text('baseline', quotaPercent(result.baseline));
    get('plan-row').hidden = !result.cards.length;
    text('plan-total', quotaPercent(result.total));
    const max = Math.max(1, result.total, result.baseline);
    get('baseline-bar').style.width = result.baseline / max * 100 + '%';
    get('plan-bar').style.width = result.total / max * 100 + '%';
    renderPlanDetail(result, input, actions);
    text('shortcut-time', get('recommendation').textContent);
    text('shortcut-gain', gainLabel);
    drawAdjustment();
  }

  function showPlan(result, input, pending = false) {
    lastPlan = { result, input };
    drawPlan(result, input);
    if (pending) setStatus('初步方案 · 继续比较中');
    else if (result !== originalPlan) setStatus('已采用调整方案', '使用方案');
    else setStatus(example ? '示例' : '已计算', example ? '示例' : '使用方案');
    resultBody.hidden = false;
    planShortcut.hidden = false;
    resultBody.removeAttribute('data-stale');
    resultBody.setAttribute('aria-busy', String(pending));
  }

  function serviceError(problem) {
    return Object.assign(new Error(problem?.message ?? SERVICE_ERROR), { field: problem?.field, service: true });
  }

  async function requestPlan(body, isCurrent, done, failed, progress) {
    if (!isCurrent()) return;
    const request = new AbortController();
    pendingRequests.set(request, isCurrent);
    let reader;
    try {
      const response = await fetch('/api/plan', { method: 'POST', signal: request.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw serviceError(await response.json());
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      while (isCurrent()) {
        const chunk = await reader.read();
        if (!isCurrent()) return;
        if (chunk.done) throw serviceError();
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          const { type, value } = JSON.parse(line);
          if (type === 'result') return done(value);
          if (type === 'error') throw serviceError(value);
          if (type === 'progress') progress?.(value);
        }
      }
    } catch (error) {
      if (isCurrent() && !request.signal.aborted) failed(error.service ? error : serviceError());
    } finally {
      pendingRequests.delete(request);
      await reader?.cancel().catch(() => {});
    }
  }

  function calculate(showOnMobile = false) {
    const current = ++revision;
    resetAdjustment();
    usageDetails.open = false;
    clearError();
    syncForm();
    let input;
    try {
      input = formInput();
    } catch (error) {
      showError(error);
      return;
    }
    setStatus('正在计算');
    recalculate.hidden = true;
    resultBody.setAttribute('aria-busy', 'true');
    resultBody.dataset.stale = 'true';
    requestPlan({ operation: 'plan', input }, () => current === revision, result => {
      originalPlan = result;
      prepareActiveChoices(result);
      showPlan(result, input);
      if (showOnMobile && matchMedia('(max-width: 700px)').matches) {
        get('results-title').scrollIntoView({ block: 'start' });
        get('results-title').focus({ preventScroll: true });
      }
    }, showError, result => showPlan(result, input, true));
  }

  function resetInputs() {
    prefilledTimes.clear();
    prefilledZone = undefined;
    form.reset();
    announcements.replaceChildren();
    cardFields.replaceChildren();
    for (const group of form.querySelectorAll('details[open]')) group.open = false;
  }

  function loadExample() {
    resetInputs();
    const daysToExpiry = 9;
    const daysToRejoin = daysToExpiry + number('grace-days');
    const rejoin = new Date();
    rejoin.setDate(rejoin.getDate() + 1 + daysToRejoin);
    const monthLength = offset => new Date(rejoin.getFullYear(), rejoin.getMonth() + offset + 1, 0).getDate();
    // A full 31-day term keeps the equal-quota option after resubscribing.
    while (monthLength(0) < 31 || rejoin.getDate() > monthLength(1)) {
      rejoin.setMonth(rejoin.getMonth() + 1, 1);
    }
    const time = (days, hour = 9) => {
      const date = new Date(rejoin);
      date.setDate(date.getDate() - daysToRejoin + days);
      date.setHours(hour, 0, 0, 0);
      return localValue(date);
    };
    const defaults = {
      'long-left': 86,
      'short-left': 100,
      'long-end': time(6),
      'subscription-end': time(daysToExpiry, 17),
      snapshot: time(0),
    };
    for (const [id, value] of Object.entries(defaults)) get(id).value = value;
    for (const expiry of [time(0, 13), time(2), time(30)]) addCard(expiry);
    example = true;
    calculate();
  }

  function startFromBlank() {
    example = false;
    lastPlan = null;
    resetInputs();
    addCard();
    resultBody.hidden = true;
    planShortcut.hidden = true;
    changed();
    get('long-left').focus();
  }

  function loadPrefill() {
    const encoded = new URLSearchParams(location.hash.slice(1)).get('prefill');
    if (encoded === null) return false;
    history.replaceState(history.state, '', location.pathname + location.search);
    try {
      if (!encoded || encoded.length > 32_000) throw new Error();
      const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const input = JSON.parse(new TextDecoder().decode(bytes));
      const { subscription, long, short, cards, resets, card, mode, hours, snapshot, timeZone } = input;
      if (!subscription || !long || !card || !Array.isArray(cards) || !Array.isArray(resets)
        || (mode !== 'extreme' && mode !== 'healthy') || !Array.isArray(hours) || hours.length !== 2) throw new Error();
      const zone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
      resetInputs();
      prefilledZone = zone;
      const write = (id, value) => { get(id).value = value ?? ''; };
      const setTime = (field, at) => {
        if (at == null) return;
        if (!Number.isSafeInteger(at) || !Number.isFinite(dateAt(at).getTime())) throw new Error();
        field.value = localValue(dateAt(at));
        prefilledTimes.set(field.id, { value: field.value, at });
      };
      const clock = minutes => [Math.floor(minutes / 60), minutes % 60].map(part => String(part).padStart(2, '0')).join(':');
      form.elements.mode.value = mode;
      write('awake-start', clock(hours[0]));
      write('awake-end', clock(hours[1]));
      get('subscription-ios').checked = subscription.channel === 'ios';
      get('subscription-renew').checked = subscription.renew === true;
      continuousOnly.checked = subscription.allowLapse === false;
      write('grace-days', subscription.graceDays);
      write('renew-days', subscription.renewDays);
      write('billing-day', subscription.billingDay);
      write('long-left', long.remaining);
      get('short-enabled').checked = short != null;
      if (short) {
        write('short-amount', short.amount);
        write('short-left', short.remaining);
      }
      get('card-preserve').checked = card.restart === false;
      for (const [id, at] of [['subscription-end', subscription.end], ['snapshot', snapshot],
        ['long-start', long.start], ['long-end', long.end], ['short-end', short?.end]]) setTime(get(id), at);
      for (const { until } of cards) setTime(addCard(), until);
      for (const { at } of resets) setTime(addAnnouncement(), at);
      example = false;
      lastPlan = null;
      resultBody.hidden = true;
      planShortcut.hidden = true;
      changed();
      setStatus('已预填 · 待计算');
    } catch {
      startFromBlank();
      showError({ message: '预填链接无效。', service: true });
    }
    return true;
  }

  function applyLanguage(language) {
    copy.setLanguage(language);
    const locale = language === 'en' ? 'en-US' : 'zh-CN';
    const dateOptions = { month: language === 'en' ? 'short' : 'numeric', day: 'numeric' };
    const clockOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    dayFormat = new Intl.DateTimeFormat(locale, dateOptions);
    fullDateFormat = new Intl.DateTimeFormat(locale, { ...dateOptions, year: 'numeric' });
    clockFormat = new Intl.DateTimeFormat(locale, clockOptions);
    offsetClockFormat = new Intl.DateTimeFormat(locale, { ...clockOptions, timeZoneName: 'shortOffset' });
    percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
    copy.apply();
    languageButton.textContent = language === 'en' ? '中文' : 'EN';
    languageButton.lang = language === 'en' ? 'zh-CN' : 'en';
    languageButton.setAttribute('aria-label', language === 'en' ? '切换至中文' : 'Switch to English');
    syncForm();
    drawStatus();
    drawError();
    if (lastPlan) drawPlan(lastPlan.result, lastPlan.input);
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    calculate(true);
  });
  form.addEventListener('input', changed);
  form.addEventListener('change', event => {
    if (event.target.name === 'mode' && !resultBody.hidden) calculate();
  });
  addReset.addEventListener('click', () => {
    const input = addAnnouncement();
    changed();
    input.focus();
  });
  get('add-card').addEventListener('click', () => {
    const input = addCard();
    changed();
    input.focus();
  });
  get('adjust-earlier').addEventListener('click', () => findAdjustment(-1));
  get('adjust-later').addEventListener('click', () => findAdjustment(1));
  get('adjust-close').addEventListener('click', closeAdjustment);
  usageDetails.addEventListener('toggle', () => {
    if (usageDetails.open && lastPlan) renderUsageDetails(lastPlan.result, lastPlan.input);
    else get('plan-rows').replaceChildren();
  });
  function layoutPlanChart() {
    fitChartTicks();
    placeChartTooltip();
  }
  if (window.ResizeObserver) new ResizeObserver(layoutPlanChart).observe(get('plan-chart-axis'));
  else window.addEventListener('resize', layoutPlanChart);
  chartTooltip.addEventListener('pointerenter', () => clearTimeout(chartTipTimer));
  chartTooltip.addEventListener('pointerleave', () => {
    if (chartTipAnchor) releaseChartTooltip(chartTipAnchor);
  });
  document.addEventListener('pointerdown', event => {
    if (chartTipAnchor && !chartTipAnchor.contains(event.target) && !chartTooltip.contains(event.target)) hideChartTooltip();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && chartTipAnchor) hideChartTooltip();
  });
  adjustmentPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAdjustment();
  });
  get('adjust-use').addEventListener('click', () => {
    if (!adjustment?.preview || adjustment.pending) return;
    const { result, choices } = adjustment.preview;
    adjustment.preview = null;
    adjustment.message = '';
    prepareActiveChoices(result, choices);
    showPlan(result, lastPlan.input);
    adjustmentPanel.querySelector('button:not(:disabled)')?.focus();
  });
  restorePlan.addEventListener('click', () => {
    if (!originalPlan) return;
    adjustment = null;
    prepareActiveChoices(originalPlan);
    showPlan(originalPlan, lastPlan.input);
    get('results-title').focus({ preventScroll: true });
  });
  exampleButton.addEventListener('click', () => {
    if (example) startFromBlank();
    else loadExample();
  });
  languageButton.addEventListener('click', () => {
    const language = copy.getLanguage() === 'zh' ? 'en' : 'zh';
    applyLanguage(language);
    copy.rememberLanguage();
  });
  window.addEventListener('hashchange', loadPrefill);
  applyLanguage(copy.getLanguage());
  if (!loadPrefill()) loadExample();
})();
