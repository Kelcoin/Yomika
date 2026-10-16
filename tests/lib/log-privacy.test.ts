import { afterEach, expect, it } from 'vitest';
import { flushErrorLog, isExpectedError, logError, setErrorLogSinkForTests, type ErrorLogRecord } from '../../src/lib/errorLog';
import { redactSensitive } from '../../src/lib/redaction';

afterEach(() => setErrorLogSinkForTests());

it('anonymizes private locations and identities in messages and structured details', async () => {
  const records: ErrorLogRecord[] = [];
  setErrorLogSinkForTests(async (batch) => { records.push(...batch); return true; });
  const privateText = 'https://alice:secret@library.example:3000/api?token=abcd 192.168.12.34 [fd00::1234]:90 C:\\Users\\Alice\\books\\file.zip /home/alice/books/file.zip alice@example.com';
  logError('reader', `broken: ${privateText}`, { serverId: 'private-server', username: 'Alice', filePath: 'private-file', note: privateText });
  await flushErrorLog();
  const text = JSON.stringify(records);
  for (const secret of ['alice', 'Alice', 'secret', 'library.example', '192.168.12.34', 'fd00::1234', 'private-server', 'private-file', 'abcd']) expect(text).not.toContain(secret);
  expect(text).toContain('broken:');
  expect(text).toContain('[REDACTED]');
  expect(redactSensitive({ error: new Error(privateText) })).not.toEqual({ error: {} });
  expect(redactSensitive({ name: 'Home library', server_id: 'host', file_path: 'book.zip' })).toEqual({ name: '[REDACTED]', server_id: '[REDACTED]', file_path: '[REDACTED]' });
});

it('silences only transport failures while retaining decoder and model diagnostics', () => {
  for (const value of [
    'REMOTE_TIMEOUT: no response', 'Failed to fetch',
    { code: 'NETWORK', message: 'error decoding response body', retryable: true },
    { code: 'NETWORK', message: 'error sending request for url (https://example.test)', retryable: true },
  ]) expect(isExpectedError(value)).toBe(true);
  for (const value of [
    { code: 'INVALID_RESPONSE', message: 'error decoding response body', retryable: true },
    { code: 'NETWORK', message: 'schema decoder invariant failed', retryable: true },
    { code: 'COMPUTE_INTERNAL', message: 'Failed to fetch', retryable: true },
    { code: 'GPU_OUTPUT_INVALID', message: 'network decoder invariant failed', cause: new TypeError('Failed to fetch') },
  ]) expect(isExpectedError(value)).toBe(false);
});

it('retains an explicit diagnostic even if its context includes a transport cause', async () => {
  const records: ErrorLogRecord[] = [];
  setErrorLogSinkForTests(async (batch) => { records.push(...batch); return true; });
  logError('reader', { code: 'GPU_OUTPUT_INVALID', message: 'invalid output' }, { cause: new TypeError('Failed to fetch') });
  await flushErrorLog();
  expect(records).toHaveLength(1);
});

it.each([
  'https://alice:secret@library.example/api?token=abcd',
  '192.168.12.34:3000', '[fd00::1234]:90', '2001:db8:0:1:2:3:4:5',
  'C:\\Users\\Alice\\file.zip', '/home/alice/books/file.zip', 'alice@example.com',
  'Authorization: Bearer auth-secret', 'Authorization: Basic auth-secret', 'passphrase="correct horse battery"',
])('scrubs a private free-text value independently: %s', (value) => {
  expect(String(redactSensitive(value))).toContain('[REDACTED]');
  expect(String(redactSensitive(value))).not.toMatch(/alice|Alice|secret|library\.example|192\.168|fd00|db8|correct|battery/);
});
