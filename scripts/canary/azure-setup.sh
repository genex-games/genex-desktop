#!/usr/bin/env bash
# One-time Azure setup for the release canary, run by the subscription's owner in Azure Cloud Shell
# (bash). It creates what .github/workflows/canary.yml signs in with, and nothing that costs money:
#
#   - an app registration "genex-desktop-canary" whose only credential is GitHub's OIDC token for
#     the `canary` environment of genex-games/genex-desktop (no password or key exists),
#   - the Contributor role for it on this subscription (each run makes and deletes its own
#     resource group),
#   - the resource providers a new subscription has to register, and
#   - a $30 monthly budget that emails the owner at 80% (pay-as-you-go only; a free trial has its
#     own spending limit instead).
#
# It prints the three IDs the workflow needs. Run it again safely: it reuses what exists.
set -euo pipefail

REPO="genex-games/genex-desktop"
APP_NAME="genex-desktop-canary"
LOCATION="${CANARY_LOCATION:-westeurope}"
BUDGET="${CANARY_BUDGET_USD:-30}"

subscription=$(az account show --query id -o tsv)
tenant=$(az account show --query tenantId -o tsv)
# A Microsoft account signs in as live.com#<address>; the budget mails the address.
email=$(az account show --query user.name -o tsv | sed 's/^live\.com#//')
echo "Subscription $subscription, tenant $tenant, signed in as $email"

app=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [ -z "$app" ]; then app=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv); fi
az ad sp show --id "$app" >/dev/null 2>&1 || az ad sp create --id "$app" >/dev/null

# The repository signs its OIDC tokens with GitHub's immutable subject (owner and repository by
# their numeric ids, so a renamed or re-created repository cannot pass for it); the name form is
# trusted too, in case that setting is ever switched back.
ids=$(curl -fsS "https://api.github.com/repos/$REPO" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["owner"]["id"], d["id"])')
read -r owner_id repo_id <<<"$ids"
owner=${REPO%/*}
name=${REPO#*/}
trust() {
  if az ad app federated-credential list --id "$app" --query "[].subject" -o tsv | grep -qxF "$2"; then return; fi
  az ad app federated-credential create --id "$app" --parameters "{
    \"name\": \"$1\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$2\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" >/dev/null
}
trust canary-environment "repo:${REPO}:environment:canary"
trust canary-environment-ids "repo:${owner}@${owner_id}/${name}@${repo_id}:environment:canary"

# A new service principal can take a few seconds to be visible to role assignment.
for attempt in 1 2 3 4 5 6; do
  if [ -n "$(az role assignment list --assignee "$app" --role Contributor --scope "/subscriptions/$subscription" --query "[0].id" -o tsv 2>/dev/null)" ]; then break; fi
  if az role assignment create --assignee "$app" --role Contributor --scope "/subscriptions/$subscription" >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 6 ]; then echo "Could not give $APP_NAME the Contributor role"; exit 1; fi
  sleep 10
done

for namespace in Microsoft.Compute Microsoft.Network Microsoft.Storage; do
  az provider register --namespace "$namespace" >/dev/null
done

start=$(date -u +%Y-%m-01)
budget_body=$(cat <<JSON
{"properties": {"category": "Cost", "amount": $BUDGET, "timeGrain": "Monthly",
  "timePeriod": {"startDate": "${start}T00:00:00Z", "endDate": "2030-12-31T00:00:00Z"},
  "notifications": {"actual80": {"enabled": true, "operator": "GreaterThan", "threshold": 80,
    "contactEmails": ["$email"], "thresholdType": "Actual"}}}}
JSON
)
if az rest --method put --only-show-errors \
  --url "https://management.azure.com/subscriptions/$subscription/providers/Microsoft.Consumption/budgets/genex-canary?api-version=2023-05-01" \
  --body "$budget_body" >/dev/null 2>&1; then
  echo "Budget: \$$BUDGET a month, email to $email at 80%"
else
  echo "Budget: not available on this subscription yet (a free trial stops at its credit by itself)"
fi

echo
echo "Windows images in $LOCATION:"
az vm image list-skus -l "$LOCATION" -p MicrosoftWindowsDesktop -f windows-11 --query "[].name" -o tsv | grep -E "pro|ent" | sort | tail -4 || true
az vm image list-skus -l "$LOCATION" -p MicrosoftWindowsDesktop -f Windows-10 --query "[].name" -o tsv | grep -E "22h2-(pro|ent)" | sort | tail -4 || true
echo "vCPU quota in $LOCATION:"
az vm list-usage -l "$LOCATION" --query "[?name.value=='cores' || name.value=='standardDASv5Family'].{name:name.localizedValue, used:currentValue, limit:limit}" -o table || true

echo
echo "Send these three lines back (they are IDs, not secrets):"
echo "AZURE_CLIENT_ID=$app"
echo "AZURE_TENANT_ID=$tenant"
echo "AZURE_SUBSCRIPTION_ID=$subscription"
