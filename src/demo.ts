import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import dotenv from "dotenv";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader
} from "@okxweb3/x402-core/http";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import {
  buildReceipt,
  buildUnpaidReceipt,
  createHeroRouteDefinition,
  type HeroMode,
  type X402SellerReceipt,
  type X402SellerStatus,
  type X402SettlementState
} from "./index.js";

const TRACKED_ARTIFACT_BASE_DIR = "artifacts/hero-runs";
const PAYMENT_REQUIRED_HEADER_NAMES = [
  "payment-required",
  "PAYMENT-REQUIRED",
  "x-payment-required"
] as const;
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

type JsonRecord = Record<string, unknown>;

export type LiveRunStage =
  | "booting"
  | "seller_ready"
  | "unpaid_402_captured"
  | "awaiting_paid_retry"
  | "paid_request_seen"
  | "verify_captured"
  | "payment_response_captured"
  | "artifact_written"
  | "completed"
  | "rejected"
  | "timed_out";

export type RunDebugStateInput = {
  runId: string;
  stage: LiveRunStage;
  baseUrl: string;
  routePath: string;
  routeId: string;
  network: "eip155:196";
  payTo: string;
  assetSymbol: string;
  assetAddress: string;
  priceUsd: string;
  waitSeconds: number;
  protectedRequestCount: number;
  unpaidProbeSeen: boolean;
  paidRetrySeen: boolean;
  verifyTrace: JsonRecord | null;
  paymentResponseHeaderCaptured: boolean;
  finalHttpStatus: number | null;
  receipt: X402SellerReceipt | null;
  artifactPaths: {
    publicArtifactPath: string;
    rawArtifactPath: string;
  };
};

type DecodedSettlementResponse = {
  success: boolean;
  status?: "pending" | "success" | "timeout";
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
  errorReason?: string;
};

type VerifySettleTrace = {
  verify: JsonRecord | null;
  settlement: JsonRecord | null;
  capture: {
    paymentResponseHeaderCaptured: boolean;
    captureSource: "afterVerifyHook+paymentResponseHeader" | "afterVerifyHook" | "none";
    finalHttpStatus: number;
    notes: string[];
  };
};

export type RunManifest = {
  runId: string;
  mode: HeroMode;
  timestamp: string;
  gitCommit: string | null;
  network: "eip155:196";
  routeId: string;
  payTo: string;
  payer: string | null;
  status: X402SellerStatus;
  settlementState: X402SettlementState;
  publicArtifactPath: string;
  rawArtifactPath: string;
};

type RunPaths = {
  runDir: string;
  publicDir: string;
  latestPath: string;
  latestLocalPath: string;
};

type RunBundleInput = {
  baseDir: string;
  manifest: RunManifest;
  commandLog: string[];
  requestSummary: Record<string, unknown>;
  unpaidResponse: Record<string, unknown>;
  paidResponse: Record<string, unknown>;
  verifySettleTrace: VerifySettleTrace;
  receipt: X402SellerReceipt;
};

type FinalizeLiveReceiptInput = {
  runId: string;
  routeId: string;
  requestId: string;
  payTo: string;
  amount: string;
  assetAddress: string;
  assetSymbol: string;
  verifyTrace: JsonRecord | null;
  paymentResponseHeader: string | null;
  finalHttpStatus: number;
};

type CapturedResponseState = {
  paymentResponseHeader: string | null;
  responseBody: unknown;
  finalHeaders: Record<string, unknown>;
};

export type LiveHeroConfig = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  payTo: string;
  port: number;
  baseUrl: string;
  routePath: "/resource/sync";
  priceUsd: string;
  assetSymbol: string;
  assetAddress: string;
  waitSeconds: number;
};

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stageLabel(stage: LiveRunStage) {
  switch (stage) {
    case "booting":
      return "boot";
    case "seller_ready":
      return "ready";
    case "unpaid_402_captured":
      return "402";
    case "awaiting_paid_retry":
      return "wait";
    case "paid_request_seen":
      return "hit";
    case "verify_captured":
      return "verify";
    case "payment_response_captured":
      return "settlement";
    case "artifact_written":
      return "artifact";
    case "completed":
      return "done";
    case "rejected":
      return "reject";
    case "timed_out":
      return "timeout";
  }
}

function alignLabel(label: string) {
  return `${label}${" ".repeat(Math.max(1, 10 - label.length))}`;
}

