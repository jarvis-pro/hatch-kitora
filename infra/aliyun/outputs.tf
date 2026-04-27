# RFC 0006 PR-1 — Workspace outputs.
#
# 这些是 deploy-cn.yml 工作流和应用 secret 清单在 `terraform apply` 成功后读取的值。
# 它们本身不是密钥 —— 密码和密钥来自 KMS。

output "vpc_id" {
  description = "VPC ID —— 方便跨 stack 引用。"
  value       = module.vpc.vpc_id
}

output "rds_endpoint" {
  description = "RDS PostgreSQL VPC 内部端点，用于 DATABASE_URL。"
  value       = module.rds.endpoint
  sensitive   = false
}

output "redis_endpoint" {
  description = "阿里云 Redis TLS 端点（端口 6380），用于 ALIYUN_REDIS_URL。"
  value       = module.redis.endpoint_tls
  sensitive   = false
}

output "oss_data_export_bucket" {
  description = "RFC 0002 PR-3 数据导出 zip 包的 Bucket，对应 ALIYUN_OSS_BUCKET。"
  value       = module.oss.data_export_bucket
}

output "oss_internal_endpoint" {
  description = "VPC 内部 OSS 端点，对应 ALIYUN_OSS_ENDPOINT。"
  value       = module.oss.internal_endpoint
}

output "sls_project" {
  description = "SLS 日志项目名称，用于 `pino` 日志推送配置。"
  value       = module.sls.project_name
}

output "ack_cluster_id" {
  description = "ACK 集群 ID，写入 ACK_CLUSTER_ID GitHub Secret。"
  value       = module.ack.cluster_id
}

output "slb_public_endpoint" {
  description = "公网 SLB 端点，kitora.cn 的 DNS A 记录指向此处。"
  value       = module.slb_waf.public_endpoint
}

output "kms_key_id" {
  description = "用于应用密钥信封加密的 KMS 密钥 ID。"
  value       = module.kms.key_id
  sensitive   = true
}
