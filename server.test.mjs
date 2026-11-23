import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import planner from './planner.js';
import { createServer } from './server.mjs';

const minute = (date, offset = '+08:00') => Date.parse(date + offset) / 60_000;
const card = (at, number) => ({ until: at, field: `card-until-${number}` });
const example = {
  timeZone: 'Asia/Shanghai',
  snapshot: minute('2026-11-21T09:00'),
  mode: 'extreme',
  hours: [480, 1380],
  subscription: { end: minute('2026-11-30T17:00'), channel: 'ios', graceDays: 3,
    renew: true, renewDays: null, billingDay: null },
  long: { start: null, end: minute('2026-11-27T09:00'), remaining: 86 },
  short: { amount: 16, remaining: 100, end: null },
  card: { restart: true },
  cards: ['2026-11-21T13:00', '2026-11-23T09:00', '2026-12-21T09:00']
    .map((date, index) => card(minute(date), index + 1)),
  resets: [],
};

const server = createServer();
let url;
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

function post(data) {
  return fetch(url + '/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function receive(data) {
  const response = await post(data);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson\b/);
  const messages = body.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.at(-1).type, 'result', body);
  return messages;
}

async function solve(input) {
  return (await receive({ operation: 'plan', input })).at(-1).value;
}

test('serves the page and its assets, with the planner and server files outside the public routes', async () => {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /src="[^"]*planner\.js/);
  for (const path of ['/app.js', '/style.css', '/i18n.js']) {
    assert.equal((await fetch(url + path)).status, 200);
  }
  for (const path of ['/planner.js', '/server.mjs', '/api/plan.mjs', '/.openai/hosting.json']) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  assert.equal((await fetch(url + '/api/plan')).status, 405);
});

test('plans the three-card example and keeps its 916% total when the third card moves past renewal', async () => {
  const original = await solve(example);
  const rejoin = minute('2026-12-03T17:00');
  assert.equal(original.baseline, 686);
  assert.deepEqual(original.renewal, { kind: 'restart', at: rejoin });

  async function moveLater(plan, checkFirst = false) {
    const jobs = [{ action: 3, direction: 1 }];
    if (checkFirst) jobs.push({ action: 1, direction: -1 });
    const updates = await receive({ operation: 'choices', plan: plan.planToken, jobs });
    if (checkFirst) assert.equal(updates.find(item => item.value?.action === 1).value.choice, null);
    const candidate = updates.find(item => item.value?.action === 3).value.choice;
    assert.equal(typeof candidate, 'string');
    return (await receive({ operation: 'describe', plan: plan.planToken, candidate })).at(-1).value;
  }

  const before = await moveLater(original, true);
  assert.ok(before.cards[2].window.end < rejoin);
  const after = await moveLater(before);
  assert.deepEqual(after.cards[2].window, {
    start: minute('2026-12-04T23:01'), end: minute('2026-12-05T10:59'),
  });
  for (const result of [original, before, after]) {
    assert.equal(result.total, 916);
    assert.deepEqual(result.cards.map(({ gain }) => gain), [30, 100, 100]);
    assert.deepEqual(result.cards.map(({ number }) => number), [1, 2, 3]);
  }
});