function logStage(
  stage: LiveRunStage,
  message: string,
  details?: Record<string, unknown>
) {
  const prefix = `[${stageLabel(stage)}]`;
  console.log(`${prefix} ${message}`);

  if (!details || Object.keys(details).length === 0) {
    return;
  }

  for (const [key, value] of Object.entries(details)) {
    console.log(`  ${key}: ${String(value)}`);
  }
}

function toPosixPath(path: string) {
  return path.replace(/\\/g, "/");
}

function normalizeHeaderValue(
  value: number | string | readonly string[] | undefined
): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value) && value.length > 0) {
    return String(value[value.length - 1]);
  }

  return null;
}

function normalizeHeadersForArtifact(
  headers: Record<string, number | string | readonly string[] | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const headerValue = normalizeHeaderValue(value);
    if (headerValue !== null) {
      normalized[key] = headerValue;
    }
  }

  return normalized;
}

function getHeaderValue(
  headers: Record<string, unknown> | null | undefined,
  names: readonly string[]
): string | null {
  if (!headers) {
    return null;
  }

  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function extractString(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): string | null {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function decodeSettlementHeader(
  paymentResponseHeader: string | null
): DecodedSettlementResponse | null {
  if (!paymentResponseHeader) {
    return null;
  }

  try {
    return cloneJsonValue(
      decodePaymentResponseHeader(paymentResponseHeader)
    ) as DecodedSettlementResponse;
  } catch {
    return null;
  }
}

function summarizePaymentRequired(paymentRequiredHeader: string) {
  const decoded = cloneJsonValue(decodePaymentRequiredHeader(paymentRequiredHeader));
  const paymentRequired = decoded as Record<string, unknown>;

  return {
    x402Version:
      typeof paymentRequired.x402Version === "number"
        ? paymentRequired.x402Version
        : null,
    resource:
      (paymentRequired.resource as Record<string, unknown> | undefined) ?? null,
    accepts: Array.isArray(paymentRequired.accepts)
      ? (paymentRequired.accepts as unknown[])
      : []
  };
}

function getRunPaths(baseDir: string, runId: string): RunPaths {
  const runDir = join(baseDir, runId);
  return {
    runDir,
    publicDir: join(runDir, "public-safe"),
    latestPath: join(baseDir, "latest.json"),
    latestLocalPath: join(baseDir, "latest.local.json")
  };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string) {
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function createRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function getGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8"
    }).trim();
  } catch {
    return null;
  }
}

function buildProofSummary(manifest: RunManifest, receipt: X402SellerReceipt) {
  return [
    `# X402 Hero Run ${manifest.runId}`,
    "",
    `- Mode: ${manifest.mode}`,
    `- Status: ${receipt.status}`,
    `- Settlement State: ${receipt.settlementState}`,
    `- Route: ${receipt.routeId}`,
    `- Network: ${receipt.network}`,
    `- PayTo: ${receipt.payTo}`,
    `- Payer: ${receipt.payer ?? "unknown"}`,
    `- Tx: ${receipt.settlementTxHash ?? "none"}`,
    `- Explorer: ${receipt.explorerUrl ?? "none"}`,
    "",
    receipt.summary
  ].join("\n");
}

export function redactArtifactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactArtifactValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      /authorization|signature|certificate|session|x-payment|payment-header/i.test(
        key
      )
    ) {
      output[key] = "[REDACTED]";
      continue;
    }

    output[key] = redactArtifactValue(raw);
  }

  return output;
}

export function buildTrackedArtifactPaths(baseDir: string, runId: string) {
  const normalizedBaseDir = toPosixPath(baseDir).replace(/\/+$/, "");

  return {
    publicArtifactPath: `${normalizedBaseDir}/${runId}/public-safe`,
    rawArtifactPath: `${normalizedBaseDir}/${runId}`
  };
}

export function buildRunDebugSnapshot(input: RunDebugStateInput) {
  return {
    runId: input.runId,
    stage: input.stage,
    route: {
      id: input.routeId,
      url: `${input.baseUrl}${input.routePath}`
    },
    network: input.network,
    payment: {
      payTo: input.payTo,
      assetSymbol: input.assetSymbol,
      assetAddress: input.assetAddress,
      priceUsd: input.priceUsd
    },
    waitSeconds: input.waitSeconds,
    counters: {
      protectedRequestCount: input.protectedRequestCount,
      unpaidProbeSeen: input.unpaidProbeSeen,
      paidRetrySeen: input.paidRetrySeen
    },
    verify: input.verifyTrace
      ? {
          isValid:
            input.verifyTrace.isValid === true
              ? true
              : input.verifyTrace.verified === true
                ? true
                : null,
          payer: extractString(input.verifyTrace, ["payer"])
        }
      : null,
    settlement: {
      paymentResponseHeaderCaptured: input.paymentResponseHeaderCaptured,
      finalHttpStatus: input.finalHttpStatus
    },
    receipt: input.receipt,
    artifacts: input.artifactPaths
  };
}

