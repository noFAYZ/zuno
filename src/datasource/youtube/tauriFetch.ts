import { invoke } from "@tauri-apps/api/core";
import { logInternalDebug, logInternalError, logInternalInfo } from "../../internal/logging";
import { toBase64 } from "../../internal/base64";
import { decodeFrame } from "../../internal/ipcFrame";

type ProxyHttpMeta = {
  status: number;
  headers: Record<string, string>;
  /** Present only when the response rotated the session cookie. */
  cookie?: string;
};

/**
 * The session cookie as it stands right now.
 *
 * Google rotates SIDCC and the SIDTS pair continuously, and Rust folds every `Set-Cookie` back
 * into the stored session — so anything derived from the cookie has to read it from here rather
 * than from whatever an Innertube client captured when it was constructed hours ago.
 */
let liveCookie: string | null = null;

export function getLiveCookie(): string | null {
  return liveCookie;
}

export function setLiveCookie(cookie: string | null): void {
  liveCookie = cookie;
}

/**
 * Notified when YouTube rejects an authenticated InnerTube call outright.
 *
 * One place rather than at each call site: a like, a subscribe, a playlist edit and a library
 * sync all fail the same way when the session dies, and every one of them used to report it as
 * its own unrelated error while the app kept claiming to be signed in.
 */
let onAuthRejected: (() => void) | null = null;

export function setAuthRejectedHandler(handler: (() => void) | null): void {
  onAuthRejected = handler;
}

/**
 * Reports a rejection that carried no status code to give it away.
 *
 * YouTube's usual answer to a dead session is not a 401 — it is a perfectly ordinary 200 whose
 * body is the signed-out version of the page. Callers that can recognise that shape report it
 * here so it lands in the same place as the honest failures.
 */
export function notifyAuthRejected(): void {
  onAuthRejected?.();
}

/**
 * Notified when YouTube answers an authenticated call *as* the signed-in user.
 *
 * The counterpart to onAuthRejected, and the only honest basis for showing an account as
 * connected. The app used to infer that from having library data on screen, which a cache with
 * no expiry could satisfy indefinitely after the session behind it had died.
 */
let onAuthConfirmed: ((at: number) => void) | null = null;
let lastConfirmedAt = 0;

export function setAuthConfirmedHandler(handler: ((at: number) => void) | null): void {
  onAuthConfirmed = handler;
}

type TauriFetchInit = RequestInit & {
  timeoutMs?: number;
};

function normalizeUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function getRequestUrl(inputUrl: string, headers: Record<string, string>): string {
  const url = new URL(inputUrl);
  const clientName = headers["x-youtube-client-name"];

  if (
    clientName === "67"
    && url.hostname === "www.youtube.com"
    && url.pathname.startsWith("/youtubei/")
  ) {
    url.hostname = "music.youtube.com";
  }

  return url.toString();
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return valueParts.join("=");
  }
  return null;
}

function getSapisidAuthCookie(cookieHeader: string | undefined): string | null {
  return getCookieValue(cookieHeader, "SAPISID")
    ?? getCookieValue(cookieHeader, "__Secure-1PAPISID")
    ?? getCookieValue(cookieHeader, "__Secure-3PAPISID");
}

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Signs an InnerTube request with the SAPISIDHASH the cookie session requires.
 *
 * The hash is bound to the origin it is sent to, so the origin here has to match the host the
 * request actually goes to — see getRequestUrl, which redirects WEB_REMIX traffic to
 * music.youtube.com. Everything else stays on www.youtube.com.
 *
 * This used to bail out for anything that was not WEB_REMIX, which meant plain WEB requests
 * went out unsigned and YouTube answered them as if signed out. The channel-switcher endpoint
 * is WEB-only, so it always came back as a signed-out stub with no accounts in it.
 */
