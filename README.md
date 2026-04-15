# X402 Paywall Skill

Seller-side X Layer skill that turns one route into a paid resource with the
official OKX seller flow.

## At A Glance

- one hero route: `GET /resource/sync`
- seller-side only: no buyer product, dashboard, or admin sprawl
- official OKX seller middleware path on X Layer
- seller-owned normalized receipt plus public-safe proof artifacts

This repo is intentionally narrow so a judge can understand it fast: one route,
one payment requirement, one paid retry, one seller receipt contract.

The protected `200` response stays intentionally small:

```json
{
  "ok": true,
  "routeId": "resource-sync",
  "resource": "premium X Layer seller payload"
}
```

The receipt truth lives in the proof pack, not in the response body.

## What Judges Can Verify Quickly

1. the route returns `402 Payment Required`
2. the paid retry is verified and settled through the OKX seller path
3. the seller repo writes a normalized receipt from final response truth
4. the work copy exposes a public-safe proof pack through
   `artifacts/hero-runs/latest.json`

## Current Work-Repo Evidence

- runtime manifest entrypoint: `artifacts/hero-runs/latest.json`
- current tracked manifest records:
  - `mode = live`
  - `status = settled`
  - `settlementState = settled_onchain`
- current public-safe proof pack includes a settlement tx hash and explorer link

This is evidence in the current work copy. Before release or public promotion,
approve the exact proof bundle you want to publish instead of treating every
work-runtime artifact as final collateral.

## Hero Flow

The repo uses the OKX x402 seller flow on X Layer to:

1. return `402 Payment Required`
2. verify the paid retry and capture post-settlement `PAYMENT-RESPONSE`
3. normalize the seller receipt from final response truth
4. write a public-safe proof bundle for review, demo, and submission ops

## Hero Route

- method: `GET`
- path: `/resource/sync`
- network: `eip155:196`
- asset wording locked to current OKX docs:
  `0x779ded0c9e1022225f8e0630b35a9b54be713736` = `USDT` on X Layer

## Preflight

`pnpm hero:live` is the primary proof command and fails fast if any of these
are missing:

- `OKX_API_KEY`
- `OKX_SECRET_KEY`
- `OKX_PASSPHRASE`
- `PAY_TO_ADDRESS`
- local port and artifact path availability

Current wallet policy for this repo:

- `PAY_TO_ADDRESS` should point to the dedicated paywall seller wallet
  `0x1300e5D8E8126c613b82b4F02f138cbdF76FDeb5`
- do not reuse `x402-payment-operator` buyer/runtime wallet `0xa301...3ff6`
- do not reuse `x402-payment-operator` seller proof-rig wallet `0x9051...Ce2b`

Optional live-demo helpers:

- set `HERO_WAIT_FOR_PAID_SECONDS` if you want a longer guided demo window
- open `GET /debug/run` during a live run to inspect the current seller stage,
  verify summary, settlement capture state, and artifact paths without exposing
  raw payment material

## Commands

```bash
pnpm typecheck
pnpm test
pnpm hero:fallback
pnpm hero:live
```

## Artifact Contract

- `latest.json` carries repo-relative `publicArtifactPath` and `rawArtifactPath`
- judge-facing links should resolve through `publicArtifactPath`
- raw/local artifacts are for local inspection only
- `pnpm hero:fallback` produces the same artifact schema with
  `settlementState = fallback_local`
- fallback artifacts are backup evidence only and must not be presented as live
  settlement proof

## What This Repo Proves

- one seller-owned X Layer route can return `402`
- the primary proof path stays on the official OKX seller stack
- the repo owns a stable seller receipt contract
- the repo can produce a public-safe proof bundle that is easy to review

## What This Repo Does Not Try To Be

- buyer tooling as a product
- dashboards or admin UI
- multi-route seller management
- generic operator workflow

## Release And Submission Note

This work repo is the operational source of truth. For release or public
submission:

- promote the approved proof pack intentionally
- backfill approved public video/contact details separately
- do not improvise public claims beyond the evidence currently in the repo

## Technical Basis

- current Node seller quickstart uses
  `paymentMiddleware(routes, resourceServer)` for seller wiring
- seller quickstart:
  [OKX Seller Quickstart](https://web3.okx.com/es-la/onchainos/dev-docs/payments/payment-use-seller-api)
- supported network and currency wording:
  [OKX Supported Networks and Currencies](https://web3.okx.com/vi/onchainos/dev-docs/payments/supported-networks)
- core x402 seller/facilitator model:
  [OKX Core Concept](https://web3.okx.com/cs/onchainos/dev-docs/payments/core-concept)