export function formatTimeoutGuidance(input: RunDebugStateInput) {
  const snapshot = buildRunDebugSnapshot(input);

  return [
    "Timed out waiting for paid retry.",
    `runId: ${snapshot.runId}`,
    `stage: ${snapshot.stage}`,
    `route: ${snapshot.route.url}`,
    `debug: ${input.baseUrl}/debug/run`,
    `publicArtifactPath: ${snapshot.artifacts.publicArtifactPath}`,
    "nextStep: trigger the paid retry against the same seller URL before the timeout window ends"
  ].join("\n");
}

export function formatLiveRunBanner(input: RunDebugStateInput) {
  const routeUrl = `${input.baseUrl}${input.routePath}`;

  return [
    "========================================",
    "x402-paywall-skill :: live seller",
    "========================================",
    `${alignLabel("runId")}${input.runId}`,
    `${alignLabel("route")}${routeUrl}`,
    `${alignLabel("routeId")}${input.routeId}`,
    `${alignLabel("network")}${input.network}`,
    `${alignLabel("payTo")}${input.payTo}`,
    `${alignLabel("asset")}${input.assetSymbol} (${input.assetAddress})`,
    `${alignLabel("price")}${input.priceUsd}`,
    `${alignLabel("timeout")}${input.waitSeconds}s`,
    `${alignLabel("debug")}${input.baseUrl}/debug/run`,
    `${alignLabel("artifacts")}${input.artifactPaths.publicArtifactPath}`,
    "----------------------------------------"
  ].join("\n");
}

export function formatCompletionSummary(input: RunDebugStateInput) {
  const receipt = input.receipt;

  return [
    "========================================",
    "proof recap",
    "========================================",
    `${alignLabel("runId")}${input.runId}`,
    `${alignLabel("status")}${receipt?.status ?? "unknown"}`,
    `${alignLabel("settlement")}${receipt?.settlementState ?? "null"}`,
    `${alignLabel("payer")}${receipt?.payer ?? "unknown"}`,
    `${alignLabel("tx")}${receipt?.settlementTxHash ?? "none"}`,
    `${alignLabel("debug")}${input.baseUrl}/debug/run`,
    `${alignLabel("artifacts")}${input.artifactPaths.publicArtifactPath}`,
    "----------------------------------------"
  ].join("\n");
}

function logStartupBanner(input: RunDebugStateInput) {
  console.log(formatLiveRunBanner(input));
}

export function buildPublicSafeUnpaidArtifact(
  unpaidResponse: Record<string, unknown>
) {
  const paymentRequiredHeader = getHeaderValue(
    (unpaidResponse.headers as Record<string, unknown> | undefined) ?? null,
    PAYMENT_REQUIRED_HEADER_NAMES
  );

  const publicArtifact: Record<string, unknown> = {
    status:
      typeof unpaidResponse.status === "number" ? unpaidResponse.status : null,
    body: unpaidResponse.body ?? null,
    receipt: unpaidResponse.receipt ?? null
  };

  if (paymentRequiredHeader) {
    publicArtifact.paymentRequired = summarizePaymentRequired(paymentRequiredHeader);
  }

  return publicArtifact;
}

function buildPublicSafePaidArtifact(paidResponse: Record<string, unknown>) {
  return {
    status: typeof paidResponse.status === "number" ? paidResponse.status : null,
    body: redactArtifactValue(paidResponse.body ?? null)
  };
}

