# RFC 0006 §4.5 — OSS buckets.
#
# Two buckets:
#   * data-export — RFC 0002 PR-3 zip artefacts. Lifecycle rule: 7d→IA,
#     30d→delete (matches signed-URL TTL of 7d).
#   * uploads     — user avatars / attachments. v1 unused; created up
#     front so RFC 0008+ can land features without re-running TF.
#
# Both: server-side encryption AES256 + cross-region replication OFF
# (data-residency: copies don't leave CN, period).

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
