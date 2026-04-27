# RFC 0006 PR-1 — Terraform provider pinning.
#
# `alicloud` 1.230+ 已全面支持 ACK 1.30+、RDS PostgreSQL 16、
# OSS v4 签名、SLS 结构化索引 —— 即 RFC 0006 §4 所列的所有组件。
# 仅在次版本升级时 bump，且需阅读 changelog；alicloud provider
# 的破坏性变更比 AWS 或 GCP 更频繁。

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.230"
    }
  }

  # State 存放在独立于数据桶的私有 OSS Bucket 中。
  # Backend 配置须在 workspace init 时指定；此处保留为
  # `# TODO` 注释，避免桶名硬编码进仓库。
  #
  # backend "oss" {
  #   bucket = "kitora-tfstate"
  #   prefix = "cn-prod"
  #   region = "cn-shanghai"
  # }
}

provider "alicloud" {
  region = var.region
  # AccessKey / Secret 来自 `ALICLOUD_ACCESS_KEY` /
  # `ALICLOUD_SECRET_KEY` 环境变量，或（推荐）通过 deploy-cn.yml
  # 工作流已使用的 GitHub OIDC 信任路径承担 STS 支撑的 RAM Role。
}
