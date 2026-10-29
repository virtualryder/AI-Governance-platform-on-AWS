#!/usr/bin/env bash
# Create a human CSR user in the platform's Cognito pool and add them to the entitlement group, so a
# person can obtain a JWT carrying cognito:groups and drive the governed workflow (F08).
#
# IaC intentionally does NOT bake in user credentials — provision humans with this scripted,
# auditable flow. Requires: the brokered-Cognito identity with identity.humanAuth.enabled (creates the
# group + human app client), and AWS creds for an admin with cognito-idp:AdminCreateUser /
# AdminSetUserPassword / AdminAddUserToGroup.
#
# Usage:
#   ./create-human-user.sh --pool-id <USER_POOL_ID> --username csr-alice \
#       --group csr-agents --profile <aws-profile> --region us-east-1 [--password '<pw>']
# If --password is omitted a strong one is generated and printed once.
set -euo pipefail

POOL_ID=""; USERNAME=""; GROUP="csr-agents"; PROFILE=""; REGION="us-east-1"; PASSWORD=""; EMAIL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pool-id) POOL_ID="$2"; shift 2;;
    --username) USERNAME="$2"; shift 2;;
    --group) GROUP="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --password) PASSWORD="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -z "$POOL_ID" || -z "$USERNAME" ]] && { echo "required: --pool-id, --username" >&2; exit 2; }
AWS=(aws --region "$REGION"); [[ -n "$PROFILE" ]] && AWS+=(--profile "$PROFILE")
[[ -z "$EMAIL" ]] && EMAIL="${USERNAME}@example.gov"
if [[ -z "$PASSWORD" ]]; then
  PASSWORD="Aa1!$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20)"
  echo "Generated password for ${USERNAME} (store securely, shown once): ${PASSWORD}"
fi

"${AWS[@]}" cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$USERNAME" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS >/dev/null
# Set a permanent password so there is no FORCE_CHANGE_PASSWORD challenge for the test flow.
"${AWS[@]}" cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$USERNAME" \
  --password "$PASSWORD" --permanent
# Only add to a group when one is given. An empty --group creates a deliberately UN-grouped user
# (the negative-test "viewer" who must be denied by deny-by-default) — adding to "" would error.
if [[ -n "$GROUP" ]]; then
  "${AWS[@]}" cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$USERNAME" \
    --group-name "$GROUP"
  echo "Created ${USERNAME} in group ${GROUP} (pool ${POOL_ID})."
else
  echo "Created ${USERNAME} with NO group (pool ${POOL_ID}) — expected to be denied by deny-by-default."
fi
echo "Obtain a token (requires identity.humanAuth.enableUserPasswordAuth + the human client id):"
echo "  aws cognito-idp initiate-auth --region ${REGION} --auth-flow USER_PASSWORD_AUTH \\"
echo "    --client-id <HUMAN_CLIENT_ID> --auth-parameters USERNAME=${USERNAME},PASSWORD='<password>'"
