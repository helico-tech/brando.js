---
status: complete
---

# BRANDOJS-0002: submit without executable handlers

Implements [the producer contract design](../specs/2026-09-20-BRANDOJS-0002-producer-contracts.md) for the Buma/Stemra Bull migration.

- Explicit zero-worker mode starts no worker or maintenance loops.
- Outbound contracts permit validated submission and atomic sends across worker profiles.
- Local reminders still require executable handlers; no storage-schema changes.
- Runtime dependency minima are pg 8.20.0, Zod 4.3.6, and @types/pg 8.18.0: the full suite passes on these and on 8.23.0/4.6.5/8.23.1. This supports existing consumers without bypassing their dependency age policies.

Validation: full typecheck, lint, format, 35 tests, production build, three browser tests, and installed ESM/CommonJS/TypeScript consumers passed. The browser suite executes `pnpm start` against a fresh schema and confirms health and interaction. The migration spike also captured the original dashboard before submission and a completed retry afterward with no console errors.
