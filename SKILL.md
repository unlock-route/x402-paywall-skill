---
name: x402-paywall-skill
description: "Seller-side X Layer x402 skill that creates one payment requirement, verifies the paid retry, and returns a normalized settlement receipt"
version: "1.0.0"
author: "ianmark89"
tags:
  - x402
  - payment
  - xlayer
  - onchainos
---

# X402 Paywall Skill

## Overview

This skill packages a seller-side x402 paywall flow on X Layer. It helps a
service owner expose one paid route, verify the paid retry, and produce a
portable seller receipt with settlement metadata.

## Pre-flight Checks

Before using this skill, ensure:

1. The seller has an X Layer payout wallet and a paid route to protect.
2. OKX credentials for x402 verification/settlement are configured out-of-band.
3. The operator can verify final transaction hashes on the X Layer explorer.

## Commands

### Create Requirement

When the seller needs to gate a resource, produce a payment requirement with:

- amount
- asset
- merchant wallet
- callback URL
- human-readable description

Required output shape:

```json
{
  "scheme": "x402",
  "requestId": "x402-paywall_xxxxxxxx",
  "settlement": {
    "chainIndex": "196",
    "currencySymbol": "USDT",
    "assetAddress": "0x779ded0c9e1022225f8e0630b35a9b54be713736"
  }
}
```

### Verify Payment

When an x402 payment payload is received:

1. verify that the payload is syntactically complete
2. verify it against the OKX x402 verification endpoint
3. reject malformed or mismatched payments

### Settle Payment

When verification succeeds:

1. submit the payment payload for settlement
2. return payer, tx hash, status, and short summary

## Examples

### Example: Paid Execution Trace

1. Create an x402 payment requirement for `GET /resource/sync`.
2. If used in a Human Track or operator-guided flow, surface the charge to a
   human and wait for approval before sending the paid retry.
3. Wait for the caller or upstream agent to send the payment payload.
4. Verify the payload.
5. Settle the payment.
6. Return a seller receipt bundle and explorer link.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `payment payload invalid` | Missing fields or malformed body | Ask for a fresh payload |
| `payment verification failed` | Invalid authorization or amount mismatch | Reject and issue a new requirement |
| `settlement failed` | Upstream OKX/payment issue | Retry once, then surface the failure |

## Security Notices

- Never embed private keys or API secrets in this skill.
- Treat incoming payment payloads as untrusted until verification succeeds.
- Always surface the final X Layer tx hash in the receipt.

## Scope Boundaries

- This public package stops at seller-side payment requirement creation,
  verification, settlement, and receipt writing.
- Treasury policy, payout allocation, and other post-settlement workflows are
  out of scope unless the caller or integrator adds them separately.
