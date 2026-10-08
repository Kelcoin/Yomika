import { describe, expect, it } from 'vitest';

import { COMPUTE_ERROR_CODES, RETRYABLE_COMPUTE_ERROR_CODES } from '../../src/domain/compute';

describe('compute domain', () => {
  it('counts a dead worker as worth another try and a missing model as final', () => {
    // 阅读器拿这个集合决定「这一页到底算不算试过了」（`ReaderRoute` 里 `!derived` 那一段）：
    // 现场问题要再给一次机会，定局不该每翻回来一次就重撞一次。名单是判据本身，所以逐字钉住。
    expect([...RETRYABLE_COMPUTE_ERROR_CODES]).toEqual([
      'COMPUTE_WORKER_UNAVAILABLE',
      'COMPUTE_WORKER_LOST',
      'COMPUTE_WORKER_BUSY',
      'COMPUTE_QUEUE_FULL',
      'COMPUTE_TIMEOUT',
      'COMPUTE_UNAVAILABLE',
      'COMPUTE_CANCELLED',
    ]);
  });

  it('keeps every retryable code inside the closed set the bridge accepts, and the final ones out', () => {
    // 桥接只认登记过的码：这里多写一个没登记的，界面上那条失败会整条变成「无效响应」，
    // 真正的理由（比如显卡拿不到）反而看不见——`COMPUTE_ERROR_CODES` 上面那段注释讲的就是这件事。
    for (const code of RETRYABLE_COMPUTE_ERROR_CODES) {
      expect(COMPUTE_ERROR_CODES, code).toContain(code);
    }
    // 定局的那几个不许溜进来：它们再问一次还是同一个结果。
    for (const final of [
      'COMPUTE_MODEL_UNAVAILABLE',
      'GPU_OUTPUT_INVALID',
      'GPU_BACKEND_UNAVAILABLE',
      'COMPUTE_INPUT_INVALID',
      'COMPUTE_RESOURCE_LIMIT',
      'COMPUTE_ARTIFACT_INVALID',
    ]) {
      expect(RETRYABLE_COMPUTE_ERROR_CODES.has(final), final).toBe(false);
    }
  });
});
