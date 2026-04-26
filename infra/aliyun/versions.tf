# RFC 0006 PR-1 — Terraform provider pinning.
#
# `alicloud` 1.230+ ships full coverage for ACK 1.30+, RDS PostgreSQL 16,
# OSS v4 signing, SLS structured indexing — all the pieces RFC 0006 §4
# names. Bump only on minor + read the changelog; the alicloud provider
# is more breaking-change-prone than AWS or GCP.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.230"
    }
  }

  # State lives in a private OSS bucket separate from data buckets.
  # Backend block must be configured at workspace init time; left as
  # `# TODO` so the bucket name doesn't get baked into the repo.
  #
  # backend "oss" {
  #   bucket = "kitora-tfstate"
  #   prefix = "cn-prod"
  #   region = "cn-shanghai"
  # }
}

provider "alicloud" {
  region = var.region
  # AccessKey / Secret come from `ALICLOUD_ACCESS_KEY` /
  # `ALICLOUD_SECRET_KEY` env vars, OR (preferred) from a STS-backed RAM
  # Role assumed via the GitHub OIDC trust path the deploy-cn.yml
  # workflow already uses.
}
