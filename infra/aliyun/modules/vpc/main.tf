# RFC 0006 §4.1 — VPC + 2× vSwitches across two AZs.
#
# Two AZs is the minimum for ACK PodDisruptionBudget to mean anything.
# CIDR carve-up is fixed at /24 per vSwitch — RDS / Redis / OSS run in
# the same VPC's vSwitches, no cross-VPC peering needed for v1.

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

# Stub outputs — replace `null` with `alicloud_*.id` once resources are
# uncommented above. `null` lets the top-level main.tf typecheck during
# the skeleton phase.

output "vpc_id" { value = null }
output "vswitch_id_a" { value = null }
output "vswitch_id_b" { value = null }
