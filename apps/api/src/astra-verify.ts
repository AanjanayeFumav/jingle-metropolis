/**
 * Astra webhook signature verification.
 *
 * Astra signs: base64( HMAC-SHA256( key = ASTRA_CLIENT_SECRET, msg = python `json.dumps(payload)` ) )
 * and sends it in the `Astra-Verification` header. Python's default json.dumps uses ", " and ": "
 * separators, insertion key order, and ensure_ascii=True, so we re-serialize the parsed payload the
 * same way (pyJsonDumps) and also try the raw bytes as received. Either match passes.
 *
 * Known non-reproducible cases (documented; irrelevant for Astra's ids-only payloads):
 *  - floats: Python prints 10.0 / 1e-07, JS prints 10 / 1e-7, so pyJsonDumps throws on non-integers.
 *  - JS reorders integer-like object keys; Python keeps insertion order.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function pyString(s: string): string {
  // JSON.stringify covers quotes, backslashes and control chars exactly like Python;
  // ensure_ascii additionally \u-escapes everything outside 0x20-0x7e (DEL and non-ASCII, per UTF-16 unit).
  return JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    throw new Error("pyJsonDumps: floats are not reproducible between Python and JS");
  }
  if (typeof v === "string") return pyString(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pyString(k)}: ${pyJsonDumps(x)}`)
      .join(", ")}}`;
  }
  throw new Error(`pyJsonDumps: unsupported type ${typeof v}`);
}

function hmac(secret: string, msg: Buffer): Buffer {
  return createHmac("sha256", secret).update(msg).digest();
}

/** What Astra would put in the header for this payload. For tests and local webhook simulation. */
export function signAstraPayload(payload: unknown, clientSecret: string): string {
  return hmac(clientSecret, Buffer.from(pyJsonDumps(payload), "utf8")).toString("base64");
}

/** True iff the header is a valid signature of the body under the client secret. Never throws. */
export function verifyAstraSignature(rawBody: Buffer | string, header: string | undefined, clientSecret: string): boolean {
  if (!header || !clientSecret) return false;
  const expected = Buffer.from(header.trim(), "base64");
  if (expected.length !== 32) return false;

  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const candidates: Buffer[] = [raw];
  try {
    candidates.push(Buffer.from(pyJsonDumps(JSON.parse(raw.toString("utf8"))), "utf8"));
  } catch {
    // not JSON, or contains something we cannot reproduce: raw-bytes candidate only
  }
  return candidates.some((c) => {
    const d = hmac(clientSecret, c);
    return d.length === expected.length && timingSafeEqual(d, expected);
  });
}
