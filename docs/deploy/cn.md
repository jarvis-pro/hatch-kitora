# 部署 — CN 区域 (kitora.cn)

> **状态**: 存根。真正上线付费 CN 栈的工作详见 RFC 0006。本文档是该 RFC 落地前必须完成的采购与备案清单。预计耗时约 30 个工作日，其中 ICP 备案单项约需 20 天。

CN 栈是 GLOBAL 栈的完全独立孪生版本（RFC 0005 §6）。它只服务中国大陆用户；跨区域数据流动被法规（网络安全法 / 数据安全法 / PIPL）和应用代码双重禁止（RFC 0005 §5）。

## 目标拓扑

```
                ┌────────────────────────────────────────────┐
                │      kitora.cn  (region: CN)               │
                │                                            │
   browsers ───▶│  Aliyun ACK Shanghai (Node 22)             │
                │   ▲                                        │
                │   │   ENV: KITORA_REGION=CN                │
                │   ├── Aliyun RDS PostgreSQL (cn-shanghai)  │
                │   ├── Aliyun Redis (cn-shanghai)           │
                │   ├── Aliyun OSS (cn-shanghai)             │
                │   ├── Aliyun DirectMail                    │
                │   ├── Alipay or WeChat Pay                 │
                │   └── Aliyun SLS (logs / audit)            │
                └────────────────────────────────────────────┘
```

## 备案与账户（RFC 0006 §1）

- [ ] **ICP 备案**（网信办）。在中国大陆将 `kitora.cn` A 记录指向任何服务器前必须完成。约 20 个工作日。通过阿里云备案门户申请（需先完成域名注册）。
- [ ] **公安部备案**（网安备）。ICP 备案通过后提交。约 5 个工作日。备案号写入 `PUBLIC_SECURITY_NUMBER`，页脚组件 `SiteFooter` 已通过 `isCnRegion()` 实现条件渲染。
- [ ] **阿里云企业账号**（已完成实名认证）。个人账号不能在生产环境承载 SaaS 服务。
- [ ] **域名 `kitora.cn`**，通过 CNNIC 认可的中国注册商注册。阿里云支持注册与备案一体化办理。

## 资源采购（RFC 0006 §2）

- [ ] **RDS for PostgreSQL** —— 最低规格待参考 GLOBAL 栈的实际负载画像后确定。`DATABASE_URL` 设置为 VPC 内网端点；公网端点仅用于执行迁移。
- [ ] **Redis** —— 阿里云托管 Redis。限流模块中的 `UPSTASH_REDIS_REST_URL` 替换为阿里云对应配置（RFC 0006 交付物）。
- [ ] **OSS 存储桶** —— 命名规范：`kitora-cn-<env>-data-export`。Bucket 策略与 S3 设置镜像；`aliyunOssProvider` 已接入 `src/lib/region/providers.ts` 中的 `getStorageProvider()`。
- [ ] **DirectMail** —— 阿里云事务邮件服务。在 `mail.kitora.cn` 完成发件人域名验证。
- [ ] **支付宝或微信支付商户账号**。provider 工厂的 CN 分支会选择其一（通过 `WECHAT_PAY_MCH_ID` 切换）。
- [ ] **SLS 日志项目** —— `recordAudit()` 写入的每条审计日志已携带 `region = CN`；SLS 索引位于 `cn-shanghai`，确保监管机构只能在境内看到日志。

## 区域配置

```env
KITORA_REGION=CN
```

需在以下位置同时设置：

- 阿里云 ACK 部署时（镜像以 `--build-arg KITORA_REGION=CN` 构建）；
- 阿里云 ACS 运行时环境映射；
- CN CI/CD 流水线。

启动时的守护逻辑（`assertRegionMatchesDatabase`）会在发现数据库中存在任何非 CN 组织行时直接 panic。这是防止 CN 集群配置错误后污染 GLOBAL 数据的唯一屏障。

## 代码已就绪内容（RFC 0006）

PR-2 / PR-3 / PR-4 / PR-5 在 v0.7.0 中合并；`src/lib/region/providers.ts` 中的 provider 工厂在 CN 分支上不再抛出异常：

