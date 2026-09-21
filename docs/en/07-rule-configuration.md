[English](./07-rule-configuration.md) | [简体中文](../07-规则配置说明.md)

# 07 Rule configuration

All thresholds live in the `configs` table and are resolved in the order **school-level → platform-level → throw** (there is no hard-coded fallback).
Changes go through `PUT /admin/configs/:key`, use `version` optimistic locking and write an `audit_logs` entry.

## 1. Configuration keys and defaults (seed data writes the platform level)

| config_key | Default | Notes |
| --- | --- | --- |
| `credit.tiers` | `[{key:excellent,min:90,label:优秀},{key:good,min:70},{key:limited,min:50},{key:high_risk,min:30},{key:banned,min:0}]` | Credit tiers |
| `credit.rules` | `{ship_on_time:+2, good_review:+1, no_dispute_streak_10:+5, late_ship:-5, mismatch_confirmed:-10, report_light:-5, banned_word:-3, fake_trade:-30}` | Score deltas |
| `credit.tier_permissions` | `{excellent:{maxBooks:999,withdrawDelayHours:0},good:{maxBooks:50,withdrawDelayHours:0},limited:{maxBooks:3,withdrawDelayHours:24},high_risk:{maxBooks:0,withdrawDelayHours:24},banned:{canTrade:false}}` | Permissions linked to each tier |
| `credit.light_violation_expire_months` | `12` | Rolling expiry window for minor violations |
| `credit.clean_months_clear_count` | `6` | Months without violations required to clear one count |
| `penalty.escalation` | see the ladder table below | Penalty ladder by cumulative upheld complaints |
| `penalty.severe_instant_ban` | `true` | Severe violations (fraud / ghostwriting / exam sitting / porn, gambling, politics) are banned permanently on the first offence |
| `order.state_machine` | see the state machine in doc 04 | Whitelist of state transitions (from → to) and the trigger conditions for each action |
| `order.auto_confirm_days` | `7` | Days after shipping before receipt is confirmed automatically |
| `order.service_fee_bps` | `200` (= 2%) | Platform service fee in basis points (overridable per school via `schools.service_fee_bps`) |
| `order.report_proof_hours` | `48` | Evidence window for the accused |
| `report.appeal_days` | `3` | Appeal window after a ruling |
| `banned_word.normalize` | `{fullWidth:true,traditional:true,pinyin:true,stripSymbols:true}` | Normalization switches |
| `banned_word.penalty` | `{L1:{action:hint},L2:{action:block},L3:{action:block,score:-3,violation:1},L4:{action:delete,ticket:true,ban:true}}` | Action per level |
| `banned_word.escalation` | `{L1_hint_per_day:3,L1_mute_days:1,L2L3_mute_hits:3,L2L3_mute_days:7,L2L3_post_ban_hits:5,L2L3_post_ban_days:30}` | Cumulative escalation rules |
| `ticket.sla` | `{normal:{firstResponseHours:24,resolveHours:72},urgent:{firstResponseHours:4,resolveHours:24}}` | Ticket SLA |
| `ticket.auto_escalate` | `true` | Auto-escalate on breach and tell the user it was expedited |
| `ai.escalate_rules` | `{unresolvedRounds:2,confidenceThreshold:0.55,fundKeywords:[退款,钱没到,投诉,仲裁,放款]}` | Conditions for handing over to a human |
| `rate_limit.default` | `{windowSeconds:60,max:300}` | Default rate limiting |
| `rate_limit.sensitive` | `{login:10,sms:3,order:20,withdraw:5}` (per 60s per IP/user) | Rate limiting for sensitive endpoints |
| `upload.image` | `{maxSidePx:1080,maxSizeMb:5,allowTypes:image/jpeg,image/png,image/webp}` | Image constraints (consistent with client-side compression) |
| `retention` | `{chatMonths:24,evidenceMonths:36,auditMonths:60,verificationMonths:36}` | Retention periods for sensitive data |
| `content.categories` | `[教材,教辅,考研,英语,计算机,经管,理工]` | Publishable categories (overridable per school) |

## 2. Penalty ladder (`penalty.escalation`, by cumulative upheld complaints)

| Cumulative upheld | Action | Additional |
| --- | --- | --- |
| 1–2 | `warning` in-app warning + reminder | The user is notified |
| 3 | `mute` 3-day mute | −5 score |
| 4 | `trade_ban` 7-day trading restriction | Notified |
| 5 | `login_ban` 7-day ban | Notified |
| 6–9 | `login_ban` 15 days each time, escalating (6→15, 7→20, 8→25, 9→30) | Notified |
| 10 | `permanent_ban` | Appeal entry point retained |
| Severe violations (fraud / ghostwriting / exam sitting / porn, gambling, politics) | `permanent_ban` on the first offence | Applied immediately |

Counting rules:
- Only includes records where `reports.status = decided` and the ruling was upheld (`penalties` with `status != revoked`).
- Minor violations expire on a 12-month rolling window; 6 consecutive clean months clear one count; severe violations are kept forever.
- A successful appeal sets the penalty to `revoked` and rolls back the credit score (a reversing `credit_logs` entry is written; history is never edited).

## 3. Four-level banned-word handling (`banned_word.penalty`)

| Level | Examples | Action |
| --- | --- | --- |
| L1 prompt | Phone numbers, WeChat IDs, QQ | Publishing is allowed but the text is masked and the user is warned |
| L2 block | Traffic-pulling ads, external links, QR codes | Blocked with a request to edit |
| L3 violation | Pirated copies, answer keys, ghostwriting, exam sitting, fake orders | Blocked + −3 score + 1 violation recorded |
| L4 severe | Porn, gambling, politics, fraud, abuse | Content deleted + escalated to a human ticket + ban depending on severity |

Cumulative escalation: 3 L1 prompts on the same day → 1-day mute; 3 cumulative L2/L3 hits → 7-day mute; 5 cumulative hits → 30-day posting ban.
Detection covers: threads, comments, direct messages, personal bios, image OCR and AI support sessions. Hits are recorded in `word_hits` (word, position, action taken).
Allowlist: false positives on textbook titles can be excluded via `banned_words.scope = school` with `status = whitelist`, or by configuring per-school allowlist words.
