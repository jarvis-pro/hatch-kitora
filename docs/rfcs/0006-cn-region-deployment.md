# RFC 0006 — 中国区落地（ICP 备案 · 阿里云栈 · 支付宝/微信支付 · DirectMail · OSS · SLS）

| 状态     | **Draft**（2026-04-26）                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 作者     | Jarvis                                                                                                                                                                                            |
| 创建于   | 2026-04-26                                                                                                                                                                                        |
| 影响版本 | 0.6.0 → 0.7.0（非破坏性，新增 provider 实现 + 新增部署 pipeline；不动 schema）                                                                                                                    |
| 关联     | RFC 0001 §10「region 占位」· RFC 0002（数据导出 / 删除合规 / 跨境）· RFC 0003（webhook 出站合规）· RFC 0004 §9「中国区 SSO」· RFC 0005（Multi-region share-nothing）· README 路线图「中国区起步」 |

---

## 1. 背景与目标

RFC 0005 把 codebase 改造成了**可在不同 region 独立部署**的形态：`KITORA_REGION` 进程常量、Region 枚举入 schema、`(email, region)` 复合唯一、provider factory 在 `src/lib/region/providers.ts` 留好接缝、`docker-compose.cn.yml` 占位、`docs/deploy/cn.md` 列出采购清单。**所有针对 CN 的代码分支今天一律抛 `*-not-implemented in v0.6.0`**——这是 RFC 0005 §4.2 故意为之的「逼着 RFC 0006 把 Aliyun 三件套配齐才能上线」。

本 RFC 就是**把那三件套 + 备案 + 域名 + 部署 pipeline 配齐**的工程项目。

**目标**（v1，本 RFC 落地范围）：

- **合规与资质**：ICP 备案 / 公安部备案 / Aliyun 企业实名 / `kitora.cn` 域名注册 全部通过，备案号写入 `ICP_NUMBER` / `PUBLIC_SECURITY_NUMBER`，footer 渲染（已通过 `isCnRegion()` 条件渲染就绪）。
- **基础设施落地**：Aliyun ACK（cn-shanghai）+ RDS for PostgreSQL + Aliyun Redis + OSS bucket + DirectMail 子域 + SLS 日志项目，全部位于 cn-shanghai region，VPC 内联通；外部入口走 Aliyun SLB + Aliyun WAF。
- **Provider 实现**：填补 `src/lib/region/providers.ts` 的 CN 分支——`AliyunDirectMailProvider` 替代 Resend、`AliyunOssProvider` 替代 S3、`AlipayProvider` + `WechatPayProvider` 从今天的 `throw not-implemented` 走到产线可用（hosted checkout + 异步通知 + 退款）。
- **限流后端切换**：`src/lib/rate-limit.ts` 在 CN region 切到 Aliyun Redis SDK，不再依赖 Upstash REST（Upstash 在 CN 出口慢且不稳）。
- **监控与告警**：Sentry CN 自托管/代理 + Aliyun SLS 索引化 + Prometheus 在 ACK 内部抓取 + 钉钉告警。
- **CI/CD pipeline**：Aliyun ACR 镜像仓 + GitHub Actions 推镜像（带 `KITORA_REGION=CN` build-arg）+ ACK kubectl rollout。
- **首包合规检查**：启动时 panic 校验（已在 `src/instrumentation.ts` 就绪）+ 出境流量审计 + 用户侧明示「这是 Kitora 中国区，与 kitora.io 是独立账号体系」。

**非目标**：

- ❌ **跨 region 账号迁移工具**——RFC 0005 §1 已明确不做，本 RFC 不重新挑起。
- ❌ **跨境数据共享**——share-nothing 是底线。任何「中国 org 看一眼海外 org」的特性一律走出站 webhook，按 RFC 0003 的合规模型走（用户配置的 endpoint，监管视角属于用户行为）。
- ❌ **中国区 SSO 集成（飞书 / 钉钉 / 企业微信）**——RFC 0004 §9 占位，本 RFC 不做。SAML / OIDC 的 IdP 自配能力已经能让企业客户接入自家 SSO；飞书 / 钉钉 / 企业微信原生 OAuth 留给 follow-up RFC 0008+。
- ❌ **WebAuthn / Passkey**——RFC 0002 §1 与 RFC 0004 §1 早期占位曾把 WebAuthn 标到 RFC 0006，但 RFC 0005 §11 已把 0006 这个编号挪给 CN 部署。WebAuthn 顺延到 **RFC 0007**，是历史决策，不在本 RFC 范围。
- ❌ **多 CN 可用区 active-active**——首版只在 cn-shanghai 单 region。多 AZ 是 ACK 节点池层面的事（`zone-i` + `zone-j` 各放一个节点），不是应用层。
- ❌ **EU region 启用**——RFC 0005 §11 留的占位继续保留；EU 实际上线在 follow-up RFC 立项。
- ❌ **港澳台部署**——监管语境与中国大陆不同，不是「CN region」的一部分。如果未来要做，作独立 region（`HK` / `TW`）单独立项。

---

## 2. 设计原则

