import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const bundledCLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const proPlans = new Set(['prolite', 'pro', 'promax']);
const minute = seconds => Number.isFinite(seconds) ? Math.ceil(seconds / 60) : null;

function windowFields(window) {
  if (!window) return null;
  const { usedPercent, resetsAt } = window;
  return { remaining: Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, 100 - usedPercent)) : null,
    end: minute(resetsAt) };
}

export function normalizeUsage(payload, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const { rateLimitsByLimitId, rateLimits, rateLimitResetCredits } = payload.structuredContent ?? payload;
  const codex = rateLimitsByLimitId?.codex ?? (rateLimits?.limitId == null || rateLimits.limitId === 'codex' ? rateLimits : null);
  const planType = codex?.planType?.toLowerCase() ?? null;
  const windows = [codex?.primary, codex?.secondary];
  const weekly = windowFields(windows.find(window => window?.windowDurationMins === 10_080));
  const shortWindow = windowFields(windows.find(window => window?.windowDurationMins === 300));
  const fiveHour = shortWindow ? { status: 'limited', ...shortWindow }
    : { status: proPlans.has(planType) ? 'weekly-only' : 'unknown' };
  const snapshot = Math.floor(now / 60_000);

  const summary = rateLimitResetCredits;
  const available = (summary?.credits ?? []).filter(card => card.status === 'available');
  const expires = available.filter(card => card.resetType === 'codexRateLimits').map(card => minute(card.expiresAt));
  const cards = expires.filter(until => until !== null && until > snapshot).sort((a, b) => a - b);
  const count = summary?.availableCount;
  const missingCardExpiries = Number.isSafeInteger(count) && count >= 0
    ? Math.max(0, count - available.length) + expires.filter(until => until === null).length : null;
  return { timeZone, snapshot, planType, weekly, fiveHour, cards, missingCardExpiries };
}

async function readCodexUsage() {
  const command = existsSync(bundledCLI) ? bundledCLI : 'codex';
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const send = body => child.stdin.write(JSON.stringify(body) + '\n');
  const unavailable = () => new Error('Could not read the local Codex account. Use the host’s Codex usage tool or sign in to Codex.');
  const timeout = AbortSignal.timeout(10_000);
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(unavailable());
      timeout.addEventListener('abort', fail, { once: true });
      child.once('error', fail);
      child.once('close', fail);
      child.stdin.on('error', fail);
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id === 0 && !message.error) {
          send({ method: 'initialized' });
          send({ method: 'account/rateLimits/read', id: 1 });
        } else if (message.id === 0 || message.id === 1) {
          if (message.id === 1 && message.result) resolve(message.result);
          else fail();
        }
      });
      send({ method: 'initialize', id: 0, params: {
        clientInfo: { name: 'resetwise', title: 'Resetwise', version: '0.1.0' },
      } });
    });
  } finally {
    lines.close();
    child.kill();
  }
}

export function buildInput(usage, settings = {}) {
  const missing = [];
  const subscription = settings.subscription ?? {};
  if (!Number.isSafeInteger(subscription.end)) missing.push('subscription.end');
  const active = subscription.end > usage.snapshot;

  const weekly = settings.weekly ?? usage.weekly;
  if (active && (!Number.isFinite(weekly?.remaining) || !Number.isSafeInteger(weekly.end))) missing.push('weekly');
  let short = settings.short;
  if (short === undefined) {
    const { status, remaining, end } = usage.fiveHour;
    if (status === 'weekly-only') short = null;
    else if (status === 'limited') short = { remaining, end, amount: 16 };
    else missing.push('short');
  }
  if (short && active && (!Number.isFinite(short.remaining) || (short.remaining < 100 && !Number.isSafeInteger(short.end)))) {
    missing.push('short.remainingAndRefresh');
  }
  const cards = settings.cards ?? usage.cards;
  if (!settings.cards && usage.missingCardExpiries !== 0) missing.push('cards');
  if (settings.mode === 'healthy' && !settings.hours) missing.push('hours');
  if (missing.length) return { missing };

  return { input: {
    timeZone: usage.timeZone, snapshot: usage.snapshot, mode: settings.mode ?? 'extreme', hours: settings.hours ?? [480, 1380],
    subscription: { end: subscription.end, channel: subscription.channel === 'ios' ? 'ios' : 'web', graceDays: 0,
      renew: subscription.renew ?? true,
      allowLapse: subscription.allowLapse ?? null,
      renewDays: subscription.renewDays ?? null, billingDay: subscription.billingDay ?? null },
    long: { start: weekly?.start ?? null, end: weekly?.end ?? null, remaining: weekly?.remaining ?? 0 },
    short: short == null ? null : { amount: short.amount ?? 16, end: short.end ?? null, remaining: short.remaining },
    card: { restart: settings.card?.restart ?? true },
    cards: cards.map((until, index) => ({ until, field: `card-until-${index + 1}` })),
    resets: (settings.resets ?? []).map(at => ({ at })),
  } };
}

