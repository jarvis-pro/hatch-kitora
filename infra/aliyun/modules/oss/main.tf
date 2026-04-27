# RFC 0006 §4.5 — OSS buckets.
#
# 两个 Bucket：
#   * data-export —— RFC 0002 PR-3 zip 包。生命周期规则：7d→IA，
#     30d→删除（与签名 URL 的 7d TTL 匹配）。
#   * uploads     —— 用户头像 / 附件。v1 暂未使用；提前创建，
#     以便 RFC 0008+ 落地功能时无需重跑 TF。
#
# 两者均：服务端 AES256 加密 + 跨区域复制关闭
#（数据驻留：副本不得离开 CN，绝对不允许）。

variable "env" { type = string }
variable "data_export_bucket_name" { type = string }
variable "uploads_bucket_name" { type = string }
variable "kms_key_id" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready.
#
# resource "alicloud_oss_bucket" "data_export" {
#   bucket = var.data_export_bucket_name
#   acl    = "private"
#
#   server_side_encryption_rule {
#     sse_algorithm = "AES256"
#   }
#
#   lifecycle_rule {
#     id      = "expire-zips"
#     enabled = true
#
#     transitions {
#       days          = 7
#       storage_class = "IA"
#     }
#     expiration {
#       days = 30
#     }
#   }
#
#   tags = var.common_tags
# }
#
# resource "alicloud_oss_bucket" "uploads" {
#   bucket = var.uploads_bucket_name
#   acl    = "private"
#
#   server_side_encryption_rule {
#     sse_algorithm = "AES256"
#   }
#
#   tags = var.common_tags
# }
#
# data "alicloud_regions" "current" { current = true }
# locals {
#   internal_oss_endpoint = "oss-${data.alicloud_regions.current.regions[0].id}-internal.aliyuncs.com"
# }

output "data_export_bucket" { value = null }
output "uploads_bucket" { value = null }
output "internal_endpoint" { value = null }
