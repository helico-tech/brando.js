---
status: complete
---

# BRANDOJS-0001: Port the durable actor runtime and ship the operations dashboard

Implement the reference durable actor contract as an installable Node library and a live shadcn dashboard. Publish source and an installable release on helico-tech/brando.js.

Scope and acceptance: [design](../specs/2026-09-20-BRANDOJS-0001-port.md), [semantic correspondence](../domain/semantics.md), [operations](../domain/operations.md).

Checkpoints: production kernel and PostgreSQL store; adversarial semantics and primitive behavior; authenticated API; responsive dashboard; package consumers, docs and GitHub release. Each checkpoint is verified before publication. The repository’s issue queue started empty.

Implementation uses no secondary agent. Browser smoke is promoted into repeatable Playwright tests. The manual before/after evidence is under docs/context; the baseline was blank because this workspace contained no application.

Resolution: the library and dashboard are implemented and published to helico-tech/brando.js. All local gates and GitHub CI passed. The versioned package is described in [release notes](../context/release-0.1.0.md). Review findings were fixed within this unit with regression tests; the issue queue is empty.