test('keeps each concurrent request in its own time zone through DST and monthly renewal', async () => {
  const start = minute('2026-11-01T00:00', '-07:00');
  const sensitive = {
    ...example, snapshot: start, mode: 'healthy', hours: [90, 120], short: null,
    subscription: { ...example.subscription, channel: 'web', end: minute('2026-11-30T16:30', '-08:00') },
    long: { start: null, end: start + 10_080, remaining: 10 },
    cards: [card(start, 1)],
  };
  function expected(input) {
    const previous = process.env.TZ;
    process.env.TZ = input.timeZone;
    try {
      const search = planner.planReset(input);
      let step;
      do { step = search.next(); } while (!step.done);
      return step.value;
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  const inputs = ['America/Los_Angeles', 'Asia/Shanghai', 'America/Los_Angeles', 'UTC']
    .map(timeZone => ({ ...sensitive, timeZone }));
  const expectedPlans = inputs.map(expected);
  assert.notDeepEqual(expectedPlans[0].usageWindows, expectedPlans[1].usageWindows);
  assert.notEqual(expectedPlans[0].end, expectedPlans[1].end);
  const previous = process.env.TZ;
  const actual = await Promise.all(inputs.map(solve));
  assert.deepEqual(actual.map(({ planToken, ...result }) => result), expectedPlans);
  assert.equal(process.env.TZ, previous);
});

test('streams a preliminary plan before confirming the best result', async () => {
  const day = 1440;
  const input = {
    ...example,
    subscription: { ...example.subscription, renewDays: 30 },
    long: { ...example.long, end: example.snapshot + 4 * day, remaining: 24 },
    cards: [1, 2, 3].map(number => card(example.snapshot + 30 * day, number)),
  };
  const messages = await receive({ operation: 'plan', input });
  const draft = messages.find(message => message.type === 'progress');
  assert.ok(draft);
  assert.ok(draft.value.total <= 924);
  assert.equal(messages.at(-1).value.total, 924);
});

test('rejects invalid time zones, expired references and unknown operations', async () => {
  const invalid = await post({ operation: 'plan', input: { ...example, timeZone: 'Not/AZone' } });
  assert.equal(invalid.status, 400);
  const plan = await solve(example);
  const invalidPlan = await post({ operation: 'choices', plan: `A${plan.planToken}`, jobs: [] });
  assert.equal(invalidPlan.status, 400);
  assert.equal((await post({ operation: 'unknown' })).status, 400);
});

test('bounds card and announcement counts before running the planner', async () => {
  const input = { ...example, subscription: { ...example.subscription, end: example.snapshot, graceDays: 0, renew: false },
    cards: Array.from({ length: 16 }, (_, index) => card(example.snapshot + 1, index + 1)),
    resets: Array.from({ length: 3 }, (_, index) => ({ at: example.snapshot + index + 1 })) };
  assert.equal((await solve(input)).total, 0);

  const tooManyCards = { ...input, cards: [...input.cards, card(example.snapshot + 1, 17)] };
  const tooManyResets = { ...input, resets: [...input.resets, { at: example.snapshot + 4 }] };
  for (const [oversized, field, message] of [
    [tooManyCards, 'add-card', '最多可安排 16 张重置卡。'],
    [tooManyResets, 'add-reset', '最多可添加 3 条自动重置公告。'],
  ]) {
    const response = await post({ operation: 'plan', input: oversized });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { field, message });
  }
});

test('reports an exhausted search budget without returning a final plan', async t => {
  let time = 100;
  t.mock.method(performance, 'now', () => time);
  t.mock.method(planner, 'planReset', function* () {
    time += 5000;
    yield;
    assert.fail('Search should stop at the budget');
  });

  const response = await post({ operation: 'plan', input: example });
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(response.status, 200);
  assert.deepEqual(frames.map(frame => frame.type), ['error']);
  assert.match(frames[0].value.message, /计算超时/);
});

test('validates the continuous-only option and keeps it when searching signed alternatives', async () => {
  const paidEnd = example.snapshot + 60;
  const input = { ...example, cards: [], short: null, long: { end: paidEnd + 1, remaining: 100 },
    subscription: { end: paidEnd, channel: 'web', graceDays: 0, renew: true, renewDays: 1, allowLapse: false } };
  const plan = await solve(input);
  assert.equal(plan.renewal.kind, 'continue');
  const job = { action: 'renewal', direction: 1 };
  const [update] = await receive({ operation: 'choices', plan: plan.planToken, jobs: [job] });
  assert.deepEqual(update.value, { ...job, choice: null });

  input.subscription.allowLapse = 'false';
  const response = await post({ operation: 'plan', input });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, 'renew-continuous-only');
});

test('rejects invalid tier changes before running the planner', async () => {
  const { snapshot, subscription } = example;
  const tierChange = { from: 'pro100', to: 'plus', at: subscription.end, weeklyPercent: 10 };
  const input = { ...example, tierChange };
  const cases = [
    [{ ...input, tierChange: 'plus' }, 'tier-from'],
    [{ ...input, tierChange: { ...tierChange, from: 'constructor' } }, 'tier-from'],
    [{ ...input, tierChange: { ...tierChange, to: 'pro100' } }, 'tier-to'],
    [{ ...input, tierChange: { ...tierChange, at: snapshot - 1 } }, 'tier-at'],
    [{ ...input, tierChange: { ...tierChange, at: subscription.end + 3 * 1440 + 1 } }, 'tier-at'],
    [{ ...input, subscription: { ...subscription, end: snapshot, graceDays: 0 },
      tierChange: { ...tierChange, at: snapshot } }, 'tier-at'],
    [{ ...input, subscription: { ...subscription, renew: false } }, 'subscription-renew'],
    [{ ...input, tierChange: { ...tierChange, weeklyPercent: undefined } }, 'tier-weekly-percent'],
    [{ ...input, tierChange: { ...tierChange, weeklyPercent: 0 } }, 'tier-weekly-percent'],
    [{ ...input, tierChange: { ...tierChange, weeklyPercent: 10001 } }, 'tier-weekly-percent'],
    [{ ...input, tierChange: { ...tierChange, shortAmount: 0 } }, 'tier-short-amount'],
    [{ ...input, tierChange: { ...tierChange, shortAmount: 101 } }, 'tier-short-amount'],
    [{ ...input, tierChange: { ...tierChange, to: 'pro200', shortAmount: 16 } }, 'tier-short-amount'],
  ];
  for (const [invalidInput, field] of cases) {
    const response = await post({ operation: 'plan', input: invalidInput });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).field, field);
  }
});

