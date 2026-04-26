# RFC 0006 §4.1 — Three-tier security group layout.
#
#   sg-public-slb : 22 / 80 / 443 ingress; only attached to SLB ENI.
#   sg-app        : ingress only from sg-public-slb on :3000; egress *.
#   sg-data       : ingress only from sg-app on :5432 / :6379 / :6380.

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
# Inter-SG rules: sg-app accepts :3000 from sg-public-slb only;
# sg-data accepts :5432 + :6379 + :6380 from sg-app only.

output "sg_public_slb_id" { value = null }
output "sg_app_id" { value = null }
output "sg_data_id" { value = null }
