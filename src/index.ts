export type HeroMode = "live" | "fallback";

export type X402SellerStatus = "required" | "rejected" | "pending" | "settled";

export type X402SettlementState =
  | "settled_onchain"
  | "settlement_pending"
  | "verified_only"
  | "fallback_local"
  | null;

export type PaidRouteDefinition = {
  routeId: "resource-sync";
  method: "GET";
  path: "/resource/sync";
  description: string;
  network: "eip155:196";
  payTo: string;
  price: string;
  assetAddress: string;
  assetSymbol: string;
  maxTimeoutSeconds: number;
  mimeType: "application/json";
};

export type X402SellerReceipt = {
  runId: string;
  routeId: string;
  mode: HeroMode;
  status: X402SellerStatus;
  settlementState: X402SettlementState;
  requestId: string | null;
  timestamp: string;
  network: "eip155:196";
  chainIndex: "196";
  scheme: string | null;
  payTo: string;
  payer: string | null;
  assetAddress: string | null;
  assetSymbol: string | null;
  amount: string | null;
  settlementTxHash: string | null;
  explorerUrl: string | null;
  invalidReason: string | null;
  summary: string;
};

type ReceiptInput = {
  runId: string;
  routeId: string;
  mode: HeroMode;
  status: X402SellerStatus;
  settlementState: X402SettlementState;
  payTo: string;
  summary: string;
  timestamp?: string;
  requestId?: string | null;
  scheme?: string | null;
  payer?: string | null;
  assetAddress?: string | null;
  assetSymbol?: string | null;
  amount?: string | null;
  settlementTxHash?: string | null;
  invalidReason?: string | null;
};

function assertStatusState(
  status: X402SellerStatus,
  settlementState: X402SettlementState
) {
  if (status === "required" || status === "rejected") {
    if (settlementState !== null) {
      throw new Error("Invalid settlementState for non-settlement outcome");
    }
    return;
  }

  if (status === "pending") {
    if (
      settlementState !== "verified_only" &&
      settlementState !== "settlement_pending"
    ) {
      throw new Error("Invalid settlementState for pending outcome");
    }
    return;
  }

  if (status === "settled") {
    if (
      settlementState !== "settled_onchain" &&
      settlementState !== "fallback_local"
    ) {
      throw new Error("Invalid settlementState for settled outcome");
    }
  }
}

export function buildExplorerUrl(txHash: string | null): string | null {
  if (!txHash) {
    return null;
  }

  return `https://www.okx.com/web3/explorer/xlayer/tx/${txHash}`;
}

export function createHeroRouteDefinition(input: {
  payTo: string;
  assetAddress: string;
  assetSymbol?: string;
  price?: string;
  maxTimeoutSeconds?: number;
}): PaidRouteDefinition {
  return {
    routeId: "resource-sync",
    method: "GET",
    path: "/resource/sync",
    description: "Paid X Layer resource sync",
    network: "eip155:196",
    payTo: input.payTo,
    price: input.price ?? "$0.01",
    assetAddress: input.assetAddress,
    assetSymbol: input.assetSymbol ?? "USDT",
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
    mimeType: "application/json"
  };
}

export function buildReceipt(input: ReceiptInput): X402SellerReceipt {
  assertStatusState(input.status, input.settlementState);

  return {
    runId: input.runId,
    routeId: input.routeId,
    mode: input.mode,
    status: input.status,
    settlementState: input.settlementState,
    requestId: input.requestId ?? null,
    timestamp: input.timestamp ?? new Date().toISOString(),
    network: "eip155:196",
    chainIndex: "196",
    scheme: input.scheme ?? null,
    payTo: input.payTo,
    payer: input.payer ?? null,
    assetAddress: input.assetAddress ?? null,
    assetSymbol: input.assetSymbol ?? null,
    amount: input.amount ?? null,
    settlementTxHash: input.settlementTxHash ?? null,
    explorerUrl: buildExplorerUrl(input.settlementTxHash ?? null),
    invalidReason: input.invalidReason ?? null,
    summary: input.summary
  };
}

export function buildUnpaidReceipt(input: {
  runId: string;
  mode: HeroMode;
  routeId: string;
  requestId: string;
  payTo: string;
  assetAddress: string;
  assetSymbol: string;
  amount: string;
  scheme: string;
}): X402SellerReceipt {
  return buildReceipt({
    runId: input.runId,
    routeId: input.routeId,
    mode: input.mode,
    status: "required",
    settlementState: null,
    requestId: input.requestId,
    payTo: input.payTo,
    scheme: input.scheme,
    assetAddress: input.assetAddress,
    assetSymbol: input.assetSymbol,
    amount: input.amount,
    summary: "Unpaid request returned HTTP 402"
  });
}
