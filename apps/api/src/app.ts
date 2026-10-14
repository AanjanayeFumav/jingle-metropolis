/**
 * The Express app: Astra webhook receiver, payment API, dispute trigger, operator data, static views. Built as a
 * function so tests can run it on port 0 with a mock runtime. server.ts is the one-command entrypoint.
 */
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import type { AstraTransfer } from "../../../packages/astra/src/client.js";
import { verifyAstraSignature } from "./astra-verify.js";
import { saveSnapshot } from "./store.js";
import { toView, type ViewLinks } from "./view.js";
import type { Runtime } from "./wiring.js";

export interface AppOptions {
  /** ASTRA_CLIENT_SECRET. Webhooks are rejected when empty. */
  webhookSecret: string;
  /** Snapshot file; omit for in-memory (mock). */
  snapshotPath?: string;
}

export interface AppContext {
  seenWebhookIds: Set<string>;
  lastWebhookAt?: string;
  webhooksHandled: number;
  webhooksRejected: number;
  pollerTicks: { bridge: number; astra: number; lastBridgeAt?: string; lastAstraAt?: string };
  startedAt: string;
  save(): void;
  /** Fully processed a webhook payload (after the 200). Exposed for tests. */
  handleAstraWebhook(payload: AstraWebhook): Promise<void>;
}

export interface AstraWebhook {
  webhook_type: string;
  webhook_id: string;
  user_id?: string;
  resource_id: string;
  /** chargeback_* events: the transfer the chargeback belongs to. */
  resource_parent_id?: string;
  [k: string]: unknown;
}

const DISPUTABLE = new Set(["settled", "replenished"]);

