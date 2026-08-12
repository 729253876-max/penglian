# Task 3 implementer report

## Result

- Implemented deterministic first-stage portrait diagnosis and two controlled rescue plans.
- `qualityWarning=true` produces only `LIGHT_NOISE` and `LIGHT_BLUR`; `false` produces no findings.
- Both plans preserve the same seven fidelity protections and forbid the same five unsafe operations.
- Task creation authorizes the owner-scoped approved asset before any task persistence, returns diagnosis and the default direction, and records the strict truthful event sequence.
- Production assembly injects `MySqlPortraitAssetReader`; `StageADemoAssetReader` is explicitly injected only by legacy demo tests. The existing provider/repository boundary was not expanded into later-task production work.
- No network access, credentials, real database connection, or real user image was used.

## Scope

The approved implementation scope comprised these 11 code/test files:

1. `apps/api/src/application/portrait-diagnosis-service.ts`
2. `apps/api/src/application/portrait-plan-service.ts`
3. `apps/api/src/application/task-service.ts`
4. `apps/api/test/portrait-diagnosis-service.test.ts`
5. `apps/api/test/portrait-plan-service.test.ts`
6. `apps/api/test/task-service.test.ts`
7. `apps/api/src/app.ts`
8. `apps/api/src/server.ts`
9. `apps/api/test/tasks-api.test.ts`
10. `apps/api/test/http-smoke.test.ts`
11. `apps/api/test/task-ownership.test.ts`

This report is the required SDD execution record outside that code/test count.

## TDD evidence

### RED 1 — diagnosis, plans, and asset integration

Command:

```powershell
npm.cmd test -w @photo-ai/api -- portrait-diagnosis-service.test.ts portrait-plan-service.test.ts task-service.test.ts
```

Observed before implementation:

- Exit code `1`.
- All three suites failed to load because the diagnosis and plan service modules did not exist.
- This established the intended missing feature before production code was added.

### Intermediate GREEN

The focused command then passed 3 files and 31 tests after the minimal services and TaskService integration were implemented.

### RED 2 — expanded production/demo assembly migration

The brief integration command exposed six `tasks-api.test.ts` failures because the legacy API assertions still encoded the old 3/9 event counts and cursors instead of the truthful 8/14 lifecycle. Removing TaskService's implicit demo reader also produced focused type errors at every legacy constructor that had not yet explicitly injected it.

After approval to expand scope, those tests were migrated to assert the actual event sequence, and production assembly was wired to `MySqlPortraitAssetReader`.

## Verified behavior

- Authorization occurs before the first `repository.save`; missing and cross-user assets leave `savedStatuses` empty.
- Creation events are strictly ordered:
  `ASSET_APPROVED` → `DIAGNOSIS_STARTED` → zero or more legitimate `DIAGNOSIS_FINDING` events → `PROTECTION_RECORDED` → two `PLAN_READY` events → `PLAN_SELECTED`, followed by `AWAITING_CONFIRMATION` state persistence.
- The warning fixture produces exactly two findings, so the creation cursor is 8; the successful preview lifecycle ends at 14.
- API incremental cursor tests assert all seven events after sequence 1 rather than merely changing numeric counts.
- Production `server.ts` constructs `TaskService` with `MySqlPortraitAssetReader(pool)`.
- `StageADemoAssetReader` is not referenced by production assembly and is explicitly passed only in demo test paths.

## Fresh verification

```powershell
npm.cmd test -w @photo-ai/api -- portrait-diagnosis-service.test.ts portrait-plan-service.test.ts task-service.test.ts tasks-api.test.ts task-ownership.test.ts http-smoke.test.ts mysql-readiness.test.ts uploads-api.test.ts identity-api.test.ts
npm.cmd run typecheck -w @photo-ai/api
git diff --check
```

Results:

- 9 test files passed.
- 129 tests passed, 0 failed.
- API typecheck exited `0`.
- `git diff --check` exited `0`; only Git line-ending notices were printed.

## Self-review

- No fabricated face exposure, skin-tone, or background-highlight detection is present.
- Fixed plan parameters are exactly 85/35 and 75/60.
- The seven protections and five forbidden operations are shared by both plans.
- Task 1's discriminated truthful events and provider sanitization were retained.
- Task 2's owner-scoped approved normalized asset reader is consumed without weakening its authorization boundary.
- No files outside the approved implementation scope and this required report were modified.
