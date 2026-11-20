(() => {
  'use strict';

  const MINUTE = 60_000;
  const DAY = 24 * 60;
  const WEEK = 7 * DAY;
  const FIVE_HOURS = 5 * 60;
  const LONG = 1;
  const SHORT = 2;
  const ALL_LIMITS = LONG | SHORT;
  const EPSILON = 1e-7;

  function requireInput(condition, field, message) {
    if (!condition) throw Object.assign(new RangeError(message), { field });
  }

  function accessEnd(subscription) {
    return subscription.end + (subscription.channel === 'ios' ? Math.round(subscription.graceDays * DAY) : 0);
  }

  function schedule(input, start, end, interruption) {
    const points = new Map();
    function point(at) {
      if (!points.has(at)) points.set(at, { at, change: 0, resets: [] });
      return points.get(at);
    }
    function allow(from, to) {
      const open = Math.max(start, from);
      const close = Math.min(end, to);
      if (open >= close) return;
      point(open).change++;
      point(close).change--;
    }

    point(start);
    point(end);
    if (interruption) {
      if (interruption.from >= start) point(interruption.from).lapse = true;
      point(interruption.to).resume = true;
    }
    if (input.mode === 'extreme') {
      allow(start, end);
    } else {
      const [open, close] = input.hours;
      const overnight = close < open;
      const day = new Date(start * MINUTE);
      day.setHours(0, 0, 0, 0);
      for (let midnight = day.getTime() / MINUTE; midnight < end; midnight = day.getTime() / MINUTE) {
        day.setDate(day.getDate() + 1);
        day.setHours(0, 0, 0, 0);
        const next = day.getTime() / MINUTE;
        if (next - midnight === DAY) {
          if (overnight) allow(midnight, midnight + close);
          allow(midnight + open, overnight ? next : midnight + close);
          continue;
        }

        // 按实际分钟检查夏令时切换当天跳过或重复的本地时间。
        const until = Math.min(next, end);
        let from = null;
        for (let at = Math.max(midnight, start); at < until; at++) {
          const local = new Date(at * MINUTE);
          const minute = local.getHours() * 60 + local.getMinutes();
          const active = overnight ? minute >= open || minute < close : minute >= open && minute < close;
          if (active && from === null) from = at;
          if (!active && from !== null) {
            allow(from, at);
            from = null;
          }
        }
        if (from !== null) allow(from, until);
      }
    }

    const enabled = input.short ? ALL_LIMITS : LONG;
    for (const reset of input.resets) {
      const scope = (reset.scope ?? ALL_LIMITS) & enabled;
      if (scope && start <= reset.at && reset.at < end) {
        point(reset.at).resets.push(scope);
      }
    }

    const ordered = [...points.values()]
      .filter(point => point.at === start || point.at === end || point.change || point.resets.length || point.lapse || point.resume)
      .sort((left, right) => left.at - right.at);
    let active = 0;
    return ordered.slice(0, -1).map((entry, index) => {
      active += entry.change;
      const suspended = Boolean(interruption && entry.at >= interruption.from && entry.at < interruption.to);
      return { ...entry, end: ordered[index + 1].at, active: active > 0 && !suspended, suspended };
    });
  }

  function resetLimits(state, model, scope, restart, moving) {
    if (scope & LONG) {
      state.long = 100;
      if (restart) {
        state.longDue = state.at + WEEK;
        if (moving) moving.longDue = moving.at;
      }
    }
    if (scope & SHORT) {
      state.short = model.shortCap;
      if (restart) {
        state.shortDue = Infinity;
        if (moving) moving.shortDue = false;
      }
    }
  }

  function processBoundary(state, model, events, moving) {
    const time = state.at;
    const segment = model.segments[state.segment];
    const begins = segment.at === time;
    if (begins && segment.lapse) {
      state.long = 0;
      state.short = model.shortEnabled ? 0 : Infinity;
      state.longDue = state.shortDue = Infinity;
      if (moving) moving.longDue = moving.shortDue = false;
      events?.push({ at: time, type: 'lapse' });
    }
    if (segment.suspended) return;
    if (begins && segment.resume) {
      resetLimits(state, model, model.enabled, true, moving);
      events?.push({ at: time, type: 'renewal', kind: 'restart', scope: model.enabled });
    }
    const refreshed = (state.longDue === time ? LONG : 0) | (state.shortDue === time ? SHORT : 0);
    if (refreshed) {
      resetLimits(state, model, refreshed, true, moving);
      events?.push({ at: time, type: 'cycle', scope: refreshed });
    }

    if (!begins) return;
    for (const scope of segment.resets) {
      resetLimits(state, model, scope, true, moving);
      events?.push({ at: time, type: 'announced', scope });
    }
  }

  function advance(state, target, model, events, usageWindows, moving) {
    while (state.at < target) {
      const segment = model.segments[state.segment];
      const canSpend = segment.active && model.rate > 0 && state.long > 0 && state.short > 0;
      if (canSpend && model.shortEnabled && state.shortDue === Infinity) {
        state.shortDue = state.at + FIVE_HOURS;
        if (moving) moving.shortDue = moving.at;
      }

      const next = Math.min(target, segment.end, state.longDue, state.shortDue);
      if (moving) {
        const fixed = Math.min(target, segment.end, moving.longDue ? Infinity : state.longDue,
          moving.shortDue ? Infinity : state.shortDue);
        const shifted = Math.min(moving.longDue ? state.longDue : Infinity, moving.shortDue ? state.shortDue : Infinity);
        // Stop skipping where a moving clock could change the order of these events.
        if (shifted <= fixed) moving.skip = Math.min(moving.skip, Math.max(1, fixed - shifted));
        if (moving.at && next === fixed) moving.skip = Math.min(moving.skip, Math.max(1, fixed - state.at));
        moving.at = shifted < fixed;
      }
      if (canSpend) {
        const spent = Math.min((next - state.at) * model.rate, state.long, state.short);
        usageWindows?.push({ start: state.at, end: next, amount: spent });
        state.long -= spent;
        state.short -= spent;
        state.used += spent;
      }
      state.at = next;
      if (next === model.end) return;
      if (next === segment.end) state.segment++;
      if (next === segment.end || next === state.longDue || next === state.shortDue) {
        processBoundary(state, model, events, moving);
      }
    }
  }

  function cardScope(state, card, model) {
    const covered = card.scope ?? ALL_LIMITS;
    const threshold = card.threshold ?? 80;
    const longCovered = covered & LONG;
    const shortCovered = model.shortEnabled && (covered & SHORT);
    const eligible = (longCovered && state.long < threshold - EPSILON)
      || (shortCovered && state.short < model.shortCap * threshold / 100 - EPSILON);
    if (!eligible) return 0;

    return (longCovered && 100 - state.long > EPSILON ? LONG : 0)
      | (shortCovered && model.shortCap - state.short > EPSILON ? SHORT : 0);
  }

  function recommendWindow(scores, first, baseline, bestTotal, tolerance) {
    const qualifies = score => score > baseline + EPSILON && score + EPSILON >= bestTotal - tolerance;
    let recommendation = { at: null, window: null };
    for (let index = 0; index < scores.length;) {
      if (!qualifies(scores[index])) {
        index++;
        continue;
      }

      const start = first + index;
      let at = null;
      let minTotal = Infinity;
      do {
        const score = scores[index];
        minTotal = Math.min(minTotal, score);
        if (at === null && score + EPSILON >= bestTotal) at = first + index;
        index++;
      } while (index < scores.length && qualifies(scores[index]));

      const end = first + index - 1;
      const previous = recommendation.window;
      if (at !== null && (!previous || end - start > previous.end - previous.start)) {
        recommendation = { at, window: { start, end, minTotal } };
      }
    }
    return recommendation;
  }

  function validateCycles(input, start, end) {
    const { long, short } = input;
    if (end > start) {
      requireInput(long.start == null || long.start <= start, 'long-start', '本轮周额度的开始时间需要早于或等于推演起点。');
      requireInput(long.end > start, 'long-end', '周额度下次刷新时间需要晚于推演起点。');
      requireInput(!short || short.end !== null || short.remaining === 100,
        'short-end', '5 小时额度未满时，请填写当前窗口的刷新时间。');
      requireInput(!short || short.end === null || short.end > start,
        'short-end', '5 小时额度的刷新时间需要晚于推演起点。');
    }
    requireInput(input.mode !== 'healthy' || input.hours[0] !== input.hours[1],
      'awake-end', '健康模式的起止时间需要不同。全天可用时可选择极限使用。');
    requireInput(end - start <= 400 * DAY, 'subscription-end', '当前订阅最多可推演 400 天（含宽限期）。');
  }

  function makeModel(input, start, end, interruption) {
    return {
      end,
      segments: schedule(input, start, end, interruption),
      rate: (input.rate ?? Infinity) / 60,
      shortEnabled: Boolean(input.short),
      shortCap: input.short?.amount ?? Infinity,
      enabled: input.short ? ALL_LIMITS : LONG,
    };
  }

  function initialState(input, start, active) {
    const { long, short } = input;
    return {
      at: start,
      segment: 0,
      long: active ? long.remaining : 0,
      longDue: active ? long.end : Infinity,
      short: short ? (active ? short.amount * short.remaining / 100 : 0) : Infinity,
      shortDue: active ? short?.end ?? Infinity : Infinity,
      used: 0,
    };
  }

  function* searchSingle(input, makeScorer) {
    const { snapshot: start, subscription, card } = input;
    const tolerance = card.tolerance ?? 1;
    const end = accessEnd(subscription);
    requireInput(Number.isInteger(card.until), 'card-until', '请填写有效的重置卡到期时间。');
    requireInput(card.from == null || card.until > card.from,
      'card-until', '用卡截止时间需要晚于生效时间。');
    requireInput(Number.isFinite(tolerance) && tolerance >= 0,
      'card-tolerance', '时段容差需要为大于或等于 0 的有限数值。');
    if (end <= start) {
      return { start, end, at: null, window: null, total: 0, baseline: 0, reason: 'expired', events: [], usageWindows: [] };
    }

    validateCycles(input, start, end);

    const model = makeModel(input, start, end);
    const scoreAfterCard = makeScorer ? makeScorer(model, advance) : state => {
      advance(state, end, model);
      return state.used;
    };
    const initial = initialState(input, start, true);
    const events = [];
    processBoundary(initial, model, events);
    const baselineEnd = { ...initial };
    advance(baselineEnd, end, model);

    const baseline = baselineEnd.used;
    const demand = model.segments.reduce(
      (total, segment) => total + (segment.active ? (segment.end - segment.at) * model.rate : 0), 0,
    );
    const first = Math.max(start, card.from ?? start);
    const until = Math.min(end, card.until);
    const scores = new Float64Array(Math.max(0, until - first));
    const scopes = new Uint8Array(scores.length);
    const prefix = { ...initial };
    let bestTotal = baseline;
    let allowed = false;
    let eligible = false;
    let checked = 0;
    for (let time = first; time < until;) {
      advance(prefix, time, model);
      const segment = model.segments[prefix.segment];
      if (!segment.active) {
        time = segment.end;
        continue;
      }

      allowed = true;
      const scope = cardScope(prefix, card, model);
      if (scope) {
        eligible = true;
        if (baseline + EPSILON >= demand) break;
        const after = { ...prefix };
        resetLimits(after, model, scope, card.restart);
        const score = scoreAfterCard(after);
        scores[time - first] = score;
        scopes[time - first] = scope;
        bestTotal = Math.max(bestTotal, score);
      }

      time++;
      if (++checked % 512 === 0) yield;
    }

    const { at: bestAt, window } = recommendWindow(scores, first, baseline, bestTotal, tolerance);
    const chosen = { ...initial };
    const usageWindows = [];
    let usedBeforeCard;
    let restored;
    if (bestAt !== null) {
      advance(chosen, bestAt, model, events, usageWindows);
      usedBeforeCard = chosen.used;
      const scope = scopes[bestAt - first];
      restored = {
        scope,
        long: scope & LONG ? 100 - chosen.long : 0,
        short: scope & SHORT ? model.shortCap - chosen.short : 0,
      };
      resetLimits(chosen, model, scope, card.restart);
      events.push({ at: bestAt, type: 'card', scope });
    }
    advance(chosen, end, model, events, usageWindows);

    let reason = 'recommended';
    if (bestAt === null) {
      reason = !allowed ? 'outside-window' : eligible ? 'no-gain' : 'ineligible';
    }
    return { start, end, at: bestAt, window, baseline, total: bestAt === null ? baseline : bestTotal, reason, usedBeforeCard, restored, events, usageWindows };
  }

  function subscriptionOptions(input, start, currentEnd) {
    const { subscription } = input;
    if (!subscription.renew) return [{ end: currentEnd, renewal: null }];
    const { renewDays: days, billingDay } = subscription;
    requireInput(days == null || (Number.isInteger(days) && days >= 1 && days <= 366),
      'renew-days', '请填写 1 至 366 天。');
    requireInput(days != null || billingDay == null || (Number.isInteger(billingDay) && billingDay >= 1 && billingDay <= 31),
      'billing-day', '请填写 1 至 31 日。');
    function renewedTermEnd(at, day) {
      if (days != null) return at + days * DAY;
      const date = new Date(at * MINUTE);
      const nextMonth = date.getMonth() + 1;
      const monthEnd = new Date(0);
      monthEnd.setUTCFullYear(date.getFullYear(), nextMonth + 1, 0);
      date.setMonth(nextMonth, Math.min(day ?? date.getDate(), monthEnd.getUTCDate()));
      return date.getTime() / MINUTE;
    }
    const options = [];
    const lastPaymentWindow = end => schedule(input, Math.max(start, end - DAY), Math.max(start, end))
      .filter(segment => segment.active).at(-1);
    const paymentWindow = lastPaymentWindow(subscription.end) ?? lastPaymentWindow(currentEnd);
    if (paymentWindow) {
      options.push({ end: Math.max(currentEnd, renewedTermEnd(subscription.end, billingDay)), renewal: {
        kind: 'continue', at: paymentWindow.end - 1, grace: paymentWindow.end > subscription.end,
        window: { start: paymentWindow.at, end: paymentWindow.end - 1 },
      } });
    }
    if (subscription.allowLapse !== false) {
      const next = Math.max(start, currentEnd);
      const paid = schedule(input, next, next + 2 * DAY).find(segment => segment.active);
      requireInput(paid, 'awake-end', '找不到可续订的使用时段。');
      options.push({ end: renewedTermEnd(paid.at), renewal: { kind: 'restart', at: paid.at },
        interruption: { from: currentEnd, to: paid.at } });
    }
    requireInput(options.length > 0, 'awake-end', '找不到可续订的使用时段。');
    return options;
  }

  function nextCandidates(model, seed, cards, from) {
    if (model.rate !== Infinity) return time => time;
    const anchors = new Set();
    const minute = time => ((time % 60) + 60) % 60;
    for (const time of [seed.at, seed.longDue, seed.shortDue, model.end, from,
      ...cards.flatMap(card => [card.until, card.from]), ...model.segments.map(segment => segment.at)]) {
      if (Number.isFinite(time)) anchors.add(minute(time));
    }
    // Usage is instantaneous. Clocks add whole hours, so between fixed minute-of-hour
    // anchors only the order (including ties) of the card minutes can affect a score.
    const chosen = new Set(anchors);
    for (const at of anchors) {
      for (let offset = 1; offset <= cards.length && !anchors.has((at + offset) % 60); offset++) {
        chosen.add((at + offset) % 60);
      }
    }
    const steps = Array.from({ length: 60 }, (_, at) => {
      let offset = 0;
      while (!chosen.has((at + offset) % 60)) offset++;
      return offset;
    });
    return time => time + steps[minute(time)];
  }

  function betterPlan(total, count, best, useAll) {
    if (useAll && count !== best.moves.length) return count > best.moves.length;
    return total > best.total + EPSILON || (Math.abs(total - best.total) <= EPSILON && count < best.moves.length);
  }

  function* chooseCards(model, seed, cards, rule, useAll, incumbent, targetTotal) {
    const initial = { ...seed };
    processBoundary(initial, model);
    const finish = (state, moving) => {
      const final = { ...state };
      advance(final, model.end, model, undefined, undefined, moving);
      return final.used;
    };
    const baseline = finish(initial);
    let best = { total: baseline, moves: [] };
    let match = null;
    const moves = [];
    const first = Math.max(seed.at, rule.from ?? seed.at);
    const until = Math.min(model.end, cards.at(-1)?.until ?? first);
    const next = nextCandidates(model, seed, cards, first);
    const hardResets = model.segments.filter(segment => segment.lapse || segment.resume
      || (!segment.suspended && segment.resets.some(scope => scope & LONG)));
    const activeSegments = model.segments.filter(segment => segment.active);
    const shortOnlyResets = model.segments.filter(segment => !segment.suspended && segment.resets.includes(SHORT)).length;
    const tightShortBound = model.shortEnabled && model.rate === Infinity && model.shortCap > EPSILON
      && ((rule.scope ?? ALL_LIMITS) & LONG) && !shortOnlyResets;
    let checked = 0;
    let reported = false;

    function previousActive(at) {
      let left = 0;
      let right = activeSegments.length;
      while (left < right) {
        const index = (left + right) >>> 1;
        if (activeSegments[index].at <= at) left = index + 1;
        else right = index;
      }
      return left ? Math.min(at, activeSegments[left - 1].end - 1) : -Infinity;
    }

    const cutoffs = [...hardResets, { at: model.end }].map(segment => {
      const latest = [];
      const slots = tightShortBound ? Math.ceil(100 / model.shortCap) : 1;
      for (let at = previousActive(segment.at - 1); at >= seed.at && latest.length < slots;
        at = previousActive(at - FIVE_HOURS)) latest.push(at);
      return { ...segment, latest };
    });

    function usableFrom(from, cutoff) {
      if (!cutoff.latest.length || from > cutoff.latest[0]) return 0;
      if (!tightShortBound) return 100;
      let slots = 0;
      while (slots < cutoff.latest.length && cutoff.latest[slots] >= from) slots++;
      // A pending 5-hour timer can grant one extra balance after a weekly refresh.
      return Math.min(100, (slots + 1) * model.shortCap);
    }

    function weeklySupply(state) {
      let due = rule.restart ? Math.min(state.longDue, state.at + WEEK) : state.longDue;
      let balance = state.long;
      let from = state.at;
      let supply = state.used;
      for (const cutoff of cutoffs) {
        if (cutoff.at <= state.at) continue;
        const grants = Math.max(0, Math.ceil((cutoff.at - due) / WEEK));
        supply += grants ? balance + 100 * (grants - 1) + usableFrom(due + (grants - 1) * WEEK, cutoff)
          : Math.min(balance, usableFrom(from, cutoff));
        const refilled = cutoff.resume || !cutoff.lapse;
        balance = refilled ? 100 : 0;
        due = refilled ? cutoff.at + WEEK : Infinity;
        from = cutoff.at;
      }
      return supply;
    }

    function canImprove(state, count, remaining) {
      if (targetTotal !== undefined) {
        return count + remaining === cards.length && weeklySupply(state) + 100 * remaining + EPSILON >= targetTotal;
      }
      if (useAll && count + remaining !== best.moves.length) return count + remaining > best.moves.length;
      const supply = weeklySupply(state);
      if (incumbent) {
        const highest = supply + 100 * remaining;
        const matching = Math.min(remaining, incumbent.moves.length - count);
        if (highest + EPSILON < incumbent.total || (highest <= incumbent.total + EPSILON
          && (matching < 0 || supply + 100 * matching + EPSILON < incumbent.total))) return false;
      }
      if (supply + 100 * remaining > best.total + EPSILON) return true;
      if (useAll || count >= best.moves.length) return false;
      const fewer = Math.min(remaining, best.moves.length - count - 1);
      return supply + 100 * fewer + EPSILON >= best.total;
    }

    function consider(total, choices) {
      if (targetTotal !== undefined) {
        if (choices.length === cards.length && Math.abs(total - targetTotal) <= EPSILON) {
          match = { total, moves: choices.slice() };
        }
      } else if (betterPlan(total, choices.length, best, useAll)) {
        best = { total, moves: choices.slice() };
      }
    }

    function* tryEarlyMoves(from, drainWeekly) {
      const state = { ...initial };
      const trial = [];
      let time = next(from);
      for (const card of cards) {
        if (card.from > time) time = next(card.from);
        const until = Math.min(model.end, card.until);
        const prefix = { ...state };
        let selected;
        while (time < until) {
          advance(prefix, time, model);
          const segment = model.segments[prefix.segment];
          if (!segment.active) {
            time = next(segment.end);
            continue;
          }
          if (++checked % 512 === 0) yield;
          const scope = cardScope(prefix, rule, model);
          if (scope && (!selected || prefix.long < selected.long - EPSILON)) {
            selected = { ...prefix };
            if (!drainWeekly || prefix.long <= EPSILON) break;
          }
          time = next(time + 1);
        }
        if (!selected) continue;
        Object.assign(state, selected);
        resetLimits(state, model, cardScope(state, rule, model), rule.restart);
        trial.push({ ...card, at: state.at });
        consider(finish(state), trial);
        time = next(state.at + 1);
      }
    }

    function* visit(state, index, moving) {
      const count = moves.length;
      if (targetTotal !== undefined ? count === cards.length : !useAll || count >= best.moves.length) {
        consider(count ? finish(state, moving) : baseline, moves);
        if (match) return;
      }
      const prefix = { ...state };
      for (let time = next(Math.max(first, state.at + (count ? 1 : 0))); time < until;) {
        while (index < cards.length && cards[index].until <= time) index++;
        if (index === cards.length) break;
        const card = cards[index];
        if (card.from > time) {
          time = next(card.from);
          continue;
        }
        const remaining = cards.length - index;
        advance(prefix, time, model);
        if (!canImprove(prefix, count, remaining)) break;
        const segment = model.segments[prefix.segment];
        if (!segment.active) {
          time = next(segment.end);
          continue;
        }
        if (++checked % 512 === 0) {
          if (targetTotal === undefined && !reported && checked >= 131_072) {
            reported = true;
            yield { ...best, baseline };
          } else yield;
        }
        const scope = cardScope(prefix, rule, model);
        const stable = model.rate !== Infinity || (prefix.long > 0 && prefix.short > 0) ? time + 1
          : Math.min(segment.end, prefix.longDue, prefix.shortDue, card.until, until);
        let step = scope ? 1 : stable - time;
        if (scope) {
          const after = { ...prefix };
          const leaf = remaining === 1 && model.rate === Infinity
            ? { at: true, longDue: false, shortDue: false, skip: stable - time } : null;
          resetLimits(after, model, scope, rule.restart, leaf);
          if (canImprove(after, count + 1, remaining - 1)) {
            // Swapping identical cards to use the earliest valid expiry first never loses a future action.
            moves.push({ ...card, at: time });
            yield* visit(after, index + 1, leaf);
            moves.pop();
            if (match) return;
          }
          if (!rule.restart && (!model.shortEnabled || Number.isFinite(after.shortDue))) step = stable - time;
          if (leaf) step = Math.max(step, leaf.skip);
        }
        time = next(time + step);
      }
    }

    yield* tryEarlyMoves(first, useAll ? false : true);
    if (targetTotal !== undefined) {
      if (!match) yield* visit(initial, 0);
      return match;
    }
    if (cards.length > 1) {
      if (useAll) yield* tryEarlyMoves(first, true);
      yield* tryEarlyMoves(Math.max(first, seed.longDue), true);
      for (const segment of hardResets) {
        if (segment.at >= first && segment.at < until) yield* tryEarlyMoves(segment.at, true);
      }
    }
    yield* visit(initial, 0);
    return { ...best, baseline };
  }

  function replay(model, seed, moves, rule, events, usageWindows) {
    const state = { ...seed };
    processBoundary(state, model, events);
    for (const move of moves) {
      if (move.at >= Math.min(model.end, move.until) || move.at < move.from || move.at < state.at) return -Infinity;
      advance(state, move.at, model, events, usageWindows);
      if (!model.segments[state.segment].active) return -Infinity;
      const scope = cardScope(state, rule, model);
      if (!scope) return -Infinity;
      resetLimits(state, model, scope, rule.restart);
      events?.push({ at: move.at, type: 'card', scope, number: move.number });
    }
    advance(state, model.end, model, events, usageWindows);
    return state.used;
  }

  function moveBounds(model, seed, moves, index, rule) {
    const move = moves[index];
    return {
      lower: Math.max(rule.from ?? seed.at, move.from ?? seed.at, (moves[index - 1]?.at ?? seed.at - 1) + 1),
      upper: Math.min(move.until, model.end, moves[index + 1]?.at ?? Infinity) - 1,
    };
  }

  function* findingWindow(model, seed, moves, index, rule, total) {
    const move = moves[index];
    const { at } = move;
    const { lower, upper } = moveBounds(model, seed, moves, index, rule);
    let start = at;
    let end = at;
    for (const direction of [-1, 1]) {
      for (let time = at + direction; time >= lower && time <= upper; time += direction) {
        move.at = time;
        if ((time - at) % 512 === 0) yield;
        if (replay(model, seed, moves, rule) + EPSILON < total) break;
        if (direction < 0) start = time;
        else end = time;
      }
    }
    move.at = at;
    return { start, end };
  }

  function* describePlan(solution, seed, rule, cards, baseline, accessEnd, center) {
    const { model, option: { renewal } } = solution;
    const moves = solution.moves.map(move => ({ ...move }));
    if (center && moves.length > 1) {
      for (let index = moves.length - 1; index >= 0; index--) {
        const { start, end } = yield* findingWindow(model, seed, moves, index, rule, solution.total);
        moves[index].at = Math.floor((start + end) / 2);
      }
    }
    for (let index = 0; index < moves.length; index++) {
      moves[index].window = yield* findingWindow(model, seed, moves, index, rule, solution.total);
    }
    const events = [];
    const usageWindows = [];
    const total = replay(model, seed, moves, rule, events, usageWindows);
    let previous = baseline;
    for (let index = 0; index < moves.length; index++) {
      const subtotal = index === moves.length - 1 ? total : replay(model, seed, moves.slice(0, index + 1), rule);
      moves[index].gain = subtotal - previous;
      previous = subtotal;
    }
    if (renewal?.kind === 'continue') {
      events.push({ at: renewal.at, type: 'renewal', kind: 'continue', scope: 0 });
      events.sort((left, right) => left.at - right.at);
    }
    const used = new Set(moves.map(move => move.number));
    const unusedCards = cards.filter(card => !used.has(card.number)).map(card => card.number).sort((a, b) => a - b);
    return { start: seed.at, end: model.end, accessEnd, total, baseline, renewal,
      cards: moves, unusedCards, events, usageWindows };
  }

  const byDeadline = (left, right) => left.until - right.until || left.number - right.number;

  function portfolioCards(input, rule) {
    return (input.cards ?? [rule]).map(({ until, field }, index) => {
      requireInput(Number.isInteger(until), field ?? 'card-until', '请填写有效的重置卡到期时间。');
      requireInput(rule.from == null || until > rule.from, field ?? 'card-until', '用卡截止时间需要晚于生效时间。');
      return { until, number: index + 1 };
    }).sort(byDeadline);
  }

  function* findNearbyMove(model, seed, moves, index, rule, total, direction) {
    const { lower, upper } = moveBounds(model, seed, moves, index, rule);
    let checked = 0;
    for (let at = direction > 0 ? lower : upper; at >= lower && at <= upper; at += direction) {
      moves[index].at = at;
      if (Math.abs(replay(model, seed, moves, rule) - total) <= EPSILON) return moves;
      if (++checked % 512 === 0) yield;
    }
    return null;
  }

  function* alternatePlan(input, result, action, direction, { prepare = false } = {}) {
    const isRenewal = action === 'renewal';
    const focused = isRenewal ? result.renewal : result.cards.find(card => card.number === action);
    if (!focused || (direction !== -1 && direction !== 1)) return null;
    const { start, accessEnd: currentEnd, total } = result;
    const rule = input.card ?? { restart: true };
    const times = new Map(result.cards.map(({ number, at }) => [number, at]));
    // Keep the actual expiry order when narrowing the adjusted card's search range.
    const reserved = portfolioCards(input, rule).filter(card => times.has(card.number)).map(card => {
      if (action !== card.number) return card;
      return direction > 0 ? { ...card, from: focused.window.end + 1 }
        : { ...card, until: Math.min(card.until, focused.window.start) };
    });
    if (reserved.some(card => Math.max(start, rule.from ?? start, card.from ?? start) >= card.until)) return null;
    const seed = initialState(input, start, currentEnd > start);
    const options = subscriptionOptions(input, start, currentEnd);
    const currentKind = result.renewal?.kind;
    const current = options.find(option => option.renewal?.kind === currentKind);
    for (const option of [current, ...options.filter(option => option !== current)]) {
      if (isRenewal && (!option.renewal || direction * (option.renewal.at - focused.at) <= 0)) continue;
      const model = makeModel(input, start, option.end, option.interruption);
      const moves = reserved.map(card => ({ ...card, at: times.get(card.number) }));
      let replacement = null;
      if (isRenewal) {
        if (Math.abs(replay(model, seed, moves, rule) - total) <= EPSILON) replacement = moves;
      } else if (option === current) {
        const index = moves.findIndex(move => move.number === action);
        replacement = yield* findNearbyMove(model, seed, moves, index, rule, total, direction);
        if (!replacement && moves.length === 1) continue;
      }
      if (!replacement) {
        // If one move cannot change on its own, compare complete schedules with the requested time constraint.
        const search = yield* chooseCards(model, seed, reserved, rule, false, null, total);
        if (!search) continue;
        replacement = search.moves;
      }
      const candidate = { option, moves: replacement };
      if (prepare) return candidate;
      return yield* describeAlternative(input, result, action, candidate);
    }
    return null;
  }

  function* describeAlternative(input, result, action, { option, moves: scheduled }) {
    const { start, accessEnd: currentEnd, total, baseline } = result;
    const model = makeModel(input, start, option.end, option.interruption);
    const seed = initialState(input, start, currentEnd > start);
    const rule = input.card ?? { restart: true };
    const cards = portfolioCards(input, rule);
    const expiry = new Map(cards.map(card => [card.number, card.until]));
    const moves = scheduled.map(move => ({ ...move }));
    if (action !== 'renewal') {
      const index = moves.findIndex(move => move.number === action);
      const previous = new Map(result.cards.map(card => [card.number, card.at]));
      if (moves.some(move => move.number !== action && previous.get(move.number) !== move.at)) {
        // Free up the selected card's window after a search that stops at the first matching schedule.
        for (let other = moves.length - 1; other > index; other--) {
          const { end } = yield* findingWindow(model, seed, moves, other, rule, total);
          moves[other].at = end;
        }
        for (let other = 0; other < index; other++) {
          const { start } = yield* findingWindow(model, seed, moves, other, rule, total);
          moves[other].at = start;
        }
      }
      const window = yield* findingWindow(model, seed, moves, index, rule, total);
      moves[index].at = Math.floor((window.start + window.end) / 2);
    }
    const plan = yield* describePlan({ model, option, moves, total }, seed, rule, cards, baseline, currentEnd, false);
    plan.cards = plan.cards.map(({ from, ...card }) => ({ ...card, until: expiry.get(card.number) }));
    return plan;
  }

  function* searchPortfolio(input) {
    const { snapshot: start, subscription } = input;
    const currentEnd = accessEnd(subscription);
    const active = currentEnd > start;
    const rule = input.card ?? { restart: true };
    const cards = portfolioCards(input, rule);
    if (!active && (!subscription.renew || subscription.allowLapse === false)) {
      return { start, end: currentEnd, accessEnd: currentEnd, total: 0, baseline: 0, renewal: null,
        cards: [], unusedCards: cards.map(card => card.number).sort((a, b) => a - b), events: [], usageWindows: [] };
    }
    validateCycles(input, start, currentEnd);
    const options = subscriptionOptions(input, start, currentEnd);
    const seed = initialState(input, start, active);
    const useAll = !subscription.renew;
    let best;
    let baseline = 0;
    function chooseOption(result, option, model) {
      const preferred = !best || betterPlan(result.total, result.moves.length, best, useAll)
        || (option.renewal?.kind === 'continue' && Math.abs(result.total - best.total) <= EPSILON
          && result.moves.length === best.moves.length);
      return preferred ? { ...result, model, option } : best;
    }

    for (const option of options.reverse()) {
      const model = makeModel(input, start, option.end, option.interruption);
      const search = chooseCards(model, seed, cards, rule, useAll, best);
      let step = search.next();
      while (!step.done) {
        if (step.value) {
          const draft = step.value;
          const proposal = chooseOption(draft, option, model);
          const preview = yield* describePlan(proposal, seed, rule, cards, Math.max(baseline, draft.baseline), currentEnd, false);
          yield preview;
        } else yield;
        step = search.next();
      }
      const result = step.value;
      baseline = Math.max(baseline, result.baseline);
      best = chooseOption(result, option, model);
    }
    return yield* describePlan(best, seed, rule, cards, baseline, currentEnd, true);
  }

  function* planReset(input, makeScorer) {
    if (!input.cards && !input.subscription.renew) return yield* searchSingle(input, makeScorer);
    return yield* searchPortfolio(input);
  }

  const api = { planReset, alternatePlan, describeAlternative };
  if (typeof module === 'object') module.exports = api;
  else globalThis.Resetwise = api;
})();