async function readRawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export function createApp(rt: Runtime, opts: AppOptions): { app: express.Express; ctx: AppContext } {
  const { engine, reconciler, readers } = rt;
  const links: ViewLinks = rt.chain ? { recordUrl: (ref) => rt.chain!.txUrl(ref) } : {};
  const view = (intentId: string) => {
    const intent = engine.intents.get(intentId);
    if (!intent) throw new Error(`unknown intent ${intentId}`);
    return toView(intent, reconciler.facts.get(intent.id), links);
  };

  const ctx: AppContext = {
    seenWebhookIds: new Set(),
    webhooksHandled: 0,
    webhooksRejected: 0,
    pollerTicks: { bridge: 0, astra: 0 },
    startedAt: new Date().toISOString(),
    save() {
      if (opts.snapshotPath) saveSnapshot(opts.snapshotPath, engine, reconciler, ctx.seenWebhookIds);
    },
    handleAstraWebhook,
  };

  function intentForAstraTransfer(t: AstraTransfer) {
    for (const intent of engine.intents.values()) {
      if (t.routine_id && intent.astraRoutineId === t.routine_id) return intent;
      if (t.client_correlation_id && intent.id === t.client_correlation_id) return intent;
    }
    return undefined;
  }

  async function handleAstraWebhook(p: AstraWebhook): Promise<void> {
    if (ctx.seenWebhookIds.has(p.webhook_id)) return;
    ctx.seenWebhookIds.add(p.webhook_id);
    ctx.lastWebhookAt = new Date().toISOString();
    const parties = rt.tokens?.partiesToTry(p.user_id) ?? ["player" as const];
    try {
      switch (p.webhook_type) {
        case "transfer_created":
        case "transfer_updated":
        case "chargeback_created":
        case "chargeback_updated": {
          const transferId = p.webhook_type.startsWith("chargeback") ? p.resource_parent_id : p.resource_id;
          if (!transferId) throw new Error(`${p.webhook_type} without a transfer id`);
          const t = await readers.astraTransfer(transferId, parties);
          const intent = intentForAstraTransfer(t);
          if (!intent) {
            console.log(`[webhook] ${p.webhook_type} transfer ${t.id} matches no payment (routine ${t.routine_id ?? "?"})`);
            break;
          }
          reconciler.recordAstraTransfer(intent.id, t);
          const applied = reconciler.reconcile(intent.id);
          console.log(`[webhook] ${p.webhook_type} -> ${intent.id} transfer=${t.id} status=${t.status} applied=${applied.join(",") || "none"}`);
          break;
        }
        case "routine_updated": {
          const r = await readers.astraRoutine(p.resource_id, parties[0]);
          const intent = [...engine.intents.values()].find((i) => i.astraRoutineId === r.id);
          if (!intent) {
            console.log(`[webhook] routine_updated ${r.id} matches no payment`);
            break;
          }
          reconciler.recordAstraRoutine(intent.id, r);
          const applied = reconciler.reconcile(intent.id);
          console.log(`[webhook] routine_updated -> ${intent.id} status=${r.status} applied=${applied.join(",") || "none"}`);
          break;
        }
        default:
          console.log(`[webhook] ignored ${p.webhook_type} (${p.webhook_id})`);
      }
      ctx.webhooksHandled++;
      ctx.save();
    } catch (err) {
      console.error(`[webhook] ${p.webhook_type} ${p.webhook_id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  const app = express();

  // Webhook first: raw body read by hand so the HMAC sees exactly what Astra sent, before any JSON middleware.
  app.post("/webhooks/astra", async (req: Request, res: Response) => {
    const raw = await readRawBody(req);
    const header = req.header("astra-verification") ?? undefined;
    if (!verifyAstraSignature(raw, header, opts.webhookSecret)) {
      ctx.webhooksRejected++;
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let payload: AstraWebhook;
    try {
      payload = JSON.parse(raw.toString("utf8")) as AstraWebhook;
    } catch {
      res.status(400).json({ error: "body is not JSON" });
      return;
    }
    res.status(200).json({ received: true });
    setImmediate(() => void handleAstraWebhook(payload));
  });

  app.use(express.json());

  app.post("/api/payments", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { amount?: unknown; merchantId?: unknown; playerId?: unknown; item?: unknown };
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive integer number of cents" });
      return;
    }
    const intent = engine.createPayment({
      merchantId: typeof body.merchantId === "string" ? body.merchantId : rt.merchantId,
      playerId: typeof body.playerId === "string" ? body.playerId : rt.defaultPlayerId,
      amount,
    });
    reconciler.factsFor(intent.id).startedAt = new Date().toISOString();
    try {
      // Single shot. If the settlement leg throws after the bank debit was created, the intent stays where
      // it is with the error attached; retrying start() would debit the player a second time.
      await engine.start(intent.id);
      ctx.save();
      res.status(201).json(view(intent.id));
    } catch (err) {
      reconciler.recordError(intent.id, err);
      ctx.save();
      console.error(`[payments] ${intent.id} start failed at ${intent.status}:`, err instanceof Error ? err.message : err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err), payment: view(intent.id) });
    }
  });

  /**
   * Demo trigger for a post-settlement Reg E dispute (in production this arrives as an Astra chargeback webhook).
   * The settlement rail absorbs it on-chain when it can (reserve refills the treasury), then the engine books
   * CHARGEBACK_ABSORBED. The merchant's payout is never touched.
   */
  app.post("/api/payments/:id/dispute", async (req: Request, res: Response) => {
    const intent = engine.intents.get(String(req.params.id));
    if (!intent) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!DISPUTABLE.has(intent.status)) {
      res.status(409).json({ error: `payment is ${intent.status}; only a paid-out payment can be disputed`, payment: view(intent.id) });
      return;
    }
    try {
      let ref: string | undefined;
      let confirmedAt: string | undefined;
      const rail = engine.settlementRail;
      if (rail.absorbDispute) {
        const r = await rail.absorbDispute({ paymentIntentId: intent.id, merchantId: intent.merchantId, amount: intent.amount });
        ref = r.externalId;
        // Wait for the receipt (Monad: about a second) so the console shows a confirmed record, not a pending hash.
        let receipt = await readers.bridgeTransfer(ref);
        for (let i = 0; i < 20 && receipt.state === "in_review"; i++) {
          await new Promise((r) => setTimeout(r, 500));
          receipt = await readers.bridgeTransfer(ref);
        }
        if (receipt.state === "error") throw new Error(`dispute transaction reverted: ${ref}`);
        confirmedAt = (receipt as { confirmedAt?: string }).confirmedAt ?? new Date().toISOString();
      } else {
        ref = `mock_dispute_${intent.id}`;
        confirmedAt = new Date().toISOString();
      }
      reconciler.recordDispute(intent.id, { status: "lost", ref, confirmedAt });
      const applied = reconciler.reconcile(intent.id);
      ctx.save();
      console.log(`[dispute] ${intent.id} ref=${ref} applied=${applied.join(",") || "none"}`);
      res.status(200).json(view(intent.id));
    } catch (err) {
      reconciler.recordError(intent.id, err);
      ctx.save();
      console.error(`[dispute] ${intent.id} failed:`, err instanceof Error ? err.message : err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err), payment: view(intent.id) });
    }
  });

  app.get("/api/payments", (_req, res) => {
    const list = [...engine.intents.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((i) => view(i.id));
    res.json({ mode: rt.mode, merchantId: rt.merchantId, merchantName: rt.merchantName, payments: list });
  });

  app.get("/api/payments/:id", (req, res) => {
    const intent = engine.intents.get(req.params.id);
    if (!intent) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(view(intent.id));
  });

  // ---- merchant payout accounts (Privy-managed wallets, created server-side from an email) ----
  const accountView = (merchantId: string) => {
    const a = rt.payouts.get(merchantId);
    return a && { merchantId, email: a.email, address: a.address, privyWalletId: a.privyWalletId, provider: "privy", createdAt: a.createdAt };
  };

  app.post("/api/merchants/:id/payout-account", async (req: Request, res: Response) => {
    const merchantId = String(req.params.id);
    const email = String((req.body as { email?: unknown } | undefined)?.email ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    try {
      const { created } = await rt.payouts.ensure(merchantId, email, merchantId === rt.merchantId ? `${rt.merchantName} payouts` : undefined);
      console.log(`[payouts] ${merchantId} ${created ? "created" : "already had"} a payout account (${rt.payouts.privy.provider})`);
      res.status(created ? 201 : 200).json(accountView(merchantId));
    } catch (err) {
      console.error(`[payouts] ${merchantId} failed:`, err instanceof Error ? err.message : err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/merchants/:id", (req, res) => {
    const v = accountView(String(req.params.id));
    if (!v) {
      res.status(404).json({ error: "no payout account" });
      return;
    }
    res.json(v);
  });

  app.get("/api/ledger", (_req, res) => {
    res.json({ entries: [...engine.ledger].reverse() });
  });

  app.get("/api/summary", (_req, res) => {
    const intents = [...engine.intents.values()];
    res.json({
      operator: engine.summary(),
      counts: {
        payments: intents.length,
        paidOut: intents.filter((i) => ["settled", "replenished", "loss_absorbed", "charged_back"].includes(i.status)).length,
        inFlight: intents.filter((i) => ["created", "ach_initiated", "fronting", "holding"].includes(i.status)).length,
        returned: intents.filter((i) => i.status === "returned").length,
      },
    });
  });

  /** Operator console data: contracts, addresses, live balances. Chain vocabulary is allowed here. */
  app.get("/api/ops", async (_req, res) => {
    const account = rt.payouts.get(rt.merchantId);
    const payoutAccount = account
      ? { provider: rt.payouts.privy.provider, privyWalletId: account.privyWalletId, address: account.address, email: account.email, createdAt: account.createdAt, link: rt.chain?.addressUrl(account.address) ?? null }
      : null;
    const base = { mode: rt.mode, merchantId: rt.merchantId, merchantName: rt.merchantName, operator: engine.summary(), payoutAccount };
    if (!rt.chain) {
      res.json({ ...base, chain: null });
      return;
    }
    const d = rt.chain.deployment;
    try {
      const balances = await rt.chain.balances();
      res.json({
        ...base,
        chain: {
          chainId: d.chainId,
          explorerUrl: d.explorerUrl,
          settlement: d.settlement,
          testUsd: d.testUsd,
          treasury: d.treasury,
          merchant: rt.resolveMerchant(rt.merchantId),
          deployTxs: d.txs,
          links: { settlement: rt.chain.addressUrl(d.settlement), treasury: rt.chain.addressUrl(d.treasury), merchant: rt.chain.addressUrl(rt.resolveMerchant(rt.merchantId)) },
          balances,
        },
      });
    } catch (err) {
      res.status(502).json({ ...base, chain: { chainId: d.chainId, settlement: d.settlement, error: err instanceof Error ? err.message : String(err) } });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mode: rt.mode,
      startedAt: ctx.startedAt,
      lastWebhookAt: ctx.lastWebhookAt ?? null,
      webhooks: { handled: ctx.webhooksHandled, rejected: ctx.webhooksRejected },
      pollers: ctx.pollerTicks,
      payments: engine.intents.size,
    });
  });

  app.get("/merchant/setup", (_req, res) => {
    res.sendFile(fileURLToPath(new URL("../public/merchant-setup.html", import.meta.url)));
  });

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));

  return { app, ctx };
}
