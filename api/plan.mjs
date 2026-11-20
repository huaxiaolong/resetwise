import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setImmediate as pause } from 'node:timers/promises';
import planner from '../planner.js';

const { planReset, alternatePlan, describeAlternative } = planner;
const REQUEST_LIMIT = 256 * 1024;
const DAY = 1440;
// shortcut: 本地单进程使用随机密钥，部署多个实例时需设置同一个 RESETWISE_PLAN_SECRET。
const signingKey = process.env.RESETWISE_PLAN_SECRET || randomBytes(32);
const headers = { 'Cache-Control': 'no-store' };

class RequestError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const invalid = field => new RequestError(400, field ? '请检查此项的值。' : '请求无效，请重新计算。', field);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (value, lower, upper) => Number.isFinite(value) && lower <= value && value <= upper;
const whole = (value, lower, upper) => Number.isInteger(value) && within(value, lower, upper);
const minute = value => Number.isSafeInteger(value) && Math.abs(value) < 144_000_000_000 - 402 * DAY;

function requireInput(condition, field) {
  if (!condition) throw invalid(field);
}

async function readRequest(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, '请求无效，请重新计算。');
  }
  const tooLarge = () => new RequestError(413, '请求过大，请减少重置卡或公告数量。');
  if (Number(request.headers.get('Content-Length')) > REQUEST_LIMIT) throw tooLarge();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.body?.values({ preventCancel: true }) ?? []) {
    bytes += chunk.byteLength;
    if (bytes > REQUEST_LIMIT) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
}

function inputForPlan(input) {
  requireInput(object(input));
  const { snapshot, mode, hours, subscription, long, short, card, cards, resets, timeZone } = input;
  requireInput(typeof timeZone === 'string' && timeZone.length < 100 && /^[a-z][a-z\d_+/-]*$/i.test(timeZone));
  let zone;
  try { zone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; } catch { throw invalid(); }
  requireInput(minute(snapshot), 'snapshot');
  requireInput(mode === 'healthy' || mode === 'extreme');
  requireInput(mode !== 'healthy' || (Array.isArray(hours) && hours.length === 2
    && hours.every(value => whole(value, 0, DAY - 1))), 'awake-end');

  requireInput(object(subscription) && minute(subscription.end), 'subscription-end');
  const { end, channel, graceDays, renew, renewDays, billingDay } = subscription;
  requireInput(channel === 'ios' || channel === 'web', 'subscription-ios');
  requireInput(within(graceDays, 0, 28), 'grace-days');
  requireInput(typeof renew === 'boolean', 'subscription-renew');
  requireInput(!renew || renewDays == null || whole(renewDays, 1, 365), 'renew-days');
  requireInput(!renew || renewDays != null || billingDay == null || whole(billingDay, 1, 31), 'billing-day');

  const active = end + (channel === 'ios' ? Math.round(graceDays * DAY) : 0) > snapshot;
  requireInput(object(long));
  requireInput(!active || minute(long.end), 'long-end');
  requireInput(!active || long.start == null || minute(long.start), 'long-start');
  requireInput(!active || within(long.remaining, 0, 100), 'long-left');
  if (short != null) {
    requireInput(object(short) && Number.isFinite(short.amount) && short.amount >= 0.01, 'short-amount');
    requireInput(!active || within(short.remaining, 0, 100), 'short-left');
    requireInput(!active || short.end == null || minute(short.end), 'short-end');
  }
  requireInput(object(card) && typeof card.restart === 'boolean', 'card-preserve');
  requireInput(Array.isArray(cards) && Array.isArray(resets));

  return {
    timeZone: zone, snapshot, mode, hours: mode === 'healthy' ? hours : [],
    subscription: { end, channel, graceDays, renew, renewDays: renew ? renewDays ?? null : null,
      billingDay: renew && renewDays == null ? billingDay ?? null : null },
    long: { start: active ? long.start ?? null : null, end: active ? long.end : null, remaining: active ? long.remaining : 0 },
    short: short == null ? null : { amount: short.amount,
      remaining: active ? short.remaining : 100, end: active ? short.end ?? null : null },
    card: { restart: card.restart },
    cards: cards.map((item, index) => {
      const field = typeof item?.field === 'string' && /^card-until-\d+$/.test(item.field)
        ? item.field : `card-until-${index + 1}`;
      requireInput(object(item) && minute(item.until), field);
      return { until: item.until, field };
    }),
    resets: resets.map(item => {
      requireInput(object(item) && minute(item.at));
      return { at: item.at };
    }),
  };
}

