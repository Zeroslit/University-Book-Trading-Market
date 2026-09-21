[English](./05-api-reference.md) | [简体中文](../05-接口清单.md)

# 05 API reference

## 0. Conventions
- Base path: `/api/v1`. Requests and responses are JSON (image upload uses `multipart/form-data`).
- Authentication: `Authorization: Bearer <accessToken>`. Role column values: `Public` = no login required, `Student` = logged-in student, `School admin` = admin of their own school, `Support` = human support agent, `Platform` = platform admin.
- Unified response: `{ "code": 0, "message": "ok", "data": {...}, "requestId": "..." }`; on failure `code` is a business error code (see `lib/errors.js`).
- Pagination: `page` (default 1), `pageSize` (default 20, max 100); the response is `{ list, page, pageSize, total }`.
- Idempotency: money endpoints such as order creation, payment, withdrawal and refund require an `Idempotency-Key` header.

## 1. Auth and accounts (auth / users / verifications / payment-accounts)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| POST | `/auth/sms/send` | Public | Send an SMS verification code (scenes: register/login/reset/bind/unbind), rate limited through Redis |
| POST | `/auth/register` | Public | Register: school + student number + phone code + password; returns a token and the verification status |
| POST | `/auth/login` | Public | Phone number + password login |
| POST | `/auth/login/wechat` | Public | One-click WeChat login (simulated code → openid exchange) |
| POST | `/auth/refresh` | Public | Refresh the access token |
| POST | `/auth/logout` | Student | Log out (the `jti` is blacklisted) |
| GET | `/auth/me` | Student | Current user + school + verification status + permission switches |
| GET | `/users/me/profile` | Student | Own profile (masked) |
| PATCH | `/users/me/profile` | Student | Update nickname/avatar/bio (the bio runs through banned-word detection) |
| GET | `/users/me/credit` | Student | Credit score, tier and current permission limits |
| GET | `/users/me/credit/logs` | Student | Credit score statement |
| GET | `/users/:id/public` | Student | Another user's public profile: nickname, credit tier, historical volume, verification badge |
| POST | `/verifications` | Student | Submit student verification (student card image URL / campus email) |
| GET | `/verifications/me` | Student | My verification records and current status |
| GET | `/verifications` | School admin / Platform | Pending verification queue (own school) |
| POST | `/verifications/:id/review` | School admin / Platform | Approve or reject (notification + trail) |
| GET | `/payment-accounts` | Student | My payout bindings (masked list) |
| POST | `/payment-accounts` | Student | Bind WeChat / Alipay / bank card (stores only the last four digits + hash) |
| POST | `/payment-accounts/:id/unbind/code` | Student | Send the SMS code required before unbinding (two-factor) |
| POST | `/payment-accounts/:id/unbind` | Student | Unbind (verifies the code, then enters a 24h cooldown) |
| POST | `/payment-accounts/:id/default` | Student | Set as the default payout method |

## 2. Schools and multi-school (schools)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/schools` | Public | Search schools by `keyword/province/city/status` (used by the registration dropdown; school names can never be typed in) |
| GET | `/schools/provinces` | Public | Province + city aggregation (cascading selectors) |
| GET | `/schools/:id` | Public | School details and public configuration (forum sections, verification requirement, cross-school switch) |
| POST | `/schools/applications` | Public | Apply to onboard a school |
| GET | `/schools/applications` | Platform | List of school onboarding applications |
| POST | `/schools/applications/:id/review` | Platform | Approve (creates the school and its forum sections automatically) or reject |
| PATCH | `/admin/schools/:id` | Platform | School configuration: status, service fee rate, categories, verification switch, cross-school zone |

