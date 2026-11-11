import { invoke } from "@tauri-apps/api/core";

type LogLevel = "debug" | "info" | "warn" | "error";

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let sequence = 0;

const SENSITIVE_KEY_PATTERN = /cookie|authorization|token|credential|secret|password|sapisid|apisid|sid|visitor|signature|cipher|url/i;

function sanitizeString(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
    } catch {
      return "[redacted-url]";
    }
  }
  return value
    .replace(/(SAPISID|APISID|HSID|SSID|SID|LOGIN_INFO|VISITOR_INFO1_LIVE|__Secure-[^=;\s]+)=([^;\s]+)/gi, "$1=[redacted]")
    .replace(/(Authorization:\s*)(Bearer\s+)?[^\s,}]+/gi, "$1[redacted]");
}

function sanitizeForLog(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      return sanitizeString(value);
    }
    return "[redacted]";
  }

  if (typeof value === "string") return sanitizeString(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
      cause: sanitizeForLog((value as { cause?: unknown }).cause, "cause", seen),
    };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, key, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    sanitized[entryKey] = sanitizeForLog(entryValue, entryKey, seen);
  }
  return sanitized;
}

function safeStringify(value: unknown, maxLen = 4000): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, v) => {
      if (v instanceof Error) {
        return {
          name: v.name,
          message: v.message,
          stack: v.stack,
          cause: (v as { cause?: unknown }).cause,
        };
      }
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      if (typeof v === "bigint") return v.toString();
      return v;
    },
    2,
  );

  if (typeof json !== "string") return String(json);
  if (json.length <= maxLen) return json;
  return `${json.slice(0, maxLen)}\n…(truncated ${json.length - maxLen} chars)…`;
}

function normalizeError(error: unknown): Record<string, unknown> | unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      // `Error.cause` depends on TS lib target; keep it safe across configs.
      cause: (error as { cause?: unknown }).cause,
    };
  }
  if (typeof error === "object" && error !== null) {
    // Some libraries throw non-Error objects with non-enumerable properties.
    const record: Record<string, unknown> = {
      type: Object.prototype.toString.call(error),
    };
    try {
      for (const key of Object.getOwnPropertyNames(error)) {
        record[key] = (error as Record<string, unknown>)[key];
      }
    } catch {
      // ignore
    }
    try {
      // Provide a best-effort string form for quick scanning in logs.
      record.string = String(error);
    } catch {
      // ignore
    }
    return record;
  }
  return error;
}

function writeInternalLog(level: LogLevel, context: string, extra?: Record<string, unknown>) {
  // Debug lines are a development aid; in release they cost a sanitize, a stringify and an IPC hop each.
  if (level === "debug" && !import.meta.env?.DEV) return;
  sequence += 1;
  const payloadText = safeStringify(sanitizeForLog({
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    context,
    ...extra,
  }));
  void invoke("frontend_log", { level, context, payload: payloadText }).catch(() => {
    // Logging must never interrupt the application flow.
  });
  // Text only: a logged object is retained by the console buffer for as long as the page lives.
  console[level](`[internal][${level}] ${context}`, payloadText);
}

export function logInternalDebug(context: string, extra?: Record<string, unknown>) {
  writeInternalLog("debug", context, extra);
}

export function logInternalInfo(context: string, extra?: Record<string, unknown>) {
  writeInternalLog("info", context, extra);
}

export function logInternalWarn(context: string, extra?: Record<string, unknown>) {
  writeInternalLog("warn", context, extra);
}

export function logInternalError(context: string, error: unknown, extra?: Record<string, unknown>) {
  writeInternalLog("error", context, {
    error: normalizeError(error),
    ...extra,
  });
}