function buildVerifySettleTrace(input: {
  verifyTrace: JsonRecord | null;
  paymentResponseHeader: string | null;
  finalHttpStatus: number;
}): VerifySettleTrace {
  const settlement = decodeSettlementHeader(input.paymentResponseHeader);
  const notes: string[] = [];

  if (!input.verifyTrace) {
    notes.push("No verify trace captured from resourceServer.onAfterVerify");
  }

  if (!input.paymentResponseHeader) {
    notes.push("No PAYMENT-RESPONSE header captured from final response");
  } else if (!settlement) {
    notes.push("PAYMENT-RESPONSE header was captured but could not be decoded");
  }

  if (input.finalHttpStatus >= 400) {
    notes.push(`Final HTTP status was ${input.finalHttpStatus}`);
  }

  return {
    verify: input.verifyTrace ? cloneJsonValue(input.verifyTrace) : null,
    settlement,
    capture: {
      paymentResponseHeaderCaptured: Boolean(input.paymentResponseHeader),
      captureSource:
        input.verifyTrace && settlement
          ? "afterVerifyHook+paymentResponseHeader"
          : input.verifyTrace
            ? "afterVerifyHook"
            : "none",
      finalHttpStatus: input.finalHttpStatus,
      notes
    }
  };
}

export function deriveSettlementState(
  trace: Record<string, unknown> | null
): X402SettlementState {
  if (!trace) {
    return "verified_only";
  }

  const txHash = extractString(trace, [
    "txHash",
    "settlementTxHash",
    "transaction"
  ]);

  if (txHash) {
    return "settled_onchain";
  }

  const status = extractString(trace, ["status"]);
  if (status === "pending" || status === "timeout") {
    return "settlement_pending";
  }

  if (trace.pending === true || trace.settlementPending === true) {
    return "settlement_pending";
  }

  return "verified_only";
}

function buildLiveSummary(
  status: X402SellerStatus,
  settlementState: X402SettlementState
) {
  if (status === "rejected") {
    return "Live payment was rejected before usable settlement proof was captured";
  }

  if (settlementState === "settled_onchain") {
    return "Live seller proof captured from verify and PAYMENT-RESPONSE settlement evidence";
  }

  if (settlementState === "settlement_pending") {
    return "Live payment verified and settlement is pending according to PAYMENT-RESPONSE";
  }

  return "Live verification succeeded; settlement evidence not yet confirmed for /resource/sync";
}

export function finalizeLiveReceipt(
  input: FinalizeLiveReceiptInput
): X402SellerReceipt {
  const settlement = decodeSettlementHeader(input.paymentResponseHeader);
  const settlementTxHash = extractString(settlement, ["transaction"]);
  const payer =
    extractString(settlement, ["payer"]) ??
    extractString(input.verifyTrace, ["payer"]);

  if (input.finalHttpStatus >= 400) {
    return buildReceipt({
      runId: input.runId,
      routeId: input.routeId,
      mode: "live",
      status: "rejected",
      settlementState: null,
      payTo: input.payTo,
      payer,
      requestId: input.requestId,
      scheme: "exact",
      amount: input.amount,
      assetAddress: input.assetAddress,
      assetSymbol: input.assetSymbol,
      invalidReason:
        extractString(settlement, ["errorReason", "reason", "message"]) ??
        `Final HTTP status ${input.finalHttpStatus}`,
      summary: buildLiveSummary("rejected", null)
    });
  }

  let status: X402SellerStatus = "pending";
  let settlementState: X402SettlementState = "verified_only";

  if (settlement?.success === true) {
    if (settlement.status === "pending" || settlement.status === "timeout") {
      settlementState = "settlement_pending";
    } else if (settlementTxHash) {
      status = "settled";
      settlementState = "settled_onchain";
    }
  }

  return buildReceipt({
    runId: input.runId,
    routeId: input.routeId,
    mode: "live",
    status,
    settlementState,
    payTo: input.payTo,
    payer,
    requestId: input.requestId,
    scheme: "exact",
    amount: input.amount,
    assetAddress: input.assetAddress,
    assetSymbol: input.assetSymbol,
    settlementTxHash,
    summary: buildLiveSummary(status, settlementState)
  });
}

