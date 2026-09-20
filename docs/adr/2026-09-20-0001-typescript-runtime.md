---
status: accepted
---

# 0001: TypeScript runtime with a PostgreSQL adapter

BRANDOJS-0001 ports the semantics of Brando at `6a07d99`. The reference’s architecture and the histories of TurnKernel and the primitive modules establish the behavior. A separate schema avoids pretending JavaScript and kotlinx.serialization share wire identities.

A small, framework-free model/kernel handles typed registration, codec validation and turn planning. A PostgreSQL store owns short transactions, actor locks and fenced commits. The runtime owns attempts, lease renewal, bounded drains, maintenance and local waiting. The HTTP adapter is an edge; the React console is compiled into optional static assets. There is no storage SPI or broker abstraction.

Node 24 is the minimum runtime. Current registry research on 2026-09-20 found TypeScript 7.0.2, but typescript-eslint 8.70.0 declares support below 6.1; use TypeScript 6.0.3, the newest compatible stable line. React 19.3, Vite 8.3 and Tailwind 4.3 are compatible with Node 24. pnpm 11.25 is the existing machine toolchain, pinned in packageManager. The only approved dependency build script is esbuild. Component source comes from the official shadcn new-york registry and is vendored with its MIT license; Inter is bundled with its OFL license.

ESM JavaScript plus declarations supports TypeScript, ESM JavaScript, and Node 24’s synchronous require(ESM). The published library has no React runtime requirement. Release tarballs on GitHub provide a reviewed installable package without claiming an npm registry publication.

Research: [Node releases](https://nodejs.org/en/about/previous-releases), [node-postgres transactions](https://node-postgres.com/features/transactions), [shadcn installation](https://ui.shadcn.com/docs/installation/manual), [shadcn Tailwind 4](https://ui.shadcn.com/docs/tailwind-v4), [pnpm settings](https://pnpm.io/settings). Exact package versions and peer support were queried from registry.npmjs.org; the lockfile is authoritative.