## 3. Textbook library (books / uploads)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| POST | `/uploads/image` | Student | Upload an image (already compressed client-side to a long edge ≤ 1080px), returns a URL; validates size and type |
| GET | `/books` | Student | Own-school book list; `keyword/course/category/condition/minPrice/maxPrice/sort` |
| GET | `/books/:id` | Student | Details: images, seller credit score and volume, whether ordering is possible |
| POST | `/books` | Student | Publish a textbook (requires verification and no restrictions; title/remark pass banned-word checks) |
| PATCH | `/books/:id` | Student | Edit (seller only, and only when not yet sold) |
| POST | `/books/:id/off-shelf` | Student | Take off the shelf |
| POST | `/books/:id/relist` | Student | Relist (validates the listing-count limit) |
| DELETE | `/books/:id` | Student / School admin | Delete (soft delete; school admins may delete violating content) |

## 4. Forum (threads / replies)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/threads` | Student | Thread list; `type=seek/sell`, `keyword`, `category`, sorting |
| GET | `/threads/:id` | Student | Thread details plus paged comments |
| POST | `/threads` | Student | Create a thread (banned-word detection, handled by level) |
| PATCH | `/threads/:id` | Student | Edit (author only) |
| DELETE | `/threads/:id` | Student / School admin | Delete (soft delete) |
| POST | `/threads/:id/replies` | Student | Comment / reply (`parentId` supports nested replies; banned-word detection) |
| DELETE | `/replies/:id` | Student / School admin | Delete a comment |

## 5. Direct messages (conversations)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/conversations` | Student | Conversation list (newest message first, with unread counts) |
| POST | `/conversations` | Student | Start a conversation from a book/thread (automatically reused for the same context) |
| GET | `/conversations/:id/messages` | Student | Chat history (visible only to the two participants; marks messages as read) |
| POST | `/conversations/:id/messages` | Student | Send a message (text or image, banned-word filtered) |

## 6. Trading and escrow (orders)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| POST | `/orders` | Student | Place an order (row lock + unique index prevent overselling; requires `Idempotency-Key`) |
| GET | `/orders` | Student | My orders (`role=buyer/seller`, `status`) |
| GET | `/orders/:id` | Both parties / Support | Order details + status history + money ledger |
| POST | `/orders/:id/pay` | Buyer | Simulated payment: balance debited → frozen in escrow (idempotent) |
| POST | `/orders/:id/cancel` | Buyer | Cancel while unpaid |
| POST | `/orders/:id/ship` | Seller | Ship (tracking number) and set the 7-day auto-confirm time |
| POST | `/orders/:id/confirm` | Buyer | Confirm receipt → payout to the seller with the platform service fee deducted |
| POST | `/orders/:id/refund-request` | Buyer | Paid but not shipped: request a refund |
| POST | `/orders/:id/refund/agree` | Seller | Agree to the refund (escrowed funds return to the buyer) |
| POST | `/orders/:id/refund/reject` | Seller | Reject the refund (may escalate to a dispute) |
| POST | `/orders/:id/return-request` | Buyer | Shipped: request a return and refund |
| POST | `/orders/:id/dispute` | Both parties | Open a dispute: payout frozen + auto-confirm countdown paused |
| POST | `/orders/:id/arbitrate` | Support | Arbitration: force payout / force refund (writes the ledger + notifies both parties) |

## 7. Wallet (wallet)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/wallet` | Student | Balance, frozen amount, withdrawable balance and withdrawal timing for the current tier |
| GET | `/wallet/transactions` | Student | Detailed ledger, traceable per transaction by `orderId` |
| POST | `/wallet/recharge` | Student | Simulated top-up (idempotent, writes the ledger) |
| POST | `/wallet/withdraw` | Student | Withdraw (requires a bound payout method + verified identity + no ban) |
| GET | `/wallet/withdrawals` | Student | Withdrawal records |

## 8. Notifications (notifications)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/notifications` | Student | In-app message list (filterable by `isRead`, `type`) |
| POST | `/notifications/:id/read` | Student | Mark as read |
| POST | `/notifications/read-all` | Student | Mark all as read |
| GET | `/notifications/unread-count` | Student | Unread count (polled by the front end for the red dot) |