| 原则                    | 解释                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **share-nothing 不动**  | RFC 0005 已经定的 share-nothing 是合规红线，本 RFC 严格沿用。任何「跨 region 数据查询」一律不做，宁可在两边各写一份冗余。                                               |
| **provider 实现可回滚** | 每个 CN provider 都先在 staging 跑 1 周，gate 在 `*-not-implemented` 抛错与正常返回之间；切换不需要改 caller。                                                          |
| **基础设施代码化**      | 阿里云资源（VPC / 安全组 / RDS / Redis / OSS / SLS / SLB）一律走 Terraform（`infra/aliyun/`），不接受控制台 click-ops 进生产。                                          |
| **VPC 内闭环**          | App ↔ DB / Redis / OSS / DirectMail / SLS 全部 VPC 内网调用，公网入口只有 SLB + WAF。RDS 公网端点仅在迁移窗口临时开启，迁完立刻关。                                     |
| **配置不入镜**          | 所有 secrets（DB 密码、API key、Alipay 私钥）放 Aliyun KMS / ACK secrets，不进镜像、不进 Git。Dockerfile 只接受 `KITORA_REGION` 一个 build-arg。                        |
| **监管可见性优先**      | 日志 / 审计 / 备案号 / 用户协议入口在 footer + `/legal` 二级页都可达；监管 spot-check 时 5 分钟内能拿出对应记录。                                                       |
| **降级先于新建**        | 凡是 GLOBAL 已经有的能力（Stripe checkout、Resend 发信、S3 导出）在 CN 都按**对等**实现，不在 CN 开新功能；功能差异只允许是「CN 独有的合规项」（备案、PIPL 同意书等）。 |

---

## 3. 备案与资质（PR-0：先于代码）

> 这一段不是工程上要写的代码，是上线**前提条件**。RFC 0006 的工期 30+ 天，绝大部分卡在这里。

### 3.1 ICP 备案（工信部）

- **主体**：Kitora 在中国大陆的运营公司主体（如 Kitora 北京/上海/深圳子公司）；个人主体备案可以下来但**不允许**做经营性 SaaS（非经营性备案不能放支付按钮），必须企业主体。
- **接入商**：Aliyun（备案系统与 RDS / ACK 绑同一账号最方便）。
- **流程**：域名注册 → Aliyun 控制台提交备案 → 网站负责人手持身份证 + 营业执照拍照上传 → Aliyun 初审 → 提交工信部 → 短信验证 → 工信部审核 → 备案号下发。
- **预估**：**~20 工作日**（疫情后流程线上化，比早年快很多但仍是工期大头）。
- **风险**：备案被退回的常见原因——网站负责人电话不接、域名 whois 信息与备案主体不一致、网站内容与申报范围不符（备类目要选「软件 SaaS」/「企业服务」之一）。
- **挂阻**：备案号下不来，DNS 不能解析到大陆 IP，整个 CN stack 无法对外。备案期间走「IP 白名单内部测试」，host 文件改 IP，团队内部用 staging 域名测试。

### 3.2 公安部备案（公网安备）

- **触发条件**：ICP 备案下来后 30 天内必须到「公安部互联网安全管理服务平台」提交。
- **预估**：**~5 工作日**（材料齐全的话，部分省份 2–3 个工作日）。
- **产物**：`公网安备 XXXXXXXXXXXX 号` 一串数字 + 一段嵌入代码。代码已经在 `SiteFooter` 通过 `isCnRegion()` 条件渲染（RFC 0005 PR-3）。

### 3.3 等保（信息系统安全等级保护）

- v1 **不做等保过审**——等保 2.0 三级是面向「金融 / 医疗 / 教育 / 涉及大量公民信息」的强制要求；初期客群不到那个量级，按二级自评估即可。等保三级测评本身 30+ 万人民币费用，等真接到要求三级的客户合同再立项。
- **影响代码**：等保最终下发时通常要求开 SLB 7 层日志、加 WAF 规则、密码复杂度、敏感操作二次验证——前两项基础设施层即可，后两项已经被 RFC 0002（2FA + Active Sessions）覆盖。

### 3.4 PIPL（个人信息保护法）合规

- **隐私协议中文版**：`/legal/privacy-policy?region=cn` 必须独立一版，明示「数据存储在中国境内」「跨境传输需用户明示同意（v1 我们不传）」「数据控制者为 Kitora 中国公司主体」。
- **同意收集**：注册时弹一次「我已阅读并同意 PIPL 同意书」，存 `User.consents`（暂复用 `User.metadata` JSONB；PR-3 加专用列若需要）。
- **删除权**：RFC 0002 PR-4 的 30 天注销宽限已经覆盖 PIPL 第 47 条「不超过实现处理目的所必需的最短时间」要求，本 RFC 不再加新流程；只在 CN 模式下 footer 增加「行使个人信息权利」入口指向 `/legal/data-rights`，照着 PIPL 第 44 条要求列查询/更正/删除/可携权 4 个按钮（背后都是 RFC 0002 PR-3 已有的导出/删除接口）。

### 3.5 域名

- **kitora.cn** 通过 Aliyun 域名服务注册（CNNIC 认证注册商，备案可同时提交；境外注册商例如 GoDaddy 注册的 `.cn` 域名做不了 ICP）。
- **二级域名分配**：`app.kitora.cn`（应用入口）、`api.kitora.cn`（公开 REST API + 公开 webhook 接收，与 GLOBAL 的 `app.kitora.io` 对应）、`mail.kitora.cn`（DirectMail 子域 + DKIM/SPF）、`status.kitora.cn`（健康页面）。
- **TLS**：Aliyun SSL 证书服务签 DV 证书，Cert-manager 在 ACK 自动续期；不引入 Let's Encrypt（CN 出口到 LE OCSP responder 的稳定性达不到 SLA）。

---

## 4. 阿里云基础设施拓扑

