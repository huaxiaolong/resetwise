const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { planReset, alternatePlan, describeAlternative } = require('./planner.js');

const MINUTE = 60_000;
const HOUR = 60;
const DAY = 24 * HOUR;
const start = new Date(2026, 10, 18, 8).getTime() / MINUTE;

function scenario(overrides = {}) {
  return {
    snapshot: start,
    mode: 'extreme',
    hours: [8 * HOUR, 23 * HOUR],
    rate: 10,
    subscription: { end: start + DAY, channel: 'web', graceDays: 0 },
    long: { start: start - DAY, end: start + 6 * DAY, remaining: 10 },
    short: null,
    card: { from: null, until: start + 30 * DAY, restart: true, threshold: 100 },
    resets: [],
    ...overrides,
  };
}

function finish(search) {
  let result = search.next();
  while (!result.done) result = search.next();
  return result.value;
}

function memoizedSuffix(model, advance) {
  const memo = new Map();
  function advanceToBoundary(state) {
    const next = Math.min(model.segments[state.segment].end, state.longDue, state.shortDue);
    advance(state, next, model);
  }
  return state => {
    advanceToBoundary(state);
    const used = state.used;
    const path = [];
    let remaining = 0;
    while (state.at < model.end) {
      const cached = memo.get(state.at);
      if (cached && cached.long === state.long && cached.short === state.short
        && cached.longDue === state.longDue && cached.shortDue === state.shortDue) {
        remaining = cached.remaining;
        break;
      }
      const step = { at: state.at, long: state.long, short: state.short,
        longDue: state.longDue, shortDue: state.shortDue };
      state.used = 0;
      advanceToBoundary(state);
      step.spent = state.used;
      path.push(step);
    }
    for (const step of path.reverse()) {
      remaining += step.spent;
      step.remaining = remaining;
      memo.set(step.at, step);
    }
    return used + remaining;
  };
}

const planResetDP = input => planReset(input, memoizedSuffix);

function calculate(input) {
  const result = finish(planReset(input));
  const dp = finish(planResetDP(input));
  close(dp.total, result.total);
  if (result.window && dp.window) close(dp.window.minTotal, result.window.minTotal);
  assert.deepEqual(
    { ...dp, total: result.total, window: dp.window && { ...dp.window, minTotal: result.window?.minTotal } },
    result,
  );
  return result;
}

function rejectsInput(input, field) {
  let expected;
  assert.throws(() => finish(planReset(input)), error => {
    assert.equal(error.field, field);
    expected = { name: error.name, message: error.message, field };
    return true;
  });
  assert.throws(() => finish(planResetDP(input)), expected);
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);
}

function minuteByMinuteScores(input) {
  const { snapshot, subscription, long, short, card } = input;
  const grace = subscription.channel === 'ios' ? Math.round(subscription.graceDays * DAY) : 0;
  const end = subscription.end + grace;
  const rate = (input.rate ?? Infinity) / HOUR;
  const [open, closeAt] = input.hours;
  const active = Array.from({ length: end - snapshot }, (_, index) => {
    if (input.mode === 'extreme') return true;
    const local = new Date((snapshot + index) * MINUTE);
    const minute = local.getHours() * HOUR + local.getMinutes();
    return open < closeAt ? open <= minute && minute < closeAt : open <= minute || minute < closeAt;
  });
  const resets = new Map();
  for (const reset of input.resets) {
    resets.set(reset.at, (resets.get(reset.at) ?? 0) | (reset.scope ?? 3));
  }

  function replay(cardAt) {
    let weekly = long.remaining;
    let weeklyDue = long.end;
    let fiveHour = short ? short.amount * short.remaining / 100 : Infinity;
    let fiveHourDue = short?.end ?? Infinity;
    let used = 0;
    function refill(time, mask, restart) {
      if (mask & 1) {
        weekly = 100;
        if (restart) weeklyDue = time + 7 * DAY;
      }
      if (short && (mask & 2)) {
        fiveHour = short.amount;
        if (restart) fiveHourDue = Infinity;
      }
    }

    for (let time = snapshot; time < end; time++) {
      if (weeklyDue === time) refill(time, 1, true);
      if (fiveHourDue === time) refill(time, 2, true);
      refill(time, resets.get(time), true);
      if (!active[time - snapshot]) {
        if (time === cardAt) return null;
        continue;
      }
      if (time === cardAt) {
        const mask = card.scope ?? 3;
        const limit = card.threshold ?? 80;
        const weeklyEligible = (mask & 1) && weekly < limit - 1e-7;
        const fiveHourEligible = short && (mask & 2) && fiveHour < short.amount * limit / 100 - 1e-7;
        if (!weeklyEligible && !fiveHourEligible) return null;
        const weeklyReset = 100 - weekly > 1e-7 ? mask & 1 : 0;
        const fiveHourReset = short && short.amount - fiveHour > 1e-7 ? mask & 2 : 0;
        refill(time, weeklyReset | fiveHourReset, card.restart);
      }
      const spent = Math.min(weekly, fiveHour, rate);
      if (spent > 0 && short && fiveHourDue === Infinity) fiveHourDue = time + 5 * HOUR;
      weekly -= spent;
      fiveHour -= spent;
      used += spent;
    }
    return used;
  }

  const baseline = replay(null);
  const scores = new Map();
  for (let time = Math.max(snapshot, card.from ?? snapshot); time < Math.min(end, card.until); time++) {
    const score = replay(time);
    if (score !== null) scores.set(time, score);
  }
  return { baseline, scores, best: Math.max(baseline, ...scores.values()) };
}

test('both searches match independent exhaustive replay on 256 reproducible small cases', () => {
  let seed = 20261119;
  function random(limit) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 0x100000000 * limit);
  }

  for (let index = 0; index < 256; index++) {
    const overnight = index % 3 === 0;
    const snapshot = start + (overnight ? 14 * HOUR : 0) - random(30);
    const duration = index % 8 === 0 ? 400 : 15 + random(60);
    const phone = random(2) === 0;
    const grace = phone ? random(20) : 0;
    const firstShortRefresh = random(2) ? null : snapshot + 1 + random(duration);
    const cardFrom = snapshot + random(20) - 10;
    const input = scenario({
      snapshot,
      mode: random(2) ? 'extreme' : 'healthy',
      hours: overnight ? [22 * HOUR, 2 * HOUR] : [8 * HOUR, 9 * HOUR],
      rate: [undefined, 0, 30, 60][random(4)],
      subscription: { end: snapshot + duration - grace, channel: phone ? 'ios' : 'web', graceDays: grace / DAY },
      long: { start: null, end: snapshot + 1 + random(duration + 10), remaining: random(101) },
      short: random(2) ? null : {
        amount: 16, remaining: firstShortRefresh === null ? 100 : random(101), end: firstShortRefresh,
      },
      card: { from: cardFrom, until: cardFrom + 1 + random(duration + 30), restart: Boolean(random(2)),
        scope: 1 + random(3), threshold: [80, 100][random(2)], tolerance: random(3) },
      resets: Array.from({ length: random(3) }, () => ({ at: snapshot + random(duration), scope: 1 + random(3) })),
    });
    const original = calculate(input);
    const reference = minuteByMinuteScores(input);
    assert.ok(Math.abs(original.baseline - reference.baseline) < 1e-6, `case ${index} baseline`);
    assert.ok(Math.abs(original.total - reference.best) < 1e-6, `case ${index} maximum`);
    if (original.window) {
      close(reference.scores.get(original.at), reference.best);
      for (let time = original.window.start; time <= original.window.end; time++) {
        const score = reference.scores.get(time);
        assert.ok(score > reference.baseline && score >= reference.best - input.card.tolerance - 1e-7);
      }
    } else {
      close(reference.best, reference.baseline);
    }
  }
});

