# RFC 0006 PR-1 — Workspace inputs.
#
# 默认值对应 cn-shanghai 生产环境部署。各环境（staging / DR）
# 可通过 -var-file= 覆盖。

variable "region" {
  description = "阿里云 region。RFC 0006 §12 规定默认为 cn-shanghai。"
  type        = string
  default     = "cn-shanghai"
}

variable "env" {
  description = "环境标识，嵌入资源名称和标签中。"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.env)
    error_message = "env must be one of: prod, staging, dev."
  }
}

variable "az_a" {
  description = "HA 对的第一个可用区（RDS 主节点、ACK 节点池插槽 1）。"
  type        = string
  default     = "cn-shanghai-i"
}

variable "az_b" {
  description = "第二个可用区，必须与 az_a 不同。"
  type        = string
  default     = "cn-shanghai-j"
}

variable "vpc_cidr" {
  description = "VPC CIDR 块。RFC 0006 §4.1 选用 10.40.0.0/16。"
  type        = string
  default     = "10.40.0.0/16"
}

variable "common_tags" {
  description = "应用于所有支持标签的资源的标签集。"
  type        = map(string)
  default = {
    project     = "kitora"
    region      = "CN"
    rfc         = "RFC-0006"
    managed-by  = "terraform"
  }
}

# ─── 各资源专属参数 ────────────────────────────────────────────────────────────

variable "rds_instance_class" {
  description = "RDS PostgreSQL 规格。RFC 0006 §4.3 指定 pg.n2.xlarge.2c。"
  type        = string
  default     = "pg.n2.xlarge.2c"
}

variable "rds_storage_gb" {
  description = "RDS 附加 SSD 容量（GB）。"
  type        = number
  default     = 200
}

variable "redis_instance_class" {
  description = "阿里云 Redis 规格。RFC 0006 §4.4 指定 amber.standard.smaller.default。"
  type        = string
  default     = "redis.amber.standard.smaller.default"
}

variable "ack_node_pool_size" {
  description = "ACK 节点初始数量（RFC 0006 §4.2 从 2 开始）。"
  type        = number
  default     = 2

  validation {
    condition     = var.ack_node_pool_size >= 2
    error_message = "ACK node pool must have at least 2 nodes for PodDisruptionBudget."
  }
}

variable "ack_node_class" {
  description = "ACK 节点的 ECS 实例规格（RFC 0006 §4.2 指定 ecs.g7.large）。"
  type        = string
  default     = "ecs.g7.large"
}

variable "oss_data_export_bucket" {
  description = "RFC 0002 PR-3 数据导出 zip 包的 Bucket 名称。"
  type        = string
  default     = "kitora-cn-prod-data-export"
}

variable "oss_uploads_bucket" {
  description = "用户上传文件（头像、附件）的 Bucket 名称。"
  type        = string
  default     = "kitora-cn-prod-uploads"
}
