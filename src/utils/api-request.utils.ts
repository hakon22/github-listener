const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_DELAY_BETWEEN_REQUESTS_MS = 200;

export const API_REQUEST_TIMEOUT_MS = Number(process.env.API_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;
export const DELAY_BETWEEN_REQUESTS_MS = Number(process.env.DELAY_BETWEEN_REQUESTS_MS) || DEFAULT_DELAY_BETWEEN_REQUESTS_MS;

export const createFetchWithTimeout = (timeoutMs: number = API_REQUEST_TIMEOUT_MS) => {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
    return fetch(input, { ...init, signal });
  };
};

export const createRateLimiter = (minDelayMs: number = DELAY_BETWEEN_REQUESTS_MS) => {
  let lastRequestTime = 0;

  return (): Promise<void> => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    const waitMs = elapsed < minDelayMs ? minDelayMs - elapsed : 0;
    lastRequestTime = now + waitMs;
    return waitMs > 0 ? new Promise((resolve) => setTimeout(resolve, waitMs)) : Promise.resolve();
  };
};