test('uses the card after spending the remaining quota and excludes the end minute', () => {
  const input = scenario();
  const best = calculate(input);
  assert.equal(best.at, start + HOUR);
  close(best.baseline, 10);
  close(best.total, 110);
  close(best.usedBeforeCard, 10);
  assert.deepEqual(best.usageWindows, [
    { start, end: start + HOUR, amount: 10 },
    { start: start + HOUR, end: input.subscription.end, amount: 100 },
  ]);

  input.card.until = start + HOUR;
  const beforeExpiry = calculate(input);
  assert.equal(beforeExpiry.at, start + HOUR - 1);
  close(beforeExpiry.total, 110 - 1 / 6);
  close(beforeExpiry.usedBeforeCard, 10 - 1 / 6);
});

test('requires a valid card expiry', () => {
  const input = scenario();
  for (const until of [null, undefined, NaN, Infinity, start + 0.5, String(start)]) {
    input.card.until = until;
    rejectsInput(input, 'card-until');
  }
});

test('a card must expire after it becomes available', () => {
  const input = scenario();
  input.card.from = start + HOUR;
  for (const until of [input.card.from - 1, input.card.from]) {
    input.card.until = until;
    rejectsInput(input, 'card-until');
  }
});

test('keeps an eligible card when existing quota already covers all demand', () => {
  for (const rate of [0, 10]) {
    const input = scenario({ rate });
    input.long.remaining = 50;
    input.subscription.end = start + HOUR;
    const result = calculate(input);

    close(result.baseline, rate);
    close(result.total, rate);
    assert.equal(result.reason, 'no-gain');
    assert.equal(result.window, null);

    input.long.remaining = 100;
    delete input.card.threshold;
    assert.equal(calculate(input).reason, 'ineligible');
  }
});

test('the same planner is available as a regular browser script', () => {
  const filename = require.resolve('./planner.js');
  const browser = {};
  runInNewContext(readFileSync(filename, 'utf8'), browser, { filename });

  const input = scenario({ rate: undefined });
  input.subscription.end = start + 2;
  const result = browser.Resetwise.planReset(input).next();
  assert.equal(result.done, true);
  assert.equal(result.value.at, start + 1);
  assert.equal(result.value.total, 110);
  assert.deepEqual(Object.keys(browser.Resetwise), ['planReset', 'alternatePlan', 'describeAlternative']);
});

test('a search still considers the last allowed minute at a 512-minute batch boundary', () => {
  const input = scenario({ rate: undefined });
  input.card.until = start + 512;
  const search = planReset(input);
  const dp = planResetDP(input);
  assert.equal(search.next().done, false);
  assert.equal(dp.next().done, false);
  const result = search.next();
  assert.equal(result.done, true);
  assert.deepEqual(result.value.window, { start: start + 1, end: start + 511, minTotal: 110 });
  assert.deepEqual(dp.next(), result);
});

test('without a usage rate the recommendation assumes quota is used as soon as it is available', () => {
  const input = scenario({ rate: undefined });
  input.subscription.end = start + 2 * HOUR;
  const result = calculate(input);
  assert.equal(result.baseline, 10);
  assert.equal(result.total, 110);
  assert.deepEqual(result.window, { start: start + 1, end: start + 2 * HOUR - 1, minTotal: 110 });
});

test('using quota immediately still respects the 5-hour limit', () => {
  const input = scenario({ rate: undefined });
  input.long.remaining = 100;
  input.short = { amount: 15, remaining: 100, end: null };
  input.subscription.end = start + 10 * HOUR + 1;
  input.card.until = start;
  const result = calculate(input);
  assert.equal(result.baseline, 45);
  assert.deepEqual(result.usageWindows, [
    { start, end: start + 5 * HOUR, amount: 15 },
    { start: start + 5 * HOUR, end: start + 10 * HOUR, amount: 15 },
    { start: start + 10 * HOUR, end: input.subscription.end, amount: 15 },
  ]);
});

test('a large 5-hour cap still draws from the same weekly balance', () => {
  const input = scenario({ rate: undefined });
  input.short = { amount: 120, remaining: 100, end: null };
  input.subscription.end = start + 2;
  const result = calculate(input);

  assert.equal(result.at, start + 1);
  assert.equal(result.baseline, 10);
  assert.equal(result.total, 110);
});

test('a weekly refresh starts the next seven days even outside usage hours', () => {
  const input = scenario({ rate: undefined, mode: 'healthy', hours: [8 * HOUR, 18 * HOUR] });
  const firstRefresh = start + 11 * HOUR;
  input.long.end = firstRefresh;
  input.subscription.end = start + 9 * DAY;
  input.card.until = start;
  const refreshes = calculate(input).events.filter(event => event.type === 'cycle').map(event => event.at);
  assert.deepEqual(refreshes, [firstRefresh, firstRefresh + 7 * DAY]);
});

test('with zero tolerance a full plateau of equally optimal minutes is recommended', () => {
  const input = scenario({ rate: 60 });
  input.subscription.end = start + 120;
  input.card.tolerance = 0;
  const result = calculate(input);
  assert.deepEqual(result.window, { start: start + 10, end: start + 20, minTotal: 110 });
  assert.equal(result.at, start + 10);
});

test('the default window allows 1% of a weekly quota in lost usage and respects card expiry', () => {
  const input = scenario({ rate: 60 });
  input.subscription.end = start + 110;
  const result = calculate(input);
  assert.equal(result.total, 110);
  assert.deepEqual(result.window, { start: start + 9, end: start + 11, minTotal: 109 });
  assert.equal(result.at, start + 10);

  input.card.until = start + 11;
  assert.deepEqual(calculate(input).window, { start: start + 9, end: start + 10, minTotal: 109 });
  input.card.tolerance = 0;
  assert.deepEqual(calculate(input).window, { start: start + 10, end: start + 10, minTotal: 110 });
});

test('selects the longest optimal window without crossing blocked hours, then breaks ties by time', () => {
  const input = scenario({ mode: 'healthy', hours: [8 * HOUR, 9 * HOUR], rate: 60 });
  input.subscription.end = start + 2 * DAY + HOUR;
  input.card.from = start + 56;
  input.card.tolerance = 0;
  const result = calculate(input);
  assert.deepEqual(result.window, { start: start + DAY, end: start + DAY + 20, minTotal: 110 });
  assert.equal(result.at, start + DAY);

  input.subscription.end -= 17;
  assert.deepEqual(calculate(input).window, { start: start + 56, end: start + 59, minTotal: 110 });
});

test('a longer near-optimal window cannot replace a window containing the actual optimum', () => {
  const input = scenario({ mode: 'healthy', hours: [8 * HOUR, 9 * HOUR], rate: 60 });
  input.subscription.end = start + 2 * DAY + 39;
  input.card.from = start + 59;
  input.card.tolerance = 10;
  const result = calculate(input);

  assert.equal(result.total, 110);
  assert.equal(result.at, start + 59);
  assert.deepEqual(result.window, { start: start + 59, end: start + 59, minTotal: 110 });
});

test('even a large tolerance excludes eligible minutes that give no extra usage', () => {
  const input = scenario({ rate: 60 });
  input.long.remaining = 5;
  input.long.end = start + 6;
  input.subscription.end = start + 20;
  input.card.restart = false;
  input.card.tolerance = 100;
  const result = calculate(input);
  assert.equal(result.baseline, 19);
  assert.equal(result.total, 20);
  assert.deepEqual(result.window, { start, end: start + 5, minTotal: 20 });
});

test('a restarted cycle replaces the upcoming ordinary refresh', () => {
  const input = scenario();
  input.long.end = start + 2 * HOUR;
  input.card.until = input.long.end;
  const restarted = calculate(input);
  close(restarted.baseline, 110);
  assert.equal(restarted.at, null);
  assert.equal(restarted.window, null);
  assert.equal(restarted.usedBeforeCard, undefined);

  input.card.restart = false;
  const preserved = calculate(input);
  assert.equal(preserved.at, start);
  assert.equal(preserved.usedBeforeCard, 0);
  close(preserved.total, 120);
  assert.ok(preserved.events.some(event => event.type === 'cycle' && event.at === input.long.end));
});

test('uses the announced reset first when simultaneous and favors using the card after consuming it', () => {
  const input = scenario();
  const announcement = start + HOUR;
  input.card.from = announcement;
  input.resets = [{ at: announcement, scope: 1 }];
  const result = calculate(input);
  assert.equal(result.at, announcement + 10 * HOUR);
  close(result.baseline, 110);
  close(result.total, 210);
  close(result.usedBeforeCard, 110);
  assert.ok(result.events.some(event => event.type === 'announced' && event.at === announcement));
});

