import { createLogger } from '../../src/lib/logger';
import { redactSensitive } from '../../src/lib/redaction';

describe('sensitive data redaction', () => {
  it('redacts nested credentials without changing ordinary metadata', () => {
    const value = {
      title: 'Local archive',
      apiKey: 'lrr-secret',
      nested: [{ Cookie: 'ipb_member_id=123; ipb_pass_hash=abc' }],
      headers: { Authorization: 'Bearer token-secret' },
    };

    const redacted = redactSensitive(value);
    const serialized = JSON.stringify(redacted);

    expect(redacted).toMatchObject({ title: 'Local archive', apiKey: '[REDACTED]' });
    expect(serialized).not.toContain('lrr-secret');
    expect(serialized).not.toContain('token-secret');
    expect(serialized).not.toContain('ipb_pass_hash');
  });

  it('scrubs bearer values and sensitive URL query parameters', () => {
    const redacted = redactSensitive(
      'GET https://reader.test/api?token=secret-token&query=artist Authorization: Bearer auth-secret',
    );

    expect(redacted).toContain('query=artist');
    expect(redacted).not.toContain('secret-token');
    expect(redacted).not.toContain('auth-secret');
  });

  it('scrubs e-hentai cookie material found inside free-form strings', () => {
    const redacted = redactSensitive(
      'eh login failed cookie=ipb_member_id=4242; ipb_pass_hash=deadbeefcafe url=https://exhentai.org/g?ipb_pass_hash=deadbeefcafe',
    );

    expect(redacted).not.toContain('deadbeefcafe');
    expect(redacted).not.toContain('4242');
    expect(redacted).toContain('eh login failed');
  });

  it('handles cyclic objects safely', () => {
    const value: Record<string, unknown> = { password: 'secret' };
    value.self = value;

    expect(redactSensitive(value)).toEqual({ password: '[REDACTED]', self: '[Circular]' });
  });

  it('redacts every logger sink payload', () => {
    const records: unknown[] = [];
    const logger = createLogger((record) => records.push(record));

    logger.info('Server connected', { token: 'secret', archive: 'A-1' });

    const serialized = JSON.stringify(records);
    expect(serialized).toContain('A-1');
    expect(serialized).not.toContain('secret');
  });
});
