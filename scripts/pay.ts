/**
 * The AC's "script-initiated payment": POST to the running API, then watch the payment move.
 * Run: npm run pay [-- --amount 1999 --watch 120]   (API must be running: npm run dev)
 */
import "dotenv/config";
import { argValue } from "./_astra.js";

const port = process.env.PORT ?? "3100";
const base = process.env.FUMAV_API ?? `http://localhost:${port}`;
const amount = Number(argValue("--amount") ?? "1999");
const watchSec = Number(argValue("--watch") ?? "120");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

interface View {
  id: string; status: string; statusLabel: string; amount: number; fee: number; net: number; error?: string;
  bankDebit: { routineId?: string; routineLabel: string; transferId?: string; transferStatus?: string };
  settlement: { transferId?: string; state?: string; label: string; failed: boolean };
}

const line = (p: View) =>
  `${p.status.padEnd(14)} ${p.statusLabel.padEnd(36)} bank-debit: ${p.bankDebit.routineId ?? "-"} (${p.bankDebit.routineLabel}${p.bankDebit.transferId ? `, transfer ${p.bankDebit.transferId} ${p.bankDebit.transferStatus}` : ""})  payout: ${p.settlement.transferId ?? "-"} (${p.settlement.label})${p.error ? `  error: ${p.error}` : ""}`;

const main = async () => {
  const health = await fetch(`${base}/api/health`).then((r) => r.json() as Promise<{ mode: string }>).catch(() => null);
  if (!health) {
    console.error(`✗ API not reachable at ${base}. Start it with: npm run dev`);
    process.exit(1);
  }
  console.log(`→ POST ${base}/api/payments  amount=${usd(amount)}  [${health.mode}]`);
  const res = await fetch(`${base}/api/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  const body = (await res.json()) as View | { error: string; payment: View };
  const p: View = "payment" in body ? body.payment : body;
  if (!res.ok) console.error(`✗ ${res.status}: ${"error" in body ? body.error : "failed"}`);
  console.log(`✓ payment ${p.id}: gross ${usd(p.amount)} fee ${usd(p.fee)} net ${usd(p.net)}`);
  console.log("  " + line(p));

  let last = p.status + p.settlement.state + p.bankDebit.transferStatus;
  const until = Date.now() + watchSec * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = (await fetch(`${base}/api/payments/${p.id}`).then((r) => r.json())) as View;
    const key = cur.status + cur.settlement.state + cur.bankDebit.transferStatus;
    if (key !== last) {
      console.log(`  ${new Date().toISOString().slice(11, 19)} ` + line(cur));
      last = key;
    }
    if (["replenished", "returned", "loss_absorbed", "charged_back"].includes(cur.status)) break;
  }
  console.log(`\nview: ${base}/`);
};

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
