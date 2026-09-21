# Design documents · 设计文档

**English** | [简体中文](../README.md)

This directory holds the full English translations of the platform design documents.
The Chinese originals live in the parent `docs/` folder — see [`docs/README.md`](../README.md).

| # | English | 简体中文 | Topic |
| --- | --- | --- | --- |
| 01 | [Requirements and scope](./01-requirements-and-scope.md) | [需求拆解与范围](../01-需求拆解与范围.md) | Business positioning, RBAC roles, in/out of scope, hard constraints, trading state machine, credit tiers |
| 02 | [Technology choices](./02-technology-choices.md) | [技术选型说明](../02-技术选型说明.md) | Stack choices and key trade-offs (overselling, ledger-derived balances, configurable rules, isolation, AI boundaries) |
| 03 | [Directory structure](./03-directory-structure.md) | [目录结构](../03-目录结构.md) | Repository layout, module conventions, layering rules |
| 04 | [Database ER design](./04-database-er-design.md) | [数据库 ER 设计](../04-数据库ER设计.md) | Entity relationships, all 33 tables with key fields and constraints, indexing notes |
| 05 | [API reference](./05-api-reference.md) | [接口清单](../05-接口清单.md) | Conventions, every endpoint by module, roles and error codes |
| 06 | [Multi-school isolation](./06-multi-school-isolation.md) | [多校隔离实现说明](../06-多校隔离实现说明.md) | Three-layer isolation, cross-school zone, verification tests, pitfalls |
| 07 | [Rule configuration](./07-rule-configuration.md) | [规则配置说明](../07-规则配置说明.md) | Every config key and default, penalty ladder, four-level banned words |
| 08 | [Phased delivery and verification](./08-phased-delivery-and-verification.md) | [分阶段交付与验证](../08-分阶段交付与验证.md) | Phase-by-phase deliverables, verification steps, end-to-end checklist, troubleshooting |
| 09 | [Payment and mini-program compliance](./09-payment-and-mini-program-compliance.md) | [支付与小程序上线合规建议](../09-支付与小程序上线合规建议.md) | Real payment prerequisites, integration points, mini-program launch compliance |

See also: [main README (English)](../../README.en.md) · [主 README（中文）](../../README.md)
