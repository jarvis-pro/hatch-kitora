# Aliyun infrastructure (RFC 0006 PR-1)

Terraform skeleton for the CN-region stack. Mirrors the topology in
[`docs/rfcs/0006-cn-region-deployment.md`](../../docs/rfcs/0006-cn-region-deployment.md)
§4.

## Status

**Skeleton, not runnable.** The `*.tf` files declare the modules and
inputs we plan to apply; resource implementations are stubbed with TODO
comments. The first real `terraform apply` is gated on:

1. Aliyun corporate account in `实名认证` status;
2. ICP 备案 number issued (no public DNS until then);
3. RAM Role for Terraform with the right policies attached.

When all three are in hand, fill in the `# TODO` markers in each module
and run `terraform plan` against a fresh workspace before `apply`. The
intent is that everything flips to a working stack with one `apply`
call — no ClickOps in production.

## Layout

```
infra/aliyun/
├── README.md              ← this file
├── main.tf                ← top-level wiring; calls all modules
├── variables.tf           ← inputs: region, az pair, env name, tags
├── outputs.tf             ← exported endpoints for ACK / app config
├── versions.tf            ← provider pin (alicloud >= 1.230)
└── modules/
    ├── vpc/               ← VPC + 2× vSwitches (zone-i, zone-j)
    ├── security-groups/   ← sg-public-slb / sg-app / sg-data
    ├── rds/               ← RDS PostgreSQL primary + standby
    ├── redis/             ← Aliyun Redis (TLS 6380)
    ├── oss/               ← buckets: data-export + uploads
    ├── sls/               ← log project + 3 logstores
    ├── ack/               ← ACK cluster + 2-node pool
    ├── slb-waf/           ← public SLB + WAF rules
    └── kms/               ← envelope-encryption key for secrets
```

## Why Terraform and not Aliyun ROS

Both work; Terraform wins on:

- multi-cloud familiarity (we already use it for AWS in GLOBAL);
- HCL ergonomics for modules and variables;
- `terraform import` for back-filling resources we created manually
  during initial备案 testing.

The `alicloud` provider has full RFC 0006 §4 surface coverage as of
`1.230+`; all eight modules use only documented resources.

## State backend

Use Aliyun OSS as the remote state store, NOT the default local backend.
Place the state file in a private bucket separate from the data buckets:

```hcl
backend "oss" {
  bucket = "kitora-tfstate"
  prefix = "cn-prod"
  region = "cn-shanghai"
}
```

Lock with Aliyun's OSS server-side locking (Terraform 1.6+).
