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
