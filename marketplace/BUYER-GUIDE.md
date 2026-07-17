# Cloud-Surgeon — AWS Marketplace Buyer Guide

## What you're getting

Cloud-Surgeon is an AI agent that monitors your AWS infrastructure and autonomously repairs incidents — ECS service crashes, Lambda throttling, RDS saturation, and more. It learns from every repair via a contextual bandit and stops asking for your approval once it earns enough confidence.

---

## Before you deploy

Have the following ready:

| What | Where to find it |
|---|---|
| **VPC ID** where Cloud-Surgeon will run | AWS Console → VPC |
| **Subnet IDs** (at least 2, different AZs) | AWS Console → VPC → Subnets |
| **ECS cluster name(s)** you want monitored | AWS Console → ECS → Clusters |
| **ECS service names** (exact, case-sensitive) | AWS Console → ECS → Services |
| **Lambda function name(s)** (optional) | AWS Console → Lambda |
| **RDS instance identifier** (optional, leave blank for CockroachDB) | AWS Console → RDS |
| **Amazon Bedrock access** enabled in your account | AWS Console → Bedrock → Model access → enable *Nova Lite* |

**AI provider** — Cloud-Surgeon uses Amazon Bedrock Nova Lite by default (no extra key needed). If you prefer Anthropic directly, enter your `ANTHROPIC_API_KEY` in the CloudFormation parameters.

---

## Deployment steps

1. **Subscribe** to Cloud-Surgeon on AWS Marketplace and click **Continue to Subscribe**.
2. Click **Continue to Configuration** → select *CloudFormation Template* → click **Continue to Launch**.
3. Fill in the CloudFormation parameters:
   - Your VPC, subnets, and allowed CIDR
   - The ECS cluster and services Cloud-Surgeon will repair
   - Your database provider and credentials
4. Click **Create stack** and wait ~5 minutes.
5. Open the **DashboardUrl** from the CloudFormation Outputs tab.

---

## How configuration works after deployment

All runtime configuration lives in **SSM Parameter Store** under `/cloud-surgeon/`. You can change any value without redeploying:

```
/cloud-surgeon/ecs/cluster                    → your ECS cluster name
/cloud-surgeon/ecs/services/0/name            → primary service name
/cloud-surgeon/ecs/services/0/aliases         → comma-separated aliases
/cloud-surgeon/ecs/services/1/name            → second service (optional)
/cloud-surgeon/lambda/functions/0/name        → Lambda function name
/cloud-surgeon/rds/instance_identifier        → RDS instance ID (blank = CockroachDB)
/cloud-surgeon/database/provider              → cockroachdb | rds-postgres | rds-mysql
/cloud-surgeon/routing/autonomous_threshold   → 0.80 (repair without approval above this)
/cloud-surgeon/routing/calibration_threshold  → 0.15
```

**To change a value:** go to AWS Console → Systems Manager → Parameter Store → find the parameter → Edit. The running container picks up the new value within 60 seconds (no restart required for threshold/alias changes; a service restart is needed for cluster/service name changes).

**Secrets** are stored as `SecureString` parameters and are never visible in logs:
```
/cloud-surgeon/secrets/anthropic_api_key
/cloud-surgeon/secrets/cockroach_cloud_api_key
/cloud-surgeon/secrets/cockroach_db_url
/cloud-surgeon/secrets/cockroach_cloud_cluster_id
```

---

## IAM permissions granted to Cloud-Surgeon

The CloudFormation template creates a task IAM role with exactly the permissions needed:

| Service | Actions |
|---|---|
| ECS | DescribeServices, UpdateService, ListServices |
| Lambda | GetFunction, GetFunctionConcurrency, PutFunctionConcurrency |
| RDS | DescribeDBInstances, ModifyDBInstance, DescribeDBParameterGroups |
| CloudWatch | GetMetricData, GetMetricStatistics, DescribeAlarms |
| Bedrock | InvokeModel (Nova Lite only) |
| SSM | GetParameter, GetParametersByPath (under /cloud-surgeon/ prefix only) |

No wildcard IAM policies. No data-plane access to your application databases.

---

## Adding more services after deployment

Go to SSM Parameter Store and create new parameters following the pattern:

```
/cloud-surgeon/ecs/services/2/name     → my-new-service
/cloud-surgeon/ecs/services/2/aliases  → new,newservice
```

Then restart the Cloud-Surgeon ECS task (AWS Console → ECS → cloud-surgeon cluster → cloud-surgeon service → Tasks → Stop task — Fargate will start a new one automatically).

---

## Custom alert patterns

Cloud-Surgeon maps alert text to repair strategies using a priority-ordered rule list. The defaults handle common AWS patterns. To add your own:

Create the SSM parameter:
```
/cloud-surgeon/alert_patterns/custom   → JSON array
```

Example value:
```json
[
  { "match": ["my-custom-alert", "spike"],  "strategy": "ecs_service_restart" },
  { "match_all": ["database", "locked"],    "strategy": "db_connection_pool_reset" }
]
```

---

## Pricing

Cloud-Surgeon charges a **monthly software fee** via AWS Marketplace (see listing for current price). You also pay for the AWS resources created by the CloudFormation stack:

| Resource | Approximate cost |
|---|---|
| ECS Fargate (0.5 vCPU / 1 GB) | ~$15/month |
| Application Load Balancer | ~$20/month |
| Bedrock Nova Lite | ~$0.0006 per 1K input tokens |
| SSM Parameter Store (standard) | Free |

Total infra cost: **~$35–50/month** depending on incident volume.

---

## Support

- **Documentation:** [cloud-surgeon.dev/docs](https://cloud-surgeon.dev/docs)
- **Issues / feature requests:** open a ticket via the AWS Marketplace seller contact form
- **Response time:** business days, 24h SLA for critical issues

---

## Uninstalling

Delete the CloudFormation stack. This removes all created resources (ECS cluster, ALB, IAM roles, SSM parameters). Your monitored services are unaffected.
