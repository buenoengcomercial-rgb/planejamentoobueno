# Architecture rules

- Period daily-report PDFs read all confirmed reports using paginated inclusive date queries before rendering; partial page state must not omit saved diaries.

- Legacy private role checks delegate to the canonical public membership helper through a non-public compatibility function; this preserves trigger checks without duplicating authorization rules.

- Undo stores record/field deltas and compares expected values before reversal; whole-project restoration is forbidden because it overwrites later edits in other areas.
- Operational deletion must have explicit new audit intent and pass integrity checks before any parent or collection write; absence in a partial project is not deletion authority.
- Failed daily-report edits use a user/project-scoped durable draft separate from confirmed cloud state; confirmation clears only the matching revision.
- Performance changes require comparable measurements and preserve complete calculation inputs; unloaded collections must never be interpreted as empty.
- Weekly routine reuses full task schedules only within one calculation call; call-local reuse avoids repeated daily work without retaining stale calendar or production results.
- Measurement loads replay at most a short event tail: load_measurement_workspace checkpoints confirmed events into the base snapshot (verified against the entry-state projection) so reads stay under the statement timeout.

# Regression rule for code changes

- For every corrected bug, add or update a focused automated test that reproduces the failure before the fix and passes after it. Assert the observable behavior and the nearby data, permission, and persistence contracts that the change could affect.
- For new behavior, add tests for the expected path and relevant limits or failure paths. Preserve existing regression tests; change them only when an approved product rule changes, with the reason recorded in the change.
- Before completing a code change, run the focused tests, `npm run verify:regression`, and ESLint on the modified source files. Investigate failures instead of weakening assertions, skipping tests, or hiding errors. The CI regression gate runs on pushes and pull requests.
- If a change affects cloud state, synchronization, or an operational UI flow, also validate that flow in the current Lovable project with reversible test data. Local automation does not establish the state of the live platform.
