#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-partsfinsad}"
TRIGGER_NAME="${FRONTEND_BUILD_TRIGGER_NAME:-deploy-crusher-frontend}"
BRANCH="${DEPLOY_BRANCH:-main}"

echo "Resolving frontend build trigger '${TRIGGER_NAME}' in project '${PROJECT_ID}'..."
TRIGGER_ID="$(gcloud builds triggers list \
  --project="${PROJECT_ID}" \
  --format="value(id)" \
  --filter="name=${TRIGGER_NAME}" | head -n 1)"

if [ -z "${TRIGGER_ID}" ]; then
  echo "Frontend build trigger not found: ${TRIGGER_NAME}" >&2
  exit 1
fi

echo "Running frontend trigger ${TRIGGER_ID} from branch ${BRANCH}..."
BUILD_ID="$(gcloud builds triggers run "${TRIGGER_ID}" \
  --project="${PROJECT_ID}" \
  --region="global" \
  --branch="${BRANCH}" \
  --format="value(metadata.build.id)")"

if [ -z "${BUILD_ID}" ]; then
  echo "Frontend build started, but build id was not returned." >&2
  exit 1
fi

echo "Frontend build started: ${BUILD_ID}"
echo "Streaming logs until completion..."
gcloud builds log --project="${PROJECT_ID}" --stream "${BUILD_ID}"

STATUS="$(gcloud builds describe "${BUILD_ID}" --project="${PROJECT_ID}" --format="value(status)")"
echo "Frontend build final status: ${STATUS}"

if [ "${STATUS}" != "SUCCESS" ]; then
  exit 1
fi
