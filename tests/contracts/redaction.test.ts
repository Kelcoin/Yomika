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

  it('redacts the passphrase of a credential export', () => {
    // 桥在命令失败时会把整个请求写进错误日志，而凭据导入导出收的就是口令：它在
    // 键名与 `name=value` 两种形状下都不能漏进日志。
    const redacted = redactSensitive({
      passphrase: 'correct horse battery',
      nested: { Passphrase: 'another-secret' },
      note: 'passphrase=also-secret',
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('correct horse battery');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).not.toContain('also-secret');
  });

  it('handles cyclic objects safely', () => {
    const value: Record<string, unknown> = { password: 'secret' };
    value.self = value;

    expect(redactSensitive(value)).toEqual({ password: '[REDACTED]', self: '[Circular]' });
  });
});
