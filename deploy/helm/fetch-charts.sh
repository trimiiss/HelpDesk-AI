#!/usr/bin/env bash
# Downloads the third-party charts at the exact versions pinned in Chart.lock.
# Helm refuses to build from a lock file until it knows every repository in it.
# Run from the repo root: bash deploy/helm/fetch-charts.sh
set -euo pipefail

helm repo add nats https://nats-io.github.io/k8s/helm/charts/ --force-update
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts --force-update
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
helm repo add grafana-community https://grafana-community.github.io/helm-charts --force-update

helm dependency build deploy/helm/helpdesk
