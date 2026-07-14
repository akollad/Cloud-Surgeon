---
name: aws.ts hard-requires static AWS keys, ignores IAM roles
description: Cloud-Surgeon's AWS repair module gates "LIVE vs SIMULATED" on AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars, not the SDK's default credential chain.
---

`artifacts/api-server/src/lib/aws.ts` (`hasCredentials()`) explicitly checks
`process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY` and returns
`{ simulated: true }` for every repair action if that check fails — it never falls back to
the AWS SDK's default provider chain (instance/task IAM role, SSO, etc.).

**Why:** written to behave identically in Replit dev (no IAM role available) and any other
environment — the trade-off is that a real ECS Fargate deployment with a **task role** and no
static keys will still report AWS tools as SIMULATED, even though the SDK could authenticate
live via the role.

**How to apply:** when deploying this service anywhere with IAM roles available (ECS task
role, EC2 instance profile, etc.), still inject `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` as
explicit secrets/env vars if you want the "LIVE" repair path to activate — the task role alone
is not sufficient with the current code. Same pattern likely applies to any future check that
mirrors `hasCredentials()`.