async function writeRunBundle(input: RunBundleInput) {
  const paths = getRunPaths(input.baseDir, input.manifest.runId);

  await mkdir(paths.runDir, { recursive: true });
  await mkdir(paths.publicDir, { recursive: true });

  await writeJson(join(paths.runDir, "manifest.json"), input.manifest);
  await writeText(join(paths.runDir, "command-log.txt"), input.commandLog.join("\n"));
  await writeJson(join(paths.runDir, "request-summary.json"), input.requestSummary);
  await writeJson(join(paths.runDir, "unpaid-response.json"), input.unpaidResponse);
  await writeJson(join(paths.runDir, "paid-response.json"), input.paidResponse);
  await writeJson(join(paths.runDir, "verify-settle-trace.json"), input.verifySettleTrace);
  await writeJson(join(paths.runDir, "normalized-receipt.json"), input.receipt);
  await writeText(
    join(paths.runDir, "proof-summary.md"),
    buildProofSummary(input.manifest, input.receipt)
  );

  await writeJson(
    join(paths.publicDir, "manifest.json"),
    redactArtifactValue(input.manifest)
  );
  await writeText(join(paths.publicDir, "command-log.txt"), input.commandLog.join("\n"));
  await writeJson(
    join(paths.publicDir, "request-summary.json"),
    redactArtifactValue(input.requestSummary)
  );
  await writeJson(
    join(paths.publicDir, "unpaid-response.json"),
    buildPublicSafeUnpaidArtifact(input.unpaidResponse)
  );
  await writeJson(
    join(paths.publicDir, "paid-response.json"),
    buildPublicSafePaidArtifact(input.paidResponse)
  );
  await writeJson(
    join(paths.publicDir, "verify-settle-trace.json"),
    redactArtifactValue(input.verifySettleTrace)
  );
  await writeJson(
    join(paths.publicDir, "normalized-receipt.json"),
    redactArtifactValue(input.receipt)
  );
  await writeText(
    join(paths.publicDir, "proof-summary.md"),
    buildProofSummary(input.manifest, input.receipt)
  );

  await writeJson(paths.latestPath, input.manifest);
  await writeJson(paths.latestLocalPath, {
    ...input.manifest,
    publicArtifactPath: toPosixPath(paths.publicDir),
    rawArtifactPath: toPosixPath(paths.runDir)
  });
}

export async function runFallbackHero(input?: {
  baseDir?: string;
  now?: Date;
  gitCommit?: string | null;
}) {
  const now = input?.now ?? new Date();
  const runId = createRunId(now);
  const baseDir = resolve(input?.baseDir ?? TRACKED_ARTIFACT_BASE_DIR);
  const trackedPaths = buildTrackedArtifactPaths(TRACKED_ARTIFACT_BASE_DIR, runId);
  const payTo = "0x1111111111111111111111111111111111111111";
  const route = createHeroRouteDefinition({
    payTo,
    assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736"
  });
  const requestId = `${route.routeId}-${runId}`;

  const unpaidReceipt = buildUnpaidReceipt({
    runId,
    mode: "fallback",
    routeId: route.routeId,
    requestId,
    payTo: route.payTo,
    assetAddress: route.assetAddress,
    assetSymbol: route.assetSymbol,
    amount: route.price,
    scheme: "exact"
  });

  const receipt = buildReceipt({
    runId,
    routeId: route.routeId,
    mode: "fallback",
    status: "settled",
    settlementState: "fallback_local",
    payTo: route.payTo,
    payer: "0xfallbackpayer000000000000000000000000000001",
    requestId,
    scheme: "exact",
    amount: route.price,
    assetAddress: route.assetAddress,
    assetSymbol: route.assetSymbol,
    summary: "Fallback local proof completed for /resource/sync"
  });

  const manifest: RunManifest = {
    runId,
    mode: "fallback",
    timestamp: now.toISOString(),
    gitCommit: input?.gitCommit ?? getGitCommit(),
    network: "eip155:196",
    routeId: route.routeId,
    payTo: route.payTo,
    payer: receipt.payer,
    status: receipt.status,
    settlementState: receipt.settlementState,
    ...trackedPaths
  };

  await writeRunBundle({
    baseDir,
    manifest,
    commandLog: ["pnpm hero:fallback", "fallback artifact capture complete"],
    requestSummary: route,
    unpaidResponse: {
      status: 402,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "payment-required": encodePaymentRequiredHeader({
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: "http://127.0.0.1:4000/resource/sync",
            description: route.description,
            mimeType: route.mimeType
          },
          accepts: [
            {
              scheme: "exact",
              network: route.network,
              amount: "1000",
              asset: route.assetAddress,
              payTo: route.payTo,
              maxTimeoutSeconds: route.maxTimeoutSeconds,
              extra: {
                name: route.assetSymbol,
                version: "1"
              }
            }
          ]
        })
      },
      body: {},
      receipt: unpaidReceipt
    },
    paidResponse: {
      status: 200,
      body: {
        ok: true,
        routeId: route.routeId,
        resource: "fallback premium payload"
      }
    },
    verifySettleTrace: {
      verify: {
        mode: "fallback",
        verified: true,
        payer: receipt.payer
      },
      settlement: null,
      capture: {
        paymentResponseHeaderCaptured: false,
        captureSource: "none",
        finalHttpStatus: 200,
        notes: ["Fallback local mode; no OKX settlement header is expected"]
      }
    },
    receipt
  });

  return { runId, manifest, receipt };
}

