# Architecture rules

- Undo stores record/field deltas and compares expected values before reversal; whole-project restoration is forbidden because it overwrites later edits in other areas.
- Operational deletion must have explicit new audit intent and pass integrity checks before any parent or collection write; absence in a partial project is not deletion authority.
- Failed daily-report edits use a user/project-scoped durable draft separate from confirmed cloud state; confirmation clears only the matching revision.
- Performance changes require comparable measurements and preserve complete calculation inputs; unloaded collections must never be interpreted as empty.
- Weekly routine reuses full task schedules only within one calculation call; call-local reuse avoids repeated daily work without retaining stale calendar or production results.