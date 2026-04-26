# RFC 0006 §4.1 — Public SLB + Aliyun WAF.
#
# SLB sits in the public vSwitch with `sg-public-slb` attached. WAF is
# in front, configured in 「先验后转发」 mode so a hostile request gets
# rejected before reaching ACK. The deploy-cn.yml workflow's smoke test
# hits the SLB-public endpoint, not WAF directly.

variable "env" { type = string }
variable "vswitch_id" { type = string }
variable "security_group_id" { type = string }
variable "ack_cluster_id" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready.
#
# resource "alicloud_slb_load_balancer" "public" {
#   load_balancer_name   = "kitora-cn-${var.env}-public"
#   address_type         = "internet"
#   load_balancer_spec   = "slb.s2.small"
#   payment_type         = "PayAsYouGo"
#   vswitch_id           = var.vswitch_id
#   tags                 = var.common_tags
# }
#
# resource "alicloud_slb_listener" "https" {
#   load_balancer_id  = alicloud_slb_load_balancer.public.id
#   backend_port      = 443
#   frontend_port     = 443
#   protocol          = "https"
#   bandwidth         = 100
#   ssl_certificate_id = "TODO: Aliyun SSL cert id once 备案 issued"
#   health_check       = "on"
# }
#
# resource "alicloud_wafv3_domain" "main" {
#   domain   = "api.kitora.cn"
#   listen {
#     ipv4_enabled = true
#     ports        = [443]
#     protocols    = ["https"]
#   }
#   redirect {
#     backends     = [alicloud_slb_load_balancer.public.address]
#     loadbalance  = "iphash"
#   }
# }

output "public_endpoint" { value = null }
output "slb_id" { value = null }
