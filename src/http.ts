const MAX_TIMEOUT_MS = 300_000;

export function requestTimeout(
  value: number | undefined,
  defaultValue: number,
  name: string,
): number {
  const timeout = value ?? defaultValue;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return timeout;
}

export function withDeadline(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
