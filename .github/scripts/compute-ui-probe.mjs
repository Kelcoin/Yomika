// §12.3 的真窗口驱动：连上 WebView2 的主页面，注入采集器，用真实输入（CDP 的
// Input.dispatch* 走的是浏览器自己的输入管线，不是 `element.click()`）跑一段场景，
// 把「输入到下一次呈现」「掉帧」「JS 长任务」「导航可见」「显存/内存」这些数写成一个
// JSON 交给 `.github/scripts/measure-compute-responsiveness.ps1` 汇总。
//
// 为什么要有这个文件：§12.3 的门槛全都长在真窗口上（§12.4 ⑤ 的 renderer 那一份也是），
// 而 `debug_outputs/` 下的临时脚本不能当仪器——它们每次都靠人肉拼参数。这里把「怎么连、
// 怎么注入、怎么算」固定下来，脚本那一侧只负责起进程和读 JSON。
//
// 用法：
//   node compute-ui-probe.mjs --ws <ws-url> --out <json> [--reader-url <url>]
//        [--inputs 120] [--kill-worker <pid>] [--settle-ms 1500] [--no-quiet]
// 退出码：0 = 量到了并写出 JSON；1 = 任何一步没量到（宁可红，也不要一张空表）。
//
// `--no-quiet` 是给**打包构建**那一档的：`http://tauri.localhost/` 里 import 不了 `/src/**`，
// 所以那边既挑不出档案（要 `--reader-url` 点名），也没法把偏好先改成关的。这一档的前提
// 由调用方负责（跑在库的副本上，偏好预先就是关的），读数里 `quiet` 会明说它是跳过的。
import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  // 光杆开关（`--no-quiet`）要认：原来按固定步长 2 走，一个没有值的开关会把**后面每一条**
  // 都错位一格，而且自己拿到的是 undefined（`Boolean(undefined)` 是假，开关等于没给）。
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`参数要成对给：${key}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key.slice(2)] = true;
      continue;
    }
    args[key.slice(2)] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const wsUrl = args.ws;
const outPath = args.out;
let readerUrl = args['reader-url'];
const inputs = Number(args.inputs ?? 120);
const navigations = Number(args.navigations ?? 3);
const killWorker = args['kill-worker'] ? Number(args['kill-worker']) : undefined;
const settleMs = Number(args['settle-ms'] ?? 1500);
// 打包构建那一档（见文件抬头）：名字叫 `--no-quiet` 而不是 `--bundled`，因为这一档真正变了的
// 只有「不去动偏好」这一件事——挑档案那件事由 `--reader-url` 点名解决。
const noQuiet = Boolean(args['no-quiet']);
// §12.3 的「重载」：压机器不在 harness 里另造一套负载，而是走**应用自己那条路**——
// `compute_submit_reader_page` 正是阅读器为可见页提交重任务用的那道门。件数由 harness 给。
const loadPages = Number(args.load ?? 0);
const loadModel = args['load-model'] ?? 'waifu2x-upconv7';
if (!wsUrl || !outPath) throw new Error('至少要给 --ws 和 --out');

// 页面侧的采集器。它必须自己能认出「这条事件是真人输入来的」——CDP 派发的事件同样是
// isTrusted 的事件，所以这里不去分辨来源，只按「事件到达 → 下两次 rAF」计时。
const INSTRUMENT = `(() => {
  if (window.__probe) return 'already';
  const probe = { inputs: [], frames: [], longTasks: [], notes: [] };
  window.__probe = probe;
  const now = () => performance.now();
  // 每一条输入都自己排一对 rAF：**不能**用「上一个还没回来就丢掉」的写法——那样
  // 连着派的输入会有几条永远不进表（本驱动第一次跑就是这样，派 120 条只记到 100 条）。
  const onInput = (kind) => (event) => {
    const t0 = now();
    const label = kind + (event.key ? ':' + event.key : '');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      probe.inputs.push({ kind: label, ms: now() - t0, at: t0 });
    }));
  };
  for (const type of ['pointerdown', 'mousedown']) window.addEventListener(type, onInput('pointerdown'), true);
  window.addEventListener('keydown', onInput('keydown'), true);
  window.addEventListener('wheel', onInput('wheel'), { capture: true, passive: true });
  let last = now();
  const tick = () => {
    const at = now();
    probe.frames.push(at - last);
    last = at;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push({ start: entry.startTime, ms: entry.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch (error) {
    probe.notes.push('这台浏览器不给 longtask：' + error.message);
  }
  probe.ready = true;
  return 'installed';
})()`;

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const console_ = [];
const events = [];

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args || [])
      .map((arg) => (arg.value !== undefined ? arg.value : arg.description ?? arg.type))
      .join(' ');
    console_.push(`[${message.params.type}] ${text}`.slice(0, 300));
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    console_.push(`[log:error] ${message.params.entry.text}`.slice(0, 300));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    console_.push(`[exception] ${message.params.exceptionDetails.text}`.slice(0, 300));
  }
  if (message.method === 'Page.loadEventFired') events.push(Date.now());
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error('页面里抛了：' + JSON.stringify(result.exceptionDetails).slice(0, 600));
  }
  return result.result.value;
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', () => reject(new Error('连不上 CDP')));
});
await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Performance.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
await evaluate(INSTRUMENT);

// 导航场景。§12.3 的「简单导航/返回原图可见 p95<=150ms」量的是**下一次呈现**，
// 所以这里从点下去那一刻算到「页面里出现了一张有像素的图」那一刻。
let navigation = null;
// 一条真档案的身份，两处要用：`--reader-url auto` 要拿它拼地址，压机器那一趟要拿它填
// `submitReaderPage` 的 `scopeId`/`archiveId`（**即使 `--reader-url` 是点名给的也要问**，
// 否则重载那一趟根本没东西可提交）。
async function discoverArchive() {
  // 不去猜档案号，也不靠列表长得什么样：用应用自己的仓储问一条档案出来（档案库是虚拟列表，
  // 行是 `button.archive-row`，点它是「选中」不是「跳转」——真窗口里点过，URL 不动）。
  // 这一句只借用身份，取页与呈现仍然走应用自己的那条路。
  const discovered = await evaluate(`(async () => {
    const module = await import('/src/repositories/nativeLibraryRepository.ts');
    const repository = new module.NativeLibraryRepository();
    const servers = await repository.listServers();
    if (!servers.ok || !servers.value.length) return { error: '一个服务器都没有' };
    const server = servers.value[0];
    const page = await repository.listArchivesPage(server.id, 0, 1);
    if (!page.ok || !page.value.items.length) return { error: '档案库是空的：' + (page.ok ? '0 条' : page.error.message) };
    const archive = page.value.items[0];
    return {
      archiveId: archive.archiveId,
      title: archive.title,
      server: server.scopeId || server.id,
      scopeId: server.scopeId || server.id,
      origin: location.origin,
    };
  })()`);
  if (!discovered || discovered.error) throw new Error('自动挑不出阅读器地址（用 --reader-url 点名）：' + JSON.stringify(discovered));
  return discovered;
}
let discovered = null;
if (readerUrl === 'auto' || loadPages > 0) discovered = await discoverArchive();
if (readerUrl === 'auto') {
  readerUrl = `${discovered.origin}/reader/${discovered.archiveId}?server=${discovered.server}`;
  console.log(`UI_PROBE_READER ${readerUrl}（${discovered.title}）`);
}

// 空载那一趟必须真的空。用户那份库里超分/去码可能是开着的（阅读器为可见页自己就会提交重任务），
// 那样两趟比的就成了「本来就有的负载」而不是「重载」。所以两趟都先把这两档写回关闭，
// 并把它原来说清楚——这一跑量的负载只来自 harness 提交的那一批。
//
// 关闭用的是「整份快照 + 改四栏」，**还原也用整份快照**：只把四栏写回原值的话，以后谁多写了
// 一栏，还原就会悄悄漏掉那一栏——而这一栏恰恰是最容易被人忘掉的那种错。
let quiet = { skipped: '这一档是打包构建（--no-quiet）：import 不了应用的模块，也没法把偏好改回去；跑之前偏好就该是关的（跑在库的副本上）' };
let quietSnapshot = null;
if (!noQuiet) {
  quiet = await evaluate(`(async () => {
    const module = await import('/src/repositories/nativeSettingsRepository.ts');
    const repository = new module.NativeSettingsRepository();
    const before = await repository.load();
    if (!before.ok) return { error: before.error.message };
    const snapshot = before.value;
    const turnedOff = {
      upscaleBackend: snapshot.upscaleBackend,
      upscaleModel: snapshot.upscaleModel,
      upscaleAutoEnable: snapshot.upscaleAutoEnable,
      decensorModel: snapshot.decensorModel,
    };
    const saved = await repository.save({ ...snapshot, upscaleBackend: 'off', upscaleAutoEnable: false, decensorModel: '' });
    if (!saved.ok) return { error: saved.error.message };
    // 快照要交回 Node：导航那一趟会把页面换掉，挂在 window 上的东西跟着新文档一起没了，
    // 所以「等到最后再还」这件事只能由 Node 拿着这份快照来做。
    return { before: turnedOff, after: { upscaleBackend: saved.value.upscaleBackend, decensorModel: saved.value.decensorModel }, snapshot };
  })()`);
  if (!quiet || quiet.error) throw new Error('没法先关掉超分/去码（空载那一趟的前提）：' + JSON.stringify(quiet));
  quietSnapshot = quiet.snapshot;
  console.log(`UI_PROBE_QUIET 超分原来是 ${quiet.before.upscaleBackend}（模型 ${JSON.stringify(quiet.before.upscaleModel)}、自动启用 ${quiet.before.upscaleAutoEnable}）、去码 ${JSON.stringify(quiet.before.decensorModel)}；这一跑都关掉`);
}

if (readerUrl) {
  // 多导航几遍：§12.3 要的是 p95，不是一次的印象。dev 构建 + Vite 的冷启动很慢，这一栏
  // 报的是「这台机器这一份构建」的数，脚本不拿它当通过理由（§12.3 原话）。
  const samples = [];
  for (let index = 0; index < navigations; index += 1) {
    await send('Page.navigate', { url: readerUrl });
    const started = Date.now();
    const visible = await evaluate(`(async () => {
      const deadline = Date.now() + 25000;
      const t0 = performance.now();
      for (;;) {
        const image = [...document.querySelectorAll('img')].find((item) => item.naturalWidth > 0);
        if (image) return { ms: performance.now() - t0, alt: image.getAttribute('alt'), width: image.naturalWidth };
        if (Date.now() > deadline) return { ms: -1, error: document.body.innerText.slice(0, 200) };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })()`);
    if (!visible || visible.ms < 0) {
      throw new Error(`第 ${index + 1} 次导航没把页面画出来，量不到导航：` + JSON.stringify(visible));
    }
    samples.push({ ms: Math.round((Date.now() - started + visible.ms / 2) * 10) / 10, image: visible.alt, width: visible.width });
    await sleep(index + 1 === navigations ? settleMs : 400);
  }
  const ordered = [...samples].sort((left, right) => left.ms - right.ms);
  const at = (percent) => ordered[Math.max(1, Math.ceil((percent / 100) * ordered.length)) - 1].ms;
  navigation = {
    count: samples.length,
    firstMs: samples[0].ms,
    p50Ms: at(50),
    p95Ms: at(95),
    worstMs: ordered[ordered.length - 1].ms,
    image: samples[0].image,
    width: samples[0].width,
    samples,
  };
}

// §12.3 的「重载」：压机器不另造负载，走应用自己那条路——`compute_submit_reader_page`
// 就是阅读器为可见页提交重任务用的同一道门，所以这里压出来的就是真活（读图、装模型、算）。
// 提交完顺带把这一代 worker 是谁问出来（`--kill-worker -1` 要用），并等它不再 `starting`。
let load = null;
if (loadPages > 0) {
  if (!discovered) throw new Error('要压机器就得先知道是哪一条档案');
  load = await evaluate(`(async () => {
    const module = await import('/src/repositories/nativeComputeRepository.ts');
    const repository = new module.NativeComputeRepository();
    const before = await repository.workerStatus();
    const jobIds = [];
    const failures = [];
    const pending = ${loadPages};
    // 后台槽位是有限的（实测 8 件），一上来就全提交会被 COMPUTE_QUEUE_FULL 挡回。
    // 所以分几轮交：每轮把还没进队的再试一遍，等一会儿让前面那批跑起来，槽位腾出来就接着进队。
    // 最后一轮离输入那一串很近，整串输入期间计算进程都在忙。
    for (let round = 0; round < 5 && jobIds.length < pending; round += 1) {
      for (let index = jobIds.length + failures.length; index < pending; index += 1) {
        const result = await repository.submitReaderPage({
          scopeId: ${JSON.stringify(discovered.scopeId)},
          archiveId: ${JSON.stringify(discovered.archiveId)},
          pageIndex: index,
          modelId: ${JSON.stringify(loadModel)},
          generation: 1,
          priority: 'background',
          deadlineMs: 0,
        });
        if (result.ok) jobIds.push(result.value.jobId);
        else failures.push(result.error.code + '：' + result.error.message);
      }
      if (jobIds.length < pending && round < 4) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    let worker = before.ok ? before.value : null;
    let workerNow = worker;
    // 问不到就把**为什么问不到**带回去：读到 null 时报告里只剩「没读到」，那和「没有 worker」
    // 长得一样，正是这一轮一直在防的那种假空。
    const workerError = before.ok ? null : before.error.code + '：' + before.error.message;
    let workerErrorLast = workerError;
    // 「起来过」也算：提交之后计算进程是**被叫起来的**，所以这里等的不是 starting 而是
    // 「不再是 stopped/starting」——只等 starting 会在还没起进程时立刻放行，把真话读成没起来。
    for (let attempt = 0; attempt < 24 && workerNow && (workerNow.kind === 'starting' || workerNow.kind === 'stopped'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const again = await repository.workerStatus();
      workerNow = again.ok ? again.value : null;
      workerErrorLast = again.ok ? null : again.error.code + '：' + again.error.message;
    }
    const jobs = await repository.jobs();
    return {
      attempted: pending,
      submitted: jobIds.length,
      refused: failures.length,
      jobIds: jobIds.slice(0, 8),
      jobError: failures.length ? failures.slice(0, 3).join('；') : null,
      worker: workerNow,
      workerBefore: worker,
      workerError,
      workerErrorLast,
      openJobs: jobs.ok ? jobs.value.filter((job) => job.state === 'queued' || job.state === 'running').length : null,
    };
  })()`);
  if (!load || load.error) throw new Error('压机器那一趟没提交成功：' + JSON.stringify(load));
  console.log(`UI_PROBE_LOAD 提交 ${load.submitted} 件（${load.jobError ?? '没有失败'}）；worker 是 ${load.worker && load.worker.kind}（pid ${load.worker && load.worker.peerPid}）`);
}

// `--kill-worker -1`：不靠外面找 pid，直接问应用「这一代 worker 是谁」。杀了之后界面得自己发现
// worker 没了并给状态——那正是 §12.3 要量的一半。
let killTarget = killWorker;
if (killWorker === -1) {
  const status = load && load.worker && load.worker.peerPid ? load.worker : await evaluate(`(async () => {
    const module = await import('/src/repositories/nativeComputeRepository.ts');
    const repository = new module.NativeComputeRepository();
    const result = await repository.workerStatus();
    return result.ok ? result.value : { error: result.error.message };
  })()`);
  if (!status || !status.peerPid) throw new Error('要杀的那一代 worker 拿不到（它还没起来？）：' + JSON.stringify(status));
  killTarget = status.peerPid;
}

// 输入场景。键盘走阅读器的翻页键，指针点页面上那几张图，滚轮换滚动位置。
// 每一类都真的从浏览器的输入管线进，所以页面里的监听器看得到。
const boxes = await evaluate(`[...document.querySelectorAll('img')]
  .map((image) => { const r = image.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })
  .filter((box) => box.w > 0 && box.h > 0)`);
if (!Array.isArray(boxes) || boxes.length === 0) throw new Error('页面上没有能点的图，驱动不了输入');

const budget = Math.max(inputs, 30);
const kinds = { key: 0, pointer: 0, wheel: 0 };
for (let index = 0; index < budget; index += 1) {
  const mode = index % 3;
  if (mode === 0) {
    const key = index % 6 === 0 ? 'PageDown' : index % 6 === 3 ? 'PageUp' : index % 2 === 0 ? 'ArrowRight' : 'ArrowLeft';
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : key === 'ArrowLeft' ? 37 : key === 'PageDown' ? 34 : 33 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : key === 'ArrowLeft' ? 37 : key === 'PageDown' ? 34 : 33 });
    kinds.key += 1;
  } else if (mode === 1) {
    const box = boxes[index % boxes.length];
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    kinds.pointer += 1;
  } else {
    const box = boxes[index % boxes.length];
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: index % 2 === 0 ? 240 : -240 });
    kinds.wheel += 1;
  }
  await sleep(16);
}
await sleep(settleMs);

// resize 场景：改的是合成器的视口，和真人拖窗口一样会走重排。
const resizes = [];
for (const [width, height] of [[1180, 760], [900, 640], [1180, 760]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  resizes.push({ width, height });
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

// worker 那一档：把计算进程杀掉，再量一次「UI 还动不动」和「多久给出状态」。
let workerKill = null;
if (killWorker) {
  const killedAt = Date.now();
  try {
    process.kill(killTarget);
  } catch (error) {
    throw new Error(`杀不掉 worker ${killTarget}：${error.message}`);
  }
  // 量的是**那一条状态本身**（`[data-testid="compute-worker-status"]`，`ComputeWorkerToasts` 把状态
  // 转成的那张 toast 卡上就带着它），
  // 不是满页找「正在恢复/不可用」几个字：满页找字在阅读器里一定能碰上（错误屏、别的提示里都有这些词），
  // 那样量到的「2 秒内给到状态」什么都不证明。
  const signalled = await evaluate(`(async () => {
    const started = performance.now();
    for (;;) {
      const found = document.querySelector('[data-testid="compute-worker-status"]');
      if (found) {
        return {
          ms: performance.now() - started,
          state: found.getAttribute('data-worker-state'),
          text: (found.textContent || '').trim(),
        };
      }
      if (performance.now() - started > 4000) return { ms: -1 };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })()`);
  const before = await evaluate('window.__probe.inputs.length');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(500);
  const after = await evaluate('window.__probe.inputs.length');
  workerKill = {
    pid: killTarget,
    statusMs: signalled && signalled.ms >= 0 ? Math.round(signalled.ms * 10) / 10 : -1,
    state: signalled ? signalled.state ?? null : null,
    text: signalled ? signalled.text ?? null : null,
    withinBudget: Boolean(signalled && signalled.ms >= 0 && signalled.ms <= 2000),
    wireMs: Date.now() - killedAt,
    inputAnswered: after > before,
  };
}

// 仪器不许把用户的偏好留在被改过的样子：上面把超分/去码写成了关的，这里把**开场那份快照**
// 整个写回去（关和还是同一个 API）。为什么还的时刻放在最后：导航那一趟要的正是「关着」这个
// 前提，提前还就把前提撤了。两趟跑（`-DropFrames`）时两趟是两个 node 进程，第一趟在这里
// 还原完第二趟才开始，所以第二趟开场读到的仍然是原值，不是上一趟留下的 off。
let quietRestored = null;
if (quietSnapshot) {
  quietRestored = await evaluate(`(async () => {
    const module = await import('/src/repositories/nativeSettingsRepository.ts');
    const repository = new module.NativeSettingsRepository();
    const saved = await repository.save(${JSON.stringify(quietSnapshot)});
    if (!saved.ok) return { ok: false, error: saved.error.message };
    return { ok: true, upscaleBackend: saved.value.upscaleBackend, decensorModel: saved.value.decensorModel };
  })()`);
  console.log(`UI_PROBE_QUIET_RESTORED 还原成超分 ${quietRestored.upscaleBackend}、去码 ${JSON.stringify(quietRestored.decensorModel)}${quietRestored.ok ? '' : '（没还回去：' + quietRestored.error + '）'}`);
}

const probe = await evaluate('window.__probe');
const metrics = await send('Performance.getMetrics');
const paint = await evaluate(`[...performance.getEntriesByType('paint')].map((entry) => ({ name: entry.name, ms: Math.round(entry.startTime) }))`);
const nav = await evaluate(`(() => { const entry = performance.getEntriesByType('navigation')[0]; return entry ? { domContentLoaded: Math.round(entry.domContentLoadedEventEnd), load: Math.round(entry.loadEventEnd) } : null; })()`);

const round = (value) => Math.round(value * 100) / 100;
function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percent / 100) * sorted.length));
  return round(sorted[rank - 1]);
}

const inputMs = probe.inputs.map((entry) => entry.ms).filter((value) => Number.isFinite(value));
const frames = probe.frames.filter((value) => Number.isFinite(value) && value > 0);
const median = percentile(frames, 50);
const dropped = median ? frames.filter((value) => value > median * 1.5) : [];
const heap = metrics.metrics.find((entry) => entry.name === 'JSHeapUsedSize');

const report = {
  test: 'ui-probe',
  readerUrl: readerUrl ?? null,
  // 这一跑量的负载从哪来、得出几件：空载趟没有它，压机器那一趟有。
  load,
  // 两趟共用的前提：超分/去码在这一跑之前是什么、现在被写成了什么；打不开应用模块的那一档
  // （`--no-quiet`）明说它是跳过的，还回原值的结果也在这里——「量到了」和「没弄脏现场」是两件事。
  quiet: {
    before: quiet.before ?? null,
    after: quiet.after ?? null,
    skipped: quiet.skipped ?? null,
    restored: quietRestored,
  },
  navigation,
  timing: { paint, navigation: nav },
  inputs: {
    total: probe.inputs.length,
    kinds,
    p50: percentile(inputMs, 50),
    p95: percentile(inputMs, 95),
    p99: percentile(inputMs, 99),
    worst: inputMs.length ? round(Math.max(...inputMs)) : null,
  },
  frames: {
    count: frames.length,
    p50Ms: median,
    p95Ms: percentile(frames, 95),
    dropped: dropped.length,
    // 掉帧比例**不许在这里四舍五入**：这个数要在 harness 里两趟相减，而 §12.3 的门槛是
  // 5 个百分点。两位小数的 `round` 会把比例量化成整百分点（0.0087 和 0.0059 都会变成 0.01），
  // 于是「增加多少」永远读出 0——一个分辨不出门槛的仪器等于没有。这里给不修约的分式，
  // 显示用的小数留给读的人自己去圆。
  droppedRatio: frames.length ? dropped.length / frames.length : null,
  },
  longTasks: {
    count: probe.longTasks.length,
    worstMs: probe.longTasks.length ? round(Math.max(...probe.longTasks.map((entry) => entry.ms))) : null,
  },
  renderer: {
    jsHeapUsedBytes: heap ? Number(heap.value) : null,
    nodes: Number(metrics.metrics.find((entry) => entry.name === 'Nodes')?.value ?? -1),
  },
  resizes,
  workerKill,
  notes: probe.notes,
  consoleTail: console_.slice(-10),
};
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('UI_PROBE_JSON ' + JSON.stringify(report));
ws.close();
// 读数先写出来（诊断要用），但没还回去的偏好必须让这一跑红——绿色的读数配一个被改坏的
// 现场，比红着退出坏得多。
if (quietRestored && !quietRestored.ok) throw new Error('偏好没还回去：' + JSON.stringify(quietRestored));