test('an announcement can split the best window by making the card temporarily ineligible', () => {
  const input = scenario({ rate: undefined });
  input.long.remaining = 0;
  input.subscription.end = start + 12;
  input.resets = [{ at: start + 5 }];
  input.card.tolerance = 0;
  const result = calculate(input);

  assert.equal(result.baseline, 100);
  assert.equal(result.total, 200);
  assert.equal(result.at, start + 6);
  assert.deepEqual(result.window, { start: start + 6, end: start + 11, minTotal: 200 });
});

test('a card and an announcement cover all enabled limits by default', () => {
  const input = scenario();
  input.long.remaining = 0;
  input.short = { amount: 20, remaining: 0, end: start + 4 * HOUR };
  input.subscription.end = start + 3 * HOUR;
  input.resets = [{ at: start + HOUR }];
  const result = calculate(input);
  assert.equal(result.at, start);
  assert.equal(result.restored.scope, 3);
  assert.equal(result.events.find(event => event.type === 'announced').scope, 3);
  close(result.baseline, 20);
  close(result.total, 30);
});

test('an announced reset restarts both weekly and 5-hour cycles', () => {
  const input = scenario({ rate: undefined });
  const announcedAt = start + HOUR;
  input.long.end = start + 3 * HOUR;
  input.short = { amount: 16, remaining: 0, end: start + 2 * HOUR };
  input.subscription.end = start + 7 * DAY + 2 * HOUR;
  input.card.until = start;
  input.resets = [{ at: announcedAt }];
  const { events } = calculate(input);
  const cycles = events.filter(event => event.type === 'cycle');
  assert.deepEqual(cycles.filter(event => event.scope & 1).map(event => event.at), [announcedAt + 7 * DAY]);
  assert.equal(cycles.find(event => event.scope & 2).at, announcedAt + 5 * HOUR);
});

test('simultaneous weekly, 5-hour and announced resets precede card eligibility', () => {
  const input = scenario({ rate: undefined });
  const at = start + HOUR;
  input.long = { ...input.long, end: at, remaining: 0 };
  input.short = { amount: 16, remaining: 0, end: at };
  input.subscription.end = at + 1;
  input.card.from = at;
  input.resets = [{ at }];
  const result = calculate(input);

  assert.equal(result.reason, 'ineligible');
  assert.equal(result.baseline, 16);
  assert.equal(result.total, 16);
  assert.deepEqual(result.events, [
    { at, type: 'cycle', scope: 3 },
    { at, type: 'announced', scope: 3 },
  ]);
});

test('a starting-minute announcement applies and a refresh at the access end does not', () => {
  const input = scenario({ rate: undefined });
  input.long.remaining = 0;
  input.short = { amount: 16, remaining: 0, end: start + 1 };
  input.resets = [{ at: start }];
  input.subscription.end = start + 5 * HOUR;
  input.card.until = start + 1;
  const result = calculate(input);

  assert.equal(result.reason, 'ineligible');
  assert.equal(result.total, 16);
  assert.deepEqual(result.events, [{ at: start, type: 'announced', scope: 3 }]);
});

test('only announcements for enabled limits during active subscription access are applied', () => {
  const input = scenario({ rate: undefined });
  const at = start + HOUR;
  const end = start + 2 * HOUR;
  input.subscription.end = end;
  input.card.until = start;
  input.resets = [{ at: start - 1 }, { at: start, scope: 2 }, { at }, { at: end }, { at: end + 1 }];
  const result = calculate(input);

  assert.equal(result.total, 110);
  assert.deepEqual(result.events, [{ at, type: 'announced', scope: 1 }]);
});

test('short quota limits the same consumption and a short-only card leaves the weekly schedule alone', () => {
  const input = scenario();
  input.long.remaining = 100;
  input.long.end = start + 3 * HOUR;
  input.subscription.end = start + 3 * HOUR;
  input.short = { amount: 8, remaining: 0, end: start + 4 * HOUR };
  input.card.scope = 2;
  const result = calculate(input);
  assert.equal(result.at, start);
  close(result.baseline, 0);
  close(result.total, 8);
  assert.equal(result.restored.scope, 2);
});

test('a card that preserves refresh times keeps the original 5-hour reset', () => {
  const input = scenario({ rate: undefined });
  const refresh = start + 3 * HOUR;
  input.long.remaining = 100;
  input.short = { amount: 16, remaining: 0, end: refresh };
  input.subscription.end = start + 4 * HOUR;
  input.card.until = start + 1;
  input.card.restart = false;
  const result = calculate(input);

  assert.equal(result.at, start);
  assert.equal(result.baseline, 16);
  assert.equal(result.total, 32);
  assert.deepEqual(result.usageWindows, [
    { start, end: refresh, amount: 16 },
    { start: refresh, end: input.subscription.end, amount: 16 },
  ]);
  assert.deepEqual(result.events, [
    { at: start, type: 'card', scope: 2 },
    { at: refresh, type: 'cycle', scope: 2 },
  ]);

  input.card.restart = true;
  const restarted = calculate(input);
  assert.equal(restarted.reason, 'no-gain');
  assert.equal(restarted.total, 16);
});

test('a short-only announcement cannot refill the long limit', () => {
  const input = scenario();
  input.subscription.end = start + 3 * HOUR;
  input.short = { amount: 10, remaining: 0, end: start + 4 * HOUR };
  input.card.until = start;
  input.resets = [{ at: start + HOUR, scope: 2 }];
  const result = calculate(input);
  close(result.total, 10);
  assert.equal(result.at, null);
  assert.equal(result.events.find(event => event.type === 'announced').scope, 2);
});

test('a full limit keeps its clock and the default manual card threshold is exclusive', () => {
  const input = scenario();
  input.snapshot = start + 20;
  input.long.remaining = 80;
  delete input.card.threshold;
  input.card.until = input.snapshot + 1;
  assert.equal(calculate(input).reason, 'ineligible');

  input.long.remaining = 100;
  input.long.end = start + 2 * HOUR;
  input.short = { amount: 15, remaining: 0, end: start + 4 * HOUR };
  const result = calculate(input);
  assert.equal(result.at, input.snapshot);
  assert.equal(result.restored.scope, 2);
  assert.ok(result.events.some(event => event.type === 'cycle' && event.at === input.long.end && event.scope === 1));
});

test('the default threshold is exclusive at 80% of the 5-hour cap', () => {
  const input = scenario({ rate: undefined });
  input.long.remaining = 100;
  input.short = { amount: 16, remaining: 80, end: start + 5 * HOUR };
  input.subscription.end = start + 1;
  delete input.card.threshold;

  assert.equal(calculate(input).reason, 'ineligible');
  input.short.remaining = 79.99;
  const result = calculate(input);
  assert.equal(result.at, start);
  assert.equal(result.total, 16);
  close(result.baseline, 16 * 0.7999);
});

test('healthy mode avoids both redeeming and consuming during the blocked hours', () => {
  const input = scenario();
  input.long.remaining = 5;
  input.rate = 1;
  input.card.from = start + 16 * HOUR;
  input.card.until = start + 22 * HOUR;
  input.mode = 'healthy';
  assert.equal(calculate(input).reason, 'outside-window');
  input.mode = 'extreme';
  assert.equal(calculate(input).at, input.card.from);

  input.mode = 'healthy';
  input.long.remaining = 2;
  input.hours = [22 * HOUR, 2 * HOUR];
  const overnight = calculate(input);
  assert.equal(overnight.at, input.card.from);
  close(overnight.baseline, 2);
});

test('healthy use includes the last minute before closing and excludes closing time', () => {
  const input = scenario({ mode: 'healthy', hours: [8 * HOUR, 9 * HOUR], rate: undefined });
  input.long.remaining = 0;
  input.card.from = start + HOUR - 1;
  input.card.until = start + 2 * HOUR;
  const result = calculate(input);

  assert.equal(result.at, input.card.from);
  assert.deepEqual(result.window, { start: input.card.from, end: input.card.from, minTotal: 100 });
  input.card.from++;
  assert.equal(calculate(input).reason, 'outside-window');
});

