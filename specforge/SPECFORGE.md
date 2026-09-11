# SpecForge Project Entry Point

This repository uses SpecForge project format 1.

A fresh human or AI session MUST:
1. Read `specforge/project.yaml`.
2. Resolve project-format and Core versions.
3. Load Core rules, schemas, workflows and tooling through manifest paths.
4. Resolve installed packs and precedence.
5. Locate authoritative product specification and canonical data model.
6. Inspect every non-terminal change and current proposal, approvals and implementation evidence.
7. Inspect relevant decisions and forensic history.
8. Run bootstrap/status before governed mutation.
9. Treat repository state, never prior chat or AI memory, as continuation authority.
10. Request lifecycle transitions through SpecForge tooling.

Framework-owned material is beneath `specforge/core/` and `specforge/packs/`. Project-owned governance state is beneath `specforge/changes/`, `specforge/decisions/`, `specforge/history/` and `specforge/evidence/`. Candidate distributions such as `specforge-dist/` are upgrade inputs, never installed project authority.
