const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const DAY = 24 * 60;
const START = Date.parse('2026-11-20T09:00:00+08:00') / 60000;
const RUNS = 9;
const example = {
  snapshot: START,
  mode: 'extreme', hours: [8 * 60, 23 * 60],
  subscription: { end: START + 9 * DAY + 8 * 60, channel: 'ios', graceDays: 3 },
  long: { start: null, end: START + 4 * DAY, remaining: 24 },
  short: { amount: 16, remaining: 100, end: null },
  card: { until: START + 30 * DAY, restart: true },
  resets: [],
};
const renewalExample = {
  ...example,
  subscription: { ...example.subscription, renew: true, renewDays: 30 },
  cards: [3, 4, 30].map(days => ({ until: START + days * DAY })),
};

const cases = [
  ['默认示例', example],
  ['保留原刷新', { ...example, card: { ...example.card, restart: false } }],
  ['健康时段', { ...example, mode: 'healthy' }],
  ['公告重置', { ...example, resets: [{ at: START + 6 * DAY }] }],
  ['60 天，仅周额度', { ...example, short: null,
    subscription: { end: START + 60 * DAY, channel: 'web' } }],
  ['60 天，含 5 小时额度', { ...example,
    subscription: { end: START + 60 * DAY, channel: 'web' } }],
  ['三张卡与续订', renewalExample],
  ['三张卡与续订 · 健康使用', { ...renewalExample, mode: 'healthy' }],
];

function run(solver, input) {
  const search = solver(input);
  let next = search.next();
  while (!next.done) next = search.next();
  return next.value;
}

function median(times) {
  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)];
}

function benchmark() {
  const { planReset } = require('./planner.js');
  process.env.TZ = 'Asia/Shanghai';
  const results = [];
  for (const [name, input] of cases) {
    const expected = run(planReset, input);
    run(planReset, input);

    const times = [];
    for (let round = 0; round < RUNS; round++) {
      const start = performance.now();
      const result = run(planReset, input);
      times.push(performance.now() - start);
      assert.deepEqual(result, expected, name);
    }

    results.push({
      场景: name,
      不用卡: expected.baseline + '%',
      最大用量: expected.total + '%',
      安排用卡: expected.cards?.length ?? Number(expected.window !== null),
      '枚举 ms': Number(median(times).toFixed(2)),
    });
  }

  console.log(`Node ${process.version} · ${process.platform}/${process.arch} · 枚举预热 2 次，测量 ${RUNS} 次取中位数`);
  console.table(results);
}

if (require.main === module) benchmark();
module.exports = { cases, run, median, RUNS };
