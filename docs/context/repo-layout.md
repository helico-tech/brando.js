# Repository layout

- `src/`: public library and PostgreSQL adapter.
- `dashboard/`: React and shadcn/ui console, bundled with the library.
- `examples/`: executable consumer examples.
- `tests/`: kernel, PostgreSQL conformance, HTTP, and browser tests.
- `scripts/`: deterministic maintenance and validation tools.
- `docs/adr/`: dated, numbered decisions.
- `docs/specs/`: dated implementation designs.
- `docs/work/`: work items allocated by script.
- `docs/issues/`: dated issue queue managed by script.
- `docs/domain/`: semantics and operations.
- `docs/context/`: repository context and verification evidence; browser screenshots live here.
- `.worktrees/`: ignored isolated checkouts.

Generated distribution, dependency, browser log and test output directories are ignored; curated verification evidence is committed under docs/context.

`.github/` contains CI; `.githooks/` contains local gates. Root files are limited to the package manifest, lockfile, README/license/notices and toolchain/environment configuration, enforced by `scripts/validate-repo.mjs`. `docs/context/.package-check/` is an ignored, temporary package-consumer build directory and is removed after every check.
