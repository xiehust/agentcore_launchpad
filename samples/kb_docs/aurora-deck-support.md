# Aurora Deck — Support Runbook

## Refund policy
Customers on the Pro plan may request a full refund within 30 days of purchase.
Enterprise contracts follow the negotiated terms in section 7.2 of the MSA.
Refunds are processed by the billing team within 5 business days via Stripe.

## Escalation path
1. Tier 1: support@auroradeck.example (SLA: 4 business hours)
2. Tier 2: platform on-call via PagerDuty rotation "aurora-platform"
3. Tier 3: engineering lead — only for data-loss incidents (severity SEV-1)

## Known issue AD-4411
Decks larger than 250 slides may show degraded thumbnail rendering on Safari 18.
Workaround: disable the "Prism preview cache" flag in workspace settings.
