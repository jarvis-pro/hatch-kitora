# RFC 0006 PR-1 — Top-level wiring.
#
# 按依赖顺序调用各模块。输出向前传递，使 RDS 能获取 VPC 的 vSwitch ID，
# ACK 能获取 SLB / 安全组布局等信息。

module "vpc" {
  source = "./modules/vpc"

  env          = var.env
  region       = var.region
  vpc_cidr     = var.vpc_cidr
  az_a         = var.az_a
  az_b         = var.az_b
  common_tags  = var.common_tags
}

module "security_groups" {
  source = "./modules/security-groups"

  env         = var.env
  vpc_id      = module.vpc.vpc_id
  common_tags = var.common_tags
}

module "kms" {
  source = "./modules/kms"

  env         = var.env
  common_tags = var.common_tags
}

module "rds" {
  source = "./modules/rds"

  env                = var.env
  vpc_id             = module.vpc.vpc_id
  vswitch_id_a       = module.vpc.vswitch_id_a
  vswitch_id_b       = module.vpc.vswitch_id_b
  security_group_id  = module.security_groups.sg_data_id
  instance_class     = var.rds_instance_class
  storage_gb         = var.rds_storage_gb
  kms_key_id         = module.kms.key_id
  common_tags        = var.common_tags
}

module "redis" {
  source = "./modules/redis"

  env                = var.env
  vswitch_id         = module.vpc.vswitch_id_a
  security_group_id  = module.security_groups.sg_data_id
  instance_class     = var.redis_instance_class
  common_tags        = var.common_tags
}

module "oss" {
  source = "./modules/oss"

  env                       = var.env
  data_export_bucket_name   = var.oss_data_export_bucket
  uploads_bucket_name       = var.oss_uploads_bucket
  kms_key_id                = module.kms.key_id
  common_tags               = var.common_tags
}

module "sls" {
  source = "./modules/sls"

  env         = var.env
  region      = var.region
  common_tags = var.common_tags
}

module "ack" {
  source = "./modules/ack"

  env                = var.env
  vpc_id             = module.vpc.vpc_id
  vswitch_ids        = [module.vpc.vswitch_id_a, module.vpc.vswitch_id_b]
  security_group_id  = module.security_groups.sg_app_id
  node_pool_size     = var.ack_node_pool_size
  node_class         = var.ack_node_class
  common_tags        = var.common_tags
}

module "slb_waf" {
  source = "./modules/slb-waf"

  env                  = var.env
  vswitch_id           = module.vpc.vswitch_id_a
  security_group_id    = module.security_groups.sg_public_slb_id
  ack_cluster_id       = module.ack.cluster_id
  common_tags          = var.common_tags
}