export function assertLivePreflight(
  env: Record<string, string | undefined>
): LiveHeroConfig {
  const required = [
    "OKX_API_KEY",
    "OKX_SECRET_KEY",
    "OKX_PASSPHRASE",
    "PAY_TO_ADDRESS"
  ] as const;

  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required env: ${key}`);
    }
  }

  return {
    apiKey: env.OKX_API_KEY!,
    secretKey: env.OKX_SECRET_KEY!,
    passphrase: env.OKX_PASSPHRASE!,
    payTo: env.PAY_TO_ADDRESS!,
    port: Number(env.HERO_PORT ?? "4000"),
    baseUrl: env.HERO_BASE_URL ?? "http://127.0.0.1:4000",
    routePath: "/resource/sync",
    priceUsd: env.HERO_PRICE_USD ?? "$0.01",
    assetSymbol: env.HERO_ASSET_SYMBOL ?? "USDT",
    assetAddress:
      env.HERO_ASSET_ADDRESS ??
      "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    waitSeconds: Number(env.HERO_WAIT_FOR_PAID_SECONDS ?? "180")
  };
}

export async function runLiveHero(input?: {
  baseDir?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  gitCommit?: string | null;
}) {
  const env = input?.env ?? process.env;
  const config = assertLivePreflight(env);
  const now = input?.now ?? new Date();
  const runId = createRunId(now);
  const baseDir = resolve(input?.baseDir ?? TRACKED_ARTIFACT_BASE_DIR);
  const trackedPaths = buildTrackedArtifactPaths(TRACKED_ARTIFACT_BASE_DIR, runId);
  const route = createHeroRouteDefinition({
    payTo: config.payTo,
    assetAddress: config.assetAddress,
    assetSymbol: config.assetSymbol,
    price: config.priceUsd
  });
  const requestId = `${route.routeId}-${runId}`;
  const debugState: RunDebugStateInput = {
    runId,
    stage: "booting",
    baseUrl: config.baseUrl,
    routePath: config.routePath,
    routeId: route.routeId,
    network: route.network,
    payTo: route.payTo,
    assetSymbol: route.assetSymbol,
    assetAddress: route.assetAddress,
    priceUsd: route.price,
    waitSeconds: config.waitSeconds,
    protectedRequestCount: 0,
    unpaidProbeSeen: false,
    paidRetrySeen: false,
    verifyTrace: null,
    paymentResponseHeaderCaptured: false,
    finalHttpStatus: null,
    receipt: null,
    artifactPaths: trackedPaths
  };

  const commandLog = ["pnpm hero:live", `baseUrl=${config.baseUrl}`];
  const app = express();
  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: config.apiKey,
    secretKey: config.secretKey,
    passphrase: config.passphrase,
    syncSettle: true
  });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(route.network, new ExactEvmScheme());

  let lastVerifyTrace: JsonRecord | null = null;
  resourceServer.onAfterVerify(async (ctx) => {
    lastVerifyTrace = cloneJsonValue(
      (ctx.result ?? {}) as Record<string, unknown>
    ) as JsonRecord;
    debugState.verifyTrace = lastVerifyTrace;
    debugState.stage = "verify_captured";
    logStage("verify_captured", "Verification evidence captured", {
      payer: extractString(lastVerifyTrace, ["payer"]) ?? "unknown",
      isValid:
        lastVerifyTrace.isValid === true || lastVerifyTrace.verified === true
          ? "true"
          : "unknown"
    });
  });

  const routes = {
    [`${route.method} ${route.path}`]: {
      accepts: [
        {
          scheme: "exact",
          network: route.network,
          payTo: route.payTo,
          price: route.price,
          maxTimeoutSeconds: route.maxTimeoutSeconds
        }
      ],
      description: route.description,
      mimeType: route.mimeType
    }
  };

  let unpaidArtifact: Record<string, unknown> = {
    note: "Unpaid probe has not executed yet"
  };
  let captureEnabled = false;
  let liveAttemptSettled = false;

  let paidResolver:
    | ((value: {
        runId: string;
        manifest: RunManifest;
        receipt: X402SellerReceipt;
      }) => void)
    | null = null;
  let paidRejecter: ((reason?: unknown) => void) | null = null;

  const paidPromise = new Promise<{
    runId: string;
    manifest: RunManifest;
    receipt: X402SellerReceipt;
  }>((resolve, reject) => {
    paidResolver = resolve;
    paidRejecter = reject;
  });

  app.get("/debug/run", (_req, res) => {
    res.json(buildRunDebugSnapshot(debugState));
  });

  app.use((req, res, next) => {
    if (req.method !== route.method || req.path !== route.path) {
      next();
      return;
    }

    const captured: CapturedResponseState = {
      paymentResponseHeader: null,
      responseBody: null,
      finalHeaders: {}
    };
    debugState.protectedRequestCount += 1;
    debugState.paidRetrySeen = captureEnabled;
    debugState.stage = captureEnabled ? "paid_request_seen" : "unpaid_402_captured";
    logStage(
      captureEnabled ? "paid_request_seen" : "unpaid_402_captured",
      captureEnabled
        ? "Protected route requested after unpaid probe"
        : "Protected route requested before payment; seller will return 402",
      {
        method: req.method,
        path: req.path,
        requestCount: debugState.protectedRequestCount
      }
    );

    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (name.toUpperCase() === PAYMENT_RESPONSE_HEADER) {
        captured.paymentResponseHeader = normalizeHeaderValue(value);
        debugState.paymentResponseHeaderCaptured = Boolean(captured.paymentResponseHeader);
        debugState.stage = "payment_response_captured";
        logStage("payment_response_captured", "Captured PAYMENT-RESPONSE header", {
          captured: debugState.paymentResponseHeaderCaptured
        });
      }

      return originalSetHeader(name, value);
    }) as typeof res.setHeader;

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      captured.responseBody = body;
      return originalJson(body);
    }) as typeof res.json;

    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      if (captured.responseBody === null || captured.responseBody === undefined) {
        captured.responseBody = body;
      }

      return originalSend(body);
    }) as typeof res.send;

    res.once("finish", () => {
      const verifyTrace = lastVerifyTrace ? cloneJsonValue(lastVerifyTrace) : null;
      const shouldFinalize =
        captureEnabled &&
        !liveAttemptSettled &&
        (captured.paymentResponseHeader !== null ||
          verifyTrace !== null ||
          res.statusCode !== 402);

      if (!shouldFinalize) {
        return;
      }

      liveAttemptSettled = true;
      captured.finalHeaders = normalizeHeadersForArtifact(
        res.getHeaders() as Record<
          string,
          number | string | readonly string[] | undefined
        >
      );
      debugState.finalHttpStatus = res.statusCode;

      void (async () => {
        const receipt = finalizeLiveReceipt({
          runId,
          routeId: route.routeId,
          requestId,
          payTo: route.payTo,
          amount: route.price,
          assetAddress: route.assetAddress,
          assetSymbol: route.assetSymbol,
          verifyTrace,
          paymentResponseHeader: captured.paymentResponseHeader,
          finalHttpStatus: res.statusCode
        });
        debugState.receipt = receipt;
        const manifest: RunManifest = {
          runId,
          mode: "live",
          timestamp: now.toISOString(),
          gitCommit: input?.gitCommit ?? getGitCommit(),
          network: route.network,
          routeId: route.routeId,
          payTo: route.payTo,
          payer: receipt.payer,
          status: receipt.status,
          settlementState: receipt.settlementState,
          ...trackedPaths
        };

        commandLog.push(`paid_status=${res.statusCode}`);
        commandLog.push(
          `payment_response_header_captured=${
            captured.paymentResponseHeader ? "true" : "false"
          }`
        );

        await writeRunBundle({
          baseDir,
          manifest,
          commandLog,
          requestSummary: route,
          unpaidResponse: unpaidArtifact,
          paidResponse: {
            status: res.statusCode,
            headers: captured.finalHeaders,
            body: captured.responseBody
          },
          verifySettleTrace: buildVerifySettleTrace({
            verifyTrace,
            paymentResponseHeader: captured.paymentResponseHeader,
            finalHttpStatus: res.statusCode
          }),
          receipt
        });
        debugState.stage = "artifact_written";
        logStage("artifact_written", "Run artifacts written", {
          settlementState: receipt.settlementState ?? "null",
          status: receipt.status,
          publicArtifactPath: manifest.publicArtifactPath
        });

        if (receipt.status === "rejected") {
          debugState.stage = "rejected";
          logStage("rejected", "Paid retry was rejected", {
            settlementState: receipt.settlementState ?? "null",
            invalidReason: receipt.invalidReason ?? "unknown"
          });
          paidRejecter?.(
            new Error(`Paid retry was rejected; see ${manifest.publicArtifactPath}`)
          );
          return;
        }

        debugState.stage = "completed";
        logStage("completed", "Live seller proof completed", {
          status: receipt.status,
          settlementState: receipt.settlementState ?? "null",
          tx: receipt.settlementTxHash ?? "none"
        });
        console.log(formatCompletionSummary(debugState));
        paidResolver?.({ runId, manifest, receipt });
      })().catch((error) => {
        paidRejecter?.(error);
      });
    });

    next();
  });

  app.use(paymentMiddleware(routes, resourceServer));
  app.get(route.path, async (_req, res) => {
    res.json({
      ok: true,
      routeId: route.routeId,
      resource: "premium X Layer seller payload"
    });
  });

  const server = app.listen(config.port);

  try {
    await new Promise<void>((resolvePromise) => {
      server.once("listening", () => resolvePromise());
    });
    await resourceServer.initialize();
    debugState.stage = "seller_ready";
    logStartupBanner(debugState);
    logStage("seller_ready", "Seller is listening and facilitator support is initialized", {
      route: `${config.baseUrl}${config.routePath}`,
      debug: `${config.baseUrl}/debug/run`
    });

    const unpaidResponse = await fetch(`${config.baseUrl}${config.routePath}`);
    const unpaidText = await unpaidResponse.text();

    let unpaidBody: unknown = null;
    if (unpaidText) {
      try {
        unpaidBody = JSON.parse(unpaidText);
      } catch {
        unpaidBody = unpaidText;
      }
    }

    unpaidArtifact = {
      status: unpaidResponse.status,
      headers: Object.fromEntries(unpaidResponse.headers.entries()),
      body: unpaidBody,
      receipt: buildUnpaidReceipt({
        runId,
        mode: "live",
        routeId: route.routeId,
        requestId,
        payTo: route.payTo,
        assetAddress: route.assetAddress,
        assetSymbol: route.assetSymbol,
        amount: route.price,
        scheme: "exact"
      })
    };
    commandLog.push(`unpaid_status=${unpaidResponse.status}`);

    if (unpaidResponse.status !== 402) {
      throw new Error(`Expected unpaid 402, received ${unpaidResponse.status}`);
    }

    captureEnabled = true;
    debugState.unpaidProbeSeen = true;
    debugState.stage = "awaiting_paid_retry";
    logStage("unpaid_402_captured", "Unpaid probe returned 402 Payment Required", {
      route: `${config.baseUrl}${config.routePath}`,
      payTo: route.payTo,
      asset: `${route.assetSymbol} (${route.assetAddress})`
    });
    logStage("awaiting_paid_retry", "Waiting for paid retry from Agentic Wallet / Onchain OS", {
      route: `${config.baseUrl}${config.routePath}`,
      waitSeconds: config.waitSeconds,
      debug: `${config.baseUrl}/debug/run`
    });

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        debugState.stage = "timed_out";
        logStage("timed_out", "No paid retry arrived before timeout", {
          debug: `${config.baseUrl}/debug/run`,
          route: `${config.baseUrl}${config.routePath}`
        });
        reject(new Error(formatTimeoutGuidance(debugState)));
      }, config.waitSeconds * 1000);
    });

    return await Promise.race([paidPromise, timeout]);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise();
      });
    });
  }
}

function parseMode(argv: string[]): HeroMode {
  if (argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "live") {
    return "live";
  }

  const modeArg = argv.find((value) => value.startsWith("--mode="));
  if (modeArg === "--mode=live") {
    return "live";
  }

  return "fallback";
}

async function main() {
  dotenv.config();

  const mode = parseMode(process.argv.slice(2));
  if (mode === "fallback") {
    const result = await runFallbackHero();
    console.log(
      JSON.stringify(
        {
          mode,
          runId: result.runId,
          artifactPath: result.manifest.publicArtifactPath,
          settlementState: result.receipt.settlementState
        },
        null,
        2
      )
    );
    return;
  }

  const result = await runLiveHero();
  console.log(
    JSON.stringify(
      {
        mode,
        runId: result.runId,
        artifactPath: result.manifest.publicArtifactPath,
        settlementState: result.receipt.settlementState
      },
      null,
      2
    )
  );
}

const entryFile = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFile = fileURLToPath(import.meta.url);

if (entryFile && existsSync(entryFile) && currentFile === entryFile) {
  void main();
}
