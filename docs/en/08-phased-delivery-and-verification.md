[English](./08-phased-delivery-and-verification.md) | [简体中文](../08-分阶段交付与验证.md)

# 08 Phased delivery and verification

Every phase runs and can be verified on its own. Shared prerequisites:

```bash
docker compose up -d mysql redis        # or use existing MySQL 8 / Redis 7
cd server && npm install
npm run migrate && npm run seed         # schema + seed data
npm run dev                             # http://localhost:3000/api/v1
```

| Phase | Deliverables | How to verify |
| --- | --- | --- |
| 0 Design | Design docs `docs/01`–`09`, directory structure, ER, API reference | Read the docs; confirm the code tree matches the documented structure |
| 1 Multi-school and accounts | `schools`/`users`/`user_verifications`/`payment_accounts`/`school_applications`; registration and login, SMS codes, verification review, payout binding with a 24h cooldown; the `schoolScope` middleware | `npm run test:unit` (masking, config lookup); `npm run test:integration` → `isolation.test.js` (cross-school blocking), `auth.test.js` (duplicate student numbers, posting blocked before verification); manual: `POST /auth/register` then `GET /auth/me` returns `schoolId` directly |
| 2 Textbook library | `books`/`book_images`, image upload, filters and sorting, detail page | `book.test.js`: publishing (rejected before verification), filtering, no ordering after being taken off the shelf; manual: upload an image, get a URL and publish successfully |
| 3 Forum | `threads`/`replies`, search, comments and replies, banned words on posts and comments | Manually post content containing an L2 word → returns `BANNED_WORD_BLOCKED` and a record appears in `word_hits` |
| 4 Direct messages | `conversations`/`messages`, conversation reuse, read state, banned words | Manual: "Contact seller" on a book detail page → conversation created → messages both ways; clicking again does not create a second conversation |
| 5 Escrow trading | `orders`/`order_status_log`/`wallet_accounts`/`wallet_transactions`/`withdraw_requests`; state machine, escrow, payout with fee deduction, refund, dispute freezing, 7-day auto-confirm | `order-concurrency.test.js` (only 1 of 20 concurrent orders succeeds), `escrow.test.js` (pay → ship → confirm receipt credits the seller with price − service fee, books the platform fee and keeps the ledger traceable), `refund.test.js` (after a refund the buyer is made whole and escrow returns to zero) |
| 6 Notifications | `notifications` plus the notification service, covering orders/complaints/penalties/bans/verification/tickets/word reminders | Manual: complete one order → both parties have in-app messages; visible via `GET /notifications` |
| 7 Credit and violations | `credit_logs`, tier-linked permissions, the `reports`/`penalties`/`appeals` chain | `credit.test.js` (tier boundaries, deductions, rollback), `penalty.test.js` (3rd offence → 3-day mute, 5th → 7-day ban, 10th → permanent, severe → instant permanent), `report.test.js` (report → accept → evidence → ruling → appeal rollback) |
| 8 Banned words | `banned_words`/`word_hits`, four-level handling, normalization, allowlist, cumulative mutes | `word-normalize.test.js`: full-width, simplified/traditional, pinyin homophones, inserted symbols and zero-width characters are all caught, while allowlisted titles are not |
| 9 Support tickets | `tickets`/`ticket_logs`/`chat_sessions`/`chat_messages`/`kb_articles`, the three AI capabilities, human handover, SLA | `ticket.test.js` (optimistic claim locking, SLA computation, breach escalation), `ai-cs.test.js` (FAQ hit, order lookup, the tool allowlist that denies the AI any payout, automatic handover after 2 unresolved turns) |
| 10 Admin console | Admin endpoints plus the front-end console pages (school configuration, content review, word library, users, arbitration, dashboards) | Log in as the `platform_admin` account in a browser → change the service fee rate → new orders are charged at the new rate |

## Manual end-to-end acceptance checklist
1. Log in with a seed account (password `Test@123456`) → land directly in your own school's book library.
2. Publish a textbook (multiple images) → another student finds it by search → messages you → places an order → simulated payment → the seller ships → the buyer confirms receipt.
3. The wallet page shows: buyer spending, the seller's "balance + price − service fee", and the platform service fee entry, all traceable by order number.
4. Post something containing "代写" (ghostwriting) → blocked with the exact word and position, credit score −3, and one entry each in `credit_logs` and `word_hits`.
5. Report a book → support accepts it → the ruling is upheld → the accused receives a penalty notification → appeals within 3 days → after approval the credit score is rolled back.
6. Ask the AI assistant "where is my order" → returns the order status; ask "I want a refund" → it creates a refund request and a ticket instead of refunding directly.

## Troubleshooting
| Symptom | Cause / fix |
| --- | --- |
| API returns `CONFIG_MISSING` | Configuration not initialized; run `npm run seed` |
| Integration tests are skipped | `TEST_DB_HOST` is not set; integration tests need MySQL, see `server/tests/helpers/db.js` |
| No books visible after login | The school is not active or no books are listed; check `schools.status` and `books.status` |
| Redis unavailable | Development mode degrades to an in-memory implementation and logs a warning (development only) |
