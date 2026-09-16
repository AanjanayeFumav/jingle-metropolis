/**
 * The Express app: Astra webhook receiver, payment API, merchant view. Built as a function so tests can
 * run it on port 0 with a mock runtime. server.ts is the one-command entrypoint.
 */
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import type { AstraTransfer } from "../../../packages/astra/src/client.js";
import { verifyAstraSignature } from "./astra-verify.js";
import { saveSnapshot } from "./store.js";
import { toView } from "./view.js";
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

async function readRawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export function createApp(rt: Runtime, opts: AppOptions): { app: express.Express; ctx: AppContext } {
  const { engine, reconciler, readers } = rt;
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
    const body = (req.body ?? {}) as { amount?: unknown; merchantId?: unknown; playerId?: unknown };
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
      res.status(201).json(toView(intent, reconciler.facts.get(intent.id)));
    } catch (err) {
      reconciler.recordError(intent.id, err);
      ctx.save();
      console.error(`[payments] ${intent.id} start failed at ${intent.status}:`, err instanceof Error ? err.message : err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err), payment: toView(intent, reconciler.facts.get(intent.id)) });
    }
  });

  app.get("/api/payments", (_req, res) => {
    const list = [...engine.intents.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((i) => toView(i, reconciler.facts.get(i.id)));
    res.json({ mode: rt.mode, payments: list });
  });

  app.get("/api/payments/:id", (req, res) => {
    const intent = engine.intents.get(req.params.id);
    if (!intent) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(toView(intent, reconciler.facts.get(intent.id)));
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

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  return { app, ctx };
}
