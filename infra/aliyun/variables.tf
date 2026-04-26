# RFC 0006 PR-1 — Workspace inputs.
#
# Defaults assume the production CN deploy in cn-shanghai. Override per
# environment (staging / DR) by passing -var-file=.

variable "region" {
  description = "Aliyun region. cn-shanghai is the default per RFC 0006 §12."
  type        = string
  default     = "cn-shanghai"
}

variable "env" {
  description = "Environment label baked into resource names + tags."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.env)
    error_message = "env must be one of: prod, staging, dev."
  }
}

variable "az_a" {
  description = "First AZ for HA pairs (RDS primary, ACK node pool slot 1)."
  type        = string
  default     = "cn-shanghai-i"
}

variable "az_b" {
  description = "Second AZ. Must differ from az_a."
  type        = string
  default     = "cn-shanghai-j"
}

variable "vpc_cidr" {
  description = "VPC CIDR block. RFC 0006 §4.1 picks 10.40.0.0/16."
  type        = string
  default     = "10.40.0.0/16"
}

variable "common_tags" {
  description = "Tags applied to every taggable resource."
  type        = map(string)
  default = {
    project     = "kitora"
    region      = "CN"
    rfc         = "RFC-0006"
    managed-by  = "terraform"
  }
}

# ─── Resource-specific knobs ─────────────────────────────────────────────────

variable "rds_instance_class" {
  description = "RDS PostgreSQL spec. RFC 0006 §4.3 specs pg.n2.xlarge.2c."
  type        = string
  default     = "pg.n2.xlarge.2c"
}

variable "rds_storage_gb" {
  description = "RDS attached SSD size in GB."
  type        = number
  default     = 200
}

variable "redis_instance_class" {
  description = "Aliyun Redis spec. RFC 0006 §4.4 specs amber.standard.smaller.default."
  type        = string
  default     = "redis.amber.standard.smaller.default"
}

variable "ack_node_pool_size" {
  description = "Initial ACK node count (RFC 0006 §4.2 starts at 2)."
  type        = number
  default     = 2

  validation {
    condition     = var.ack_node_pool_size >= 2
    error_message = "ACK node pool must have at least 2 nodes for PodDisruptionBudget."
  }
}

variable "ack_node_class" {
  description = "ECS instance type for ACK nodes (RFC 0006 §4.2 ecs.g7.large)."
  type        = string
  default     = "ecs.g7.large"
}

variable "oss_data_export_bucket" {
  description = "Bucket name for RFC 0002 PR-3 data-export zips."
  type        = string
  default     = "kitora-cn-prod-data-export"
}

variable "oss_uploads_bucket" {
  description = "Bucket name for user uploads (avatars, attachments)."
  type        = string
  default     = "kitora-cn-prod-uploads"
}