test('midnight can close, open or continue a healthy interval', () => {
  const snapshot = start + 16 * HOUR - 1;
  const input = scenario({ mode: 'healthy', rate: 60, snapshot });
  input.subscription.end = snapshot + 2;
  input.card.until = snapshot;

  for (const [hours, allowed] of [
    [[22 * HOUR, 0], 1], [[0, 2 * HOUR], 1], [[22 * HOUR, 2 * HOUR], 2],
  ]) {
    input.hours = hours;
    assert.equal(calculate(input).baseline, allowed);
  }
  assert.deepEqual(calculate(input).usageWindows, [
    { start: snapshot, end: snapshot + 2, amount: 2 },
  ]);
});

test('healthy use follows local hours during daylight saving changes', async t => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  const changes = [
    { name: 'skipped opening time', date: '2026-03-08', end: '05:00:00-07:00', hours: [150, 240], allowed: 60 },
    { name: 'split interval in the repeated hour', date: '2026-11-01', end: '03:00:00-08:00', hours: [90, 120], allowed: 60 },
    { name: 'closing time occurs twice', date: '2026-11-01', end: '03:00:00-08:00', hours: [0, 75], allowed: 90 },
    { name: 'overnight interval with access ending in the repeated hour', date: '2026-11-01', end: '01:15:00-08:00', hours: [1320, 90], allowed: 105 },
  ];
  for (const { name, date, end, hours, allowed } of changes) {
    await t.test(name, () => {
      const snapshot = Date.parse(`${date}T00:00:00`) / MINUTE;
      const input = scenario({ mode: 'healthy', hours, rate: 15, snapshot });
      input.subscription.end = Date.parse(`${date}T${end}`) / MINUTE;
      input.long = { start: snapshot, end: snapshot + DAY, remaining: 100 };
      input.card.until = snapshot;

      const result = calculate(input);
      close(result.baseline, allowed / 4);
    });
  }

  await t.test('a card cannot be redeemed in the blocked part of the repeated hour', () => {
    const snapshot = Date.parse('2026-11-01T00:00:00-07:00') / MINUTE;
    const secondOpening = Date.parse('2026-11-01T01:30:00-08:00') / MINUTE;
    const input = scenario({ mode: 'healthy', hours: [90, 120], rate: undefined, snapshot });
    input.subscription.end = secondOpening + 30;
    input.long = { start: snapshot, end: snapshot + DAY, remaining: 0 };
    input.card.from = secondOpening - 15;
    input.card.until = secondOpening;
    assert.equal(calculate(input).reason, 'outside-window');

    input.card.until++;
    assert.deepEqual(calculate(input).window, { start: secondOpening, end: secondOpening, minTotal: 100 });
  });
});

test('only confirmed iOS grace days add to the projection and can make a later use worthwhile', () => {
  const input = scenario();
  input.card.from = input.subscription.end;
  input.subscription.graceDays = 1;
  assert.equal(calculate(input).reason, 'outside-window');

  input.subscription.channel = 'ios';
  const result = calculate(input);
  assert.equal(result.end, input.subscription.end + DAY);
  assert.equal(result.at, input.card.from);
  close(result.total, 110);
});

test('a usage-triggered short clock starts when consumption resumes in the morning', () => {
  const input = scenario();
  input.mode = 'healthy';
  input.snapshot = start + 20 * HOUR;
  input.subscription.end = start + 32 * HOUR;
  input.long.remaining = 100;
  input.short = { amount: 10, remaining: 100, end: null };
  input.card.until = input.snapshot;
  const result = calculate(input);
  close(result.baseline, 20);
  assert.ok(result.events.some(event => event.type === 'cycle' && event.scope === 2 && event.at === start + 29 * HOUR));
});

test('a full 5-hour balance waits for first use when the weekly balance is empty', () => {
  const input = scenario({ rate: undefined });
  const weeklyRefresh = start + 4 * HOUR;
  input.long.end = weeklyRefresh;
  input.long.remaining = 0;
  input.short = { amount: 16, remaining: 100, end: null };
  input.subscription.end = weeklyRefresh + 5 * HOUR + 1;
  input.card.until = start;
  const result = calculate(input);

  assert.equal(result.total, 32);
  assert.deepEqual(result.usageWindows, [
    { start: weeklyRefresh, end: weeklyRefresh + 5 * HOUR, amount: 16 },
    { start: weeklyRefresh + 5 * HOUR, end: input.subscription.end, amount: 16 },
  ]);
  assert.deepEqual(result.events, [
    { at: weeklyRefresh, type: 'cycle', scope: 1 },
    { at: weeklyRefresh + 5 * HOUR, type: 'cycle', scope: 2 },
  ]);
});

test('the 5-hour timer waits for first use even if an old fixed clock setting is supplied', () => {
  const input = scenario({ mode: 'healthy', rate: undefined });
  const morning = start + DAY;
  const firstRefresh = morning - 2 * HOUR;
  input.snapshot = morning - 4 * HOUR;
  input.subscription.end = morning + 8 * HOUR;
  input.long.remaining = 100;
  input.short = { amount: 16, remaining: 0, end: firstRefresh, clock: 'fixed' };
  input.card.until = input.snapshot;
  const refreshes = calculate(input).events.filter(event => event.scope === 2).map(event => event.at);

  assert.deepEqual(refreshes, [firstRefresh, morning + 5 * HOUR]);
});

test('uses the recorded balance time as the start even with an old subscription start value', () => {
  const input = scenario();
  input.snapshot = start + 3 * HOUR;
  input.subscription.start = start + 6 * HOUR;
  const active = calculate(input);
  assert.equal(active.start, input.snapshot);
  assert.equal(active.at, input.snapshot + HOUR);

  input.snapshot = input.subscription.end;
  const result = calculate(input);
  assert.equal(result.reason, 'expired');
  assert.equal(result.baseline, 0);
});

test('a snapshot at subscription expiry can still use iOS grace days', () => {
  const input = scenario();
  input.snapshot = input.subscription.end;
  input.long.start = null;
  assert.equal(calculate(input).reason, 'expired');

  input.subscription.channel = 'ios';
  input.subscription.graceDays = 1;
  const result = calculate(input);
  assert.equal(result.start, input.snapshot);
  assert.equal(result.end, input.snapshot + DAY);
  close(result.baseline, 10);
});

test('iOS grace rounds to the nearest minute and its end is exclusive', () => {
  const input = scenario({ rate: undefined });
  input.long.remaining = 0;
  input.subscription = { end: start - 1, channel: 'ios', graceDays: 1.49 / DAY };
  const expired = calculate(input);
  assert.equal(expired.reason, 'expired');
  assert.deepEqual(expired.usageWindows, []);

  input.subscription.graceDays = 1.5 / DAY;
  const result = calculate(input);
  assert.equal(result.end, start + 1);
  assert.deepEqual(result.window, { start, end: start, minTotal: 100 });
  assert.deepEqual(result.usageWindows, [{ start, end: start + 1, amount: 100 }]);

  input.card.from = result.end;
  assert.equal(calculate(input).reason, 'outside-window');
});

test('the 400-day horizon limit includes iOS grace and permits its exact boundary', () => {
  const input = scenario({ rate: undefined });
  input.subscription = { end: start + 399 * DAY, channel: 'ios', graceDays: 1 };
  input.card.until = start;
  const result = calculate(input);

  assert.equal(result.end, start + 400 * DAY);
  assert.equal(result.reason, 'outside-window');
  assert.equal(result.baseline, 10 + 57 * 100);
  input.subscription.end++;
  rejectsInput(input, 'subscription-end');
});

test('rejects conflicting dates and a missing current 5-hour refresh', () => {
  const input = scenario();
  input.long.start = start + 1;
  rejectsInput(input, 'long-start');
  input.long.start = start;
  input.long.end = input.snapshot;
  rejectsInput(input, 'long-end');

  input.long.end = start + DAY;
  input.short = { amount: 20, remaining: 20, end: null };
  rejectsInput(input, 'short-end');
  input.short.end = start;
  rejectsInput(input, 'short-end');

  input.short.end = start + 1;
  input.mode = 'healthy';
  input.hours = [8 * HOUR, 8 * HOUR];
  rejectsInput(input, 'awake-end');
});

