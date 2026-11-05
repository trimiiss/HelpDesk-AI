#!/usr/bin/env bash
# Creates a local k3s cluster and installs the chart into it, with no accounts.
# Stop the Compose stack first on a small machine: `npm run sim:down`.
# Run from the repo root: bash deploy/k3d/up.sh
set -euo pipefail

CLUSTER=helpdesk
NAMESPACE=helpdesk
COMPOSE=(docker compose --env-file deploy/sim/sim.env)
IMAGES=(call-gateway knowledge-service call-worker admin-ui ingest-job sim)

if ! k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create --config deploy/k3d/cluster.yaml --wait
fi

# One at a time: building them together can run a small Docker VM out of memory.
for service in call-gateway knowledge-service call-worker admin-ui ingest sim; do
  echo "Building $service..."
  "${COMPOSE[@]}" build "$service"
done

echo "Loading images into the cluster..."
k3d image import -c "$CLUSTER" $(printf 'helpdesk/%s:dev ' "${IMAGES[@]}")

kubectl apply -f deploy/k3s/traefik-config.yaml

bash deploy/helm/fetch-charts.sh

# The admin hash lives in sim.env, so there's only one copy of the test password.
HASH=$(grep '^ADMIN_PASSWORD_HASH=' deploy/sim/sim.env | cut -d= -f2-)

echo "Installing the chart..."
helm upgrade --install helpdesk deploy/helm/helpdesk \
  --namespace "$NAMESPACE" --create-namespace \
  --values deploy/helm/helpdesk/values-k3d.yaml \
  --set-string "secrets.values.ADMIN_PASSWORD_HASH=$HASH" \
  --wait --timeout 10m

kubectl -n "$NAMESPACE" get pods
