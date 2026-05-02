# RFCs

Kitora 的重大架构决策都以 RFC 形式记录。RFC 不是"事后补的设计文档"——它是**动手写代码之前**的提案，落地后只更新状态字段，**不重写历史**，让未来的你能看到当时的权衡。

> 工作约定：动手做任何会跨多个 PR、影响数据模型、影响安全合规、或会引入新供应商的工作之前，**先写 RFC**；RFC 不需要写得完美，但要把"为什么是这条路而不是另一条路"讲清楚。

## 索引

| 编号                                   | 标题                                                        | 状态                                 | 目标版本      | 摘要                                                               |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------ | ------------- | ------------------------------------------------------------------ |
| [0001](./0001-organizations.md)        | 多租户 / 团队协作（Organizations）                          | **Implemented** (2026-04-26)         | 0.1.0 → 0.2.0 | 把所有租户资源从挂在 `User` 改为挂在 `Organization`，支持 B2B 协作 |
| [0002](./0002-security-compliance.md)  | 安全合规进阶（2FA / Active Sessions / 数据导出 / 注销宽限） | **Implemented** (2026-04-26)         | 0.2.0 → 0.3.0 | TOTP 2FA、设备会话列表、GDPR 数据导出、30 天注销宽限、Org 强制 2FA |
| [0003](./0003-webhooks-and-openapi.md) | 出站 Webhook & OpenAPI 文档站                               | **Implemented** (2026-04-26)         | 0.3.0 → 0.4.0 | HMAC 签名、重试退避、终态 sweep、OpenAPI 3.1 + Scalar              |
| [0004](./0004-sso.md)                  | SSO（SAML + OIDC + SCIM）                                   | **Implemented** (2026-04-26)         | 0.4.0 → 0.5.0 | BoxyHQ Jackson 接 SAML/OIDC，SCIM v2 用户自动 provision            |
| [0005](./0005-data-residency.md)       | 数据驻留 / 中国区（Multi-Region Share-Nothing）             | **Implemented** (2026-04-27, v0.6.0) | 0.5.0 → 0.6.0 | `KITORA_REGION` 进程常量 + 每行 region 列 + 跨区域只走 HTTP        |
| [0006](./0006-cn-region-deployment.md) | 中国区落地（ICP / 阿里云 / 支付宝微信 / DirectMail / OSS）  | **Implemented** (2026-04-26, 工程层) | 0.6.0 → 0.7.0 | CN 栈完全独立孪生，BillingEvent + Aliyun provider 全套接入         |
| [0007](./0007-webauthn-passkey.md)     | WebAuthn / Passkey（双轨：2FA 因子 + 密码快捷登录）         | **Implemented** (2026-04-26, v0.8.0) | 0.7.0 → 0.8.0 | Passkey 与 TOTP 同级 2FA 因子，登录页可选快捷入口                  |
| [0008](./0008-background-jobs.md)      | 通用 Background Jobs 抽象                                   | **Implemented** (2026-04-27, v0.9.0) | v0.9.0        | Postgres 队列 + 注册表式 handler + 外部 cron 驱动 + 指数退避       |

> 状态值约定：`Draft` → `Accepted` → `Implemented` → `Superseded`。`Draft` 写完待评审；`Accepted` 通过评审，正在写代码；`Implemented` 至少一个 PR 落地（同时把第一个落地版本写进"影响版本"）；`Superseded` 被新 RFC 替代，RFC 头部写明替代者编号。

## 写一份 RFC（最小模板）

新建 `docs/rfcs/<NNNN>-<slug>.md`，编号取**当前最大编号 + 1**，slug 用 kebab-case。

```markdown
# RFC NNNN — <标题>

| 状态     | **Draft**（YYYY-MM-DD）                           |
| -------- | ------------------------------------------------- |
| 作者     | <你的名字>                                        |
| 创建于   | YYYY-MM-DD                                        |
| 影响版本 | a.b.c → x.y.z（说明是否破坏性、是否需要数据迁移） |
| 关联     | RFC NNNN §X · README 路线图「phase-name」         |

---

## 1. 背景与目标

讲清楚现状、痛点、要解决的问题、要达成的指标。**不要直接写解决方案。**

## 2. 设计选项对比

至少列 2 个候选方案，每个方案给出"优点 / 缺点 / 适用场景"。这是 RFC 价值最高的部分。

## 3. 选择的方案

明确选 X，并说明为什么 X 比其他方案好。

## 4. 数据模型 / 接口契约

schema diff、新增 endpoint、event payload 等结构化变化。

## 5. 迁移与向后兼容

旧数据怎么办？灰度怎么放？回滚策略是什么？

## 6. 风险与开放问题

还没想清楚的、需要团队讨论的点。

## 7. 实施计划（PR 拆分）

PR-1 ... / PR-2 ... / PR-3 ...，每个 PR 独立可上线。
```

## 维护约定

- **状态字段必须维护**——RFC 落地了就把状态改 `Implemented`，停滞了就改 `Superseded` 或删（保留废弃 RFC 不如删干净）。状态变化时**同时更新本 README 索引表**。
- **影响版本**写实际的 `package.json` `version`，便于追溯哪个发布带来了哪些设计。
- **实现 commits / 实现 PR** 一行一行追加，便于将来 `git log` 复盘。
- 跨 RFC 引用用 `RFC NNNN §X` 的格式，不要复制粘贴大段内容——保持单一事实源。
- RFC 落地后**不删除中间方案的对比**——这是它最大的价值。