```
                                 ┌───────────────────────────────────────────┐
                                 │            Aliyun cn-shanghai             │
                                 │                                           │
                                 │   ┌──────────────────────────────────┐    │
   browsers ───▶  Aliyun WAF ───▶│   │ Aliyun SLB (HTTPS / TCP)         │    │
                                 │   └──────────────────────────────────┘    │
                                 │                  │                        │
                                 │                  ▼                        │
                                 │   ┌──────────────────────────────────┐    │
                                 │   │   ACK (Kubernetes 1.30+)         │    │
                                 │   │   ── kitora-cn-app (3 replicas)  │    │
                                 │   │   ── kitora-cn-cron (1 replica)  │    │
                                 │   │   ── prometheus + grafana        │    │
                                 │   └──────────────────────────────────┘    │
                                 │           │       │       │      │        │
                                 │           ▼       ▼       ▼      ▼        │
                                 │   ┌────────┐ ┌────────┐ ┌────┐ ┌──────┐   │
                                 │   │ RDS PG │ │ Redis  │ │OSS │ │ SLS  │   │
                                 │   └────────┘ └────────┘ └────┘ └──────┘   │
                                 │           │                                │
                                 │           ▼                                │
                                 │   ┌──────────────────────────────────┐    │
                                 │   │  DirectMail · Alipay · WeChat Pay│    │
                                 │   │  （HTTPS 出公网到阿里云端点）     │    │
                                 │   └──────────────────────────────────┘    │
                                 └───────────────────────────────────────────┘
```

### 4.1 网络

- **VPC**：`vpc-kitora-cn-shanghai`，CIDR `10.40.0.0/16`。两个 vSwitch，一个在 zone-i（`10.40.1.0/24`），一个在 zone-j（`10.40.2.0/24`），跨可用区。
- **安全组**：
  - `sg-public-slb`：22 / 80 / 443 入；只挂 SLB ENI。
  - `sg-app`：仅接受来自 `sg-public-slb` 的 3000 端口；出站任意（要打 DirectMail / Alipay / WeChat Pay 公网端点）。
  - `sg-data`：仅接受来自 `sg-app` 的 5432 / 6379；不开公网。
- **NAT 网关**：1 个，绑 1 个公网 EIP，作为 app 出公网调 Alipay / WeChat / DirectMail / Sentry 的统一出口（监管视角 IP 单一可审计）。

### 4.2 ACK 集群

- **版本**：Kubernetes 1.30+（Aliyun ACK 长期支持版）。
- **节点池**：2 个节点，`ecs.g7.large`（4c8g），均价 ¥220/月/台；起步够用，3 个 app pod + 1 cron pod + monitoring 在 8c16g 内宽裕。后续按指标加节点。
- **入口**：Nginx Ingress + cert-manager（自签 + Aliyun SSL 证书的 dual-source）。
- **PodDisruptionBudget**：app 至少 2 副本可用；deployment rollout 策略 `maxUnavailable=1, maxSurge=1`。

### 4.3 RDS PostgreSQL

- **规格**：`pg.n2.xlarge.2c`（4c8g 200GB SSD），主备双节点，自动故障切换。
- **版本**：PostgreSQL 16（与 GLOBAL 对齐；schema migration 走同一套 Prisma migration）。
- **网络**：仅 VPC 内网端点，公网端点临时开启在迁移窗口（PR-2 §部署），迁完关闭。
- **备份**：每日全量 + WAL 持续归档（Aliyun 默认开启），保留 7 天。**备份不出境**——Aliyun RDS 自然就在境内，比自托管 + 跨境备份省事。
- **慢查询**：开 `pg_stat_statements`，与 GLOBAL 相同。

### 4.4 Aliyun Redis

- **规格**：`redis.amber.standard.smaller.default`（1GB 主备），起步够 rate-limit + session cache。
- **协议**：标准 Redis 6 协议；上 TLS（`6380` 端口）。
- **替换 Upstash**：见 §5.4。

### 4.5 Aliyun OSS

- **Bucket 命名**：
  - `kitora-cn-prod-data-export`（RFC 0002 PR-3 的 user/org 数据导出 zip）
  - `kitora-cn-prod-uploads`（用户头像 / 附件等，预留）
- **访问**：默认 private，预签名 URL 出（与 RFC 0002 PR-3 在 GLOBAL 走 S3 一致）。
- **生命周期**：data-export bucket 7 天后自动转 IA + 30 天后自动删（用户下载链接默认 7 天有效，下载完即可丢）。
- **跨地复制**：**关闭**——开了等于把数据复制到境外或其他境内 region，与 share-nothing 冲突。

### 4.6 DirectMail

- **域名**：`mail.kitora.cn` 作为发件域；DKIM / SPF / DMARC 三件套配齐（Aliyun 控制台一键生成 DNS 记录）。
- **回信地址**：`noreply@mail.kitora.cn`，bounce 收到 `bounce@mail.kitora.cn` 由 DirectMail 内部消化。
- **配额**：起步包月 100k 封 / 月，¥0.001 / 封 超额，远低于业务封顶。

### 4.7 SLS（日志服务）

- **Project**：`kitora-cn-prod`，所在 region `cn-shanghai`。
- **Logstore**：
  - `app-logs` —— 应用 stdout / stderr（pino-pretty 转 JSON 入 SLS）。
  - `audit-logs` —— RFC 0001 PR-2 的 `AuditLog` 表 nightly 导出 + RFC 0002 PR-1 的 `DeviceSession` 创建/撤销事件。SLS 端对 `region = CN` 做索引前缀（与 schema 索引 `(region, createdAt)` 一致）。
  - `access-logs` —— SLB 7 层访问日志，等保 2.0 二级要求保留 6 个月。
- **保留**：app-logs 30 天 / audit-logs 180 天 / access-logs 180 天。
- **不出境**：SLS 数据天然不出境（Aliyun 服务），但要确认 Sentry / Prometheus 远端不指向境外 endpoint。

