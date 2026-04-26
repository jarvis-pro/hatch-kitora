# RFC 0006 PR-1 — Workspace outputs.
#
# These are the values the deploy-cn.yml workflow + the app's secret
# manifest read after a successful `terraform apply`. None of them are
# secrets in themselves — passwords and keys come from KMS.

output "vpc_id" {
  description = "VPC id — handy for cross-stack references."
  value       = module.vpc.vpc_id
}

output "rds_endpoint" {
  description = "RDS PostgreSQL VPC endpoint. Used in DATABASE_URL."
  value       = module.rds.endpoint
  sensitive   = false
}

output "redis_endpoint" {
  description = "Aliyun Redis TLS endpoint (port 6380). Used in ALIYUN_REDIS_URL."
  value       = module.redis.endpoint_tls
  sensitive   = false
}

output "oss_data_export_bucket" {
  description = "Bucket for RFC 0002 PR-3 data-export zips. ALIYUN_OSS_BUCKET."
  value       = module.oss.data_export_bucket
}

output "oss_internal_endpoint" {
  description = "VPC-internal OSS endpoint. ALIYUN_OSS_ENDPOINT."
  value       = module.oss.internal_endpoint
}

output "sls_project" {
  description = "SLS log project name. Used by `pino` shipper config."
  value       = module.sls.project_name
}

output "ack_cluster_id" {
  description = "ACK cluster id. Feeds ACK_CLUSTER_ID GitHub secret."
  value       = module.ack.cluster_id
}

output "slb_public_endpoint" {
  description = "Public SLB endpoint. DNS A record for kitora.cn points here."
  value       = module.slb_waf.public_endpoint
}

output "kms_key_id" {
  description = "KMS key id for envelope encryption of app secrets."
  value       = module.kms.key_id
  sensitive   = true
}
