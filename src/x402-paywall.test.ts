import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader
} from "@okxweb3/x402-core/http";
import { describe, expect, it } from "vitest";

import {
  buildReceipt,
  buildUnpaidReceipt,
  buildExplorerUrl,
  createHeroRouteDefinition
} from "./index.js";
import {
  assertLivePreflight,
  buildRunDebugSnapshot,
  buildPublicSafeUnpaidArtifact,
  buildTrackedArtifactPaths,
  deriveSettlementState,
  formatCompletionSummary,
  formatLiveRunBanner,
  formatTimeoutGuidance,
  finalizeLiveReceipt,
  redactArtifactValue,
  runFallbackHero
} from "./demo.js";

describe("x402-paywall-skill seller contract", () => {
  it("creates the one allowed hero route definition", () => {
    const route = createHeroRouteDefinition({
      payTo: "0x1111111111111111111111111111111111111111",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736"
    });

    expect(route.path).toBe("/resource/sync");
  });

  it("builds the unpaid 402 receipt with no settlement state", () => {
    const receipt = buildUnpaidReceipt({
      runId: "run-001",
      mode: "live",
      routeId: "resource-sync",
      requestId: "req-001",
      payTo: "0x1111111111111111111111111111111111111111",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      assetSymbol: "USDT",
      amount: "$0.01",
      scheme: "exact"
    });

    expect(receipt.status).toBe("required");
    expect(receipt.settlementState).toBeNull();
  });

  it("builds a rejected receipt with null settlement state", () => {
    const receipt = buildReceipt({
      runId: "run-002",
      routeId: "resource-sync",
      mode: "live",
      status: "rejected",
      settlementState: null,
      payTo: "0x1111111111111111111111111111111111111111",
      payer: null,
      requestId: "req-002",
      invalidReason: "signature mismatch",
      summary: "Payment rejected for /resource/sync"
    });

    expect(receipt.invalidReason).toBe("signature mismatch");
  });

  it("derives settled_onchain from a trace with txHash", () => {
    expect(
      deriveSettlementState({
        txHash: "0xabc123"
      })
    ).toBe("settled_onchain");
  });

  it("derives settlement_pending from a pending trace", () => {
    expect(
      deriveSettlementState({
        pending: true
      })
    ).toBe("settlement_pending");
  });

  it("derives verified_only when verification succeeded but tx evidence is absent", () => {
    expect(
      deriveSettlementState({
        isValid: true
      })
    ).toBe("verified_only");
  });

  it("fails fast when OKX_API_KEY is missing", () => {
    expect(() =>
      assertLivePreflight({
        OKX_SECRET_KEY: "secret",
        OKX_PASSPHRASE: "pass",
        PAY_TO_ADDRESS: "0x1111111111111111111111111111111111111111"
      })
    ).toThrow("Missing required env: OKX_API_KEY");
  });

  it("redacts reusable payment material from public-safe artifacts", () => {
    const redacted = redactArtifactValue({
      headers: {
        "x-payment": "abc",
        "x-session-certificate": "secret"
      },
      payload: {
        authorization: {
          signature: "0xsig"
        }
      }
    });

    expect(redacted).toEqual({
      headers: {
        "x-payment": "[REDACTED]",
        "x-session-certificate": "[REDACTED]"
      },
      payload: {
        authorization: "[REDACTED]"
      }
    });
  });

  it("creates repo-relative tracked artifact paths", () => {
    expect(buildTrackedArtifactPaths("artifacts/hero-runs", "run-123")).toEqual({
      publicArtifactPath: "artifacts/hero-runs/run-123/public-safe",
      rawArtifactPath: "artifacts/hero-runs/run-123"
    });
  });

  it("summarizes PAYMENT-REQUIRED for public-safe unpaid artifacts", () => {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "http://127.0.0.1:4000/resource/sync",
        description: "Paid X Layer resource sync",
        mimeType: "application/json"
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:196",
          amount: "1000",
          asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
          extra: {
            name: "USDT",
            version: "1"
          }
        }
      ]
    });

    const artifact = buildPublicSafeUnpaidArtifact({
      status: 402,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "payment-required": header
      },
      body: {},
      receipt: {
        status: "required"
      }
    });

    expect(JSON.stringify(artifact)).not.toContain(header);
    expect(artifact).toEqual({
      status: 402,
      paymentRequired: {
        x402Version: 2,
        resource: {
          url: "http://127.0.0.1:4000/resource/sync",
          description: "Paid X Layer resource sync",
          mimeType: "application/json"
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:196",
            amount: "1000",
            asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 300,
            extra: {
              name: "USDT",
              version: "1"
            }
          }
        ]
      },
      body: {},
      receipt: {
        status: "required"
      }
    });
  });

  it("builds a video-friendly debug snapshot for the current hero run", () => {
    const snapshot = buildRunDebugSnapshot({
      runId: "run-live-001",
      stage: "awaiting_paid_retry",
      baseUrl: "http://127.0.0.1:4000",
      routePath: "/resource/sync",
      routeId: "resource-sync",
      network: "eip155:196",
      payTo: "0x1111111111111111111111111111111111111111",
      assetSymbol: "USDT",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      priceUsd: "$0.01",
      waitSeconds: 600,
      protectedRequestCount: 1,
      unpaidProbeSeen: true,
      paidRetrySeen: false,
      verifyTrace: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      paymentResponseHeaderCaptured: false,
      finalHttpStatus: null,
      receipt: null,
      artifactPaths: {
        publicArtifactPath: "artifacts/hero-runs/run-live-001/public-safe",
        rawArtifactPath: "artifacts/hero-runs/run-live-001"
      }
    });

    expect(snapshot).toEqual({
      runId: "run-live-001",
      stage: "awaiting_paid_retry",
      route: {
        id: "resource-sync",
        url: "http://127.0.0.1:4000/resource/sync"
      },
      network: "eip155:196",
      payment: {
        payTo: "0x1111111111111111111111111111111111111111",
        assetSymbol: "USDT",
        assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        priceUsd: "$0.01"
      },
      waitSeconds: 600,
      counters: {
        protectedRequestCount: 1,
        unpaidProbeSeen: true,
        paidRetrySeen: false
      },
      verify: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      settlement: {
        paymentResponseHeaderCaptured: false,
        finalHttpStatus: null
      },
      receipt: null,
      artifacts: {
        publicArtifactPath: "artifacts/hero-runs/run-live-001/public-safe",
        rawArtifactPath: "artifacts/hero-runs/run-live-001"
      }
    });
  });

  it("formats timeout guidance with next steps and debug endpoint", () => {
    const guidance = formatTimeoutGuidance({
      runId: "run-live-001",
      stage: "awaiting_paid_retry",
      baseUrl: "http://127.0.0.1:4000",
      routePath: "/resource/sync",
      routeId: "resource-sync",
      network: "eip155:196",
      payTo: "0x1111111111111111111111111111111111111111",
      assetSymbol: "USDT",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      priceUsd: "$0.01",
      waitSeconds: 600,
      protectedRequestCount: 0,
      unpaidProbeSeen: true,
      paidRetrySeen: false,
      verifyTrace: null,
      paymentResponseHeaderCaptured: false,
      finalHttpStatus: null,
      receipt: null,
      artifactPaths: {
        publicArtifactPath: "artifacts/hero-runs/run-live-001/public-safe",
        rawArtifactPath: "artifacts/hero-runs/run-live-001"
      }
    });

    expect(guidance).toContain("Timed out waiting for paid retry");
    expect(guidance).toContain("run-live-001");
    expect(guidance).toContain("http://127.0.0.1:4000/debug/run");
    expect(guidance).toContain("http://127.0.0.1:4000/resource/sync");
    expect(guidance).toContain("artifacts/hero-runs/run-live-001/public-safe");
  });

  it("formats a live-run banner for video-friendly startup output", () => {
    const banner = formatLiveRunBanner({
      runId: "run-live-001",
      stage: "seller_ready",
      baseUrl: "http://127.0.0.1:4000",
      routePath: "/resource/sync",
      routeId: "resource-sync",
      network: "eip155:196",
      payTo: "0x1111111111111111111111111111111111111111",
      assetSymbol: "USDT",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      priceUsd: "$0.01",
      waitSeconds: 900,
      protectedRequestCount: 0,
      unpaidProbeSeen: false,
      paidRetrySeen: false,
      verifyTrace: null,
      paymentResponseHeaderCaptured: false,
      finalHttpStatus: null,
      receipt: null,
      artifactPaths: {
        publicArtifactPath: "artifacts/hero-runs/run-live-001/public-safe",
        rawArtifactPath: "artifacts/hero-runs/run-live-001"
      }
    });

    expect(banner).toContain("x402-paywall-skill :: live seller");
    expect(banner).toContain("runId     run-live-001");
    expect(banner).toContain("route     http://127.0.0.1:4000/resource/sync");
    expect(banner).toContain("debug     http://127.0.0.1:4000/debug/run");
  });

  it("formats a final proof summary from the normalized receipt", () => {
    const summary = formatCompletionSummary({
      runId: "run-live-001",
      stage: "completed",
      baseUrl: "http://127.0.0.1:4000",
      routePath: "/resource/sync",
      routeId: "resource-sync",
      network: "eip155:196",
      payTo: "0x1111111111111111111111111111111111111111",
      assetSymbol: "USDT",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      priceUsd: "$0.01",
      waitSeconds: 900,
      protectedRequestCount: 2,
      unpaidProbeSeen: true,
      paidRetrySeen: true,
      verifyTrace: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      paymentResponseHeaderCaptured: true,
      finalHttpStatus: 200,
      receipt: {
        runId: "run-live-001",
        routeId: "resource-sync",
        mode: "live",
        status: "settled",
        settlementState: "settled_onchain",
        requestId: "req-001",
        timestamp: "2026-04-15T03:00:00.000Z",
        network: "eip155:196",
        chainIndex: "196",
        scheme: "exact",
        payTo: "0x1111111111111111111111111111111111111111",
        payer: "0x2222222222222222222222222222222222222222",
        assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        assetSymbol: "USDT",
        amount: "$0.01",
        settlementTxHash: "0xabc123",
        explorerUrl: "https://www.okx.com/web3/explorer/xlayer/tx/0xabc123",
        invalidReason: null,
        summary: "Live seller proof captured from verify and PAYMENT-RESPONSE settlement evidence"
      },
      artifactPaths: {
        publicArtifactPath: "artifacts/hero-runs/run-live-001/public-safe",
        rawArtifactPath: "artifacts/hero-runs/run-live-001"
      }
    });

    expect(summary).toContain("proof recap");
    expect(summary).toContain("status    settled");
    expect(summary).toContain("settlement settled_onchain");
    expect(summary).toContain("tx        0xabc123");
    expect(summary).toContain("artifacts/hero-runs/run-live-001/public-safe");
  });

  it("keeps verified_only when only verify-hook evidence exists", () => {
    const receipt = finalizeLiveReceipt({
      runId: "run-verify",
      routeId: "resource-sync",
      requestId: "req-verify",
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "$0.01",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      assetSymbol: "USDT",
      verifyTrace: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      paymentResponseHeader: null,
      finalHttpStatus: 200
    });

    expect(receipt.status).toBe("pending");
    expect(receipt.settlementState).toBe("verified_only");
    expect(receipt.settlementTxHash).toBeNull();
  });

  it("upgrades to settled_onchain when PAYMENT-RESPONSE reports success with transaction", () => {
    const header = encodePaymentResponseHeader({
      success: true,
      status: "success",
      payer: "0x2222222222222222222222222222222222222222",
      transaction: "0xabc123",
      network: "eip155:196"
    });

    const receipt = finalizeLiveReceipt({
      runId: "run-settled",
      routeId: "resource-sync",
      requestId: "req-settled",
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "$0.01",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      assetSymbol: "USDT",
      verifyTrace: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      paymentResponseHeader: header,
      finalHttpStatus: 200
    });

    expect(receipt.status).toBe("settled");
    expect(receipt.settlementState).toBe("settled_onchain");
    expect(receipt.settlementTxHash).toBe("0xabc123");
    expect(receipt.explorerUrl).toContain("0xabc123");
  });

  it("maps PAYMENT-RESPONSE pending to settlement_pending", () => {
    const header = encodePaymentResponseHeader({
      success: true,
      status: "pending",
      payer: "0x2222222222222222222222222222222222222222",
      transaction: "0xdef456",
      network: "eip155:196"
    });

    const receipt = finalizeLiveReceipt({
      runId: "run-pending",
      routeId: "resource-sync",
      requestId: "req-pending",
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "$0.01",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      assetSymbol: "USDT",
      verifyTrace: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      paymentResponseHeader: header,
      finalHttpStatus: 200
    });

    expect(receipt.status).toBe("pending");
    expect(receipt.settlementState).toBe("settlement_pending");
    expect(receipt.settlementTxHash).toBe("0xdef456");
  });

  it("maps a failed post-verify response to rejected", () => {
    const header = encodePaymentResponseHeader({
      success: false,
      payer: "0x2222222222222222222222222222222222222222",
      transaction: "",
      network: "eip155:196",
      errorReason: "settlement failed"
    });

    const receipt = finalizeLiveReceipt({
      runId: "run-rejected",
      routeId: "resource-sync",
      requestId: "req-rejected",
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "$0.01",
      assetAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      assetSymbol: "USDT",
      verifyTrace: {
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222"
      },
      paymentResponseHeader: header,
      finalHttpStatus: 402
    });

    expect(receipt.status).toBe("rejected");
    expect(receipt.settlementState).toBeNull();
  });

  it("writes matching raw and public-safe fallback artifacts with relative tracked paths", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "x402-paywall-"));

    const result = await runFallbackHero({
      baseDir,
      now: new Date("2026-04-14T12:00:00.000Z"),
      gitCommit: "deadbeef"
    });

    const latest = JSON.parse(
      readFileSync(join(baseDir, "latest.json"), "utf8")
    ) as {
      mode: string;
      settlementState: string | null;
      publicArtifactPath: string;
      rawArtifactPath: string;
    };

    expect(result.manifest.mode).toBe("fallback");
    expect(latest.publicArtifactPath).toBe(
      "artifacts/hero-runs/2026-04-14T12-00-00-000Z/public-safe"
    );
    expect(latest.rawArtifactPath).toBe("artifacts/hero-runs/2026-04-14T12-00-00-000Z");
  });

  it("buildExplorerUrl returns null for empty tx hashes", () => {
    expect(buildExplorerUrl(null)).toBeNull();
  });
});
