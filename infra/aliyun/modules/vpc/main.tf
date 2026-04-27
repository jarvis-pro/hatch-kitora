# RFC 0006 §4.1 — VPC + 2× vSwitches across two AZs.
#
# 两个可用区是 ACK PodDisruptionBudget 生效的最低要求。
# 每个 vSwitch 固定划分 /24 CIDR —— RDS / Redis / OSS 运行在
# 同一 VPC 的 vSwitch 中，v1 无需跨 VPC 对等连接。

variable "env" { type = string }
variable "region" { type = string }
variable "vpc_cidr" { type = string }
variable "az_a" { type = string }
variable "az_b" { type = string }
variable "common_tags" { type = map(string) }

# TODO: enable once Aliyun account is in 实名认证 status.
#
# resource "alicloud_vpc" "main" {
#   vpc_name   = "kitora-cn-${var.env}"
#   cidr_block = var.vpc_cidr
#   tags       = var.common_tags
# }
#
# resource "alicloud_vswitch" "a" {
#   vpc_id      = alicloud_vpc.main.id
#   cidr_block  = cidrsubnet(var.vpc_cidr, 8, 1)
#   zone_id     = var.az_a
#   vswitch_name = "kitora-cn-${var.env}-${var.az_a}"
# }
#
# resource "alicloud_vswitch" "b" {
#   vpc_id      = alicloud_vpc.main.id
#   cidr_block  = cidrsubnet(var.vpc_cidr, 8, 2)
#   zone_id     = var.az_b
#   vswitch_name = "kitora-cn-${var.env}-${var.az_b}"
# }
#
# resource "alicloud_nat_gateway" "egress" {
#   vpc_id        = alicloud_vpc.main.id
#   nat_gateway_name = "kitora-cn-${var.env}-egress"
#   payment_type  = "PayAsYouGo"
#   vswitch_id    = alicloud_vswitch.a.id
#   nat_type      = "Enhanced"
# }

# 存根输出 —— 待上方资源取消注释后，将 `null` 替换为 `alicloud_*.id`。
# 骨架阶段保留 `null` 使顶层 main.tf 能通过类型检查。

output "vpc_id" { value = null }
output "vswitch_id_a" { value = null }
output "vswitch_id_b" { value = null }
