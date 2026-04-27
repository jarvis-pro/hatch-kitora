# RFC 0006 §4.2 — ACK Kubernetes cluster + 2-node pool.
#
# 集群控制面由阿里云托管。节点池初始配置为 2× ecs.g7.large（4c8g）
# —— 足以运行 3 个应用 Pod + 1 个 cron Pod + Prometheus/Grafana 并留有余量。
# 通过 `node_pool_size` 变量扩缩容。
#
# Pod 级配置（deployment、service、PDB）位于 `k8s/cn/` 清单，
# 由 deploy-cn.yml 应用；本模块仅负责创建集群和节点池。

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "vswitch_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "node_pool_size" { type = number }
variable "node_class" { type = string }
variable "common_tags" { type = map(string) }

# TODO: 就绪后取消注释。provider 的 `alicloud_cs_managed_kubernetes`
# 资源首次 apply 需要 15 分钟以上 —— 请耐心等待。
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
