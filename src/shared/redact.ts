const SECRET_PATTERNS = [/api[_-]?key/gi, /token/gi, /secret/gi, /authorization/gi];

export function redactValue(value: string): string {
  if (value.length <= 8) {
    return '***';
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const shouldRedact = SECRET_PATTERNS.some((pattern) => pattern.test(key));
      if (!shouldRedact) {
        return [key, value];
      }

      if (typeof value === 'string') {
        return [key, redactValue(value)];
      }

      return [key, '***'];
    }),
  );
}
