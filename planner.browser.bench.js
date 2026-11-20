const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { cases, run, median, RUNS } = require('./planner.bench.js');

const BENCHMARK_PAGE = 'about:blank';
const plannerSource = readFileSync(join(__dirname, 'planner.js'), 'utf8');
const MEMORY_RUNS = 5;
const KiB = 1024;

function devTools(chrome) {
  const pending = new Map();
  let id = 0;
  let buffer = '';
  chrome.stdio[4].setEncoding('utf8').on('data', chunk => {
    const messages = (buffer + chunk).split('\0');
    buffer = messages.pop();
    for (const message of messages) {
      const reply = JSON.parse(message);
      pending.get(reply.id)?.(reply.error, reply.result);
    }
  });
  chrome.once('close', (code, signal) => {
    for (const reply of pending.values()) reply({ message: `Chrome exited (${signal ?? code})` });
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const request = ++id;
    const timeout = setTimeout(() => settle({ message: 'timed out' }), 10000);
    function settle(error, value) {
      clearTimeout(timeout);
      pending.delete(request);
      if (error) reject(new Error(`${method}: ${error.message}`));
      else resolve(value);
    }
    pending.set(request, settle);
    chrome.stdio[3].write(JSON.stringify({ id: request, method, params, sessionId }) + '\0', error => {
      if (error) settle(error);
    });
  });
}

async function withBrowser(executable, work) {
  const profile = await mkdtemp(join(tmpdir(), 'resetwise-bench-'));
  const chrome = spawn(executable, [
    '--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-background-networking', '--disable-extensions',
    '--disable-features=SpareRendererForSitePerProcess', BENCHMARK_PAGE,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, TZ: 'Asia/Shanghai' } });
  const closed = once(chrome, 'close').catch(error => error);
  let stderr = '';
  chrome.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const send = devTools(chrome);
  try {
    const { product } = await send('Browser.getVersion');
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(target => target.type === 'page' && target.url === BENCHMARK_PAGE);
    assert(page, 'Benchmark page was not opened');
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
    async function evaluate(expression) {
      const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    }
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const ready = await evaluate('document.readyState === "complete"');
        if (ready) break;
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find .*context/.test(error.message)) throw error;
      }
      assert(Date.now() < deadline, 'Benchmark page did not finish loading');
      await delay(10);
    }
    await evaluate(plannerSource);
    return await work({ send, call, evaluate, product });
  } catch (error) {
    if (stderr) error.message += '\n' + stderr.trim();
    throw error;
  } finally {
    if (chrome.exitCode === null && chrome.signalCode === null && chrome.pid) {
      await send('Browser.close').catch(() => chrome.kill());
    }
    await closed;
    await rm(profile, { recursive: true, force: true });
  }
}

async function measureTime(evaluate, input) {
  return evaluate(`(() => {
    ${run.toString()}
    const input = ${JSON.stringify(input)};
    const solver = Resetwise.planReset;
    const expected = run(solver, input);
    run(solver, input);
    const times = [];
    for (let round = 0; round < ${RUNS}; round++) {
      const start = performance.now();
      run(solver, input);
      times.push(performance.now() - start);
    }
    return { expected, times };
  })()`);
}

async function measureMemory({ send, call, evaluate }, input, expected) {
  const { processInfo } = await send('SystemInfo.getProcessInfo');
  const renderers = processInfo.filter(process => process.type === 'renderer');
  assert.equal(renderers.length, 1, 'Expected one renderer for the isolated page');
  async function sample() {
    const { usedSize, backingStorageSize } = await call('Runtime.getHeapUsage');
    const rss = execFileSync('ps', ['-o', 'rss=', '-p', String(renderers[0].id)], { encoding: 'utf8' });
    assert(Number.isFinite(usedSize) && Number.isFinite(backingStorageSize) && Number(rss) > 0,
      'Chrome heap usage and renderer RSS must both be available');
    return { js: usedSize + backingStorageSize, rss: Number(rss) * KiB };
  }
  await evaluate(`globalThis.benchInput = ${JSON.stringify(input)};
    globalThis.benchSearch = null;
    globalThis.benchResult = null;
    globalThis.benchStep = () => {
      const next = benchSearch.next();
      if (next.done) {
        benchResult = next.value;
        benchSearch = null;
      }
      return next.done;
    }`);
  await call('HeapProfiler.collectGarbage');
  const baseline = await sample();
  const peak = { ...baseline };
  await evaluate('void (benchSearch = Resetwise.planReset(benchInput))');
  let done;
  do {
    done = await evaluate('benchStep()');
    const usage = await sample();
    peak.js = Math.max(peak.js, usage.js);
    peak.rss = Math.max(peak.rss, usage.rss);
  } while (!done);
  // Keep the plan for the post-GC sample, as the result view does.
  await call('HeapProfiler.collectGarbage');
  const retained = await sample();
  assert.deepEqual(await evaluate('benchResult'), expected);
  return {
    jsPeak: peak.js - baseline.js, jsRetained: retained.js - baseline.js,
    rssPeak: peak.rss - baseline.rss, rssRetained: retained.rss - baseline.rss,
  };
}

async function main(executable) {
  assert(executable, 'Usage: node planner.browser.bench.js /path/to/chrome-headless-shell');
  const timings = await withBrowser(executable, async ({ evaluate, product }) => {
    console.log(`${product} · ${process.platform}/${process.arch} · 耗时 ${RUNS} 次，中位数`);
    const results = [];
    for (const [, input] of cases) results.push(await measureTime(evaluate, input));
    return results;
  });
  const rows = [];
  for (const [index, [name, input]] of cases.entries()) {
    const { expected, times } = timings[index];
    const memory = [];
    for (let round = 0; round < MEMORY_RUNS; round++) {
      memory.push(await withBrowser(executable, browser => measureMemory(browser, input, expected)));
    }
    const medianKiB = key => Math.round(median(memory.map(sample => sample[key])) / KiB);
    rows.push({
      场景: name, 最大用量: `${expected.total}%`,
      '耗时 ms': Number(median(times).toFixed(2)),
      'JS 峰值增量 KiB': medianKiB('jsPeak'), 'JS 回收后增量 KiB': medianKiB('jsRetained'),
      '渲染进程峰值增量 KiB': medianKiB('rssPeak'), '渲染进程回收后增量 KiB': medianKiB('rssRetained'),
    });
    console.log(`已完成 ${name}`);
  }
  console.log(`枚举内存 ${MEMORY_RUNS} 次，中位数。`);
  console.table(rows);
}

main(process.argv[2]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
