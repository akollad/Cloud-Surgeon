---
name: IAM CloudWatch Resource star — justified AWS limitation
description: Why cloudwatch:GetMetricData and cloudwatch:DescribeAlarms require Resource * and why this is not a security gap.
---

## Rule
`cloudwatch:GetMetricData` and `cloudwatch:DescribeAlarms` do not support resource-level ARN restrictions in AWS IAM. These two actions **must** use `"Resource": "*"`. This is documented AWS behavior, not a configuration choice.

All other Cloud-Surgeon IAM actions are scoped:
- ECS: `arn:aws:ecs:<region>:<account>:service/cloud-surgeon/*` + cluster ARN
- RDS: `arn:aws:rds:<region>:<account>:db:*`
- Lambda: `arn:aws:lambda:<region>:<account>:function:*`

**Why:** AWS documentation explicitly lists these CloudWatch actions as not supporting resource-level permissions. If a security reviewer flags the `*` on CloudWatch actions, cite the AWS documentation — it is an AWS API limitation, not a misconfiguration.

**How to apply:** When creating or updating the ECS task role, put CloudWatch actions in a separate `Statement` block with `"Resource": "*"` and a descriptive `Sid` (e.g. `"CloudWatchRead"`). Add a comment in the policy document explaining why.
