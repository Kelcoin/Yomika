import { err, isOk, ok } from '../../src/domain/result';

describe('command result', () => {
  it('creates and narrows a successful result', () => {
    const result = ok({ ready: true });

    expect(result).toEqual({ ok: true, value: { ready: true } });
    expect(isOk(result)).toBe(true);
  });

  it('creates a stable domain error', () => {
    expect(err('LRR_UNAUTHORIZED', 'API key rejected', false)).toEqual({
      ok: false,
      error: {
        code: 'LRR_UNAUTHORIZED',
        message: 'API key rejected',
        retryable: false,
      },
    });
  });
});