const signature = data => createHmac('sha256', signingKey).update(data).digest();

function seal(value) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${data}.${signature(data).toString('base64url')}`;
}

function open(token, kind) {
  const expired = () => new RequestError(400, '方案已失效，请重新计算。');
  const match = typeof token === 'string' && /^([\w-]+)\.([\w-]{43})$/.exec(token);
  if (!match || !timingSafeEqual(Buffer.from(match[2], 'base64url'), signature(match[1]))) throw expired();
  const value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  if (value.kind !== kind) throw expired();
  return { ...value, signature: match[2] };
}

function withToken(input, plan) {
  const { start, accessEnd, total, baseline, renewal, cards } = plan;
  const result = { start, accessEnd, total, baseline, renewal,
    cards: cards.map(({ number, at, window }) => ({ number, at, window })) };
  return { ...plan, planToken: seal({ kind: 'plan', input, result }) };
}

function* prepareChoices({ input, result, signature: parent }, jobs) {
  const pending = jobs.map(({ action, direction }) => ({
    action, direction, search: alternatePlan(input, result, action, direction, { prepare: true }),
  }));
  while (pending.length) {
    for (let index = 0; index < pending.length;) {
      const { action, direction, search } = pending[index];
      let step;
      try { step = search.next(); } catch (error) {
        console.error(error);
        step = { done: true, value: null };
      }
      if (!step.done) {
        index++;
        yield;
        continue;
      }
      pending.splice(index, 1);
      const choice = step.value ? seal({ kind: 'choice', parent, action, candidate: step.value }) : null;
      yield { action, direction, choice };
    }
  }
  return null;
}

function operationFor(body) {
  requireInput(object(body));
  if (body.operation === 'plan') {
    const input = inputForPlan(body.input);
    return { input, search: planReset(input), result: plan => withToken(input, plan) };
  }
  requireInput(body.operation === 'choices' || body.operation === 'describe');
  const context = open(body.plan, 'plan');
  const { input, result } = context;
  if (body.operation === 'choices') {
    const actions = result.cards.map(card => card.number);
    if (result.renewal) actions.push('renewal');
    requireInput(Array.isArray(body.jobs) && body.jobs.length <= 2 * actions.length && body.jobs.every(job =>
      object(job) && actions.includes(job.action) && (job.direction === -1 || job.direction === 1)));
    return { input, search: prepareChoices(context, body.jobs), result: value => value };
  }
  const { parent, action, candidate } = open(body.candidate, 'choice');
  requireInput(parent === context.signature);
  return { input, search: describeAlternative(input, result, action, candidate), result: plan => withToken(input, plan) };
}

function nextBatch(search, timeZone) {
  const previous = process.env.TZ;
  if (previous !== timeZone) process.env.TZ = timeZone;
  try {
    // Only advance the synchronous generator while the request time zone is installed.
    const until = performance.now() + 12;
    do {
      const step = search.next();
      if (step.done || step.value !== undefined) return step;
    } while (performance.now() < until);
    return { done: false };
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else if (previous !== timeZone) process.env.TZ = previous;
  }
}

function calculationError(error) {
  if (error instanceof RequestError || (error instanceof RangeError && typeof error.field === 'string')) {
    return { message: error.message, field: error.field };
  }
  console.error(error);
  return { message: '计算服务暂时不可用，请重试。' };
}

function streamResult({ input, search, result }, signal) {
  const encode = new TextEncoder();
  const frame = (type, value) => encode.encode(JSON.stringify({ type, value }) + '\n');
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled && !signal.aborted) {
          const step = nextBatch(search, input.timeZone);
          if (step.done) {
            controller.enqueue(frame('result', result(step.value)));
            break;
          }
          if (step.value !== undefined) {
            controller.enqueue(frame('progress', step.value));
            return;
          }
          await pause();
        }
      } catch (error) {
        if (!cancelled && !signal.aborted) controller.enqueue(frame('error', calculationError(error)));
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
    try {
      return streamResult(operationFor(await readRequest(request)), request.signal);
    } catch (error) {
      return Response.json(calculationError(error), { status: error.status ?? 500, headers });
    }
  },
};
