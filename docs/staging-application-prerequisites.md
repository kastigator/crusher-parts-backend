# Staging application prerequisites

This document describes application controls only. It does not authorize creating staging, recovery, GCP, Cloud SQL, IAM, network, or storage resources.

## CORS

`CORS_ORIGINS` is a comma-separated list of exact origins. The legacy `CORS_ORIGIN` name remains accepted, but no production origin is implicit. `CORS_ALLOW_NO_ORIGIN` defaults to `true` for intentional non-browser/API-client compatibility and can be set to `false`. Before rolling this code to production, preserve the current frontend by explicitly setting `CORS_ORIGINS=https://storage.googleapis.com` (plus any other approved exact production origin).

## Outbound integrations

`OUTBOUND_MODE` controls OpenAI and FX globally; `OPENAI_OUTBOUND_MODE` and `FX_OUTBOUND_MODE` override it per service. Allowed values are `live`, `disabled`, and `fixture`. `APP_ENV=staging` or `APP_ENV=recovery` defaults to disabled. Production/local defaults remain live for compatibility. Staging/recovery should still set the mode explicitly.

OpenAI fixture output can be set with `OPENAI_FIXTURE_TEXT`. FX fixture rates can be supplied as an object in `FX_FIXTURE_RATES_JSON`, for example `{"USD->RUB":91.25}`. Disabled and fixture modes bypass external calls; FX also bypasses the application database path.

## Masking tool

Run `npm run staging:mask -- inventory|dry-run|mask|verify`. The CLI intentionally does not load dotenv and accepts only dedicated `MASK_TARGET_*` connection variables. It requires an explicit non-production `MASK_TARGET_ENV`, `PRODUCTION_TARGETS_JSON` for exact production identity comparison, and `MASK_FORBIDDEN_LITERALS_JSON` containing known production domains/buckets/resource strings. Mutation additionally requires `MASK_TARGET_CONFIRMATION=MASK_NON_PRODUCTION_DATA` and a runtime-only `MASKING_SEED` of at least 16 characters.

The versioned `wave0-staging-mask-v1` policy discovers the live schema, fails closed on unhandled sensitive-looking fields, recursively masks JSON, invalidates secrets/session state, removes document references, pseudonymizes PII/bank/legal/address data, and applies one deterministic factor to commercial money fields. Primary and foreign keys are preserved. Evidence contains safe counts, rule IDs, HMAC checksums, checks, and only a target fingerprint—not values or credentials.

Always run `inventory`, then `dry-run`, then `mask`; accept a dataset only when the transactional post-mask verification returns `PASS`. No production target or source database should ever be supplied to this CLI.
