# RFC 0006 §4.1 — Three-tier security group layout.
#
#   sg-public-slb : 开放 22 / 80 / 443 入站；仅挂载到 SLB ENI。
#   sg-app        : 仅允许来自 sg-public-slb 的 :3000 入站；出站不限。
#   sg-data       : 仅允许来自 sg-app 的 :5432 / :6379 / :6380 入站。

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment after VPC module lands real resources.
#
# resource "alicloud_security_group" "public_slb" {
#   name        = "kitora-cn-${var.env}-public-slb"
#   vpc_id      = var.vpc_id
#   description = "Public-facing SLB ENI only"
#   tags        = var.common_tags
# }
#
# resource "alicloud_security_group_rule" "slb_ingress_443" {
#   type              = "ingress"
#   ip_protocol       = "tcp"
#   port_range        = "443/443"
#   cidr_ip           = "0.0.0.0/0"
#   security_group_id = alicloud_security_group.public_slb.id
# }
#
# resource "alicloud_security_group" "app" { ... }
# resource "alicloud_security_group" "data" { ... }
#
# 安全组间规则：sg-app 仅接受来自 sg-public-slb 的 :3000；
# sg-data 仅接受来自 sg-app 的 :5432 + :6379 + :6380。

output "sg_public_slb_id" { value = null }
output "sg_app_id" { value = null }
output "sg_data_id" { value = null }
