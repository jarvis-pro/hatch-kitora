# RFC 0006 — KMS envelope key for app secrets at rest.
#
# Used by:
#   * RDS (encrypt storage)
#   * OSS (per-object SSE-KMS optional escalation from default AES256)
#   * ACK secret-binding (envelope-encrypt etcd-side secrets so a stolen
#     etcd snapshot is useless without the KMS key handle).
#
# One key for the whole CN stack. Rotate annually via Aliyun's
# auto-rotation policy.

variable "env" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready.
#
# resource "alicloud_kms_key" "main" {
#   description            = "Kitora CN ${var.env} envelope key"
#   key_usage              = "ENCRYPT/DECRYPT"
#   protection_level       = "SOFTWARE"
#   key_state              = "Enabled"
#   automatic_rotation     = "Enabled"
#   rotation_interval      = "365d"
#   pending_window_in_days = 7
#   tags                   = var.common_tags
# }
#
# resource "alicloud_kms_alias" "main" {
#   alias_name = "alias/kitora-cn-${var.env}"
#   key_id     = alicloud_kms_key.main.id
# }

output "key_id" { value = null }
output "key_alias" { value = null }
