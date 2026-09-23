// `passphrase` 在里面：凭据导入导出收的就是它，而桥在命令失败时会把整个请求写进
// 错误日志（文件日志是给人看的现场，也是报 bug 时会发出去的东西）。
const SENSITIVE_NAME = 'api[_-]?key|token|password|passwd|passphrase|sync[_-]?secret|credential|secret|ipb_member_id|ipb_pass_hash';
const SENSITIVE_KEY = new RegExp(`(?:${SENSITIVE_NAME}|authorization|cookie)`, 'i');
// Matches `name=value` / `name: value` anywhere in a string, not only in a query
// string: E-Hentai auth travels as a raw `Cookie:` header value.
const SENSITIVE_ASSIGNMENT = new RegExp(`\\b(${SENSITIVE_NAME})(\\s*[=:]\\s*)[^\\s,;&#]+`, 'gi');
const BEARER_VALUE = /(Bearer\s+)[^\s,;]+/gi;

export function redactSensitive(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value
      .replace(SENSITIVE_ASSIGNMENT, '$1$2[REDACTED]')
      .replace(BEARER_VALUE, '$1[REDACTED]');
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, seen),
    ]),
  );
}