const hostedOrigin = 'https://codex-resetwise.vercel.app';

function siteOrigin(value = process.env.RESETWISE_BASE_URL ?? hostedOrigin) {
  const site = new URL(value);
  if (site.origin === hostedOrigin
    || (site.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(site.hostname))) return site.origin;
  throw new Error('Use the Resetwise Vercel site or a local Resetwise server.');
}

async function request(origin, operation) {
  const response = await fetch(origin + '/api/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
    redirect: 'error', signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.message ?? 'Resetwise rejected the request.');
  }
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const end = frames.at(-1);
  if (end.type !== 'result') throw new Error(end.value?.message ?? 'Resetwise did not return a complete plan.');
  return frames;
}

const planKey = result => JSON.stringify([result.renewal?.kind, result.renewal?.at,
  result.cards.map(card => [card.number, card.window.start, card.window.end])]);

function present(result, input, origin, seen) {
  const format = new Intl.DateTimeFormat('zh-CN', { timeZone: input.timeZone, month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const label = at => format.format(at * 60_000);
  const range = ({ start, end }) => start === end ? label(start) : `${label(start)} – ${label(end)}`;
  const hundredths = n => Math.sign(n) * Math.round(Math.abs(n) * 100);
  let cumulative = 0;
  let previous = 0;
  const steps = result.cards.map((card, index) => {
    cumulative += card.gain;
    const rounded = hundredths(index === result.cards.length - 1 ? result.total - result.baseline : cumulative);
    const step = { kind: 'card', number: card.number, at: card.at, window: range(card.window),
      exampleTime: label(card.at), gain: (rounded - previous) / 100 };
    previous = rounded;
    return step;
  });
  if (result.renewal) {
    const { kind, at, window, grace } = result.renewal;
    steps.push({ kind: 'renewal', renewal: kind, at, window: window ? range(window) : label(at), grace });
  }
  steps.sort((left, right) => left.at - right.at);
  const actions = steps.map(step => step.number ?? 'renewal');
  const prefill = Buffer.from(JSON.stringify(input)).toString('base64url');
  return { total: result.total, baseline: result.baseline, availableUntil: label(result.end), steps,
    unusedCards: result.unusedCards, url: origin + '/#prefill=' + prefill,
    context: { origin, input, token: result.planToken, total: result.total, actions, seen: [...seen, planKey(result)] } };
}

async function initialPlan(input, origin) {
  const frames = await request(origin, { operation: 'plan', input });
  return present(frames.at(-1).value, input, origin, []);
}

export async function first({ usage, settings }, base) {
  const { input, missing } = buildInput(usage, settings);
  if (missing) return { missing };
  return initialPlan(input, siteOrigin(base));
}

export async function more({ context, action, direction }) {
  const origin = siteOrigin(context.origin);
  const { input } = context;
  if (input.subscription.graceDays !== 0) {
    const plan = await initialPlan({ ...input, subscription: { ...input.subscription, graceDays: 0 } }, origin);
    return { ...plan, recalculated: true };
  }
  const actions = action == null ? context.actions : context.actions.filter(item => item === action);
  const directions = direction == null ? [1, -1] : [direction];
  const jobs = actions.flatMap(item => directions.map(side => ({ action: item, direction: side })));
  if (jobs.length) {
    const frames = await request(origin, { operation: 'choices', plan: context.token, jobs });
    const choices = frames.filter(frame => frame.type === 'progress').map(frame => frame.value);
    let failure;
    for (const job of jobs) {
      const choice = choices.find(choice => choice.action === job.action && choice.direction === job.direction);
      if (choice?.choice === null) continue;
      if (typeof choice?.choice !== 'string') {
        failure ??= choice?.error?.message ?? 'Could not check all alternative time windows. Try again.';
        continue;
      }
      const response = await request(origin, { operation: 'describe', plan: context.token, candidate: choice.choice });
      const result = response.at(-1).value;
      if (Math.abs(result.total - context.total) <= 1e-7 && !context.seen.includes(planKey(result))) {
        return present(result, context.input, origin, context.seen);
      }
    }
    if (failure) throw new Error(failure);
  }
  return { exhausted: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const command = process.argv[2];
    if (!['read', 'normalize', 'first', 'more'].includes(command)) throw new Error('Use read, normalize, first, or more.');
    const input = command === 'read' ? await readCodexUsage()
      : JSON.parse(await new Response(process.stdin).text());
    const output = command === 'first' ? await first(input) : command === 'more' ? await more(input) : normalizeUsage(input);
    console.log(JSON.stringify(output));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
