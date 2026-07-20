---
name: ecsTaskExecutionRole needs inline Secrets Manager policy
description: The AWS-managed AmazonECSTaskExecutionRolePolicy does not grant secretsmanager:GetSecretValue; this causes a hard boot failure in ECS when secrets are referenced in the task definition.
---

**Rule:** Always attach an inline policy granting `secretsmanager:GetSecretValue` to `ecsTaskExecutionRole` for any secret referenced in a task definition. The managed `AmazonECSTaskExecutionRolePolicy` does **not** include this permission.

**Why:** ECS resolves secrets at container start-time before the entrypoint runs. Without `GetSecretValue`, every task fails immediately with `ResourceInitializationError: AccessDeniedException`. This is not caught by the task definition registration step — it only surfaces when the service tries to place a task.

**How to apply:**
```bash
aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name cloud-surgeon-secrets-access \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue"],
    "Resource":"arn:aws:secretsmanager:us-east-1:153983052396:secret:cloud-surgeon/prod-k366bu"}]}'
```

Use the full secret ARN (including the random suffix like `-k366bu`). A wildcard `cloud-surgeon/prod*` also works and survives secret rotation.

Adding a new secret to Secrets Manager (e.g. `BEDROCK_API_KEY`) and referencing it in a new task definition revision does not change the ARN of the existing secret — the same inline policy covers it. No policy update needed unless you create a completely new secret with a different name.
