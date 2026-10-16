// `passphrase` 在里面：凭据导入导出收的就是它，而桥在命令失败时会把整个请求写进
// 错误日志（文件日志是给人看的现场，也是报 bug 时会发出去的东西）。
const SENSITIVE_NAME = 'api[_-]?key|token|password|passwd|passphrase|sync[_-]?secret|credential|secret|ipb_member_id|ipb_pass_hash';
const SENSITIVE_KEY = new RegExp(`(?:${SENSITIVE_NAME}|authorization|cookie|(?:^|[_-])(?:url|uri|host|hostname|address|path|username|email)$|^(?:name|baseUrl|serverUrl|serverId|serverName|scopeId|archiveId|userId|userName|filePath|fileName|directory|identity)$)`, 'i');
// Matches `name=value` / `name: value` anywhere in a string, not only in a query
// string: E-Hentai auth travels as a raw `Cookie:` header value.
const SENSITIVE_ASSIGNMENT = new RegExp(`\\b(${SENSITIVE_NAME}|authorization|cookie|username|user[_-]?id|server[_-]?id|scope[_-]?id)(\\s*[=:]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&#]+)`, 'gi');
const BEARER_VALUE = /((?:Bearer|Basic)\s+)[^\s,;]+/gi;

/** Run before truncation: a clipped credential or URL can no longer be recognized. */
export function redactLogText(text: string): string {
  // JSON details from older versions must receive the same key-based protection.
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    try { return JSON.stringify(redactSensitive(JSON.parse(text))); } catch { /* Free text or a partial JSON record. */ }
  }
  return text
    .replace(/\b(?:https?|wss?|ftp|file|content):\/\/[^\s<>"'`),}]+/gi, '[REDACTED]')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n\t"'<>|,;]+/g, '[REDACTED]')
    .replace(/\/(?:home|Users|data\/user|storage|mnt|media|private|tmp|var\/folders)\/[^\s"'<>),;]+/g, '[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[REDACTED]')
    .replace(/\[?[\da-f]*:[\da-f:]+(?:%[\w.-]+)?\]?(?::\d+)?/gi, (value) => value.includes('::') || (value.match(/:/g)?.length ?? 0) >= 3 ? '[REDACTED]' : value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(BEARER_VALUE, '$1[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1$2[REDACTED]');
}

export function redactSensitive(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactLogText(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (value instanceof Error) {
    return redact({ name: value.name, message: value.message, stack: value.stack, ...Object.fromEntries(Object.entries(value)) }, seen);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) || SENSITIVE_KEY.test(key.replace(/[_-]/g, '')) ? '[REDACTED]' : redact(item, seen),
    ]),
  );
}