---

## 5. Provider 实现详细方案

### 5.1 AliyunDirectMailProvider（取代 Resend）

**目标**：CN region 下 `sendEmail(...)` 走 DirectMail，shape 与 Resend 等价（`from / to / subject / html / text / replyTo`）。

**接入**：

- 用 Aliyun 官方 Node SDK：`@alicloud/dm20151123` + `@alicloud/openapi-client`。
- 鉴权：AccessKeyId + AccessKeySecret 通过 STS 短期凭证（ACK Service Account 绑 RAM Role），不进镜像。
- 实现位置：新增 `src/lib/email/aliyun-direct-mail.ts`，导出 `aliyunDirectMailClient.send(params)`。
- `src/lib/email/send.ts` 改造：
  ```ts
  export async function sendEmail(params: SendEmailParams) {
    const html = await render(params.react);
    const text = await render(params.react, { plainText: true });
    if (isCnRegion()) {
      return aliyunDirectMailClient.send({ ...params, html, text });
    }
    return resendClient.send({ ...params, html, text });
  }
  ```
  分支放在 `sendEmail()` 一个函数里，不在每个调用方判断。
- `getEmailProvider()` 在 CN 分支不再 `throw`，而是返回 `{ id: 'aliyun-direct-mail' }`。

**坑**：

- DirectMail 的「单地址」与「批量地址」是两个 API（`SingleSendMail` vs `BatchSendMail`）。模板邮件用 `BatchSendMail` 反而更慢（要先建模板），全部走 `SingleSendMail` 即可，单次最多 100 收件人。
- DirectMail 的发件配置叫 `AccountName`（即「发件人地址」，必须先在控制台新建并验证），不是 SDK 调用时随便填。Migration 步骤包括「在 DirectMail 控制台创建 `noreply@mail.kitora.cn` 发件人」。
- DirectMail 不支持 `replyTo`——SDK 字段叫 `ReplyToAddress`，**值必须也是 DirectMail 已验证发件地址**。如果业务需要 reply 到非 DirectMail 域（例如 `support@kitora.cn`），需要另把 `support@mail.kitora.cn` 验证为发件地址，或者降级——v1 接受这一点，`replyTo` 在 CN 不传时静默忽略。

### 5.2 AliyunOssProvider（取代 S3）

**目标**：CN region 下数据导出 zip 写入 OSS，预签名 URL 让用户下载。RFC 0002 PR-3 已经把 caller 抽到 `storage.putObject(...)` / `storage.getSignedUrl(...)` 接口；本节只做新实现。

**接入**：

- 用 `ali-oss` SDK（npm `ali-oss`，官方），不用通用 S3 兼容层（OSS 的 S3 兼容协议在签名细节上有兼容坑）。
- 实现位置：新增 `src/lib/storage/aliyun-oss.ts`，实现 `StorageProvider` 接口（`putObject` / `getObject` / `getSignedUrl` / `deleteObject`）。
- `getStorageProvider()` CN 分支返回该 provider 的单例。

**鉴权**：AccessKey + Secret 通过 STS（同 §5.1），STS 凭证 60 分钟自动续。Pod 启动时通过 ACK 注入的 `ALIYUN_ROLE_ARN` 走 AssumeRole 拿短期凭证；env.ts 新增可选 `ALIYUN_OSS_BUCKET` / `ALIYUN_OSS_REGION` / `ALIYUN_OSS_ENDPOINT` 三项。

**预签名 URL**：

- OSS `signatureUrl()` 默认 v1 签名；强制升 v4：`new OSS({ ... authorizationV4: true })`。
- 默认有效期 7 天（与 RFC 0002 PR-3 在 S3 上的 7 天一致），与 OSS 生命周期 IA 转换一致。

**ETag 兼容性**：ali-oss 返回的 ETag 加引号；与 S3 SDK 一致，写入 `DataExportArchive.checksum` 时统一 strip 引号。

### 5.3 AlipayProvider 与 WechatPayProvider 完整实现

**当前状态**：两个 provider 都是 `throw new Error('alipay-not-implemented')` 占位。

**v1 范围**：仅做**月订阅 hosted checkout + 异步通知 + 退款**，不做：

- 实物订单 / 物流码 / 担保交易（与 SaaS 模型无关）
- 当面付 / 刷卡支付（线下场景，B2B SaaS 不需要）
- 跨境结算（CN merchant 无此能力）

#### 5.3.1 AlipayProvider

- SDK：`alipay-sdk` 官方 Node 包（v3）。
- **`createCheckoutSession(input)`**：
  - 调用「电脑网站支付」`alipay.trade.page.pay` 接口，返回前端跳转 URL。
  - `out_trade_no` = `kitora-{orgId}-{nonce}`（Kitora 侧业务订单号，幂等）。
  - `notify_url` = `https://api.kitora.cn/api/billing/alipay/notify`（异步通知）。
  - `return_url` = caller 传入的 `successUrl`。
  - 由于支付宝**不直接做订阅**，做法是：第一次扣款 = 成功支付一次；后续按月由我们的 cron 拿用户的「免密支付协议号」（`alipay.user.agreement.page.sign` 流程，首次签）扣款（`alipay.trade.create` + `agreement_id`）。这个流程相当于「订阅 = 协议 + 周期性 charge」，业务层正常感知 `Subscription` 状态机。
