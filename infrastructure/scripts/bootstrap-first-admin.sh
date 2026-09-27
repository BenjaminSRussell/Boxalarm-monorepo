#!/usr/bin/env bash
# Creates a department's first ADMIN or CHIEF - the one member nobody else can create,
# because adding members and assigning roles both require an ADMIN or CHIEF already.
#
# It goes through the deployed code, not hand-written items: it invokes the stack's
# members-create Lambda (Cognito login + member row + member.created event) and then its
# members-update-roles Lambda (Cognito group + member row + member.updated event, which also
# reaches the alerting eligibility snapshot), each with a principal marked "bootstrap" so the
# audit log shows where the member came from. Cognito emails the member a temporary password.
#
# Refuses to run once the pool has any ADMIN or CHIEF: after that, use the web app.
#
# Usage:
#   bootstrap-first-admin.sh <env> --dept-id NICHOLS --email chief@example.org \
#     --first-name Pat --last-name Doe --phone +12035550100 --rank Chief \
#     --agency-id NICHOLS-FD [--role CHIEF|ADMIN] [--join-date YYYY-MM-DD]
# Needs the AWS CLI v2 and jq, with credentials for the stack's account. AWS_REGION defaults
# to us-east-1 (every stack is pinned there).
set -euo pipefail

usage() {
  sed -n '14,18p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
env="$1"
shift
[[ "$env" =~ ^(dev|qa|staging|prod)$ ]] || usage

role=ADMIN
join_date="$(date -u +%Y-%m-%d)"
dept_id="" email="" first_name="" last_name="" phone="" rank="" agency_id=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --dept-id) dept_id="$2" ;;
    --email) email="$2" ;;
    --first-name) first_name="$2" ;;
    --last-name) last_name="$2" ;;
    --phone) phone="$2" ;;
    --rank) rank="$2" ;;
    --agency-id) agency_id="$2" ;;
    --role) role="$2" ;;
    --join-date) join_date="$2" ;;
    *) usage ;;
  esac
  shift 2
done
for required in dept_id email first_name last_name phone rank agency_id; do
  [[ -n "${!required}" ]] || { echo "missing --${required//_/-}" >&2; usage; }
done
[[ "$role" =~ ^(ADMIN|CHIEF)$ ]] || { echo "--role must be ADMIN or CHIEF" >&2; exit 2; }
export AWS_REGION="${AWS_REGION:-us-east-1}"

create_fn="boxalarm-${env}-personnel-members-create"
roles_fn="boxalarm-${env}-personnel-members-update-roles"

pool_id="$(aws lambda get-function-configuration --function-name "$create_fn" \
  --query 'Environment.Variables.COGNITO_USER_POOL_ID' --output text)"
[[ -n "$pool_id" && "$pool_id" != "None" ]] || { echo "no COGNITO_USER_POOL_ID on $create_fn" >&2; exit 1; }

for group in ADMIN CHIEF; do
  existing="$(aws cognito-idp list-users-in-group --user-pool-id "$pool_id" \
    --group-name "$group" --max-results 1 --query 'length(Users)' --output text)"
  if [[ "$existing" != "0" ]]; then
    echo "refusing: the pool already has a member in $group - add members from the web app" >&2
    exit 1
  fi
done

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# Invokes a members Lambda as API Gateway would, with the bootstrap principal the authorizer
# would otherwise supply. Prints the response body; fails on any non-2xx.
invoke() {
  local fn="$1" event="$2"
  aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
    --payload "$event" "$out" >/dev/null
  local status
  status="$(jq -r '.statusCode // empty' "$out")"
  if [[ ! "$status" =~ ^2 ]]; then
    echo "$fn answered ${status:-an error}: $(jq -c '.body // .' "$out")" >&2
    exit 1
  fi
  jq -r '.body' "$out"
}

principal="$(jq -nc --arg dept "$dept_id" \
  '{sub: "bootstrap", deptId: $dept, "cognito:groups": "ADMIN"}')"
request_id="bootstrap-$(date -u +%s)"

create_body="$(jq -nc --arg firstName "$first_name" --arg lastName "$last_name" \
  --arg phone "$phone" --arg email "$email" --arg joinDate "$join_date" \
  --arg rank "$rank" --arg agencyId "$agency_id" \
  '{firstName: $firstName, lastName: $lastName, phone: $phone, email: $email,
    joinDate: $joinDate, rank: $rank, agencyId: $agencyId}')"
create_event="$(jq -nc --argjson principal "$principal" --arg body "$create_body" \
  --arg requestId "$request_id-create" \
  '{version: "2.0", routeKey: "POST /api/v1/personnel/members", headers: {},
    requestContext: {requestId: $requestId, authorizer: {lambda: $principal}},
    body: $body, isBase64Encoded: false}')"
member_id="$(invoke "$create_fn" "$create_event" | jq -r '.memberId')"
echo "created member ${member_id} (${email}); Cognito has emailed a temporary password."

roles_event="$(jq -nc --argjson principal "$principal" --arg memberId "$member_id" \
  --arg role "$role" --arg requestId "$request_id-roles" \
  '{version: "2.0", routeKey: "PUT /api/v1/personnel/members/{memberId}/roles", headers: {},
    pathParameters: {memberId: $memberId},
    requestContext: {requestId: $requestId, authorizer: {lambda: $principal}},
    body: ({roles: ["MEMBER", $role]} | tojson), isBase64Encoded: false}')"
invoke "$roles_fn" "$roles_event" | jq -r '"roles: \(.roles | join(", "))"'
echo "done: ${email} can sign in and add the rest of the department from the web app."