## 9. Risk control (reports / appeals / words)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| POST | `/reports` | Student | File a report (book/thread/comment/message/user/order, with encrypted evidence) |
| GET | `/reports` | School admin / Support / Platform | Report queue (own school / platform-wide) |
| GET | `/reports/:id` | School admin / Support / Platform | Details (masked evidence; sensitive reads are audited) |
| POST | `/reports/:id/accept` | School admin / Support | Accept: notify the accused to submit evidence within 48h |
| POST | `/reports/:id/proof` | Accused user | Submit evidence |
| POST | `/reports/:id/decide` | School admin / Support | Rule upheld / not upheld (upheld applies a penalty + score deduction + violation record and opens the 3-day appeal window) |
| POST | `/appeals` | Student | Submit an appeal (within 3 days of the penalty taking effect) |
| GET | `/appeals` | School admin / Support / Platform | Appeal queue |
| POST | `/appeals/:id/review` | School admin / Support | Re-review: approval revokes the penalty and rolls back the credit score |
| POST | `/words/check` | Student | Pre-publish check from the front end (returns matched words, level, position and suggested action) |
| GET | `/admin/banned-words` | School admin / Platform | Word library list (global + own school) |
| POST | `/admin/banned-words` | School admin / Platform | Add a word (level, action, score deduction, scope) |
| PATCH | `/admin/banned-words/:id` | School admin / Platform | Update an entry (enable/disable, allowlist exceptions) |
| DELETE | `/admin/banned-words/:id` | Platform | Delete an entry |
| GET | `/admin/word-hits` | School admin / Platform | Hit records (trace the evidence chain by user/scene/level) |

## 10. Customer support (tickets / chat / kb)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| POST | `/tickets` | Student | Create a ticket (source: user) |
| GET | `/tickets` | Support / School admin / Platform | Ticket queue (sorted by priority and remaining SLA time) |
| GET | `/tickets/:id` | Support / Owner | Ticket details + transition log + order snapshot + the user's risk data on one screen |
| POST | `/tickets/:id/claim` | Support | Claim a ticket (optimistic locking: `UPDATE ... WHERE assignee_id IS NULL`) |
| POST | `/tickets/:id/reply` | Support | Reply to the user (quick-reply templates) |
| POST | `/tickets/:id/resolve` | Support | Mark as resolved (a resolution note is required) |
| POST | `/tickets/:id/escalate` | Support / System | Manual escalation (the system escalates automatically on SLA breach) |
| GET | `/tickets/stats` | Support / Platform | Ticket statistics (response compliance rate, breaches, distribution by type) |
| POST | `/chat/sessions` | Student | Start an AI support session |
| POST | `/chat/sessions/:id/messages` | Student | Talk to the AI (FAQ / order lookup / triggering actions) |
| POST | `/chat/sessions/:id/transfer` | Student / System | Hand over to a human (triggered by rules; creates a ticket automatically) |
| GET | `/kb/articles` | Student | Knowledge-base search |
| POST/PATCH/DELETE | `/kb/articles/:id` | Platform | Maintain the knowledge base |

## 11. Admin console (admin)

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/admin/dashboard` | School admin / Platform | Dashboard (orders, GMV, escrow balance, violation and complaint statistics) |
| GET | `/admin/schools` | Platform | School list (including configuration) |
| POST | `/admin/schools` | Platform | Create a school (initializes its forum sections) |
| GET | `/admin/users` | School admin / Platform | User search (student number / phone last four / verification status / ban status) |
| POST | `/admin/users/:id/ban` | Platform / Support | Apply a ban (mute / trade ban / login ban, combinable and time-bounded) |
| POST | `/admin/users/:id/unban` | Platform / Support | Lift a ban (restores the switches) |
| GET | `/admin/users/:id/risk` | School admin / Support / Platform | The user's risk screen: credit score, violation history, penalties, tickets, orders |
| GET | `/admin/contents` | School admin / Platform | Content review queue (books/threads/comments, with word-hit flags) |
| POST | `/admin/contents/:type/:id/review` | School admin / Platform | Approve / take down / delete |
| GET | `/admin/configs` | Platform | Rule threshold list (platform-level + school-level) |
| PUT | `/admin/configs/:key` | Platform | Update a threshold (optimistic locking via `version`, writes an audit entry) |
| GET | `/admin/audit-logs` | Platform | Audit log (trace sensitive operations) |