test('rejects a negative or non-finite window tolerance', () => {
  const input = scenario();
  for (const tolerance of [-1, Infinity, NaN]) {
    input.card.tolerance = tolerance;
    rejectsInput(input, 'card-tolerance');
  }
});

function withCards(expiries, overrides = {}) {
  return scenario({ rate: undefined, card: { restart: true },
    cards: expiries.map(until => ({ until })), ...overrides });
}

test('a downgrade carries spent quota and opens the target five-hour window at the new cap', () => {
  const input = withCards([], {
    subscription: { end: start + DAY, channel: 'web', renew: true, renewDays: 1 },
    long: { end: start + HOUR, remaining: 85 },
    tierChange: { from: 'pro100', to: 'plus', at: start, weeklyPercent: 10, shortAmount: 25 },
  });
  const result = finish(planReset(input));
  assert.equal(result.baseline, 10);
  assert.equal(result.total, 10);
  assert.equal(result.usageWindows.length, 4);
  assert.deepEqual(result.usageWindows[0], { start: start + HOUR, end: start + 6 * HOUR, amount: 2.5 });
  assert.deepEqual(result.events.slice(0, 2), [
    { at: start, type: 'tier-change', scope: 0, from: 'pro100', to: 'plus' },
    { at: start + HOUR, type: 'cycle', scope: 1 },
  ]);
});

test('an upgrade values the same card at the target cap after the switch', () => {
  const at = start + 5;
  const input = withCards([at + 3], {
    subscription: { end: start + DAY, channel: 'web', renew: true, renewDays: 1 },
    long: { end: start + 7 * DAY, remaining: 100 },
    tierChange: { from: 'pro100', to: 'pro500', at, weeklyPercent: 500 },
  });
  const result = finish(planReset(input));
  assert.equal(result.baseline, 500);
  assert.equal(result.total, 1_000);
  assert.equal(result.cards[0].gain, 500);
  assert.deepEqual(result.cards[0].window, { start: at + 1, end: at + 2 });
  assert.equal(finish(alternatePlan(input, result, 'renewal', 1)), null);
});

test('a card before an upgrade separates its restored quota from its gain over the full plan', () => {
  const minute = (month, day, hour) => new Date(2026, month - 1, day, hour).getTime() / MINUTE;
  const paidEnd = minute(12, 3, 17);
  const input = withCards([minute(11, 24, 13), minute(11, 26, 9), minute(12, 24, 9)], {
    snapshot: minute(11, 24, 9),
    subscription: { end: paidEnd, channel: 'ios', graceDays: 3, renew: true },
    long: { end: minute(11, 30, 9), remaining: 86 },
    tierChange: { from: 'pro100', to: 'pro500', at: paidEnd, weeklyPercent: 500 },
  });
  const result = finish(planReset(input));
  const third = result.cards[2];
  assert.ok(third.at < paidEnd);
  assert.equal(result.total, 3286);
  assert.equal(result.baseline, 2586);
  assert.equal(third.gain, 500);
  assert.deepEqual(third.restored, { scope: 1, long: 100, short: 0 });
});

test('a coincident weekly refresh uses the lower cap relative to the originating subscription', () => {
  const at = start + 1;
  const input = withCards([], {
    subscription: { end: start + DAY, channel: 'web', renew: true, renewDays: 1 },
    long: { end: at, remaining: 20 },
    tierChange: { from: 'pro200', to: 'pro100', at, weeklyPercent: 50 },
  });
  const result = finish(planReset(input));
  assert.equal(result.total, 70);
  assert.deepEqual(result.usageWindows.map(({ amount }) => amount), [20, 50]);
  assert.deepEqual(result.renewal, { kind: 'switch', at, from: 'pro200', to: 'pro100' });
});

test('browses separated equal-usage time windows for the same card in both directions', () => {
  const input = withCards([start + 12], {
    subscription: { end: start + 12, channel: 'web' },
    long: { end: start + DAY, remaining: 0 },
    resets: [{ at: start + 4 }, { at: start + 8 }],
  });
  const first = finish(planReset(input));
  const original = structuredClone(first);
  const second = finish(alternatePlan(input, first, 1, 1));
  const third = finish(alternatePlan(input, second, 1, 1));
  const previous = finish(alternatePlan(input, third, 1, -1));
  assert.deepEqual([first, second, third].map(plan => plan.cards[0].window), [
    { start, end: start + 3 }, { start: start + 5, end: start + 7 }, { start: start + 9, end: start + 11 },
  ]);
  assert.deepEqual(previous.cards[0].window, second.cards[0].window);
  assert.equal(finish(alternatePlan(input, third, 1, 1)), null);
  assert.equal(finish(alternatePlan(input, first, 1, -1)), null);
  assert.deepEqual(first, original);
  for (const plan of [first, second, third, previous]) {
    assert.equal(plan.total, 300);
    assert.equal(plan.usageWindows.reduce((sum, window) => sum + window.amount, 0), 300);
    assert.equal(plan.events.find(event => event.type === 'card').at, plan.cards[0].at);
  }
});

test('prepares a reusable alternative without generating its timeline', () => {
  const input = withCards([start + 12], {
    subscription: { end: start + 12, channel: 'web' },
    long: { end: start + DAY, remaining: 0 },
    resets: [{ at: start + 4 }, { at: start + 8 }],
  });
  const original = finish(planReset(input));
  assert.equal(finish(alternatePlan(input, original, 1, -1, { prepare: true })), null);
  const candidate = finish(alternatePlan(input, original, 1, 1, { prepare: true }));
  const saved = structuredClone(candidate);
  assert.deepEqual(Object.keys(candidate), ['option', 'moves']);
  const expected = finish(alternatePlan(input, original, 1, 1));
  assert.deepEqual(finish(describeAlternative(input, original, 1, candidate)), expected);
  assert.deepEqual(finish(describeAlternative(input, original, 1, candidate)), expected);
  assert.deepEqual(candidate, saved);
});

test('preflight finds no neighbors beyond a single usable window', () => {
  const input = withCards([start + 24], {
    subscription: { end: start + 12, channel: 'web' },
    long: { end: start + DAY, remaining: 100 },
  });
  const plan = finish(planReset(input));
  assert.deepEqual(plan.cards[0].window, { start: start + 1, end: start + 11 });
  for (const direction of [-1, 1]) {
    assert.equal(finish(alternatePlan(input, plan, 1, direction, { prepare: true })), null);
  }
});

test('offers no later window when it would require reversing the card order', () => {
  for (const secondExpiry of [6, 8]) {
    const input = withCards([start + 6, start + secondExpiry], {
      subscription: { end: start + 6, channel: 'web' },
      long: { end: start + DAY, remaining: 0 },
    });
    const initial = finish(planReset(input));
    const displayed = { ...initial, cards: [
      { ...initial.cards[0], at: start + 4, window: { start, end: start + 4 } },
      { ...initial.cards[1], at: start + 5, window: { start: start + 5, end: start + 5 } },
    ] };
    assert.deepEqual(initial.cards.map(card => card.number), [1, 2]);
    assert.equal(finish(alternatePlan(input, displayed, 1, 1, { prepare: true })), null);
  }
});

test('moving a card earlier keeps the actual expiry order', () => {
  for (const [deadlines, order] of [[[12, 20], [1, 2]], [[20, 12], [2, 1]], [[8, 8], [1, 2]]]) {
    const input = withCards(deadlines.map(offset => start + offset), {
      subscription: { end: start + 24, channel: 'web' },
      long: { end: start + DAY, remaining: 0 },
    });
    const original = finish(planReset(input));
    const alternate = finish(alternatePlan(input, original, order[1], -1));
    assert.equal(alternate.total, original.total);
    assert.deepEqual(alternate.cards.map(card => card.number), order);
    assert.ok(alternate.cards[0].at < alternate.cards[1].at);
    assert.ok(alternate.cards[1].window.end < original.cards[1].window.start);
  }
});

