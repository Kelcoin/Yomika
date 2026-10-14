import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { invokeCommand, resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { flushErrorLog, setErrorLogSinkForTests, type ErrorLogRecord } from '../../src/lib/errorLog';

/** 「现在没位置」这一类码不许写进错误日志。
 *
 * 现场：一份真实设备日志 925 行里有 848 行是这一类（`COMPUTE_QUEUE_FULL` 424 条 × 两个
 * 来源、`COMPUTE_UNAVAILABLE`、`COMPUTE_WORKER_BUSY`），占 92%；真正要查的那 75 条
 * `COMPUTE_MODEL_UNAVAILABLE` 反倒被埋在噪声里。它们说的是「队列排满了 / 内存处在软阈值
 * 上 / worker 手上正有一件」——都会自己过去，提交方要做的正是退让再问一次
 * （`src/lib/readerCompute.ts` 的 `BACKPRESSURE_RETRY_MS`）。
 *
 * 这条判据走**真的** `logError` 与真的 `invokeCommand`，只用官方的测试 sink
 * （`setErrorLogSinkForTests`）接收落盘的那几条，不去 mock 模块——`src/bridge/invoke.ts`
 * 在 `tests/setup.ts` 预加载 `ReaderRoute` 时就求过值了，测试文件里的 `vi.mock` 那时已经
 * 晚了（setup.ts 里那段注释记的正是这个坑）。
 *
 * 第二类安静码是本体更新检查（`APP_RELEASE_CHECK_FAILED` / `APP_RELEASE_UNREACHABLE`）：
 * 用户的原话是「无视检测版本更新失败的日志」。GitHub 的 404 / 403 rate limit、离线、镜像
 * 挂了都会走到这里，界面上只说「这次查不出来」，而它每次启动都刷两条。 */
describe('backpressure codes stay out of the error log', () => {
  const records: ErrorLogRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setErrorLogSinkForTests(async (batch) => {
      records.push(...batch);
      return true;
    });
  });

  afterEach(() => {
    resetInvokeAdapterForTests();
    // 还回默认 sink，顺便把 `sinkAvailable` 复位（否则后面的用例会以为后端在）。
    setErrorLogSinkForTests();
  });

  for (const code of ['COMPUTE_QUEUE_FULL', 'COMPUTE_UNAVAILABLE', 'COMPUTE_WORKER_BUSY']) {
    it(`keeps ${code} out of the log while still reporting the failure`, async () => {
      setInvokeAdapterForTests(async () => ({
        ok: false as const,
        error: { code, message: '计算队列满了：Pressure', retryable: true },
      }));

      const result = await invokeCommand('dlssnr_apply_page', {}, z.unknown());
      await flushErrorLog();

      // 照样按失败返回：该退让的退让、该重试的重试。变的只是「记不记现场」。
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe(code);
      expect(result.ok === false && result.error.retryable).toBe(true);
      expect(records).toEqual([]);
    });
  }

  // 本体更新检查那一类：照样把失败交回去（`update-notice` 靠它决定显示什么），但不落盘。
  for (const code of ['APP_RELEASE_CHECK_FAILED', 'APP_RELEASE_UNREACHABLE']) {
    it(`keeps ${code} out of the log while the update notice still sees the failure`, async () => {
      setInvokeAdapterForTests(async () => ({
        ok: false as const,
        error: {
          code,
          message: '查不到最新版本：HTTP status client error (403 rate limit exceeded) for url (https://api.github.com/repos/Kelcoin/Yomika/releases/latest)',
          retryable: true,
        },
      }));

      const result = await invokeCommand('app_release_latest', {}, z.unknown());
      await flushErrorLog();

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe(code);
      expect(records).toEqual([]);
    });
  }

  it('still writes a submit rejection that is a real answer', async () => {
    // 反例：指名了一个这台机器上没有的模型是**真的没成**（`COMPUTE_MODEL_UNAVAILABLE`），
    // 这一条必须留在日志里——安静名单只收「现在没位置」，不收「这件事办不成」。
    // （这一栏以前拿 anime4k-hq 当例子：它当时是宿主内置、worker 里没有的一档；第 30 轮
    // 把那条链连解析器带执行体搬进 compute-core 之后它就走得通了，例子换成仍然真会发生的
    // 「模型没装」。）
    setInvokeAdapterForTests(async () => ({
      ok: false as const,
      error: {
        code: 'COMPUTE_MODEL_UNAVAILABLE',
        message: '这台机器上还没有这个超分模型：realcugan-2x-conservative（先去设置里下载它）',
        retryable: false,
      },
    }));

    const result = await invokeCommand('compute_submit_reader_page', { archiveId: 'a:12' }, z.unknown());
    await flushErrorLog();

    expect(result.ok).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe('bridge/compute_submit_reader_page');
    expect(records[0]?.message).toBe('COMPUTE_MODEL_UNAVAILABLE: 这台机器上还没有这个超分模型：realcugan-2x-conservative（先去设置里下载它）');
    expect(records[0]?.detail).toBe('{"request":{"archiveId":"a:12"},"retryable":false}');
  });
});
