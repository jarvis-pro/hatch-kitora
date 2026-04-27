# Kitora REST API — 集成指南

本目录存放 Kitora 公开 API 的权威 OpenAPI 规范（`openapi/v1.yaml`）以及面向集成方的示例代码。规范在产品内渲染于 `/docs/api`（Scalar），并以原始文件形式对外暴露于 `/api/openapi/v1.yaml`。

该规范是**手写的**，不是自动生成的。当你在 `src/app/api/v1/**/route.ts` 下新增公开端点时，必须在同一个 PR 中同步更新 `v1.yaml`。CI 会执行两项交叉检查：

```bash
pnpm openapi:lint       # @redocly/cli — schema 级别 lint
pnpm openapi:check      # scripts/check-openapi-coverage.ts — paths × routes 差异检查
```

两项均通过方可合并。

## 为什么手写而非生成

SaaS 模板的公开 API 是对集成方的稳定性承诺 —— 一份变更应比代码慢得多的契约。从代码生成规范会将两者耦合得过于紧密：Zod schema 里一个随手加的 `.optional()` 就可能造成破坏性的规范变更。我们用少量重复换来了充分的表达意图的空间。

覆盖率检查脚本捕获最常见的偏差（新增了路由但忘记更新规范）；lint 任务捕获其余问题（拼写错误、悬空引用、示例格式错误）。

## Webhook 签名验证

Kitora 的出站 Webhook 投递在 `X-Kitora-Signature` 请求头中携带 HMAC-SHA256 签名，格式为：

```
X-Kitora-Signature: t=<unix_ts>,v1=<hex_sha256>
```

签名载荷为 `<unix_ts>.<原始请求体>`。接收方**必须**完成以下两件事：

1. **验证签名** —— 用**原始**请求字节（不得重新序列化 JSON）重新计算 `hex(HMAC_SHA256(secret, ts + "." + body))`，并与 `v1` 做常量时间比较。
2. **执行 5 分钟时间窗口校验** —— 若 `|now - t| > 300`，则拒绝请求，以防止已捕获投递的重放攻击。

以下是三种语言的接收方示例代码，选择与你技术栈匹配的版本直接内嵌。`examples/` 目录中有完整可运行的版本。

### Node.js（Next.js / Express）

```js
import crypto from 'node:crypto';

const MAX_AGE = 300; // 5 minutes

export function verifyKitoraSignature({ header, body, secret, now = Date.now() / 1000 }) {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(now - t) > MAX_AGE) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1 ?? '', 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

### Python（FastAPI / Flask）

```python
import hmac
import hashlib
import time

MAX_AGE = 300

def verify_kitora_signature(*, header: str, body: bytes, secret: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    parts = dict(p.strip().split('=', 1) for p in header.split(',') if '=' in p)
    try:
        t = int(parts['t'])
    except (KeyError, ValueError):
        return False
    if abs(now - t) > MAX_AGE:
        return False
    signed_payload = f"{t}.".encode() + body
    expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get('v1', ''))
```

### PHP（Laravel / Symfony / 原生）

```php
function verifyKitoraSignature(string $header, string $body, string $secret): bool {
    $maxAge = 300;
    $parts = [];
    foreach (explode(',', $header) as $pair) {
        [$k, $v] = array_map('trim', explode('=', $pair, 2)) + [null, null];
        if ($k && $v) $parts[$k] = $v;
    }
    if (!isset($parts['t'], $parts['v1'])) return false;
    $t = (int) $parts['t'];
    if (abs(time() - $t) > $maxAge) return false;
    $expected = hash_hmac('sha256', $t . '.' . $body, $secret);
    return hash_equals($expected, $parts['v1']);
}
```

## Kitora 每次投递携带的请求头

| 请求头                | 说明                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `X-Kitora-Event-Id`   | 逻辑事件 ID，在重试之间保持不变。用于接收方的幂等去重。                        |
| `X-Kitora-Event-Type` | 例如 `subscription.created`。完整事件类型注册表见规范中的 `WebhookEventType`。 |
| `X-Kitora-Timestamp`  | 投递发起时的 Unix 时间戳（秒），即签名中 `t=` 部分的回显。                     |
| `X-Kitora-Signature`  | `t=<ts>,v1=<hex_sha256>` —— 验证方式见上文。                                   |
| `User-Agent`          | `Kitora-Webhooks/1.0` —— 如需更严格的过滤，可将此值加入防火墙白名单。          |
| `Content-Type`        | `application/json`                                                             |

## 幂等性

使用 `X-Kitora-Event-Id` 作为去重键。cron worker 最多重试 8 次，持续约 44 小时；每次尝试的事件 ID **相同**，但签名时间戳不同。不要用签名、投递行 ID 或请求体哈希做去重 —— 这些值在重试间会变化。

## 管理 API 的速率限制

`/api/v1/orgs/{slug}/webhooks*` 管理端点与其他 API 共享同一个基于 token 的速率限制器。请检查每次响应中的 `X-RateLimit-Remaining` / `X-RateLimit-Reset` 请求头。429 表示令牌桶已空，直到 reset 时间戳刷新前不会接受新请求。

对于发送到你端点的入站投递，**没有**独立的速率限制 —— 那是你和反向代理之间的事。

## 自动禁用行为

向某个端点连续投递失败 8 次（默认重试曲线下约 44 小时）后，Kitora 会通过设置 `disabledAt` 暂停该端点，并在下一次 cron tick 时取消其待处理队列。系统会向组织的 OWNER 和 ADMIN 发送邮件，并追加一条 `webhook.endpoint_auto_disabled` 审计记录。

重新启用端点后（通过 `PATCH /webhooks/{id}` 将 `disabledAt` 设为 `null`），待处理的投递**不会**自动恢复 —— 它们已被取消，而非暂停。请从你这侧触发新事件来重建状态。

暂停阈值和重试曲线目前不支持用户自定义配置；如有调整需求，请提交 issue。

## 服务状态

生产状态、计划维护窗口和 cron-tick 公告发布于 https://status.kitora.example.com。在该页面订阅，可在影响 API 或 Webhook 行为的变更前收到通知。

## 自托管的可观测性钩子

如果你自行部署 Kitora，`/api/metrics` 端点会以 Prometheus 格式暴露以下计数器/指标：

- `kitora_webhook_endpoints_total{disabled="false|true"}` —— 活跃端点 vs 已暂停端点数量。
- `kitora_webhook_deliveries_total{status="..."}` —— 当前投递状态机的分布情况。
- `kitora_webhook_dead_letter_total` —— 告警基线；非零的增长率是唤醒值班人员的信号。

该端点需要持有平台 `ADMIN` 角色的 Bearer ApiToken 进行认证。按照普通 API 客户端相同的方式配置你的抓取器进行认证。
