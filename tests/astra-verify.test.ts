/** Astra webhook HMAC, cross-checked against python3's json.dumps when python3 is on the machine. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pyJsonDumps, signAstraPayload, verifyAstraSignature } from "../apps/api/src/astra-verify.js";

const python = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

function pyDumps(value: unknown): string {
  const r = spawnSync("python3", ["-c", "import json,sys; print(json.dumps(json.loads(sys.stdin.read())), end='')"], {
    input: JSON.stringify(value),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const payload = { webhook_type: "transfer_updated", webhook_id: "wh_1", user_id: "u_1", resource_id: "r_1" };
// Reference computed independently in python:
//   base64.b64encode(hmac.new(b"secret", json.dumps(payload).encode(), hashlib.sha256).digest())
const KNOWN_SIG = "hG7HcAdEpSVEHRsM8rCtFFH9vvq/GZIkvS34jI+kSVk=";

test("pyJsonDumps reproduces python json.dumps defaults", { skip: !python && "python3 not available" }, () => {
  const cases: unknown[] = [
    payload,
    { a: [1, 2, { b: null, c: true, d: false }], e: 'x"y\\z\n\t', f: {}, g: [] },
    { name: "Café ☕ \u{1F600}", del: "", ctrl: "", slash: "a/b" },
    { nested: { deep: { deeper: ["ünïcödé", 0, -5] } } },
  ];
  for (const c of cases) assert.equal(pyJsonDumps(c), pyDumps(c));
});

test("pyJsonDumps refuses floats instead of guessing", () => {
  assert.throws(() => pyJsonDumps({ amount: 19.99 }));
});

test("known-good signature verifies for the python-style body and for a re-serialized body", () => {
  assert.equal(signAstraPayload(payload, "secret"), KNOWN_SIG);
  const pythonBody = pyJsonDumps(payload); // what Astra puts on the wire
  assert.ok(verifyAstraSignature(pythonBody, KNOWN_SIG, "secret"));
  const compactBody = JSON.stringify(payload); // if a proxy re-serialized it, the fallback still matches
  assert.ok(verifyAstraSignature(compactBody, KNOWN_SIG, "secret"));
});

test("tampered body, wrong secret, missing or malformed header all fail without throwing", () => {
  const body = pyJsonDumps(payload);
  assert.equal(verifyAstraSignature(body.replace("r_1", "r_2"), KNOWN_SIG, "secret"), false);
  assert.equal(verifyAstraSignature(body, KNOWN_SIG, "other"), false);
  assert.equal(verifyAstraSignature(body, undefined, "secret"), false);
  assert.equal(verifyAstraSignature(body, "not-base64!!", "secret"), false);
  assert.equal(verifyAstraSignature(body, "AAAA", "secret"), false);
  assert.equal(verifyAstraSignature("not json at all", KNOWN_SIG, "secret"), false);
  assert.equal(verifyAstraSignature(body, KNOWN_SIG, ""), false);
});