- **`createPortalSession(input)`**：
  - Alipay 没有 Stripe Customer Portal 的对应物。我们走自建：返回 `successUrl + '?portal=alipay'` 让 Next.js 内的 `/billing/cn-portal` 页面渲染——展示当前协议号、解约按钮（调 `alipay.user.agreement.unsign`）、近 12 个月支付流水（已经在订阅表内）。
  - 这个自建页对齐 Stripe Portal 用户体验（90% 用户只需要看「下次扣款时间 + 取消订阅」），不算降级。
- **异步通知签名校验**：用 SDK 自带 `alipay.checkNotifySign(params)`。校验失败的请求不入库、不回复。
- **退款**：`alipay.trade.refund` 同步调用，幂等键 `out_request_no`。
- **签约 / 解约 webhook**：分别命中 `/api/billing/alipay/sign-notify` 与 `/api/billing/alipay/notify`，更新 `Subscription.cnAgreementId`（新加列，§6.1）+ status。

#### 5.3.2 WechatPayProvider

- SDK：`wechatpay-node-v3` （社区维护，APIv3），不用 v2（v2 已经停止新增功能）。
- **`createCheckoutSession(input)`**：
  - 调用「Native 支付」`pay/transactions/native` 拿 `code_url`（一段 weixin:// 协议串），前端用 qrcode.react 渲染二维码弹窗。OR：「JSAPI 支付」`pay/transactions/jsapi` 走公众号 / 小程序内调起，但 SaaS 用户用浏览器扫码更通用，所以 v1 只做 Native。
  - `out_trade_no` 命名同 Alipay；`notify_url` = `https://api.kitora.cn/api/billing/wechat/notify`。
  - 微信支付的「订阅」叫**周期扣款（pap）**，签约接口 `papay/contracts`；流程与 Alipay 类似（先签约拿合同号，cron 周期 charge）。
- **`createPortalSession(input)`**：自建 `/billing/cn-portal` 同上，区分 provider 渲染对应的合同管理 UI。
- **签名验证 + 通知解密**：APIv3 的回调 body 是 AES-GCM 加密的，必须用商户证书私钥解密；`wechatpay-node-v3` 自带 `WechatpayUtility.decryptResource(...)`。
- **退款**：`refund/domestic/refunds`，同步调用，幂等键 `out_refund_no`。

#### 5.3.3 共用：webhook 入站统一管线

- 新建 `src/app/api/billing/[provider]/notify/route.ts`，按 `provider ∈ {'alipay','wechat'}` 路由。
- 入站 → 验签 → 查 `out_trade_no` 关联的 `Subscription` → 落 `BillingEvent`（已有表，RFC 0001 PR-2 引入）→ 按事件类型 emit RFC 0003 的出站 webhook（`subscription.created/updated/canceled`）。
- 通知幂等：`BillingEvent` 唯一键 `(provider, providerEventId)`，重投递直接 200 OK。
- **回应文体**：Alipay 期望 `success` 字符串，WeChat APIv3 期望 `{"code":"SUCCESS","message":"OK"}` JSON——按 provider 各自回应。

### 5.4 限流后端切换：Upstash → Aliyun Redis

**问题**：`src/lib/rate-limit.ts` 当前用 `@upstash/ratelimit` + `@upstash/redis`（REST 协议）。CN 出公网到 Upstash AWS region 延迟稳定 200ms+，而 rate-limit 在 hot path 上（每个 API 请求都打），不能这样。

**方案**：

- 在 CN region，把 limiter 换成 `ioredis` + `@upstash/ratelimit` 的「自托管 Redis」分支（`@upstash/ratelimit` 支持非 Upstash 后端：`new Ratelimit({ redis: new RedisClient(ioredis) })`，但 ratelimit lib 自带的 `Redis` interface 只兼容 Upstash REST shape，所以实际上要换成 `rate-limit-redis` 或自写一个滑窗算法）。
- v1 实现选择：自写 `slidingWindow(redis, key, limit, window)` 函数 30 行，不引第三方包，避免再来一次依赖锁。
- `buildLimiter()` 改造：
  ```ts
  function buildLimiter(...) {
    if (isCnRegion()) {
      return buildAliyunRedisLimiter(prefix, requests, window); // ioredis-based
    }
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      return buildUpstashLimiter(prefix, requests, window);
    }
    return noopLimiter();
  }
  ```
- 新增 env：`ALIYUN_REDIS_URL`（VPC 内网端点 + 密码），通过 ACK secret 注入。

**不做**：把 GLOBAL 也切到自托管 Redis——Upstash 在 AWS 内同 region 延迟 5ms，体验比自托管好；切了等于回退。

### 5.5 Sentry / Prometheus

- **Sentry**：CN region 上线 self-hosted Sentry on Aliyun ECS（一台 4c16g 起步），DSN 指向 `https://sentry.kitora.cn`。**不**直接用 Sentry SaaS 海外端点（出口慢 + 数据出境）。
  - 替代方案：Aliyun ARMS（应用实时监控）原生即可——但 Sentry 在 source-map 处理 / 前端错误堆栈层面更成熟，自托管的运维成本可接受（每月节点 ¥600 上下）。
- **Prometheus**：在 ACK 内置部署，scrape `/api/metrics`（已有，RFC 0003 PR-4），存储 Aliyun NAS 30 天，告警走 AlertManager → 钉钉机器人 webhook。
- **健康探测**：`/api/health` 已就绪（DB + Redis 双探），SLB 健康检查指向它。

---

## 6. 数据模型变更

本 RFC **不动 Prisma schema 的现有表结构**——RFC 0005 已经把 `region` 列加齐，足够支撑 CN region。

### 6.1 唯一新增列（Subscription.cnAgreementId）

