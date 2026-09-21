# 设计文档 · Design documents

**简体中文** | [English](./en/README.md)

本目录是「校园教材循环」平台的设计文档，每篇都提供完整英文版（见 [`docs/en/`](./en/README.md)）。
主仓库说明见 [README.md](../README.md) 与 [README.en.md](../README.en.md)。

| # | 简体中文 | English | 主题 |
| --- | --- | --- | --- |
| 01 | [需求拆解与范围](./01-需求拆解与范围.md) | [Requirements and scope](./en/01-requirements-and-scope.md) | 业务定位、RBAC 角色、一期范围、硬性约束、交易状态机、信誉档位 |
| 02 | [技术选型说明](./02-技术选型说明.md) | [Technology choices](./en/02-technology-choices.md) | 选型清单与关键取舍（防超卖、余额由流水推导、规则配置化、多校隔离、AI 权限边界） |
| 03 | [目录结构](./03-目录结构.md) | [Directory structure](./en/03-directory-structure.md) | 仓库结构、模块命名与分层约定 |
| 04 | [数据库 ER 设计](./04-数据库ER设计.md) | [Database ER design](./en/04-database-er-design.md) | 实体关系、33 张表的字段与约束、索引与性能要点 |
| 05 | [接口清单](./05-接口清单.md) | [API reference](./en/05-api-reference.md) | 接口约定、各模块接口与角色、错误码 |
| 06 | [多校隔离实现说明](./06-多校隔离实现说明.md) | [Multi-school isolation](./en/06-multi-school-isolation.md) | 三级防护、跨校专区、越权验证与常见坑 |
| 07 | [规则配置说明](./07-规则配置说明.md) | [Rule configuration](./en/07-rule-configuration.md) | 全部配置项与默认值、处罚梯度、四级违禁词 |
| 08 | [分阶段交付与验证](./08-分阶段交付与验证.md) | [Phased delivery and verification](./en/08-phased-delivery-and-verification.md) | 各阶段交付物与验证方法、端到端验收清单、失败排查 |
| 09 | [支付与小程序上线合规建议](./09-支付与小程序上线合规建议.md) | [Payment and mini-program compliance](./en/09-payment-and-mini-program-compliance.md) | 真实支付前提、代码对接点、小程序上线合规 |
