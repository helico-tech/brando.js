---
status: complete
---

# BRANDOJS-0003: support existing CommonJS TypeScript consumers

The application uses TypeScript's classic Node resolution with CommonJS output.
Brando 0.2.0 could be required by Node 24 but its exports-only metadata was
invisible to that compiler. Add conventional `main`, `types`, and subpath
`typesVersions` metadata without changing the runtime module format.

The installed-package regression failed to resolve all four entrypoints before
the change and passed afterward. The package check now covers NodeNext and
classic CommonJS TypeScript consumers, plus actual Node ESM and CommonJS execution.

Jest 30.2's custom CommonJS runtime cannot parse the ESM distribution. Consumers
using that older runner must transform this dependency or use an ESM-aware runner;
Node's native require support does not imply Jest support. This is distinct from
application execution and is not hidden by mocking Brando.
