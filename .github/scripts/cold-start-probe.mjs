// 冷启动探针：把「一个干净的交付包在一台干净点的机器上到底能不能用」变成读数。
//
// 它连的是 WebView2 的主页面，做四件事：
//   1. 等界面真的起来（导航链接出现），记下标题、地址、导航项；
//   2. 用界面上那颗「重试」按的同一道门（`compute_retry_worker`）加一次合成提交
//      （`compute_submit`，不给 `source`，所以不碰用户的资料库）把计算进程叫起来；
//      —— 这一步是必须的：计算进程是**按需起的**（`manager.rs` 的 `maybe_spawn`：
//      没有排队的活就不起），只读一次 `compute_worker_status` 在空库里永远是 `stopped`，
//      那样写出来的「计算这一半没问题」是假的；
//   3. 按 `--expect` 核对 `compute_worker_status`：包里有 worker 就该 `ready`，
//      没有、或者是另一份构建，就该 `broken` 且理由里带着该有的那句话；
//   4. 走一次导航，确认算力这一栏坏了也不挡界面（Task 10 出口条件第三句）。
//
// 用法：
//   node cold-start-probe.mjs --ws <ws-url> --out <json>
//        [--expect any|ready|broken] [--needle <文本>] [--nav <导航项文字>]
//        [--wait-ms 60000] [--worker-wait-ms 30000] [--no-trigger]
// 退出码：0 = 每一条都成立；1 = 任何一条不成立（宁可红，也不要一张空表）。
import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`参数要成对给：${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const wsUrl = args.ws;
const port = args.port ? Number(args.port) : null;
const outPath = args.out;
const expect = args.expect ?? 'any';
const needle = args.needle ?? '';
const navLabel = args.nav ?? '设置';
const waitMs = Number(args['wait-ms'] ?? 60000);
const workerWaitMs = Number(args['worker-wait-ms'] ?? 30000);
const trigger = args['no-trigger'] === undefined;
if (!wsUrl || !outPath) throw new Error('至少要给 --ws 和 --out');
if (!['any', 'ready', 'broken'].includes(expect)) throw new Error(`--expect 只认 any/ready/broken：${expect}`);

const startedAt = new Date().toISOString();
const report = {
  probe: 'cold-start',
  startedAt,
  expect,
  needle,
  target: null,
  ui: null,
  worker: null,
  navigation: null,
  console: [],
  checks: {},
  ok: false,
};

let ws = null;
let collecting = false;
let nextId = 0;
const pending = new Map();

// 一个进程里两个 WebView2 环境各绑一个 IPv4/IPv6 端口，而且**两扇窗刚起来时都还是
// about:blank**：`/json/list` 里那一条 url 是某一刻的快照，等我们连上去时它可能已经
// 换了文档（2026-10-08 实测：列出来是 `http://tauri.localhost/`，连上去 `location.href`
// 却是 about:blank）。所以「接哪一页」不能只看列表，得连上去问一句。
function wire(socket) {
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (!collecting) return;
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || [])
        .map((arg) => (arg.value !== undefined ? arg.value : arg.description ?? arg.type))
        .join(' ');
      if (message.params.type === 'error' || message.params.type === 'warning') {
        report.console.push(`[${message.params.type}] ${text}`.slice(0, 300));
      }
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      report.console.push(`[log:error] ${message.params.entry.text}`.slice(0, 300));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails ?? {};
      const text = details.exception?.description ?? details.text ?? '未命名异常';
      report.console.push(`[exception] ${String(text)}`.slice(0, 400));
    }
  });
}

function connect(rawUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(rawUrl);
    const timer = setTimeout(() => reject(new Error(`${rawUrl} 超过 10 秒没连上`)), 10000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      wire(socket);
      ws = socket;
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`连不上这条 ws：${rawUrl}`));
    }, { once: true });
  });
}

