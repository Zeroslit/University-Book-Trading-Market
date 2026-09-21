[English](./03-directory-structure.md) | [简体中文](../03-目录结构.md)

# 03 Directory structure

```
University-Book-Trading-Market/
|- docker-compose.yml            # One-command startup for MySQL + Redis + API + Web
|- .env.example                  # Environment variable sample
|- README.md                     # Architecture / startup / API / data model / rules / isolation / compliance
|- docs/                         # Design documents
|- server/                       # Node 20 + Express API
|  |- package.json  Dockerfile  .env.example
|  |- src/
|  |  |- server.js               # Process entry (HTTP server + scheduled jobs)
|  |  |- app.js                  # Express wiring (middleware, routes, error handling)
|  |  |- bootstrap.js            # Route registration
|  |  |- config/index.js         # Central export of environment variables and constants
|  |  |- lib/
|  |  |  |- errors.js            # Unified error codes and AppError
|  |  |  |- response.js          # Unified envelope {code,message,data,requestId}
|  |  |  |- logger.js  async-handler.js  pagination.js
|  |  |  |- crypto.js            # AES-256-GCM and HMAC blind index
|  |  |  |- mask.js              # Masking for phone numbers, student IDs, card numbers
|  |  |  |- normalize.js         # Banned-word normalization (full/half width, simplified/traditional, pinyin homophones, noise removal)
|  |  |  |- word-matcher.js      # Aho-Corasick multi-pattern matching + allowlist
|  |  |  |- state-machine.js     # Configuration-driven state machine
|  |  |  |- idempotency.js
|  |  |- db/
|  |  |  |- pool.js              # mysql2 connection pool
|  |  |  |- tx.js                # Transaction wrapper (retry, row-lock helpers)
|  |  |  |- migrate.js           # Migration runner
|  |  |  |- migrations/          # Executed in numeric order starting from 001_init.sql
|  |  |  |- seed.js              # Seed data (3 schools / 9 students / 10 books / 5 threads / 2 orders / 1 ticket / 1 pending verification)
|  |  |- middleware/
|  |  |  |- request-id.js  auth.js  school-scope.js  rbac.js
|  |  |  |- validate.js  rate-limit.js  error-handler.js  audit.js
|  |  |- services/
|  |  |  |- config.service.js    # Rule threshold lookup (school override -> platform default)
|  |  |  |- redis.service.js     # Cache / rate limiting / verification codes / idempotency locks
|  |  |  |- sms.service.js       # SMS adapter (console / mock)
|  |  |  |- storage.service.js   # Image storage adapter (local / oss)
|  |  |  |- notify.service.js    # In-app messages + WeChat subscription messages
|  |  |  |- audit.service.js     # Audit trail
|  |  |  |- credit.service.js    # Credit score (scoring, tiers, permission linkage)
|  |  |  |- penalty.service.js   # Penalty escalation and ban switches
|  |  |  |- word.service.js      # Banned-word detection, hit handling, allowlist
|  |  |  |- wallet.service.js    # Wallet ledger (top-up / freeze / payout / withdrawal)
|  |  |  |- escrow.service.js    # Escrow money actions (pay, release, refund)
|  |  |  |- order.service.js     # Order state machine orchestration
|  |  |  |- report.service.js    # Report → evidence → ruling → appeal chain
|  |  |  |- ticket.service.js    # Tickets and SLA
|  |  |  |- ai-cs.service.js     # AI support (intent detection, tools, human handover)
|  |  |- modules/                # Each module = routes + service (+repository)
|  |  |  |- auth/ schools/ users/ verifications/ payment-accounts/ uploads/
|  |  |  |- books/ threads/ conversations/ orders/ wallet/ notifications/
|  |  |  |- reports/ appeals/ words/ tickets/ chat/ kb/ admin/
|  |  |- jobs/                   # Auto receipt confirmation, SLA escalation, credit recovery, retention cleanup
|  |- tests/
|     |- unit/                   # No database required: normalization, credit score, penalty escalation, state machine, masking, config
|     |- integration/            # Requires MySQL: concurrent ordering without overselling, payout and refund, cross-school access, accumulated complaints
|     |- helpers/                # Test database and login fixtures
|- web/                          # Vue 3 + Vite responsive front end
|  |- package.json  vite.config.js  index.html  Dockerfile
|  |- src/
|     |- main.js  App.vue
|     |- router/index.js
|     |- stores/                 # Pinia: user, school, conversation
|     |- api/                    # Axios wrapper and per-module endpoints
|     |- utils/                  # Image compression, money formatting, permission checks
|     |- layouts/                # Student app / admin console
|     |- components/             # Book card, image uploader, message bubble, status tag
|     |- views/                  # Student pages + admin console pages
|- scripts/                      # Local helper scripts (db:reset, dev)
```

## Naming and layering conventions
- File names are lowercase with hyphens; inside a module the files are always `*.routes.js` / `*.service.js` / `*.repository.js`.
- Repositories only write SQL, services carry business rules, and routes only validate and orchestrate.
- Named exports everywhere (except Vue components).
- Chinese comments explain where a business rule comes from, e.g. "Requirement 6: auto-confirm receipt 7 days after shipping".
