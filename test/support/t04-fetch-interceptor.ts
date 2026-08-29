import type { TestContext } from "node:test";

export interface T04ObservedRequest {
  readonly method: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}

export interface T04FetchInterceptor {
  readonly calls: readonly T04ObservedRequest[];
  readonly restore: () => void;
}

export function t04JsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...headers,
    },
  });
}

/**
 * Installs a test-local fetch boundary around the in-process gateway. The
 * transcript is content-free: it records only method and URL components.
 */
export function installT04FetchInterceptor(
  t: TestContext,
  handler: (request: Request, call: T04ObservedRequest) => Promise<Response | undefined>,
): T04FetchInterceptor {
  const originalFetch = globalThis.fetch;
  const calls: T04ObservedRequest[] = [];
  const interceptedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const call = {
      method: request.method,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    };
    calls.push(call);
    const synthetic = await handler(request, call);
    return synthetic ?? (await originalFetch(request));
  };
  globalThis.fetch = interceptedFetch;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (globalThis.fetch === interceptedFetch) globalThis.fetch = originalFetch;
  };
  t.after(restore);
  return { calls, restore };
}