test('finds an earlier window when both cards must move in expiry order', () => {
  const input = withCards([start + 20, start + 30], {
    rate: 120,
    subscription: { end: start + 40, channel: 'web' },
    long: { end: start + DAY, remaining: 24 },
  });
  const original = finish(planReset(input));
  const earlier = finish(alternatePlan(input, original, 2, -1));
  assert.equal(earlier.total, original.total);
  assert.deepEqual(earlier.cards.map(card => card.number), [1, 2]);
  assert.ok(earlier.cards[0].at < original.cards[0].at);
  assert.ok(earlier.cards[1].window.end < original.cards[1].window.start);
});

test('widens coordinated alternatives while preserving unrelated example times', () => {
  const input = withCards([start + 3 * DAY, start + 4 * DAY, start + 30 * DAY], {
    subscription: { end: start + 9 * DAY + 8 * HOUR, channel: 'ios', graceDays: 3, renew: true, renewDays: 30 },
    long: { end: start + 4 * DAY, remaining: 24 },
    short: { amount: 16, remaining: 100, end: null },
  });
  const first = finish(planReset(input));
  const later = finish(alternatePlan(input, first, 3, 1));
  assert.equal(later.total, 924);
  assert.deepEqual(later.renewal, first.renewal);
  assert.deepEqual(later.cards.slice(0, 2).map(card => card.at), first.cards.slice(0, 2).map(card => card.at));
  assert.equal(later.cards[2].window.start - first.cards[2].window.start, 7 * DAY);
  assert.equal(later.cards[2].window.end - first.cards[2].window.end, 7 * DAY);
  assert.equal(finish(alternatePlan(input, later, 3, 1)), null);

  for (const number of [1, 2]) {
    const original = first.cards.find(card => card.number === number);
    const alternate = finish(alternatePlan(input, first, number, 1));
    const window = alternate.cards.find(card => card.number === number).window;
    assert.equal(alternate.total, first.total);
    assert.deepEqual(alternate.cards.map(card => card.number), [1, 2, 3]);
    assert.equal(window.start, original.window.end + 1);
    assert.ok(window.end - window.start >= 8 * HOUR, `Card ${number} should have hours of slack`);
    assert.equal(finish(alternatePlan(input, alternate, number, 1, { prepare: true })), null);
  }
});

test('switches renewal paths if either yields the same quota', () => {
  const paidEnd = start + HOUR;
  const input = withCards([], {
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: 1 },
    long: { end: paidEnd + 1, remaining: 100 },
  });
  const original = finish(planReset(input));
  const later = finish(alternatePlan(input, original, 'renewal', 1));
  assert.equal(original.renewal.kind, 'continue');
  assert.equal(later.renewal.kind, 'restart');
  assert.ok(later.events.some(event => event.type === 'lapse'));
  assert.equal(later.total, original.total);
  assert.equal(finish(alternatePlan(input, later, 'renewal', -1)).renewal.kind, 'continue');

  input.subscription.allowLapse = false;
  assert.equal(finish(alternatePlan(input, original, 'renewal', 1)), null);
});

test('does not offer a different action that reduces total quota', () => {
  const paidEnd = start + HOUR;
  const input = withCards([], {
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: 1 },
    long: { end: start + 7 * DAY, remaining: 0 },
  });
  const original = finish(planReset(input));
  assert.equal(original.renewal.kind, 'restart');
  assert.equal(finish(alternatePlan(input, original, 'renewal', -1)), null);
  assert.equal(finish(alternatePlan(input, original, 1, 1)), null);
});

test('rechecks expiry of access when a different renewal would shorten the plan', () => {
  const paidEnd = start + HOUR;
  const input = withCards([paidEnd + 2 * DAY], {
    subscription: { end: paidEnd, channel: 'ios', graceDays: 1, renew: true, renewDays: 1 },
    long: { end: start + 7 * DAY, remaining: 0 },
  });
  delete input.card;
  const original = finish(planReset(input));
  const later = finish(alternatePlan(input, original, 1, 1));
  assert.ok(later.cards[0].at > later.accessEnd);
  assert.equal(later.total, 200);
  assert.equal(finish(alternatePlan(input, later, 'renewal', -1)), null);
});

test('uses three interchangeable cards by expiry before the subscription ends', () => {
  const input = withCards([start + 2 * DAY, start + DAY, start + 10 * DAY], {
    subscription: { end: start + 4 * DAY, channel: 'web', renew: false, renewDays: 30 },
  });
  const result = finish(planReset(input));
  assert.equal(result.end, input.subscription.end);
  assert.equal(result.renewal, null);
  assert.equal(result.total, 310);
  assert.deepEqual(result.cards.map(card => card.number), [2, 1, 3]);
  assert.deepEqual(result.unusedCards, []);
  for (const { at, window, number } of result.cards) {
    assert.ok(window.start <= at && at <= window.end);
    assert.ok(window.end < Math.min(input.cards[number - 1].until, result.end));
  }
  assert.deepEqual(result.events.filter(event => event.type === 'card').map(event => event.number), [2, 1, 3]);
  assert.equal(result.usageWindows.reduce((total, slot) => total + slot.amount, 0), 310);
});

test('reports cards that cannot all fit before the same exclusive expiry', () => {
  const input = withCards([start + 2, start + 2, start + 2, start + HOUR]);
  input.long.remaining = 100;
  const result = finish(planReset(input));
  assert.deepEqual(result.cards.map(card => card.number), [1, 4]);
  assert.deepEqual(result.unusedCards, [2, 3]);
  assert.equal(result.cards[0].at, start + 1);
  assert.equal(result.total, 300);
});

test('a continuous renewal keeps the upcoming refresh and wins equal-usage ties', () => {
  const paidEnd = start + HOUR;
  const input = withCards([start], {
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: 1 },
    long: { end: paidEnd + 1, remaining: 100 },
  });
  const result = finish(planReset(input));
  assert.equal(result.renewal.kind, 'continue');
  assert.ok(result.renewal.at < paidEnd);
  assert.equal(result.end, paidEnd + DAY);
  assert.equal(result.total, 200);
  assert.deepEqual(result.events.filter(event => event.type === 'cycle'), [
    { at: paidEnd + 1, type: 'cycle', scope: 1 },
  ]);
});

test('continuous-only renewal keeps both quota cycles even when rejoining gives more', () => {
  const paidEnd = start + HOUR;
  const input = withCards([], {
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: 1 },
    long: { end: paidEnd + 2 * DAY, remaining: 40 },
    short: { end: paidEnd + 2, remaining: 0, amount: 16 },
  });
  const unrestricted = finish(planReset(input));
  assert.equal(unrestricted.renewal.kind, 'restart');

  input.subscription.allowLapse = false;
  const result = finish(planReset(input));
  assert.equal(result.renewal.kind, 'continue');
  assert.equal(result.total, 40);
  assert.equal(result.events.find(event => event.type === 'renewal').scope, 0);
  assert.equal(result.events.find(event => event.type === 'cycle').at, paidEnd + 2);
  assert.ok(!result.events.some(event => event.type === 'lapse'));
});

test('continuous-only renewal needs an available time before access ends', () => {
  const input = withCards([], {
    snapshot: start + 15 * HOUR, mode: 'healthy',
    subscription: { end: start + 16 * HOUR, channel: 'web', renew: true, renewDays: 1, allowLapse: false },
  });
  assert.throws(() => finish(planReset(input)), { field: 'awake-end' });
});

test('rejoining from free resets weekly and 5-hour limits before using later cards', () => {
  const paidEnd = start + 2;
  const input = withCards([paidEnd, start + DAY + 10], {
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: 1 },
    long: { end: start + 7 * DAY, remaining: 0 },
    short: { end: null, remaining: 100, amount: 16 },
  });
  const result = finish(planReset(input));
  assert.equal(result.renewal.kind, 'restart');
  assert.equal(result.renewal.at, paidEnd);
  assert.equal(result.end, paidEnd + DAY);
  assert.equal(result.events.find(event => event.type === 'renewal').scope, 3);
  assert.ok(result.cards.every(card => card.at < input.cards[card.number - 1].until));
  assert.ok(result.total > 80);
});

