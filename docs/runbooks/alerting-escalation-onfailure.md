# Runbook: alerting escalation on-failure queue

**Alarm:** `boxalarm-<env>-alerting-escalation-onfailure` (pages through `alerting-page`).

**What it means.** EventBridge Scheduler invokes two alerting Lambdas asynchronously:

- `boxalarm-<env>-alerting-escalation` places a member's voice call about 75 s after a tone they have not answered;
- `boxalarm-<env>-alerting-tone-evaluator` fires tone 2 at T+180 s and tone 3 at T+360 s, and requests mutual aid after an unanswered tone 3.

After Lambda's retries (2 retries, up to an hour of event age) a failed invocation lands in `boxalarm-<env>-alerting-escalation-onfailure`. **Every message in that queue is a voice call, a tone, or a mutual-aid request that did not complete.** Treat it as a live paging failure while the incident is still running.

## First: is the incident still live?

Each message's `requestPayload` names the `dispatchId` (and `toneSequence`, plus `memberId` for a voice call). If the dispatch is still in progress, **tell the officer in charge now** which members may have missed a tone or call, and page by radio. Don't wait for the redrive.

## Find the cause

1. Read the failure: `requestContext.condition` is `RetriesExhausted` (the function threw) or `EventAgeExceeded` (it was throttled or unavailable for an hour).
2. For `RetriesExhausted`, search the function's log group (`/aws/lambda/boxalarm-<env>-alerting-escalation` or `-tone-evaluator`) around the message `timestamp` for `alerting.toneLadder.*Failed`, `alerting.mutualAid.*`, or `alerting.escalation.*` errors.
3. Fix it before redriving. A redrive into the same fault fails again and comes back to this queue after another round of retries.

## Redrive

From `infrastructure/`, with credentials for the stack's account:

```sh
scripts/redrive-escalation-onfailure.sh <env> --dry-run   # list what would be re-invoked
scripts/redrive-escalation-onfailure.sh <env>             # re-invoke and delete
```

What the script does and guarantees:

- It re-invokes each failed event asynchronously with its recorded `requestPayload`, then deletes the message. A message is deleted only after the re-invoke is accepted, so an interrupted run loses nothing.
- It only re-invokes this environment's two functions. Anything else is left on the queue and reported.
- **Repeating it is safe.** The Tone Evaluator resumes a partly fired tone and re-publishes only pages not yet sent. It re-runs a mutual-aid prompt pass that is still pending. It records a tone that was already committed as already fired. The escalation handler's per-member `RECEIPT#…#VOICE#<tone>` guard absorbs a call that was already placed.
- A redriven voice call for an incident that has since ended still dials the member. Before redriving an old message, check whether the dispatch is over, and delete the message instead if it is.

The alarm clears once the queue is empty, one minute after the last message is gone.

## Not covered here

- The fan-out on-failure queue (`boxalarm-<env>-alerting-fan-out-onfailure`) holds DynamoDB stream batch pointers, not payloads, and has its own procedure.
- Whether halting the tone ladder should also cancel voice calls already scheduled is an open product decision (OQ-25). Today a halt stops future tones, but a voice call already scheduled for an unanswered tone still goes out.