```prisma
model Subscription {
  // ... 现有字段
  // RFC 0006 — 中国区扣款协议号。Stripe 用 customerId/subscriptionId
  // 完成订阅状态机；Alipay/WeChat 没有「订阅对象」，只有「免密扣款合同号」。
  // Stripe 路径下此列为 null。
  cnAgreementId    String?
  @@index([cnAgreementId])
}
```

迁移：`prisma/migrations/20260601000000_add_cn_agreement_id/`，纯加列 + 索引，零回填，秒级。

### 6.2 BillingEvent 复合唯一键扩 provider

RFC 0001 PR-2 引入的 `BillingEvent.providerEventId @unique` 在 GLOBAL 下指 Stripe event id；CN 下要换成 `(provider, providerEventId)` 复合唯一，避免 stripe / alipay / wechat 三家事件 id 撞库。

```prisma
model BillingEvent {
  provider         String  // 'stripe' | 'alipay' | 'wechat'
  providerEventId  String
  @@unique([provider, providerEventId])  // 替换原 providerEventId @unique
}
```

迁移：先加 `provider` 列默认 `'stripe'` 回填；再 drop 旧 unique；再加新复合 unique。**不破坏**线上 Stripe 事件历史（默认值即正确语义）。

### 6.3 不加的列

讨论过的、最后决定不加的：

- `Organization.cnLicense`（CN 客户的营业执照号 / 税号）—— v1 不做发票闭环，Alipay/WeChat 的电子发票走商家后台手开，不入库。等真有 B2B 开票闭环需求再加。
- `User.pipliConsentAt` —— PIPL 同意时间戳。`User.consents` 字段已经有 JSONB，存进去即可，不再开新列。
- `IdentityProvider.cnVendor`（飞书 / 钉钉 / 企业微信）—— RFC 0004 §9 留的非目标，本 RFC 也不动。

---

## 7. 部署 pipeline

### 7.1 Dockerfile build-arg

`Dockerfile` 已在 RFC 0005 PR-3 接受 `KITORA_REGION` build-arg；本 RFC 不改，仅在 CI 中传值：

```yaml
# .github/workflows/deploy-cn.yml（新增）
- run: docker buildx build \
    --build-arg KITORA_REGION=CN \
    --tag registry.cn-shanghai.aliyuncs.com/kitora/app:${{ github.sha }} \
    --push .
```

### 7.2 GitHub Actions → Aliyun ACR → ACK

- Workflow `deploy-cn.yml` trigger：`main` 分支打 tag `cn-v*` 时启动（手工 promotion，不自动跟 GLOBAL 部署）。
- Step 1：build & push 到 Aliyun ACR `registry.cn-shanghai.aliyuncs.com/kitora/app:${sha}`。Aliyun ACR access token 通过 GitHub OIDC + Aliyun RAM 配的 trust policy 拿，**不**用长期 AccessKey 入 Secret。
- Step 2：`kubectl set image deployment/kitora-cn-app app=...:${sha} -n kitora` + `kubectl rollout status`，5 分钟超时。
- Step 3：rollout 后跑 e2e smoke（在 CN 集群跑一份精简 Playwright，覆盖：登录、创建 org、订阅 hosted checkout 跳转 Alipay sandbox 拿到合法 URL、发一封测试邮件、撤销 session）。Smoke 失败自动回滚（`kubectl rollout undo`）。

### 7.3 GLOBAL 与 CN 双轨工作流

- 主 workflow（GLOBAL 现有 `deploy.yml`）不动；CN workflow 独立。
- 同一 git commit 可以在两个 region 独立 promotion——这是 RFC 0005 share-nothing 的天然好处。
- secrets：GitHub Actions 配 `ALIYUN_ACR_OIDC_ROLE_ARN` / `ACK_KUBECONFIG_CN`；GLOBAL 沿用 AWS / Vercel。

### 7.4 数据迁移与首批数据

CN region 首次启动时**没有任何数据**——RFC 0005 §1 已明确不做跨 region 迁移。`prisma migrate deploy` 在新 RDS 上跑全量 migration（含 RFC 0001–0005 与本 RFC 6.1/6.2），库进入空白可用状态。后续注册由用户从 `kitora.cn` 自助完成。

---

## 8. 监管与可审计性补丁

### 8.1 出境流量审计

新增 `scripts/audit-egress.ts`（dev-time + CI 检查）：

- 扫描 `src/`，列举所有 `fetch(...)` / SDK 调用的 URL。
- 黑名单：CN region 下不允许出现 `*.amazonaws.com` / `*.upstash.io` / `*.resend.com` / `api.stripe.com` / `*.sentry.io`（除非走自托管子域）。
- 黑名单触发 → `pnpm typecheck` 链路中报错。
- 这是「应用层防止数据出境」的最后一道闸——provider factory 是第一道，CI 是第二道。

### 8.2 footer 与 `/icp` 公示页

- footer 在 CN region 渲染 `<ICP_NUMBER>` 与 `<PUBLIC_SECURITY_NUMBER>` 已就绪（RFC 0005 PR-3）。
- `/icp` 路由在 GLOBAL 下 404，CN 下渲染备案信息 + 主体名称 + 联系电话 + 监管投诉入口（`12377.cn`）。

### 8.3 PIPL 合规入口

- `/legal/data-rights`（CN-only 路由），4 个按钮：查询 / 更正 / 删除 / 导出，背后调用：
  - 查询 → 跳 `/settings/account`
  - 更正 → 跳 `/settings/account#profile`
  - 删除 → 跳 `/settings/account#danger`（已有 30 天宽限注销，RFC 0002 PR-4）
  - 导出 → 跳 `/settings/data-export`（已有 zip 异步导出，RFC 0002 PR-3）