test('keeps the tier change and current quota units when describing a signed alternative', async () => {
  const at = example.snapshot + 60;
  const input = { ...example, short: null, long: { end: at + 300, remaining: 80 },
    subscription: { end: at, channel: 'web', graceDays: 0, renew: true, renewDays: 1 },
    tierChange: { from: 'pro100', to: 'pro200', at, weeklyPercent: 200 },
    card: { restart: false }, cards: [card(at + 1440, 1)] };
  const original = await solve(input);
  const jobs = [{ action: 1, direction: -1 }, { action: 1, direction: 1 }, { action: 'renewal', direction: 1 }];
  const messages = await receive({ operation: 'choices', plan: original.planToken, jobs });
  const choices = messages.filter(message => message.type === 'progress').map(message => message.value);
  assert.equal(choices.find(choice => choice.action === 'renewal').choice, null);
  const candidate = choices.find(choice => choice.action === 1 && typeof choice.choice === 'string')?.choice;
  assert.ok(candidate);
  const alternative = (await receive({ operation: 'describe', plan: original.planToken, candidate })).at(-1).value;

  assert.notEqual(alternative.cards[0].at, original.cards[0].at);
  for (const plan of [original, alternative]) {
    const { kind, from, to, at: effective } = plan.renewal;
    assert.deepEqual({ kind, from, to, at: effective }, { kind: 'switch', from: 'pro100', to: 'pro200', at });
    assert.equal(plan.end, at + 1440);
    assert.equal(plan.baseline, 380);
    assert.equal(plan.total, 580);
  }
});

test('applies the supplied Plus 5-hour allowance at a switch at the snapshot', async () => {
  const { snapshot } = example;
  const input = { ...example, short: null, long: { end: snapshot + 4 * 1440, remaining: 100 },
    subscription: { end: snapshot + 60, channel: 'web', graceDays: 0, renew: true, renewDays: 1 },
    tierChange: { from: 'pro100', to: 'plus', at: snapshot, weeklyPercent: 10, shortAmount: 25 }, cards: [] };
  const plan = await solve(input);
  assert.equal(plan.total, 10);
  assert.equal(plan.usageWindows[0].amount, 2.5);
});

test('measures both tiers against the current allowance when upgrading from Plus', async () => {
  const at = example.snapshot + 60;
  const input = { ...example, long: { end: at + 4 * 1440, remaining: 80 },
    subscription: { end: at, channel: 'web', graceDays: 0, renew: true, renewDays: 1 },
    tierChange: { from: 'plus', to: 'pro100', at, weeklyPercent: 1000 }, cards: [] };
  const plan = await solve(input);
  assert.equal(plan.baseline, 980);
  assert.equal(plan.total, 980);
  assert.deepEqual(plan.usageWindows.map(({ amount }) => amount), [16, 964]);
});

test('reports a failed direction, keeps confirmed results, and allows a retry', async t => {
  const original = await solve(example);
  const alternate = planner.alternatePlan;
  let fail = true;
  t.mock.method(console, 'error', () => {});
  t.mock.method(planner, 'alternatePlan', function* (input, result, action, direction, options) {
    if (fail && action === 3 && direction === 1) throw new Error('Simulated search failure');
    return yield* alternate(input, result, action, direction, options);
  });

  const later = { action: 3, direction: 1 };
  const earlier = { action: 1, direction: -1 };
  const search = jobs => receive({ operation: 'choices', plan: original.planToken, jobs });
  const failed = await search([later, earlier]);
  const failure = failed.find(frame => frame.value?.action === 3).value;
  assert.equal(failure.direction, 1);
  assert.equal('choice' in failure, false);
  assert.match(failure.error.message, /请重试/);
  assert.deepEqual(failed.find(frame => frame.value?.action === 1).value, { ...earlier, choice: null });

  fail = false;
  const retried = await search([later]);
  assert.equal(typeof retried[0].value.choice, 'string');
});
