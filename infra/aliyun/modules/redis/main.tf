# RFC 0006 §4.4 — Aliyun Redis (master + replica).
#
# TLS port 6380 only — `ALIYUN_REDIS_URL` should use `rediss://`. The
# rate-limit module (RFC 0006 PR-4) hits this from inside the same
# VPC over the internal endpoint.

variable "env" { type = string }
variable "vswitch_id" { type = string }
variable "security_group_id" { type = string }
variable "instance_class" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready.
#
# resource "alicloud_kvstore_instance" "main" {
#   instance_name      = "kitora-cn-${var.env}-redis"
#   instance_class     = var.instance_class
#   instance_type      = "Redis"
#   engine_version     = "6.0"
#   vswitch_id         = var.vswitch_id
#   security_group_id  = var.security_group_id
#   payment_type       = "PostPaid"
#   ssl_enable         = "Enable"
#   tags               = var.common_tags
# }

output "endpoint_tls" { value = null }
output "instance_id" { value = null }
