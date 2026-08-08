# Backend release identity and rollback

## Release identity

Every Cloud Build publishes two tags for the same image:

- immutable: `gcr.io/partsfinsad/crusher-backend:$COMMIT_SHA`;
- compatibility: `gcr.io/partsfinsad/crusher-backend:latest`.

Cloud Run is deployed from the immutable tag. `GET /api/version` returns only
safe identifiers: source commit, Cloud Build id, artifact tag and Cloud Run
revision. Cloud Run labels duplicate the short commit and build id for operator
lookup.

## Non-destructive preflight

Record the current and candidate rollback revisions without changing traffic:

```bash
gcloud run services describe crusher-backend --project=partsfinsad --region=europe-west4 --format='yaml(status.traffic,status.latestReadyRevisionName)'
gcloud run revisions list --service=crusher-backend --project=partsfinsad --region=europe-west4 --format='table(metadata.name,metadata.creationTimestamp,spec.containers[0].image,status.conditions[0].status)'
```

Verify the selected revision image digest/commit and retain the command output
in the incident/deployment record.

## Application rollback

Rollback changes Cloud Run traffic only. It does not roll back Cloud SQL:

```bash
gcloud run services update-traffic crusher-backend --project=partsfinsad --region=europe-west4 --to-revisions=ROLLBACK_REVISION=100
```

After traffic converges:

1. call `GET /api/version` and confirm the expected commit/build/revision;
2. run read-only authentication and critical GET smoke checks;
3. confirm error rate and latency before closing the rollback.

Do not route an older application revision across an incompatible contracted DB
schema. Slice 0.1 makes no DB changes, so revisions produced by this slice remain
application-level rollback candidates.
