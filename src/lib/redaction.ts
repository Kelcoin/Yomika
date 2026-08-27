const SENSITIVE_KEY = /(?:api[_-]?key|token|password|authorization|cookie|sync[_-]?secret|ipb_member_id|ipb_pass_hash)/i;
const SENSITIVE_QUERY = /([?&](?:api[_-]?key|token|password|sync[_-]?secret)=)[^&#\s]+/gi;
const BEARER_VALUE = /(Bearer\s+)[^\s,;]+/gi;

export function redactSensitive(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value
      .replace(SENSITIVE_QUERY, '$1[REDACTED]')
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