- 没有新业务逻辑，只是把 PIPL 第 44 条要求的 4 个权利**集中入口**显式列出来。监管检查时直接给链接即可。

---

## 9. PR 拆分

| PR   | 范围                                                                                                                                        | 估时                     | 依赖                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------- |
| PR-0 | **非代码**：ICP 备案 + 公安备案 + Aliyun 实名 + 域名注册 + DirectMail 域名验证                                                              | ~25 工作日（备案占大头） | —                                  |
| PR-1 | Terraform IaC（`infra/aliyun/`）：VPC / 安全组 / RDS / Redis / OSS / SLS / ACK / SLB / WAF / KMS。一次 `terraform apply` 拉起整个 CN 栈。   | 3–4 天                   | PR-0 完成                          |
| PR-2 | `AliyunDirectMailProvider` + `AliyunOssProvider` + `sendEmail` 改造 + `getEmailProvider` / `getStorageProvider` 去掉 `not-implemented` 抛错 | 2 天                     | PR-1（OSS bucket / DirectMail 域） |
| PR-3 | `AlipayProvider` + `WechatPayProvider` 完整实现 + `Subscription.cnAgreementId` 迁移 + `BillingEvent` 复合唯一迁移 + 入站 webhook 路由       | 4 天                     | PR-1                               |
| PR-4 | Rate-limit Aliyun Redis 后端 + `audit-egress.ts` CI 检查 + Sentry self-hosted + Prometheus / Grafana / 钉钉告警                             | 2 天                     | PR-1                               |
| PR-5 | `/legal/data-rights` 与 `/icp` 路由 + footer 文案 i18n + `deploy-cn.yml` GitHub Actions + smoke e2e + README & deploy/cn.md 收尾            | 1.5 天                   | PR-2 / PR-3 / PR-4                 |
| 合计 | 代码工程量                                                                                                                                  | ~12.5 天                 | （+25 工作日 PR-0 备案）           |

每个 PR 拒绝大杂烩——一个 commit 不跨 provider 域。

### 9.1 回滚

- PR-1：`terraform destroy`，整套阿里云资源销毁；不影响 GLOBAL。
- PR-2 / PR-3 / PR-4：每个 provider 实现都 gate 在 `isCnRegion()` 后，回滚是 revert commit。CN region 回到 `*-not-implemented` 抛错状态，paying flow 不可用，但服务本身仍可启动（登录 / dashboard 不挂）。
- PR-3 schema 迁移：`cnAgreementId` 加列回滚需 drop 列；`BillingEvent` 复合唯一回滚先 drop 新 unique、加回旧 unique、再 drop 列。两步迁移而非一步。
- PR-5：路由 / 文案改动，回滚是 revert commit。

---

## 10. 风险与对策

| 风险                                                       | 对策                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ICP 备案被退回，工期再加 20 工作日                         | 备案前一周让法务 / 合规过一遍材料；网站负责人电话保持 24h 在线；备案期间 IP 白名单内部测试不停                                             |
| Aliyun 账号实名审核未通过（公司证件不全）                  | PR-0 第一步就跑实名，给法务 5 个工作日预备                                                                                                 |
| Alipay / WeChat Pay 商户号开通要求线上实际产品 demo        | 准备 staging.kitora.cn 提前 1 个月部署到 Aliyun（用 staging 域名 + 临时 IP，备案不要求 staging 单独走）                                    |
| WeChat Pay APIv3 SDK 社区维护，碰 bug 需要自修             | 验收过后把 fork 钉到 monorepo `patches/`，pnpm `patchedDependencies` 锁版本                                                                |
| RDS 主备切换瞬时 DB 不可写                                 | 应用层 Prisma 默认 5s 重连；hot-path 写入（订单 / 支付通知）加 idempotent 重试 3 次                                                        |
| 阿里云 RAM Role 配错权限，Pod 拿不到 OSS / DirectMail 凭证 | PR-1 Terraform 把 RAM Role policy 写死并 e2e 验证；启动时打一封测试邮件 + 写一个测试 OSS object，失败立即 panic                            |
| 自托管 Sentry 节点宕机，CN 区错误漏报                      | 同节点上跑 alertmanager → 钉钉，监控 Sentry 自身的 systemd 状态；同时 app 端 `sentry.scope.captureException` 写 fallback log 到 SLS        |
| 用户跨 region 注册造成认知混乱（同邮箱 us / cn 两份账号）  | RFC 0005 §9 已覆盖；CN 注册页头部加横幅「Kitora 中国区独立账号体系，与 kitora.io 不互通」                                                  |
| 数据出境违规（被监管发现）                                 | §8.1 CI 出境扫描；运行时 provider factory 第一道闸；Sentry / SLS 告警「检测到对境外域名的 fetch」                                          |
| Alipay 协议签约用户取消但 cron 仍在按合同号扣款            | webhook `alipay.user.agreement.unsigned` 命中时立即把 `Subscription.cnAgreementId` 置 null + status=CANCELED；cron 入口先校验非空再扣      |
| WeChat Pay Native 二维码扫码后用户超时不付款               | `pay/transactions/native` 的 `code_url` 默认 2h 失效；前端定时器 5 分钟自动刷新二维码（重新拉单），与 `out_trade_no` 同业务订单号幂等      |
| ACK 节点池在工作日早晨被 Aliyun 重启（系统补丁）           | PodDisruptionBudget + 双副本 + readiness probe；rolling restart 用户感知 0 秒                                                              |
| 备案信息变更（公司搬家、负责人换人）需要重新走流程         | 文档化在 `docs/deploy/cn.md`「年度合规检查清单」；每年 12 月 review 一次                                                                   |
| 中国区监管要求年度等保测评（业务规模触达三级）             | 留出预算行；测评机构提前 6 个月对接，避免合同到期才开始走流程                                                                              |
| 跨境 webhook（出站 → 海外客户 endpoint）被认为是数据传输   | RFC 0003 出站 webhook 是「用户主动配置的 endpoint」，监管视角属于用户行为；隐私协议 §出站集成段落已写明                                    |
| GitHub Actions OIDC 在 CN 网络环境拉镜像超时               | ACR 配 VPC 端点；ACK 节点拉镜像走 VPC，不走公网 OIDC 链路；CI 推镜像本身依然走 GitHub Actions（Aliyun OIDC trust policy 已与 GitHub 互通） |

