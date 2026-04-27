# RFC 0006 — KMS envelope key for app secrets at rest.
#
# 使用方：
#   * RDS（加密存储）
#   * OSS（可选在默认 AES256 基础上升级为 SSE-KMS 对象级加密）
#   * ACK secret 绑定（信封加密 etcd 侧密钥，使被盗的 etcd
#     快照在没有 KMS 密钥句柄时毫无价值）。
#
# 整个 CN 栈共用一个密钥，通过阿里云自动轮换策略每年轮换一次。

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
