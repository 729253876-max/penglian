import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

type NativeHttpNamedExports = Pick<typeof http, "get" | "request">;
type NativeHttpsNamedExports = Pick<typeof https, "get" | "request">;
type TestRuntime = typeof globalThis & {
  fetch: typeof fetch;
  testNetworkPolicyNativeNamedExports?: {
    http: NativeHttpNamedExports;
    https: NativeHttpsNamedExports;
  };
};
const TEST_RUNTIME = globalThis as TestRuntime;

async function loadNativeNamedExports<T>(
  specifier: "node:http" | "node:https"
): Promise<T> {
  const source = `import { get, request } from "${specifier}"; export { get, request };`;
  return import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
  ) as Promise<T>;
}

const nativeHttpNamedExports = await loadNativeNamedExports<NativeHttpNamedExports>(
  "node:http"
);
const nativeHttpsNamedExports = await loadNativeNamedExports<NativeHttpsNamedExports>("node:https");
TEST_RUNTIME.testNetworkPolicyNativeNamedExports = {
  http: nativeHttpNamedExports,
  https: nativeHttpsNamedExports
};

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ERROR_CODE = "TEST_NETWORK_EGRESS_FORBIDDEN";
type UnknownArgsFunction = (...args: unknown[]) => unknown;

const originalFetch = TEST_RUNTIME.fetch;
const originalHttpRequest = http.request as UnknownArgsFunction;
const originalHttpGet = http.get as UnknownArgsFunction;
const originalHttpsRequest = https.request as UnknownArgsFunction;
const originalHttpsGet = https.get as UnknownArgsFunction;
const originalNetConnect = net.connect as UnknownArgsFunction;
const originalNetCreateConnection = net.createConnection as UnknownArgsFunction;
const originalSocketConnect = net.Socket.prototype.connect as UnknownArgsFunction;
const originalTlsConnect = tls.connect as UnknownArgsFunction;

TEST_RUNTIME.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = resolveFetchInputAsUrl(input);
  if (url) {
    const violation = assertLocalTarget(url.hostname);
    if (violation) {
      return Promise.reject(violation);
    }
  }
  return originalFetch(input, init);
}) as typeof fetch;

http.request = ((...args: unknown[]) => {
  const options = normalizeHttpTarget(args[0], args[1]);
  const violation = assertLocalTarget(options?.hostname, options?.host);
  if (violation) {
    throw violation;
  }
  return originalHttpRequest(...args);
}) as typeof http.request;

http.get = ((...args: unknown[]) => {
  const options = normalizeHttpTarget(args[0], args[1]);
  const violation = assertLocalTarget(options?.hostname, options?.host);
  if (violation) {
    throw violation;
  }
  return originalHttpGet(...args);
}) as typeof http.get;

https.request = ((...args: unknown[]) => {
  const options = normalizeHttpTarget(args[0], args[1]);
  const violation = assertLocalTarget(options?.hostname, options?.host);
  if (violation) {
    throw violation;
  }
  return originalHttpsRequest(...args);
}) as typeof https.request;

https.get = ((...args: unknown[]) => {
  const options = normalizeHttpTarget(args[0], args[1]);
  const violation = assertLocalTarget(options?.hostname, options?.host);
  if (violation) {
    throw violation;
  }
  return originalHttpsGet(...args);
}) as typeof https.get;

net.connect = ((...args: unknown[]) => {
  const target = parseNetTarget(args as Parameters<typeof net.connect>);
  const violation = assertLocalTarget(target.host, target.host);
  if (violation) {
    throw violation;
  }
  return originalNetConnect(...args);
}) as typeof net.connect;

net.createConnection = ((...args: unknown[]) => {
  const target = parseNetTarget(args as Parameters<typeof net.createConnection>);
  const violation = assertLocalTarget(target.host, target.host);
  if (violation) {
    throw violation;
  }
  return originalNetCreateConnection(...args);
}) as typeof net.createConnection;

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const target = parseSocketTarget(args);
  const violation = assertLocalTarget(target.host, target.host);
  if (violation) {
    throw violation;
  }
  return originalSocketConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;

tls.connect = ((...args: unknown[]) => {
  const target = parseSocketTarget(args);
  const violation = assertLocalTarget(target.host, target.host);
  if (violation) {
    throw violation;
  }
  return originalTlsConnect(...args);
}) as typeof tls.connect;

syncBuiltinESMExports();

function normalizeHttpTarget(
  input: unknown,
  fallback: unknown
): { hostname?: string | undefined; host?: string | undefined } {
  if (typeof input === "string") {
    const parsed = parseHttpUrl(input);
    return parsed ? { hostname: parsed.hostname, host: parsed.host } : {};
  }

  if (typeof input === "object" && input !== null) {
    const typed = input as { host?: unknown; hostname?: unknown };
    return {
      host: typeof typed.host === "string" ? String(typed.host) : undefined,
      hostname: typeof typed.hostname === "string" ? String(typed.hostname) : undefined
    };
  }

  const fallbackUrl = typeof fallback === "string" ? parseHttpUrl(fallback) : undefined;
  return fallbackUrl ? { hostname: fallbackUrl.hostname, host: fallbackUrl.host } : {};
}

function parseNetTarget(args: Parameters<typeof net.createConnection>): { host?: string | undefined } {
  return parseSocketTarget(args);
}

function parseSocketTarget(args: readonly unknown[]): { host?: string | undefined } {
  if (typeof args[0] === "number") {
    return { host: typeof args[1] === "string" ? args[1] : undefined };
  }
  if (typeof args[0] === "object" && args[0] !== null) {
    const typed = args[0] as { host?: unknown; hostname?: unknown };
    return {
      host: typeof typed.host === "string"
        ? String(typed.host)
        : typeof typed.hostname === "string"
          ? String(typed.hostname)
          : undefined
    };
  }
  return {};
}

function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function resolveFetchInputAsUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  if (typeof input === "string") {
    return parseHttpUrl(input);
  }
  if (input instanceof URL) {
    return input.protocol === "http:" || input.protocol === "https:" ? input : undefined;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return parseHttpUrl(input.url);
  }
  return undefined;
}

function assertLocalTarget(hostname?: string, host?: string): Error | undefined {
  const candidate = normalizeHost(host ?? hostname);
  if (!candidate) {
    return undefined;
  }
  if (!ALLOWED_HOSTS.has(candidate)) {
    return Object.assign(new Error(ERROR_CODE), {
      code: ERROR_CODE
    });
  }
  return undefined;
}

function normalizeHost(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw === "::1") {
    return raw;
  }
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 1 ? raw.slice(1, end).toLowerCase() : raw.toLowerCase();
  }
  if (raw.startsWith(":") || raw.endsWith(":")) {
    return raw.toLowerCase();
  }
  const match = raw.match(/^(.+):\d+$/);
  if (match) {
    return match[1]!.toLowerCase();
  }
  return raw.toLowerCase();
}
