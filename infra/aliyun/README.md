# 阿里云基础设施（RFC 0006 PR-1）

CN region 技术栈的 Terraform 骨架，拓扑与
[`docs/rfcs/0006-cn-region-deployment.md`](../../docs/rfcs/0006-cn-region-deployment.md)
§4 中的描述保持一致。

## 状态

**骨架阶段，尚不可执行。** `*.tf` 文件声明了计划部署的模块和输入；资源实现以 TODO 注释占位。首次真正执行 `terraform apply` 的前置条件：

1. 阿里云企业账号完成`实名认证`；
2. ICP 备案号已取得（备案前不得使用公网 DNS）；
3. Terraform 专用 RAM Role 已创建并附加正确的权限策略。

三项就绪后，填入各模块中的 `# TODO` 标记，在全新 workspace 上执行 `terraform plan` 验证后再 `apply`。目标是一次 `apply` 调用将整个技术栈拉起 —— 生产环境不走 ClickOps。

## 目录结构

```
infra/aliyun/
├── README.md              ← 本文件
├── main.tf                ← 顶层连线；调用所有模块
├── variables.tf           ← 输入：region、可用区对、环境名、标签
├── outputs.tf             ← 导出端点，供 ACK / 应用配置使用
├── versions.tf            ← provider 版本锁定（alicloud >= 1.230）
└── modules/
    ├── vpc/               ← VPC + 2× vSwitch（zone-i、zone-j）
    ├── security-groups/   ← sg-public-slb / sg-app / sg-data
    ├── rds/               ← RDS PostgreSQL 主节点 + 备节点
    ├── redis/             ← 阿里云 Redis（TLS 6380）
    ├── oss/               ← Bucket：data-export + uploads
    ├── sls/               ← 日志项目 + 3 个 logstore
    ├── ack/               ← ACK 集群 + 2 节点池
    ├── slb-waf/           ← 公网 SLB + WAF 规则
    └── kms/               ← 密钥信封加密用 KMS 密钥
```

## 为何选择 Terraform 而非阿里云 ROS

两者均可；Terraform 的优势在于：

- 跨云熟悉度（我们在 GLOBAL 栈已使用 AWS + Terraform）；
- HCL 在模块和变量方面的工程体验更佳；
- `terraform import` 可将备案测试期间手动创建的资源纳入管理。

`alicloud` provider 自 `1.230+` 起已全面覆盖 RFC 0006 §4 的资源面，
八个模块均只使用已文档化的资源。

## State 后端

使用阿里云 OSS 作为远程 state 存储，**不使用**默认的本地后端。
将 state 文件放在独立于数据桶的私有 Bucket 中：

```hcl
backend "oss" {
  bucket = "kitora-tfstate"
  prefix = "cn-prod"
  region = "cn-shanghai"
}
```

通过阿里云 OSS 服务端锁定（Terraform 1.6+）防止并发写入。
