import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createServer } from './server.mjs';
import { buildInput, first, more, normalizeUsage } from './codex-plugin/skills/plan-codex-quota/scripts/resetwise.mjs';

const ms = value => Date.parse(value + '+08:00');
const minute = value => ms(value) / 60_000;
const snapshot = '2026-11-21T09:00';
const weekly = { windowDurationMins: 10_080, usedPercent: 14, resetsAt: ms('2026-11-27T09:00') / 1000 };
const short = { windowDurationMins: 300, usedPercent: 0, resetsAt: null };
const subscription = { end: minute('2026-11-30T17:00'), channel: 'ios' };
const credits = ['2026-11-21T13:00', '2026-11-23T09:00', '2026-12-21T09:00']
  .map((expiry, index) => ({ id: `example-card-${index}`, status: 'available', resetType: 'codexRateLimits', expiresAt: ms(expiry) / 1000 }));

function usage(planType, secondary, resetCredits = { availableCount: credits.length, credits }) {
  return normalizeUsage({
    rateLimitsByLimitId: { codex: { planType, primary: weekly, secondary }, other: { primary: short } },
    rateLimitResetCredits: resetCredits,
  }, ms(snapshot), 'Asia/Shanghai');
}

const server = createServer();
let origin;
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

test('keeps current Pro tiers weekly-only and checks actual window lengths before using the plan tier', () => {
  for (const tier of ['prolite', 'pro', 'promax']) {
    const profile = usage(tier, null);
    assert.equal(profile.fiveHour.status, 'weekly-only');
    assert.equal(buildInput(profile, { subscription }).input.short, null);
  }
  const withWindow = usage('prolite', short);
  assert.deepEqual(withWindow.fiveHour, { status: 'limited', remaining: 100, end: null });
  assert.deepEqual(buildInput(withWindow, { subscription }).input.short, { amount: 16, remaining: 100, end: null });
  assert.deepEqual(buildInput(usage('plus', null), { subscription }), { missing: ['short'] });
});

test('keeps missing card details and subscription fields visible to the caller', async () => {
  const entries = [credits[0], { ...credits[1], expiresAt: null }, { ...credits[2], status: 'redeemed' }];
  const profile = usage('prolite', null, { availableCount: 3, credits: entries });
  assert.deepEqual(profile.cards, [minute('2026-11-21T13:00')]);
  assert.equal(profile.missingCardExpiries, 2);
  assert.deepEqual(await first({ usage: profile }, origin), { missing: ['subscription.end', 'cards'] });
});

test('plans iOS subscriptions without grace days or a required subscription channel', () => {
  const profile = usage('prolite', null);
  const { input: ios } = buildInput(profile, { subscription: { ...subscription, graceDays: 3 } });
  assert.equal(ios.subscription.channel, 'ios');
  assert.equal(ios.subscription.graceDays, 0);
  const { input } = buildInput(profile, { subscription: { end: subscription.end } });
  assert.equal(input.subscription.channel, 'web');
  assert.equal(input.subscription.graceDays, 0);
  const expired = { ...profile, snapshot: subscription.end, weekly: null };
  assert.ok(buildInput(expired, { subscription: { ...subscription, graceDays: 3 } }).input);
});

test('uses hosted planning by default and accepts a configured local service', async t => {
  const savedOrigin = process.env.RESETWISE_BASE_URL;
  t.after(() => {
    if (savedOrigin === undefined) delete process.env.RESETWISE_BASE_URL;
    else process.env.RESETWISE_BASE_URL = savedOrigin;
  });
  delete process.env.RESETWISE_BASE_URL;

  const liveFetch = globalThis.fetch;
  const request = t.mock.method(globalThis, 'fetch', (url, options) =>
    liveFetch(new URL(new URL(url).pathname, origin), options));
  const input = { usage: usage('prolite', null), settings: { subscription } };

  const hosted = await first(input);
  assert.equal(request.mock.calls[0].arguments[0], 'https://codex-resetwise.vercel.app/api/plan');
  assert.equal(new URL(hosted.url).origin, 'https://codex-resetwise.vercel.app');

  process.env.RESETWISE_BASE_URL = origin;
  const local = await first(input);
  assert.equal(request.mock.calls[1].arguments[0], origin + '/api/plan');
  assert.equal(new URL(local.url).origin, origin);
});

test('makes a zero-grace plan and finds a later window with the same quota', async () => {
  const original = await first({ usage: usage('plus', short), settings: { subscription } }, origin);
  assert.equal(original.total, 888);
  assert.equal(original.baseline, 686);
  assert.deepEqual(original.steps.filter(step => step.kind === 'card').map(step => step.gain), [30, 96, 76]);
  assert.equal(original.steps.find(step => step.kind === 'renewal').at, subscription.end);
  const link = new URL(original.url);
  assert.equal(link.search, '');
  const encoded = new URLSearchParams(link.hash.slice(1)).get('prefill');
  const prefill = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  assert.deepEqual(prefill, original.context.input);
  assert.equal(prefill.subscription.graceDays, 0);
  assert.ok(!Buffer.from(encoded, 'base64url').includes('example-card'));

  const later = await more({ context: original.context, action: 3, direction: 1 });
  const afterRenewal = await more({ context: later.context, action: 3, direction: 1 });
  assert.equal(later.total, original.total);
  assert.equal(later.steps.at(-1).window, '12/1 18:01 – 12/1 20:59');
  assert.equal(afterRenewal.total, original.total);
  assert.deepEqual(afterRenewal.steps.map(step => step.number ?? 'renewal'), [1, 2, 'renewal', 3]);
  assert.equal(afterRenewal.steps.at(-1).window, '12/8 13:01 – 12/8 15:59');
});

test('recalculates a previous grace-period plan before searching for more', async () => {
  const { input } = buildInput(usage('plus', short), { subscription });
  const previousInput = { ...input, subscription: { ...input.subscription, graceDays: 3 } };
  const response = await fetch(origin + '/api/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'plan', input: previousInput }),
  });
  assert.equal(response.status, 200);
  const previous = JSON.parse((await response.text()).trim().split('\n').at(-1)).value;
  assert.equal(previous.total, 916);

  const plan = await more({ context: { origin, input: previousInput, token: previous.planToken } });
  assert.equal(plan.recalculated, true);
  assert.equal(plan.context.input.subscription.graceDays, 0);
  assert.equal(plan.total, 888);
});

test('can still make a weekly-only plan when there are zero available cards', async () => {
  const zero = usage('prolite', null, { availableCount: 0, credits: [] });
  const plan = await first({ usage: zero, settings: { subscription: { end: subscription.end } } }, origin);
  assert.equal(plan.context.input.short, null);
  assert.equal(plan.context.input.cards.length, 0);
  assert.equal(plan.total, plan.baseline);
});

test('reports an incomplete alternative search and can retry it', async t => {
  const plan = await first({ usage: usage('plus', short), settings: { subscription } }, origin);
  const liveFetch = globalThis.fetch;
  let fail = true;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!fail) return liveFetch(url, options);
    const request = JSON.parse(options.body);
    assert.equal(request.operation, 'choices');
    assert.deepEqual(request.jobs, [{ action: 3, direction: 1 }]);
    const frames = [
      { type: 'progress', value: { action: 3, direction: 1, error: { message: 'Could not check this time window.' } } },
      { type: 'result', value: null },
    ];
    return new Response(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
  });

  const next = { context: plan.context, action: 3, direction: 1 };
  await assert.rejects(more(next), /Could not check this time window/);
  fail = false;
  assert.equal((await more(next)).total, plan.total);
});
