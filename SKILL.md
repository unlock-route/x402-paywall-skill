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
2. Wait for the caller or upstream agent to send the payment payload.
3. Verify the payload.
4. Settle the payment.
5. Return a seller receipt bundle and explorer link.

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

## Skill Routing

- For treasury policy checks after payment, route to `treasury-guard-skill`.
- For payout allocation after settlement, route to `payout-splitter-skill`.