test('waits for iOS grace and the first healthy-use minute before rejoining', () => {
  const paidEnd = start + 16 * HOUR;
  const input = withCards([start], {
    mode: 'healthy',
    subscription: { end: paidEnd, channel: 'ios', graceDays: 3, renew: true, renewDays: 1 },
    long: { end: start + 7 * DAY, remaining: 0 },
  });
  const result = finish(planReset(input));
  assert.equal(result.renewal.kind, 'restart');
  assert.equal(result.renewal.at, start + 4 * DAY);
  assert.equal(result.accessEnd, paidEnd + 3 * DAY);
  assert.equal(result.end, start + 5 * DAY);
  assert.equal(result.total, 100);
  assert.ok(result.usageWindows.every(window => window.start >= result.renewal.at));
});

test('an already-free account can start a new subscription with no old balances', () => {
  const input = withCards([start + 2 * DAY], {
    subscription: { end: start - DAY, channel: 'web', renew: true, renewDays: 1 },
    long: { end: null, remaining: NaN },
    short: { end: null, remaining: NaN, amount: 16 },
  });
  const result = finish(planReset(input));
  assert.deepEqual(result.renewal, { kind: 'restart', at: start });
  assert.equal(result.baseline, 80);
  assert.equal(result.total, 96);
});

test('an expired account cannot use cards without permission to start a new subscription', () => {
  const input = withCards([start + DAY, start - 10], {
    subscription: { end: start, channel: 'web', renew: false },
  });
  for (const renewal of [{ renew: false }, { renew: true, allowLapse: false }]) {
    Object.assign(input.subscription, renewal);
    const result = finish(planReset(input));
    assert.equal(result.total, 0);
    assert.deepEqual(result.unusedCards, [1, 2]);
    assert.equal(result.renewal, null);
  }
});

test('without renewal, using the card takes priority even with no extra quota', () => {
  const input = withCards([start + 5], {
    rate: 60,
    subscription: { end: start + 2, channel: 'web', renew: false },
    long: { end: start + DAY, remaining: 50 },
  });
  const result = finish(planReset(input));
  assert.equal(result.baseline, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(result.cards.map(card => card.number), [1]);
  assert.equal(result.cards[0].gain, 0);
});

test('measures the actual gain after a card shifts the weekly refreshes', () => {
  const input = withCards([start + 17 * DAY], {
    subscription: { end: start + 30 * DAY, channel: 'web' },
    long: { end: start + 7 * DAY, remaining: 100 },
    short: { amount: 16, remaining: 100, end: null },
  });
  const result = finish(planReset(input));
  assert.equal(result.baseline, 500);
  assert.equal(result.total, 576);
  assert.equal(result.cards[0].gain, 76);
});

test('deducts the natural refresh displaced by the first card', () => {
  const input = withCards([start + 1, start + 2], {
    subscription: { end: start + 3, channel: 'web' },
    long: { end: start + 1, remaining: 0 },
  });
  const result = finish(planReset(input));
  assert.equal(result.baseline, 100);
  assert.equal(result.total, 200);
  assert.deepEqual(result.cards.map(({ at, gain }) => [at, gain]), [[start, 0], [start + 1, 100]]);
});

test('reports a negative gain when a required card reduces the usable quota', () => {
  const input = withCards([start + 1], {
    subscription: { end: start + 3, channel: 'web' },
    long: { end: start + 2, remaining: 50 },
  });
  const result = finish(planReset(input));
  assert.equal(result.baseline, 150);
  assert.equal(result.total, 100);
  assert.equal(result.cards[0].gain, -50);
});

test('recalculates each card’s gain when an alternative changes the refreshes', () => {
  const input = withCards([start + 12, start + 6, start + 13], {
    rate: 300,
    subscription: { end: start + 32, channel: 'web' },
    long: { end: start + 4, remaining: 71 },
  });
  const original = finish(planReset(input));
  const later = finish(alternatePlan(input, original, 2, 1));
  assert.equal(later.total, original.total);
  assert.equal(original.total - original.baseline, 40);
  assert.deepEqual(original.cards.map(({ number, gain }) => [number, gain]), [[2, -20], [1, 30], [3, 30]]);
  assert.deepEqual(later.cards.map(({ number, gain }) => [number, gain]), [[2, -10], [1, 25], [3, 25]]);
});

test('rejoining defaults to the same date next month, clamped to month end', () => {
  for (const [from, to] of [
    ['2026-12-03T17:25', '2027-01-03T17:25'],
    ['2026-01-31T17:25', '2026-02-28T17:25'],
    ['2028-01-31T17:25', '2028-02-29T17:25'],
    ['2026-03-01T17:25', '2026-04-01T17:25'],
    ['2026-03-31T17:25', '2026-04-30T17:25'],
  ]) {
    const snapshot = new Date(from).getTime() / MINUTE;
    const input = withCards([], {
      snapshot,
      subscription: { end: snapshot, channel: 'web', renew: true },
    });
    delete input.card;
    const result = finish(planReset(input));
    assert.deepEqual(result.renewal, { kind: 'restart', at: snapshot });
    assert.equal(result.end, new Date(to).getTime() / MINUTE, from);
    assert.equal(result.total, result.baseline);
  }
});

test('an uninterrupted monthly renewal extends the current paid expiry', () => {
  const paidEnd = new Date('2026-01-31T17:25').getTime() / MINUTE;
  const input = withCards([], {
    snapshot: paidEnd - HOUR,
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: null },
    long: { end: paidEnd + 1, remaining: 100 },
  });
  const result = finish(planReset(input));
  assert.equal(result.renewal.kind, 'continue');
  assert.ok(result.renewal.at < paidEnd);
  assert.equal(result.end, new Date('2026-02-28T17:25').getTime() / MINUTE);
});

test('a full annual term can roll into a 366-day renewal on the same quota cycle', () => {
  const paidEnd = start + 365 * DAY;
  const input = withCards([], {
    subscription: { end: paidEnd, channel: 'web', renew: true, renewDays: 366, allowLapse: false },
    long: { end: start + 7 * DAY, remaining: 25 },
  });
  const result = finish(planReset(input));
  assert.equal(result.renewal.kind, 'continue');
  assert.equal(result.end, paidEnd + 366 * DAY);
  assert.equal(result.total, 10_425);
  assert.equal(result.events.find(event => event.type === 'cycle' && event.at > paidEnd).at, start + 371 * DAY);
});

test('an uninterrupted monthly renewal restores the original billing day after a short month', () => {
  for (const [from, billingDay, to] of [
    ['2026-01-31T17:25', 31, '2026-02-28T17:25'],
    ['2026-02-28T17:25', 31, '2026-03-31T17:25'],
    ['2026-02-28T17:25', 30, '2026-03-30T17:25'],
    ['2026-02-28T17:25', null, '2026-03-28T17:25'],
    ['2028-02-29T17:25', 31, '2028-03-31T17:25'],
    ['2026-04-30T17:25', 31, '2026-05-31T17:25'],
  ]) {
    const paidEnd = new Date(from).getTime() / MINUTE;
    const input = withCards([], {
      snapshot: paidEnd - HOUR,
      subscription: { end: paidEnd, channel: 'web', renew: true, billingDay },
      long: { end: paidEnd + 1, remaining: 100 },
    });
    const result = finish(planReset(input));
    assert.equal(result.renewal.kind, 'continue');
    assert.equal(result.end, new Date(to).getTime() / MINUTE, `${from}, billing day ${billingDay}`);
  }
});

test('resubscribing after lapsing sets a new monthly billing day', () => {
  const snapshot = new Date('2026-03-02T17:25').getTime() / MINUTE;
  const input = withCards([], {
    snapshot,
    subscription: { end: new Date('2026-02-28T17:25').getTime() / MINUTE, channel: 'web', renew: true, billingDay: 31 },
  });
  const result = finish(planReset(input));
  assert.deepEqual(result.renewal, { kind: 'restart', at: snapshot });
  assert.equal(result.end, new Date('2026-04-02T17:25').getTime() / MINUTE);
});

