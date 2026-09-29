# boxalarm-infrastructure

All AWS infrastructure for **[Boxalarm](https://github.com/zdemanche/boxalarm-docs)** — a fire department operations platform. Tenant zero: Nichols Fire Department, Trumbull CT.

**This repo is the only thing that touches AWS.** [`boxalarm-ui`](https://github.com/zdemanche/boxalarm-ui) and [`boxalarm-backend`](https://github.com/zdemanche/boxalarm-backend) are build-only. Pulumi (TypeScript), deployed via GitHub OIDC → central org role.

## Hard constraints

- **U.S. region pinned.** NERIS requires servers inside U.S. geographic boundaries — a vendor obligation, not a preference. No global edge, no cross-region replication.
- **Usage-based cost only.** An unpaid volunteer municipal fire department is paying for this. Anything that idles expensively is the wrong answer; that constraint drove out OpenSearch, Kafka, and provisioned capacity.
- **No maintenance window may take alerting down.** Ever.

## What gets provisioned

| Area | Resources |
|---|---|
| Identity | Cognito user pool, Verified Permissions policy store |
| Data | 3 DynamoDB tables — `alerting`, `incident`, `platform`. On-demand, PITR on, Streams on from day one |
| Alerting transport | SNS **FIFO** topic + per-channel SQS **FIFO** queues, each with a paired DLQ |
| LOB transport | EventBridge `boxalarm-{env}-platform-bus` + rules → consumer SQS queues + DLQs |
| Scheduling | EventBridge Scheduler for one-time escalation timers |
| Compute | Lambda per service. **Alerting Lambdas are not VPC-attached** — no ENI cold start on the alert path |
| Encryption | Customer-managed KMS keys for the alerting and incident tables; AWS-managed for platform. Valkey encrypted at rest and in transit |
| Audit | CloudTrail incl. DynamoDB **data events** on the alerting table; S3 Object Lock (compliance mode) for audit entries and delivery receipts |

**Why SNS FIFO and not EventBridge for alerting:** FIFO ordering plus `MessageDeduplicationId` is load-bearing for the exactly-once delivery guarantee, and EventBridge has no FIFO mode.

## Environment separation

Per-environment NERIS base URL, OAuth credentials, and a distinct `User-Agent`. Dev traffic must never reach the NERIS production host.

## Push credentials (set out-of-band, per stack)

Push goes to APNs and FCM directly — no push vendor. `ChannelWorkers` creates four empty secrets per stack; the push worker cannot page anyone until they hold values. Full JSON shapes are in the header of `components/alerting/channel-workers.ts`.

| Secret | Value |
|---|---|
| `boxalarm-{env}-alerting-push-apns-credentials` | `{"teamId","keyId","privateKey"(.p8 PEM),"bundleId","environment"?:"production"\|"sandbox","interruptionLevel"?:"critical"\|"time-sensitive"}` |
| `boxalarm-{env}-alerting-push-apns-sandbox-credentials` | Same shape; always sent to the APNs sandbox host (self-test/canary) |
| `boxalarm-{env}-alerting-push-fcm-credentials` | Firebase service-account key JSON, as downloaded |
| `boxalarm-{env}-alerting-push-fcm-sandbox-credentials` | Service-account JSON; sends are `validate_only` (self-test/canary) |

Set `interruptionLevel` to `time-sensitive` until Apple grants the Critical Alerts entitlement (#4), and `environment` to `sandbox` on stacks whose app builds are development-signed. The worker only ever reads the sandbox secrets for `isTest` messages and fails closed if one is unset.

## Deploying

`lambdaCode()` (`components/shared/lambda-code.ts`) wires each Lambda to `../backend/dist/<service>/<function>/index.mjs`
when that bundle exists, and otherwise falls back to a fail-closed 501 placeholder — so `pulumi preview`/`pulumi up`
never fail outright for a missing build. **Always run `cd backend && npm run bundle` before deploying** so every
service/function key resolves to real code; a stale or missing bundle silently redeploys that Lambda back to the
501 stub. `lambdaCode()` logs a Pulumi warning for every fallback it takes — check `pulumi preview`/`pulumi up`
output for `lambdaCode: no bundle found for ...` before proceeding with any deploy.

## Getting started

Wave 1 foundations are in progress — see [PR #90](https://github.com/zdemanche/boxalarm-infrastructure/pull/90) and the open `-INFRA` issues. Stacks: `dev`, `qa`, `staging`, `prod` (`Pulumi.<env>.yaml`).