async function applyCookieAuth(
  headers: Record<string, string>,
  requestUrl: string,
): Promise<void> {
  /*
   * InnerTube calls and the playback-stats pings only. Signing an ordinary page, player script
   * or media fetch would rewrite its Origin and Referer to a host it is not going to, which is
   * worse than leaving it alone.
   *
   * `/api/stats/` is here because a watchtime ping only counts against an account when it
   * carries the session — an unsigned one is accepted with 204 and attributed to nobody.
   */
  const path = new URL(requestUrl).pathname;
  const signable = path.startsWith("/youtubei/") || path.startsWith("/api/stats/");
  if (!headers.cookie || !signable) return;

  const origin = headers["x-youtube-client-name"] === "67"
    ? "https://music.youtube.com"
    : "https://www.youtube.com";
  // The live cookie, not the session's copy — the proxy sends the live one, so the hash has to
  // be built from the same SAPISID that actually goes out.
  const sapisid = getSapisidAuthCookie(liveCookie ?? headers.cookie);
  if (sapisid) {
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${timestamp} ${sapisid} ${origin}`);
    headers.authorization = `SAPISIDHASH ${timestamp}_${hash}`;
    headers["x-goog-request-time"] = timestamp.toString();
  }
  headers.origin = origin;
  headers["x-origin"] = origin;
  headers.referer = `${origin}/`;
}

async function buildBodyBase64(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const body = init?.body;
  if (!body) return undefined;

  if (typeof body === "string") {
    return toBase64(new TextEncoder().encode(body));
  }

  if (body instanceof URLSearchParams) {
    return toBase64(new TextEncoder().encode(body.toString()));
  }

  if (body instanceof Uint8Array) {
    return toBase64(body);
  }

  if (body instanceof ArrayBuffer) {
    return toBase64(new Uint8Array(body));
  }

  if (body instanceof Blob) {
    return toBase64(new Uint8Array(await body.arrayBuffer()));
  }

  if (typeof input !== "string" && !(input instanceof URL) && input.body) {
    const fallbackBuffer = await input.clone().arrayBuffer();
    return toBase64(new Uint8Array(fallbackBuffer));
  }

  return undefined;
}

export async function tauriFetch(input: RequestInfo | URL, init?: TauriFetchInit): Promise<Response> {
  const startedAt = performance.now();
  let sourceHeaders: HeadersInit | undefined;
  
  if (init?.headers) {
    sourceHeaders = init.headers;
  } else if (typeof input !== "string" && !(input instanceof URL) && input.headers) {
    sourceHeaders = input.headers;
  }
  
  const requestHeaders = new Headers(sourceHeaders);

  const headers: Record<string, string> = {};
  requestHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  // Signed before the URL is resolved, because getRequestUrl keys off the client name that
  // decides the origin the signature is bound to.
  await applyCookieAuth(headers, normalizeUrl(input));
  const method =
    init?.method ??
    (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
  const body_base64 = await buildBodyBase64(input, init);
  const url = getRequestUrl(normalizeUrl(input), headers);

  logInternalDebug("tauriFetch.request", { method, url });

  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  signal?.throwIfAborted();
  try {
    const request = invoke<ArrayBuffer>("proxy_http_request", {
      input: { url, method, headers, body_base64, timeout_ms: init?.timeoutMs },
    });
    // Rust finishes the request either way; an abort only stops the caller waiting on it.
    const frame = await (signal
      ? Promise.race([request, new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })])
      : request);
    const { meta, body } = decodeFrame<ProxyHttpMeta>(frame);

    if (meta.cookie) {
      liveCookie = meta.cookie;
    }

    // Only for requests that carried credentials: the download client is deliberately
    // anonymous, and a 401 there says nothing about the user's session.
    if (meta.status === 401 && headers.cookie) {
      logInternalInfo("tauriFetch.authRejected", { url });
      onAuthRejected?.();
    }

    const authenticatedApiCall = headers.cookie
      && new URL(url).pathname.startsWith("/youtubei/");
    if (authenticatedApiCall && meta.status >= 200 && meta.status < 300) {
      const now = Date.now();
      // Throttled: this fires on every API call, and the UI only needs it to be roughly current.
      if (now - lastConfirmedAt >= 30_000) {
        lastConfirmedAt = now;
        onAuthConfirmed?.(now);
      }
    }

    if (meta.status >= 400) {
      logInternalError("tauriFetch.http error", new Error(`HTTP ${meta.status}`), {
        method,
        url,
        responseBody: new TextDecoder().decode(body.subarray(0, 1000)),
      });
    }
    logInternalDebug("tauriFetch.response", {
      url,
      status: meta.status,
      responseBytes: body.byteLength,
      durationMs: Math.round(performance.now() - startedAt),
    });
    const nullBody = meta.status === 204 || meta.status === 205 || meta.status === 304;
    return new Response(nullBody ? null : body, { status: meta.status, headers: meta.headers });
  } catch (error) {
    if (signal?.aborted) throw error;
    logInternalError("tauriFetch.invoke failed", error, {
      method,
      url,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}
