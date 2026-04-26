# RFC 0006 §4.7 — SLS log project + 3 logstores.
#
#   app-logs     — application stdout / stderr (pino → SLS shipper).
#   audit-logs   — RFC 0001 PR-2 AuditLog rows nightly export.
#   access-logs  — SLB 7-layer access log (等保 2.0 二级 6-month rule).

variable "env" { type = string }
variable "region" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready.
#
# resource "alicloud_log_project" "main" {
#   name        = "kitora-cn-${var.env}"
#   description = "Kitora CN region logs (RFC 0006 §4.7)"
#   tags        = var.common_tags
# }
#
# resource "alicloud_log_store" "app_logs" {
#   project           = alicloud_log_project.main.name
#   name              = "app-logs"
#   retention_period  = 30
#   shard_count       = 2
#   auto_split        = true
#   max_split_shard_count = 8
# }
#
# resource "alicloud_log_store" "audit_logs" {
#   project           = alicloud_log_project.main.name
#   name              = "audit-logs"
#   retention_period  = 180
#   shard_count       = 1
# }
#
# resource "alicloud_log_store" "access_logs" {
#   project           = alicloud_log_project.main.name
#   name              = "access-logs"
#   retention_period  = 180
#   shard_count       = 4
# }

output "project_name" { value = null }
