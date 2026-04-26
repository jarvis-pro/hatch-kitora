# RFC 0006 §4.2 — ACK Kubernetes cluster + 2-node pool.
#
# Cluster control plane is managed (Aliyun-side). Node pool starts at
# 2× ecs.g7.large (4c8g) — enough for 3 app pods + 1 cron pod +
# Prometheus/Grafana with headroom. Scale via `node_pool_size` var.
#
# Pod-level config (deployment, service, PDB) lives in `k8s/cn/`
# manifests applied by deploy-cn.yml; this module only stands up the
# cluster + node pool.

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "vswitch_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "node_pool_size" { type = number }
variable "node_class" { type = string }
variable "common_tags" { type = map(string) }

# TODO: uncomment when ready. The provider's `alicloud_cs_managed_kubernetes`
# resource takes 15+ minutes on first apply — be patient.
#
# resource "alicloud_cs_managed_kubernetes" "main" {
#   name                  = "kitora-cn-${var.env}-ack"
#   cluster_spec          = "ack.pro.small"
#   version               = "1.30.1-aliyun.1"
#   worker_vswitch_ids    = var.vswitch_ids
#   pod_cidr              = "172.20.0.0/16"
#   service_cidr          = "172.21.0.0/20"
#   load_balancer_spec    = "slb.s2.small"
#   security_group_id     = var.security_group_id
#   tags                  = var.common_tags
# }
#
# resource "alicloud_cs_kubernetes_node_pool" "default" {
#   cluster_id            = alicloud_cs_managed_kubernetes.main.id
#   name                  = "default"
#   vswitch_ids           = var.vswitch_ids
#   instance_types        = [var.node_class]
#   desired_size          = var.node_pool_size
#   system_disk_category  = "cloud_essd"
#   system_disk_size      = 80
#   tags                  = var.common_tags
# }

output "cluster_id" { value = null }

output "kubeconfig" {
  value     = null
  sensitive = true
}
