#!/usr/bin/env bash
# Re-invokes the async alerting events that exhausted Lambda's retries and landed in
# boxalarm-<env>-alerting-escalation-onfailure (components/alerting/escalation.ts): a voice
# escalation, or a tone-2/3 evaluation (which also carries the tone-3 mutual-aid request).
#
# Runbook: docs/runbooks/alerting-escalation-onfailure.md. Fix the cause first - a redrive
# into the same fault just fails again and returns to the queue.
#
# Safe to repeat: both handlers are idempotent. The Tone Evaluator resumes a partly fired
# tone and re-publishes only unsent pages; the escalation handler's RECEIPT#...#VOICE guard
# absorbs a call already placed. Each message is deleted only after its re-invoke is
# accepted, so an interrupted run loses nothing.
#
# Usage: redrive-escalation-onfailure.sh <env> [--dry-run]
#   env        dev | qa | staging | prod
#   --dry-run  print what would be re-invoked; delete nothing
# Needs the AWS CLI v2 and jq, with credentials for the stack's account. AWS_REGION
# defaults to us-east-1 (every stack is pinned there).
set -euo pipefail

usage() {
  echo "usage: $0 <dev|qa|staging|prod> [--dry-run]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
env="$1"
[[ "$env" =~ ^(dev|qa|staging|prod)$ ]] || usage
dry_run=0
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--dry-run" ]] || usage
  dry_run=1
fi
export AWS_REGION="${AWS_REGION:-us-east-1}"

queue_url="$(aws sqs get-queue-url \
  --queue-name "boxalarm-${env}-alerting-escalation-onfailure" \
  --query QueueUrl --output text)"

# Only this stack's two Scheduler-invoked alerting functions may be re-invoked, whatever a
# message claims. Lambda records the invoked ARN with its qualifier (usually $LATEST).
allowed_fn="^arn:aws:lambda:${AWS_REGION}:[0-9]{12}:function:boxalarm-${env}-alerting-(escalation|tone-evaluator)(:[^:]+)?$"

redriven=0
skipped=0
while :; do
  # Received messages stay invisible for 5 minutes, so every message is seen once per run
  # and the loop ends when nothing visible is left - including in a dry run.
  batch="$(aws sqs receive-message --queue-url "$queue_url" \
    --max-number-of-messages 10 --wait-time-seconds 2 --visibility-timeout 300 \
    --output json)"
  count="$(jq '(.Messages // []) | length' <<<"$batch")"
  [[ "$count" -gt 0 ]] || break

  for ((i = 0; i < count; i++)); do
    message="$(jq -c ".Messages[$i]" <<<"$batch")"
    receipt="$(jq -r '.ReceiptHandle' <<<"$message")"
    body="$(jq -r '.Body' <<<"$message")"
    fn="$(jq -r '.requestContext.functionArn // empty' <<<"$body" 2>/dev/null || true)"
    payload="$(jq -c '.requestPayload // empty' <<<"$body" 2>/dev/null || true)"
    condition="$(jq -r '.requestContext.condition // "unknown"' <<<"$body" 2>/dev/null || true)"

    if [[ ! "$fn" =~ $allowed_fn || -z "$payload" ]]; then
      echo "LEFT ON QUEUE (not a recognized alerting failure record): $(jq -r '.MessageId' <<<"$message")" >&2
      skipped=$((skipped + 1))
      continue
    fi

    echo "${fn##*:function:} (${condition}): ${payload}"
    if [[ "$dry_run" -eq 1 ]]; then
      continue
    fi
    aws lambda invoke --function-name "$fn" --invocation-type Event \
      --cli-binary-format raw-in-base64-out --payload "$payload" /dev/null >/dev/null
    aws sqs delete-message --queue-url "$queue_url" --receipt-handle "$receipt"
    redriven=$((redriven + 1))
  done
done

if [[ "$dry_run" -eq 1 ]]; then
  echo "dry run: nothing re-invoked or deleted; received messages reappear in 5 minutes."
else
  echo "re-invoked and deleted: ${redriven}; left on queue: ${skipped}."
fi
