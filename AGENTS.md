# AGENTS.md — n8n-nodes-fragments

The n8n node **IFC to Fragments** (`n8n-nodes-fragments.fragments`). It converts IFC → `.frag`
in a child process inside the n8n instance. `README.md` covers usage; this file lists the rules
that are easy to break.

## Rules

- **Keep the conversion in a separate process with `env: {}`.** Don't move it in-process or into a
  worker thread. web-ifc's WASM memory isn't capped by V8 limits, and an OOM would take n8n down
  with every running execution. The empty environment keeps n8n's secrets away from the code that
  parses untrusted IFC.
- **One conversion at a time per process.**
  - The queue lives on `globalThis[Symbol.for('n8n-nodes-fragments.queue')]`, so two loaded copies
    of the module share it.
  - An abort while queued releases the slot without letting later jobs overtake the running one.
    There is a test for this.
- **Version pins:** `@thatopen/fragments` 3.4.3, `web-ifc` 0.0.77 and `three` 0.186.1 are exact.
  `pnpm.overrides` pins the deps fragments inlines (earcut, flatbuffers, pako, lru-cache).
  - Changing the fragments version changes which viewers can load the output, so treat it as a
    breaking change for users.
  - After any bump, run `pnpm compare` on a few real models and expect `IDENTICAL`.
- **No runtime dependencies.** `scripts/build.mjs` bundles everything and fails if a bundle would
  `require` anything but node built-ins (plus `n8n-workflow` for the node file). n8n installs
  community packages into a shared `node_modules` and strips peer deps, so a dependency here can
  collide with another package's.
- **In `Fragments.node.ts`, import only types from `n8n-workflow`, plus `NodeOperationError` and
  `NodeConnectionTypes`.** Values are resolved at runtime from the host's n8n-workflow.
- **Lint:** `eslint.config.mjs` mirrors `@n8n/scan-community-package`, except that three rules are
  off for `nodes/**`: `no-restricted-imports`, `no-restricted-globals` and `no-dangerous-functions`.
  The design needs built-ins, timers and `child_process.fork`. Keep every other rule passing; don't
  add more exceptions without a reason in that file. The plugin versions match the scanner's.
- **Memory default:** peak RSS is about 0.5 GB plus ~3× the IFC size (238 MB IFC → 1.29 GB). That
  is why Max Memory defaults to 3072 MB with a 512 MB IFC cap. Users' containers share that limit
  with n8n.

## Tests

`pnpm test` builds, then runs:

- `test/runner.test.mjs`, with fake children in `test/fixtures/*.cjs`. It covers timeout, memory,
  crash, child error, queue order, cancellation, cleanup, the empty env and the format check.
- `test/convert.test.mjs`: the real converter on `test/fixtures/wall-and-slab.ifc`, a hand-written
  IFC4 file with a wall, a slab and a property set. Set `FRAGMENTS_TEST_IFC` to use another model.

Only commit IFC fixtures that you wrote yourself or that are clearly licensed for redistribution.

## Releasing

See `RELEASING.md`. In short: bump `version`, update `CHANGELOG.md`, and push a `v<version>` tag.
`publish.yml` publishes with provenance.
