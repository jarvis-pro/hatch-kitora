# RFC 0006 §4.3 — RDS PostgreSQL primary + standby (HA).
#
# Engine 16, encrypted at rest via KMS envelope, VPC-internal endpoint
# only. Public endpoint is left disabled here; opening it for the
# initial migration window is a manual operator step (`aliyun rds
# AllocateInstancePublicConnection ...`) so it doesn't accidentally
# survive past the cutover.

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "vswitch_id_a" { type = string }
variable "vswitch_id_b" { type = string }
variable "security_group_id" { type = string }
variable "instance_class" { type = string }
variable "storage_gb" { type = number }
variable "kms_key_id" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready for first apply.
#
# resource "alicloud_db_instance" "main" {
#   instance_name        = "kitora-cn-${var.env}"
#   engine               = "PostgreSQL"
#   engine_version       = "16.0"
#   instance_type        = var.instance_class
#   instance_storage     = var.storage_gb
#   instance_charge_type = "Postpaid"
#   vswitch_id           = "${var.vswitch_id_a},${var.vswitch_id_b}"
#   security_group_ids   = [var.security_group_id]
#   storage_type         = "cloud_essd"
#   storage_encrypted    = true
#   encryption_key       = var.kms_key_id
#   tags                 = var.common_tags
#
#   # WAL log retention 7 days; backup retention 7 days.
#   backup_period      = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
#   backup_time        = "02:00Z-03:00Z"
#   log_backup_retention_period = 7
# }
#
# resource "alicloud_db_database" "kitora" {
#   instance_id   = alicloud_db_instance.main.id
#   name          = "kitora"
#   character_set = "UTF8"
# }

output "endpoint" { value = null }
output "instance_id" { value = null }