function send(method, params, timeoutMs = 30000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超过 ${timeoutMs} ms 没回话`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// 页面里的一小段表达式求值。`awaitPromise` 让 Promise 的结果直接回来，
// `returnByValue` 让对象变成 JSON 而不是远程句柄——这两样一少，读到的全是 undefined。
async function evaluate(expression, timeoutMs = 60000) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`页面里这段话抛了：${String(text).split('\n')[0]}`);
  }
  return result.result.value;
}

// 轮询直到 `expression` 求值为真（或给的对象里的 `.done` 为真）。超时不算异常：
// 把「最后看到的样子」带回去，让上层决定这是红还是只是没等到。
async function waitFor(expression, budgetMs, pollMs = 250) {
  const deadline = Date.now() + budgetMs;
  let last;
  for (;;) {
    last = await evaluate(expression);
    if (last && (last.done === true || last === true)) return { done: true, last };
    if (Date.now() >= deadline) return { done: false, last };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

const UI_READY = `(() => {
  const links = [...document.querySelectorAll('a[href]')];
  const labels = links.map((a) => (a.textContent || '').trim()).filter(Boolean);
  return {
    done: !!document.querySelector('a[href="/settings"]') && labels.length >= 4,
    title: document.title,
    url: location.href,
    labels: labels.slice(0, 12),
    text: (document.body ? document.body.innerText : '').slice(0, 200),
  };
})()`;

const STATUS = `(async () => {
  const answer = await window.__TAURI_INTERNALS__.invoke('compute_worker_status', {});
  return { envelope: answer, kind: answer && answer.ok ? answer.value.kind : null,
           value: answer && answer.ok ? answer.value : null };
})()`;

async function readStatus() {
  const raw = await evaluate(STATUS);
  return raw;
}

// 两族地址都问一遍：托盘菜单那一页与主窗可能分别绑在 IPv4 与 IPv6 上。
async function listTargets(port) {
  const found = [];
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const answer = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!answer.ok) continue;
      for (const item of await answer.json()) {
        if (item && item.type === 'page' && item.webSocketDebuggerUrl) found.push(item);
      }
    } catch {
      // 这一族没起来不算错：另一族还有机会。
    }
  }
  return found;
}

// 挑主窗：连上去问 `location.href`，只认落在自己页面上的那一页（不是 about:blank、
// 不是托盘菜单）。列出来的 url 是快照，问出来的才是现场。
async function chooseTarget(port, firstWsUrl) {
  const tried = [];
  const deadline = Date.now() + 30000;
  for (;;) {
    const candidates = [];
    if (firstWsUrl && !tried.some((entry) => entry.ws === firstWsUrl)) {
      candidates.push({ url: '（调用方给的那条 ws）', ws: firstWsUrl });
    }
    if (port) {
      for (const item of await listTargets(port)) {
        if (!candidates.some((entry) => entry.ws === item.webSocketDebuggerUrl)) {
          candidates.push({ url: item.url, ws: item.webSocketDebuggerUrl });
        }
      }
    }
    for (const candidate of candidates) {
      if (tried.some((entry) => entry.ws === candidate.ws)) continue;
      let live = null;
      try {
        await connect(candidate.ws);
        await send('Runtime.enable');
        await send('Log.enable');
        live = await evaluate('location.href', 5000);
      } catch (error) {
        live = `连不上：${error.message}`;
      }
      tried.push({ url: candidate.url, live: String(live) });
      const text = String(live);
      if (text.startsWith('http') && !text.includes('tray-menu')) {
        collecting = true;
        return { ws: candidate.ws, live: text, tried };
      }
      try { ws?.close(); } catch { }
      ws = null;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`没有一页能接：${tried.map((entry) => `${entry.url} → ${entry.live}`).join('；')}`);
}

async function main() {
  // 「接哪一页」交给 chooseTarget：它连上去问现场，接错了会换一条（2026-10-08 的
  // 两次实测都栽在这里——先挂到托盘菜单那一页，后来又挂到一个已经变成 about:blank
  // 的目标上，而两者的 `/json/list` 快照看上去都像主窗）。
  const chosen = await chooseTarget(port, wsUrl);
  report.target = {
    url: chosen.ws,
    pageUrl: chosen.live,
    isTrayMenu: chosen.live.includes('tray-menu'),
    considered: chosen.tried,
  };

  // 1. 界面起来了吗。
  const uiStarted = Date.now();
  const ui = await waitFor(UI_READY, waitMs, 250);
  report.ui = { ...(ui.last ?? {}), readyMs: Date.now() - uiStarted, done: ui.done };
  report.checks.uiReady = ui.done === true;
  if (!ui.done) {
    report.checks.workerMatchesExpectation = false;
    report.checks.navigationWorks = false;
    return;
  }

  // 2. 把计算进程叫起来：先点界面那颗「重试」（清掉熔断；没坏时它什么也不做），
  //    再交一件不需要资料库的活——没有排队的活，按需启进程那一段根本不会走。
  const before = await readStatus();
  const history = [before.kind];
  let retry = null;
  let submitted = null;
  if (trigger) {
    retry = await evaluate(`(async () => await window.__TAURI_INTERNALS__.invoke('compute_retry_worker', {}))()`);
    submitted = await evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return await invoke('compute_submit', { payload: {
        inputId: 'cold-start#0',
        settingsId: 'cold-start-settings',
        sourceRevision: 'cold-start-revision',
        backend: 'cpu',
        generation: 1,
        priority: 'background',
        input: { inputId: 'cold-start#0', contentHash: '0'.repeat(64), byteLength: 1024 },
        pipeline: [{ stageId: 'cold-start-stage', modelSpecId: 'echo', enginePolicy: 'cpu' }],
        outputGrantId: 'cold-start-grant',
        deadlineMs: 0,
      } });
    })()`);
  }

  // 3. 等状态离开始发态。
  const workerStarted = Date.now();
  let seen = before;
  const deadline = Date.now() + workerWaitMs;
  for (;;) {
    seen = await readStatus();
    if (history[history.length - 1] !== seen.kind) history.push(seen.kind);
    if (seen.kind && seen.kind !== 'starting' && seen.kind !== 'stopped') break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  // 交了活就该看见一个结论：算力这一栏坏了可以，但界面不许一直等下去。
  // `JobState` 是带数据的枚举：单位变体序列化成字符串（`"completed"`），带字段的
  // 变成对象（`{"failed":{"code":"…"}}`）。只比字符串会把「已经失败」读成「还没完」，
  // 一路等到超时——所以先归一成一个名字再看。
  const stateName = (state) => (typeof state === 'string' ? state : state && typeof state === 'object' ? Object.keys(state)[0] : null);
  const IN_FLIGHT = new Set(['queued', 'dispatched', 'accepted', 'running']);
  let job = null;
  const jobId = submitted && submitted.ok ? submitted.value.jobId : null;
  if (jobId) {
    const jobDeadline = Date.now() + 15000;
    for (;;) {
      const answer = await evaluate(`(async () => await window.__TAURI_INTERNALS__.invoke('compute_job_get', { jobId: ${JSON.stringify(jobId)} }))()`);
      job = answer && answer.ok ? answer.value : null;
      if (job && !IN_FLIGHT.has(stateName(job.state))) break;
      if (Date.now() >= jobDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  const reason = seen.value && seen.value.reason ? String(seen.value.reason) : '';
  report.worker = {
    before: before.kind,
    retry,
    submitted,
    history,
    kind: seen.kind,
    value: seen.value,
    reason,
    jobId,
    jobState: job ? stateName(job.state) : null,
    jobCode: job && stateName(job.state) === 'failed' ? job.state.failed?.code ?? null : null,
    ms: Date.now() - workerStarted,
  };
  const matches = expect === 'any'
    ? seen.kind !== null
    : expect === 'ready'
      ? seen.kind === 'ready'
      : seen.kind === 'broken' && reason.includes(needle);
  report.checks.workerMatchesExpectation = matches;

  // 4. 算力这一栏这样了，界面还走得动吗。
  const clicked = await evaluate(`(() => {
    const wanted = ${JSON.stringify(navLabel)};
    const links = [...document.querySelectorAll('a[href]')];
    const link = links.find((a) => (a.textContent || '').trim() === wanted);
    if (!link) return { clicked: false, labels: links.map((a) => (a.textContent || '').trim()).filter(Boolean).slice(0, 12) };
    const before = location.pathname;
    link.click();
    return { clicked: true, before, href: link.getAttribute('href') };
  })()`);
  let navigated = { done: false };
  if (clicked.clicked) {
    const want = String(clicked.href ?? '').split('?')[0];
    navigated = await waitFor(
      `(() => ({ done: location.pathname === ${JSON.stringify(want)}, pathname: location.pathname,
                 text: (document.body ? document.body.innerText : '').slice(0, 200) }))()`,
      15000,
      200,
    );
  }
  report.navigation = { label: navLabel, ...clicked, ...(navigated.last ?? {}), done: navigated.done };
  report.checks.navigationWorks = clicked.clicked === true && navigated.done === true;
  report.checks.noUncaughtExceptions = !report.console.some((line) => line.startsWith('[exception]'));
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
report.failure = failure;
report.checks.probeFinished = failure === null;
report.ok = failure === null
  && report.checks.uiReady === true
  && report.checks.workerMatchesExpectation === true
  && report.checks.navigationWorks === true
  && report.checks.noUncaughtExceptions === true;
report.finishedAt = new Date().toISOString();

try {
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
} catch (error) {
  process.stderr.write(`写不出读数：${error.message}\n`);
  process.exit(1);
}
const verdict = report.ok ? '冷启动探针通过' : '冷启动探针不通过';
process.stdout.write(`${verdict}：界面 ${report.checks.uiReady}、算力那一栏 ${report.checks.workerMatchesExpectation}（${report.worker?.kind ?? '没读到'}）、导航 ${report.checks.navigationWorks}${failure ? `；半路出错：${failure}` : ''}\n`);
ws.close();
process.exit(report.ok ? 0 : 1);
