# Bento Deno/TypeScript reimplementation specification

This directory is the implementation brief for replacing Bento's host-side Python control plane with a type-safe TypeScript application on Deno 2.9 while preserving Bento's product behavior and operating model.

The target is not a transliteration of Python modules into TypeScript. It is a clean reimplementation with explicit domain types, runtime validation at every untrusted boundary, reproducible dependencies, and two supported delivery modes:

1. run the TypeScript source directly with Deno during development and repository-based operation;
2. compile the same entrypoint into a standalone `bento` executable for production distribution.

Both modes must expose the same commands, state transitions, generated output, safety checks, and exit behavior. Python is a migration source and compatibility reference, not a target runtime dependency.

## Product in one sentence

Bento is a self-hosted operations layer for running multiple isolated PHP applications and reverse-proxied services on one Linux server using Docker Compose, with safe ingress, runtime, data, deployment, background-process, and maintenance workflows behind one management CLI.

## Documents

1. [01-product-spec.md](01-product-spec.md) defines the user, problem, product scope, and required capabilities.
2. [02-system-architecture.md](02-system-architecture.md) defines the topology, boundaries, data model, trust model, control flows, and technology stack.
3. [03-reimplementation-contract.md](03-reimplementation-contract.md) separates fixed product invariants from replaceable implementation choices and provides acceptance criteria.

Read them in that order. The product spec says what Bento must do, the architecture spec says how the system is divided, and the contract says what a replacement must prove.

## Baseline and interpretation

This specification reflects the repository behavior surveyed on 2026-07-16. The implementation, tests, `README.md`, and `docs/architecture.md` define the current product baseline. The root `auto_deploy.md` has been merged into these specifications: its settled design decisions are requirements here, while obsolete draft notes and contradicted alternatives are not.

The Deno target is the stable 2.9 release line. Development and CI must pin an exact 2.9.x runtime, record it in repository/release tooling, and deliberately update that patch version. Production may run the sources with the same pinned runtime or use an executable produced by that pinned runtime.

Where the existing product exposes a specific safety or compatibility guarantee, the guarantee is retained. Exact command names, output formatting, file names, template syntax, and internal code organization are not part of the required design unless explicitly called out as an invariant.

## Deno implementation policy

- Use strict TypeScript throughout the host control plane. External JSON, environment variables, CLI input, command output, and filesystem data enter as `unknown` and become domain types only after runtime validation.
- Use `deno.json` for tasks, imports, compiler, lint, format, test, permission, and compile configuration; commit `deno.lock` and enforce it in CI and release builds.
- Package use is encouraged when it removes risky bespoke infrastructure or unlocks maintained functionality. Prefer JSR packages, allow npm packages through Deno's compatibility layer, and keep dependencies compatible with `deno compile` and Linux amd64/arm64.
- Centralize runtime capabilities. Direct execution and compilation must grant the same explicit filesystem, environment, network, FFI, and subprocess permissions; do not make unrestricted `-A` the documented default.
- Use Deno's built-in formatter, linter, type checker, task runner, test runner, and compiler. Third-party libraries may supplement those tools when they provide clear value.
- The compiled artifact must include the TypeScript module graph and every immutable template/helper it needs. Operator state, durable data, secrets, Compose overlays, and customization remain external. Assets that Docker or Compose require as host files must be materialized deterministically from embedded, digest-checked content.
- No Python interpreter, `pip`, Node.js runtime, or global npm install may be required to run the compiled control plane.

Relevant platform references are the official Deno documentation for [configuration](https://docs.deno.com/runtime/fundamentals/configuration/), [CLI applications](https://docs.deno.com/runtime/cli_apps/), and [`deno compile`](https://docs.deno.com/runtime/reference/cli/compile/).

## Central mental model

Bento has a small host-side control plane and a containerized data plane:

- The operator changes desired state through a CLI.
- Bento renders a complete candidate configuration from that state.
- It promotes, validates, and narrowly reloads only affected services.
- Durable application data, credentials, certificates, backups, and database volumes are kept separate from disposable generated configuration.
- An application is isolated by Linux identity, filesystem policy, PHP-FPM pool/socket, database grants, and optional Redis ACL—not by receiving a dedicated container.

That last point is essential. A reimplementation that creates one container per app is a different product architecture, even if its command surface looks similar.
