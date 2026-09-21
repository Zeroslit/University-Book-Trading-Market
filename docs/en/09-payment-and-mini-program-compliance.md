[English](./09-payment-and-mini-program-compliance.md) | [简体中文](../09-支付与小程序上线合规建议.md)

# 09 Compliance notes for real payments and mini-program launch

> This document is the phase 2 checklist. In phase 1 every money movement is simulated inside the platform (no real payment integration and no real bank-card authentication).

## 1. Prerequisites for real payment integration
1. **Entity qualifications**: a corporate entity is required (sole proprietorships are restricted in some scenarios); open a WeChat Pay merchant account and an Alipay open-platform account; for education-related transactions, prepare school cooperation or campus partnership evidence.
2. **Escrow compliance**: "collection and disbursement on behalf of others" is essentially fund aggregation, so exposure to the Regulations on Non-Bank Payment Institutions must be assessed. There are usually two compliant paths:
   - Use a **licensed payment institution's profit-sharing or guaranteed-transaction product** (such as WeChat Pay "service provider + profit sharing" or Alipay "fund custody / profit sharing"), so the platform never actually pools funds;
   - Or use bank custody / class-II account structures so the bank keeps funds segregated.
   Never let buyer payments sit in the platform's own corporate account for long periods, which risks being classified as second-tier clearing.
3. **Fees and invoicing**: the platform service fee (2% by default in phase 1, `school.service_fee_bps`) must be clearly displayed and invoiceable; payment-channel fees and platform service fees are booked separately.
4. **Refund compliance**: refunds must return to the original payment method, never into a platform balance for later withdrawal; the phase 1 simulation already models "escrowed funds back to the buyer", so switching to a real channel is a mapping change.
5. **Withdrawals (payouts)**: enable merchant transfers to WeChat balance / Alipay transfers, enforce payee real-name consistency checks, per-transaction and daily limits, and anti-money-laundering name screening.

## 2. Integration points in code (adapters already reserved)
| Capability | Phase 1 implementation | Phase 2 integration point |
| --- | --- | --- |
| Payment | `escrow.service.mockPay()`: debit the buyer's balance + hold in escrow | `payment.provider = wechat/alipay`; add a `payments` table for channel order IDs and call the same `escrow.hold()` after callback signature verification |
| Refund | `escrow.refund()` writes the ledger directly | Call the channel refund API; a `pending → success` async callback drives the same ledger state machine |
| Withdrawal | `withdraw_requests` is persisted as `pending` | Call the merchant transfer API; `processing/paid` are updated by callbacks; keep `reject_reason` |
| Identity | Student number + manual student-card review | Add campus email domain allowlist checks and integration with the national student registry or the school's academic system (requires school authorization) |
| SMS | `sms.service` console driver | Alibaba Cloud / Tencent Cloud SMS (template IDs and signature registration required) |
| Image review | Word-library pre-filtering + OCR adapter (off by default) | Integrate WeChat `imgSecCheck` / `mediaCheckAsync` |

## 3. Mini-program launch compliance essentials
1. **Entity and category**: a WeChat mini-program requires a corporate entity; the "e-commerce platform / second-hand trading" category usually requires an ICP/EDI value-added telecom business licence or platform service agreement and similar materials, per WeChat's latest review requirements.
2. **User agreement and privacy**:
   - The four documents — Terms of Service, Privacy Policy, Trading Rules and Community Guidelines — must be accessible;
   - The privacy policy must explain item by item the purpose, scope and retention period for collected student numbers, phone numbers and payout accounts (consistent with `configs.retention`);
   - A "user privacy protection guideline" must be configured in the mini-program console, and sensitive data such as student numbers and phone numbers requires a dedicated consent prompt.
3. **Content safety**: mini-programs must integrate content-safety checks (`msgSecCheck` / `mediaCheckAsync`); the platform's `banned_words` library acts as a pre-filter and the WeChat content-safety API as a post-check; images go through `imgSecCheck`, wired to the phase 1 `ocr_status` field.
4. **Real-name and minor protection**: real-name verification should be integrated for money-related trading; if users may be minors, add guardian consent and spending limits.
5. **Public disclosure of trading rules**: the service fee rate, shipping deadlines, the 7-day automatic confirmation, the dispute process and the appeal entry point must be prominently published (driven by the configuration in `docs/07` and rendered dynamically by the front end, so the copy can never drift from the rules).
6. **Data compliance**: user data stays within mainland China; chat history and report evidence are purged or anonymized when `retention` expires, avoiding over-retention.

## 4. Pre-launch checklist
- [ ] Service fees, SLAs and penalty ladders all come from `configs`, editable in the console and audited.
- [ ] Money ledger entries map one-to-one to orders and can be exported for reconciliation (`wallet_transactions.order_id` is indexed).
- [ ] Orders already in progress during a ban can still complete or be refunded (covered by integration tests).
- [ ] Every penalty has an appeal entry point and a re-review rollback path.
- [ ] Sensitive fields (student numbers, phone numbers, payout accounts, chat history, report evidence) are encrypted + masked + tiered-access + retention-cleaned.
- [ ] The privacy policy, terms of service, trading rules and community guidelines are accessible on both web and mini-program.
