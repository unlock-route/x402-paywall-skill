---
name: x402-paywall-skill
description: "Create x402 payment requirements, verify payment payloads, and return settlement receipts on X Layer"
version: "1.0.0"
author: "FILL_ME_AUTHOR"
tags:
  - x402
  - payment
  - xlayer
  - onchainos
---

# X402 Paywall Skill

## Overview

This skill turns an agent action into a paid x402 flow on X Layer. It helps an agent
create a payment requirement, verify an incoming x402 payload, and produce a
portable settlement receipt with transaction metadata.

## Pre-flight Checks

Before using this skill, ensure:

1. The requester has an X Layer payment asset and destination wallet.
2. OKX credentials for x402 verification/settlement are configured out-of-band.
3. The agent can verify final transaction hashes on the X Layer explorer.

## Commands

### Create Requirement

When the agent needs to gate a resource, produce a payment requirement with:

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
    "currencySymbol": "USDC",
    "assetAddress": "0x..."
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

1. Create an x402 payment requirement for a premium execution trace.
2. Wait for the user or upstream agent to send the payment payload.
3. Verify the payload.
4. Settle the payment.
5. Return a receipt bundle and explorer link.

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