test('the default three-card example keeps the same gains when the last card moves past resubscription', () => {
  const time = value => new Date(value).getTime() / MINUTE;
  const snapshot = time('2026-11-21T09:00');
  const rejoin = time('2026-12-03T17:00');
  const input = withCards(['2026-11-21T13:00', '2026-11-23T09:00', '2026-12-21T09:00'].map(time), {
    snapshot,
    subscription: { end: time('2026-11-30T17:00'), channel: 'ios', graceDays: 3, renew: true },
    long: { end: time('2026-11-27T09:00'), remaining: 86 },
    short: { amount: 16, remaining: 100, end: null },
  });
  const original = finish(planReset(input));
  assert.deepEqual(original.renewal, { kind: 'restart', at: rejoin });
  assert.equal(original.end, time('2027-01-03T17:00'));

  const before = finish(alternatePlan(input, original, 3, 1));
  assert.ok(before.cards[2].window.end < rejoin);
  const candidate = finish(alternatePlan(input, before, 3, 1, { prepare: true }));
  const after = finish(describeAlternative(input, before, 3, candidate));
  assert.deepEqual(after.renewal, original.renewal);
  assert.deepEqual(after.cards.map(card => card.number), [1, 2, 3]);
  for (const plan of [original, before, after]) {
    assert.equal(plan.baseline, 686);
    assert.equal(plan.total, 916);
    assert.deepEqual(plan.cards.map(card => card.gain), [30, 100, 100]);
  }
  assert.deepEqual(after.cards[2].window, {
    start: time('2026-12-04T23:01'),
    end: time('2026-12-05T10:59'),
  });
});

test('a single dated card with renewal honors the time when it becomes usable', () => {
  const input = scenario({ rate: 6000, card: { from: start + 8, until: start + 9, restart: false },
    subscription: { end: start + 12, channel: 'web', renew: true, renewDays: 1 },
    long: { end: start + DAY * 2, remaining: 10 },
  });
  const result = finish(planReset(input));
  assert.equal(result.cards[0].at, start + 8);
  assert.equal(result.total, 210);
});

test('cards can be used before and after a healthy-mode gap between subscriptions', () => {
  const accessEnd = start + 2;
  const input = withCards([accessEnd, start + DAY + HOUR], {
    mode: 'healthy', hours: [8 * HOUR, 8 * HOUR + 2],
    subscription: { end: accessEnd - DAY, channel: 'ios', graceDays: 1, renew: true, renewDays: 1 },
    long: { end: start + 6 * DAY, remaining: 100 },
    resets: [{ at: accessEnd + 1 }],
  });
  const result = finish(planReset(input));
  assert.deepEqual(result.renewal, { kind: 'restart', at: start + DAY });
  assert.ok(result.cards[0].at < accessEnd);
  assert.ok(result.cards[1].at > result.renewal.at);
  assert.ok(result.events.some(event => event.type === 'lapse' && event.at === accessEnd));
  assert.ok(result.events.every(event => event.type !== 'announced'));
});

test('enumeration yields progress while comparing three identical future expiries', () => {
  const input = withCards([start + 30 * DAY, start + 30 * DAY, start + 30 * DAY], {
    subscription: { end: start + 9 * DAY + 8 * HOUR, channel: 'ios', graceDays: 3, renew: true, renewDays: 30 },
    short: { end: null, remaining: 100, amount: 16 },
    long: { end: start + 4 * DAY, remaining: 24 },
  });
  const search = planReset(input);
  let step = search.next();
  let preview;
  while (!step.done) {
    if (step.value) preview = step.value;
    step = search.next();
  }
  const result = step.value;
  assert.ok(preview && preview.total <= result.total);
  assert.equal(result.total, 924);
  assert.equal(result.cards.length, 3);
});

test('validates each card expiry, renewal length, and monthly billing day', () => {
  const input = withCards([start + DAY, null]);
  input.cards[1].field = 'second-card';
  assert.throws(() => finish(planReset(input)), { field: 'second-card' });
  input.cards[1].until = start + 2 * DAY;
  input.subscription.renew = true;
  for (const days of [0, 367, 1.5]) {
    input.subscription.renewDays = days;
    assert.throws(() => finish(planReset(input)), { field: 'renew-days' });
  }
  delete input.subscription.renewDays;
  for (const day of [0, 32, 1.5]) {
    input.subscription.billingDay = day;
    assert.throws(() => finish(planReset(input)), { field: 'billing-day' });
  }
  input.subscription.renewDays = 30;
  input.subscription.end = start + 400 * DAY + 1;
  assert.throws(() => finish(planReset(input)), { field: 'subscription-end' });
});

function portfolioByMinute(input) {
  const { snapshot, subscription, long, short, card, cards, hours } = input;
  const cap = short?.amount ?? Infinity;
  const memo = new Map();
  function visit(at, weekly, weeklyDue, fiveHour, fiveHourDue, used) {
    if (at === subscription.end) return { count: 0, total: 0 };
    if (weeklyDue === at) {
      weekly = 100;
      weeklyDue = at + 7 * DAY;
    }
    if (fiveHourDue === at) {
      fiveHour = cap;
      fiveHourDue = Infinity;
    }
    if (input.resets.some(event => event.at === at)) {
      weekly = 100;
      weeklyDue = at + 7 * DAY;
      fiveHour = cap;
      fiveHourDue = Infinity;
    }
    const key = [at, weekly, weeklyDue, fiveHour, fiveHourDue, used].join('|');
    if (memo.has(key)) return memo.get(key);
    const time = new Date(at * MINUTE);
    const minute = time.getHours() * 60 + time.getMinutes();
    const active = input.mode === 'extreme' || (hours[0] < hours[1]
      ? minute >= hours[0] && minute < hours[1] : minute >= hours[0] || minute < hours[1]);
    function use(w, wd, s, sd, number) {
      const spent = active ? Math.min(w, s) : 0;
      if (short && spent > 0 && sd === Infinity) sd = at + 5 * HOUR;
      const mask = number === null ? used : used | (1 << number);
      const future = visit(at + 1, w - spent, wd, s - spent, sd, mask);
      return { count: future.count + Number(number !== null), total: future.total + spent };
    }
    let best = use(weekly, weeklyDue, fiveHour, fiveHourDue, null);
    if (active && (weekly < 80 || (short && fiveHour < 0.8 * cap))) {
      for (const [number, { until }] of cards.entries()) {
        if (until <= at || (used & (1 << number))) continue;
        const wd = card.restart && weekly < 100 ? at + 7 * DAY : weeklyDue;
        const sd = card.restart && fiveHour < cap ? Infinity : fiveHourDue;
        const trial = use(100, wd, cap, sd, number);
        if (trial.count > best.count || (trial.count === best.count && trial.total > best.total)) best = trial;
      }
    }
    memo.set(key, best);
    return best;
  }
  return visit(snapshot, long.remaining, long.end, short ? cap * short.remaining / 100 : Infinity,
    short?.end ?? Infinity, 0);
}

test('pruned multi-card enumeration matches independent per-minute DP', () => {
  let seed = 87234;
  const random = size => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % size;
  };
  for (let index = 0; index < 80; index++) {
    const horizon = index % 10 === 0 ? 312 : 6 + random(32);
    const input = withCards(Array.from({ length: 1 + random(3) }, () => start + 1 + random(11)), {
      subscription: { end: start + horizon, channel: 'web', renew: false },
      mode: random(2) ? 'healthy' : 'extreme', hours: [8 * HOUR + random(4), 8 * HOUR + 6 + random(30)],
      long: { end: start + 1 + random(horizon + 6), remaining: random(101) },
      short: random(2) ? null : { end: start + 1 + random(horizon + 6), remaining: random(101), amount: 16 },
      card: { restart: Boolean(random(2)) }, resets: Array.from({ length: random(3) }, () => ({ at: start + random(horizon) })),
    });
    const expected = portfolioByMinute(input);
    const actual = finish(planReset(input));
    assert.equal(actual.cards.length, expected.count, `case ${index}: card count`);
    assert.ok(Math.abs(actual.total - expected.total) < 1e-6, `case ${index}: ${actual.total} ≠ ${expected.total}`);
  }
});