---

## 11. 工作量与时间表

```
W1   ┃ PR-0 启动：法务出主体、Aliyun 实名、域名注册、备案首次提交
W2   ┃ PR-0 备案审核中，PR-1 Terraform 在 staging 账号验证（不写到 prod）
W3   ┃ 备案号下发（乐观）/ 公安备案启动；PR-1 在 prod 账号 apply
W4   ┃ PR-2 + PR-3 + PR-4 并行（DirectMail / OSS / 支付 / 监控 / rate-limit）
W5   ┃ PR-5 收尾：legal 路由、CI、smoke e2e；staging.kitora.cn 内部 dogfood 一周
W6   ┃ 灰度切到 prod：先 IP 白名单内测，再 100% 公开；监管接口纳入文档
```

合计：**~6 周**（备案 4 周 + 工程 1 周 + 灰度 1 周）。

---

## 12. 待评审决策（Draft 阶段）

下列为 Draft 阶段尚未拍板的关键选项；落地前需在 PR-0 内决出。

- [ ] **运营主体公司放在哪个城市**（北京 / 上海 / 深圳 / 杭州）—— 影响备案管局、税收洼地、阿里云华东 vs 华南 region 选择。建议 **上海 + cn-shanghai**，与阿里云总部 region 距离一致，运营商出口给力。
- [ ] **Alipay 与 WeChat Pay 双开还是单开**——v1 双开会增加 PR-3 工期 1 天，但用户支付选择更宽。建议 **双开**，反正 SDK 都接入了。
- [ ] **Sentry 自托管 vs Aliyun ARMS**——自托管运维 ¥600/月，ARMS 按量付费但前端 source map 处理弱。建议 **Sentry self-hosted**。
- [ ] **CN 价格档位**——人民币 vs 美元报价，是否做地域价差。建议 **人民币定价独立 SKU**，价格不直接换算（汇率敏感）。这部分接 follow-up RFC（计费与定价）。
- [ ] **PIPL 同意书版本与法务签发**——本 RFC 提供模板入口，正文由法务出。备案前完成。
- [ ] **数据导出 zip 在 CN 是否加密** —— GLOBAL 走 S3 server-side encryption；OSS server-side encryption 默认开启。是否额外做用户自带密钥（BYOK）作为合规增强？建议 **v1 不做 BYOK**，OSS 默认加密满足 PIPL 第 51 条「采取必要的安全措施」。
- [ ] **微信支付 Native vs JSAPI 二选一** —— v1 选 Native（PC 浏览器扫码），后续若有移动端需求再加 JSAPI。建议 **v1 仅 Native**。
- [ ] **`audit-egress.ts` CI 检查阻断级别** —— `error`（CI 红线）vs `warn`（仅提示）。建议 **error**，否则形同虚设。

---

## 13. 与历史 RFC 的衔接

- **RFC 0001（Organizations）**：org 维度的资源完全沿用，`Subscription.cnAgreementId` 是 org 级订阅的 CN 增量字段。
- **RFC 0002（Active Sessions / 2FA / 数据导出 / 注销宽限）**：所有合规能力 in-place，CN region 复用即可；`/legal/data-rights` 把它们对外集中入口化。
- **RFC 0003（Webhooks / OpenAPI）**：CN region 的 OpenAPI 文档站 URL 改 `https://api.kitora.cn/docs/api`；webhook 出站走相同管线，签名 / 重试逻辑零修改。
- **RFC 0004（SSO）**：SAML / OIDC / SCIM 在 CN region 同样可用——客户的 IdP 是境内 IdP（飞书 / 钉钉 / 企业微信经 OIDC 转接，或 Okta CN edition），跨境 IdP 在合规视角属于用户配置范围。RFC 0004 §9 留的「飞书 / 钉钉 / 企业微信原生集成」仍是 follow-up。
- **RFC 0005（Multi-region share-nothing）**：本 RFC 是 0005 留下的 follow-up 第一个；落地后 0005 §11 决策项「CN 部署交付」从「待 RFC 0006」翻成「Implemented」。
- **WebAuthn / Passkey**：RFC 0002 / 0004 早期文本里的「RFC 0006 处理 WebAuthn」是 0005 重新分配编号前的占位，已**顺延到 RFC 0007**——这是历史决策，本 RFC 不修订旧 RFC 的占位文本（RFC 一旦 Implemented，叙事冻结）。

---

## 14. 实施完成（待 v0.7.0 上线后回填）

> 本节占位。PR-1 → PR-5 全部落地、CN 区灰度通过监管 spot-check 后，按 RFC 0001–0005 §「实施完成」体例回填：每个 PR 的 commit 区间、关键文件清单、未交付项标注、生产首日观测指标（订单数 / 邮件成功率 / OSS 写入延迟 / rate-limit 命中率）。
