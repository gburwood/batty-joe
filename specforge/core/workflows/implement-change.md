# Implement Change Workflow

1. Run executable bootstrap readiness.
2. Request implementation transition through the lifecycle gate.
3. Confirm exact current proposal has valid human-authorised approval and matching digest when Controlled mode requires it.
4. Record implementation attempt where meaningful.
5. Modify implementation within approved scope.
6. Run relevant change-specific tests and record `passed`, `failed`, `blocked`, or `unavailable`.
7. Run SpecForge structural validation.
8. Record implementation outcome and immutable source revision when available.
9. Request completion through the lifecycle gate.
10. Complete only if every mandatory gate passes; otherwise retain current state and report machine-readable blockers.
11. Record forensic events and release traceability where applicable.
