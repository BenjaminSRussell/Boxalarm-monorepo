#!/usr/bin/env bash
# Creates a department's first ADMIN or CHIEF - the one member nobody else can create,
# because adding members and assigning roles both require an ADMIN or CHIEF already.
#
# It goes through the deployed code, not hand-written items: it invokes the stack's
# members-create Lambda (Cognito login + member row) and then its members-update-roles Lambda
# (Cognito group + member row + audit entry + member.updated event, which also creates the
# member's alerting eligibility snapshot), each with a principal marked "bootstrap" so the
# audit log shows where the member came from. Cognito emails the member a temporary password.
#
# Refuses to run once the department has any ADMIN or CHIEF: after that, use the web app.
# Asks you to re-type the department id (or pass --yes), because a typo would create an
# admin in a department that does not exist. If a run created the login but failed before
# assigning the role, running it again with the same arguments finishes the job.
# Don't run it twice at once for the same department.
#
# Usage:
#   bootstrap-first-admin.sh <env> --dept-id NICHOLS --email chief@example.org \
#     --first-name Pat --last-name Doe --phone +12035550100 --rank Chief \
#     --agency-id NICHOLS-FD [--role CHIEF|ADMIN] [--join-date YYYY-MM-DD] [--yes]
# Needs the AWS CLI v2 and jq, with credentials for the stack's account. AWS_REGION defaults
# to us-east-1 (every stack is pinned there).
set -euo pipefail

usage() {
  sed -n '18,22p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
env="$1"
shift
[[ "$env" =~ ^(dev|qa|staging|prod)$ ]] || usage

role=ADMIN
confirmed=0
join_date="$(date -u +%Y-%m-%d)"
dept_id="" email="" first_name="" last_name="" phone="" rank="" agency_id=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--yes" ]]; then
    confirmed=1
    shift
    continue
  fi
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

# Per department: the pool is shared, so another department's admin must not block this one.
for group in ADMIN CHIEF; do
  existing="$(aws cognito-idp list-users-in-group --user-pool-id "$pool_id" --group-name "$group" \
    --query "length(Users[?Attributes[?Name=='custom:deptId' && Value=='${dept_id}']])" \
    --output text)"
  if [[ "$existing" != "0" ]]; then
    echo "refusing: ${dept_id} already has a member in $group - add members from the web app" >&2
    exit 1
  fi
done

if [[ "$confirmed" -ne 1 ]]; then
  [[ -t 0 ]] || { echo "not a terminal: pass --yes to confirm department ${dept_id}" >&2; exit 2; }
  read -r -p "Creating ${role} ${email} in department ${dept_id}. Re-type the department id to confirm: " typed
  [[ "$typed" == "$dept_id" ]] || { echo "department id did not match; nothing was created" >&2; exit 1; }
fi

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# Invokes a members Lambda as API Gateway would, with the bootstrap principal the authorizer
# would otherwise supply. Prints the response body; fails on any non-2xx other than the ones
# the caller says it handles (passed as a third argument, e.g. "409").
invoke() {
  local fn="$1" event="$2" tolerated="${3:-}"
  aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
    --payload "$event" "$out" >/dev/null
  local status
  status="$(jq -r '.statusCode // empty' "$out")"
  if [[ -n "$tolerated" && "$status" == "$tolerated" ]]; then
    echo "__STATUS_${status}__"
    return
  fi
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
created="$(invoke "$create_fn" "$create_event" 409)"
if [[ "$created" == "__STATUS_409__" ]]; then
  # A login already exists for this email - an earlier run that stopped before the role step.
  # Resume only if that login belongs to this department.
  login="$(aws cognito-idp admin-get-user --user-pool-id "$pool_id" --username "$email" --output json)"
  login_dept="$(jq -r '.UserAttributes[] | select(.Name == "custom:deptId") | .Value' <<<"$login")"
  if [[ "$login_dept" != "$dept_id" ]]; then
    echo "refusing: ${email} already has a login in department '${login_dept}'" >&2
    exit 1
  fi
  member_id="$(jq -r '.UserAttributes[] | select(.Name == "sub") | .Value' <<<"$login")"
  echo "resuming: ${email} already has a login (member ${member_id}); assigning the role."
else
  member_id="$(jq -r '.memberId' <<<"$created")"
  echo "created member ${member_id} (${email}); Cognito has emailed a temporary password."
fi

roles_event="$(jq -nc --argjson principal "$principal" --arg memberId "$member_id" \
  --arg role "$role" --arg requestId "$request_id-roles" \
  '{version: "2.0", routeKey: "PUT /api/v1/personnel/members/{memberId}/roles", headers: {},
    pathParameters: {memberId: $memberId},
    requestContext: {requestId: $requestId, authorizer: {lambda: $principal}},
    body: ({roles: ["MEMBER", $role]} | tojson), isBase64Encoded: false}')"
invoke "$roles_fn" "$roles_event" | jq -r '"roles: \(.roles | join(", "))"'
echo "done: ${email} can sign in and add the rest of the department from the web app."