- **`AliyunOssProvider`**（`src/lib/storage/aliyun-oss.ts`）基于 `ali-oss`@6+（v4 签名）实现了 `StorageProvider` 接口。`src/lib/storage/index.ts` 中的存储层在 `isCnRegion()` 为真时直接切换至该 provider，忽略 `DATA_EXPORT_STORAGE`。
- **`sendAliyunDirectMail()`**（`src/lib/email/aliyun-direct-mail.ts`）封装了 `@alicloud/dm20151123` 用于事务邮件发送。`src/lib/email/send.ts` 中的 `sendEmail()` 通过 `isCnRegion()` 分支选择发送方式。
- **`AlipayProvider` / `WechatPayProvider`**（`src/lib/billing/provider/`）实现了完整的托管结账、异步回调通知和退款流程。入站 Webhook 落地于 `src/app/api/billing/{alipay,wechat}/notify/route.ts`，通过 `BillingEvent` 表去重（RFC 0006 §6.2）。
- **`buildAliyunRedisLimiter()`**（`src/lib/rate-limit.ts`）在 `isCnRegion()` 为真时，用基于 `ioredis` 手写的 ZSET 滑动窗口替换 Upstash REST 限流器。
- **`/legal/data-rights`** 路由（仅 CN 可访问，其他区域返回 404）展示 PIPL §44 四项权利菜单（查询 / 更正 / 删除 / 可携带），路由至现有的设置流程。
- **`scripts/audit-egress.ts`** 扫描 `src/` 和 `scripts/` 中被禁止的主机引用；CI 在 CN 部署时以严格模式运行该脚本。
- **`.github/workflows/deploy-cn.yml`** 以 `KITORA_REGION=CN` build-arg 构建镜像，推送至 ACR，在 ACK 上滚动发布，对 `/api/health` 进行冒烟测试，失败时自动回滚。

以下内容需要真实采购（本 RFC 范围止于代码）：

- 9 个 `ALIYUN_*` / `ALIPAY_*` / `WECHAT_PAY_*` 环境变量必须填入真实的商户凭证，栈才能接受支付或发送邮件。
- ICP / 公安部备案完成前，DNS 无法解析。

## 后台任务定时调度（RFC 0008）

`BackgroundJob` 表通过阿里云托管 Kubernetes（ACK）中的 Kubernetes CronJob 驱动。此栈完全运行在 CN 境内，**不能**使用 Vercel Cron。

```yaml
# infra/aliyun/cronjob.yaml（使用 kubectl apply -f 部署，namespace = kitora-cn）
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jobs-tick
  namespace: kitora-cn
spec:
  schedule: '* * * * *' # 每分钟（UTC）
  concurrencyPolicy: Forbid # 若上一次 tick 仍在运行，则跳过本次
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 0 # 不自动重试；重试逻辑由 lib 层负责
      template:
        spec:
          serviceAccountName: kitora-jobs
          restartPolicy: Never
          containers:
            - name: jobs
              image: <ACR_REGISTRY>/kitora:<VERSION>
              command: ['pnpm', 'tsx', 'scripts/run-jobs.ts']
              envFrom:
                - secretRef:
                    name: kitora-env-cn
              resources:
                requests: { cpu: '100m', memory: '256Mi' }
                limits: { cpu: '500m', memory: '512Mi' }
```

注意事项：

- `concurrencyPolicy: Forbid` 是安全默认值。尽管 `FOR UPDATE SKIP LOCKED` 使数据库层面的并行 tick 是安全的，但在 K8s 层进行串行化可让可观测性更清晰（每分钟只有一行 `jobs-tick-complete` 日志，而非五行）。
- `backoffLimit: 0`：每个任务的重试 / 死信队列逻辑位于 `src/lib/jobs/runner.ts`。让 K8s 重试整个 CronJob Pod 会导致调度投影重复计算，以及错误累加 attempt 计数。
- 此处**不需要** `CRON_SECRET` —— CLI 入口不经过 `/api/jobs/tick`。CN 栈上保持该变量未设置即可。
- `defineSchedule(...)` 中的 cron 表达式均以 **UTC** 时区解释（RFC 0008 §4.3）。`'0 3 * * *'` 的删除清扫任务在 UTC 03:00 触发，即北京时间 11:00；如需在北京时间 03:00 执行，请将 `defineSchedule` 中的 cron 改为 `'0 19 * * *'`（UTC 19:00 = 前一天北京时间 03:00），然后重新部署。
- 日志通过与应用其余部分相同的 pino → SLS 桥接方案写入阿里云日志服务（RFC 0006 §4）。

## 上线后健康检查

- 从中国 ISP 访问 `https://kitora.cn/api/health` 返回 200。
- 页脚显示 `<ICP_NUMBER>` 和 `<PUBLIC_SECURITY_NUMBER>`（已在 `SiteFooter` 中通过 `isCnRegion()` 完成接线）。
- `select region, count(*) from "Organization" group by region;` 只返回一行，且 `region = 'CN'`。出现其他行意味着 `KITORA_REGION` 指向了错误的数据库。
- 从 kitora.cn 所在 IP 注册的用户，`User.region` 为 `'CN'`；同一邮箱在 kitora.io 注册则生成独立的 `User` 行，`region` 为 `'GLOBAL'`。
