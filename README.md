# n8n-nodes-fragments

An [n8n](https://n8n.io) community node, **IFC to Fragments**, that converts IFC files to
[That Open Fragments](https://docs.thatopen.com/fragments/getting-started) (`.frag`) inside your
n8n instance. No external service is needed.

It runs That Open's own converter, `@thatopen/fragments` `IfcImporter` with the web-ifc WASM. For
the same IFC and model id, the output is byte-identical to calling `IfcImporter` yourself. Each
conversion runs in its own child process, so a model that is too big or broken can't take n8n down.

> **Self-hosted n8n only.** The node needs the filesystem and child processes, which n8n Cloud and
> n8n's verified-node programme don't allow. It installs as an unverified community node.

## Installation

In a self-hosted n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-fragments`.
See n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

For a manual install (e.g. queue-mode workers), install the package where n8n looks for community
nodes, typically `~/.n8n/nodes`:

```bash
cd ~/.n8n/nodes && npm install n8n-nodes-fragments
```

Restart n8n afterwards. The package has no runtime dependencies; everything is bundled.

**Compatibility:** tested with n8n 2.36 (Docker image, Node.js 24) and on Node.js 20 or newer,
on Linux. macOS and Windows are untested; there, the memory cap only limits the V8 heap (see below).

## Usage

1. Get an IFC into a binary field, e.g. with *Read/Write Files from Disk*, *HTTP Request* or an S3
   node.
2. Add **IFC to Fragments**. By default it reads the `data` field and writes the `.frag` to `data`.
3. Store or upload the `.frag`. Load it in a browser with `@thatopen/fragments`:

```ts
const model = await fragments.load(fragBytes, { modelId: 'my-model' });
```

The `.frag` is made with `@thatopen/fragments` 3.4.3; load it with a matching 3.4.x viewer.

## How it runs

- **One child process per conversion.**
  - The IFC is streamed to a private temp dir. A child `node` process converts it, and the `.frag`
    comes back as a file.
  - Worker threads would not be enough: web-ifc's WASM memory sits outside the V8 heap, so neither
    `--max-old-space-size` nor `resourceLimits` cap it.
- **One conversion at a time per n8n process.** Conversions from any workflow wait in a queue, and
  queue time doesn't count towards the timeout. In queue mode, each n8n worker has its own queue.
- **Limits:**
  - **Max IFC Size** is checked while the IFC is streamed to disk, before any child starts.
  - **Timeout** kills the child.
  - **Max Memory:** on Linux, the child's resident memory is sampled every 100 ms and the child is
    killed above the cap. The child's V8 heap is capped on every platform.
- **Empty environment.** The child gets none of n8n's environment variables, so the code that
  parses the IFC can't see your encryption key or database credentials.
- **Format check.** Input that isn't IFC-SPF (it must start with `ISO-10303-21`) is refused up
  front. ifcXML and ifcZIP are not supported.
- **Cancellation.** Stopping the execution kills the child, or removes the job from the queue.

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| Input Binary Field | `data` | Holds the IFC |
| Output Binary Field | `data` | Receives the `.frag`. The IFC is dropped unless *Keep Input Binary* is on |
| Options → Model ID | empty | GUID embedded in the `.frag`. Empty gives a random UUID; set it (e.g. to a file version id) for reproducible bytes |
| Options → Output File Name | `<ifc name>.frag` | |
| Options → Timeout (Seconds) | 600 | |
| Options → Max IFC Size (MB) | 512 | |
| Options → Max Memory (MB) | 3072 | Memory cap for the child |
| Options → Distance Threshold | 100000 | `IfcImporter`'s cutoff for geometry far from the origin; 0 keeps everything |
| Options → Keep Input Binary | false | |

Each output item keeps its input JSON and gains a `fragments` object:

```json
{ "fileName": "model.frag", "modelId": "v123", "ifcBytes": 54100000, "fragBytes": 5170000,
  "convertMs": 3645, "totalMs": 4128, "queuedMs": 0, "peakRssMb": 508,
  "fragmentsVersion": "3.4.3", "webIfcVersion": "0.0.77" }
```

Failures are `NodeOperationError`s, with the converter's stderr tail as the description. With
*On Error → Continue*, the item gets `error` and `errorCode`. The codes are `empty`, `not_ifc`,
`too_large`, `timeout`, `memory`, `cancelled`, `crashed` and `failed`.

## Resource use

These were measured on a 12-core Linux VM with real project models, 0.2–238 MB of IFC:

| IFC | .frag | convert | total | peak memory |
|---|---|---|---|---|
| 0.2 MB | 0.01 MB | 0.16 s | 0.47 s | 179 MB |
| 2.3 MB | 0.20 MB | 0.78 s | 1.1 s | 209 MB |
| 15 MB | 0.70 MB | 1.7 s | 2.1 s | 259 MB |
| 54 MB | 5.2 MB | 3.6 s | 4.1 s | 508 MB |
| 75 MB | 3.5 MB | 4.4 s | 4.7 s | 748 MB |
| 130 MB | 10.4 MB | 7.8 s | 8.3 s | 943 MB |
| 238 MB | 19.2 MB | 21.9 s | 22.6 s | 1287 MB |

- The child process adds about 0.3–0.5 s per conversion.
- Peak memory is roughly 0.5 GB plus about 3× the IFC size, so the 3072 MB default covers the
  512 MB size cap.
- If n8n runs in a memory-limited container, the child counts against the same limit. Leave
  headroom for n8n itself.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint                 # n8n's community-node rules (see eslint.config.mjs)
pnpm test                 # build + runner tests (fake children) + real-converter tests
pnpm compare a.ifc ...    # byte-compare against IfcImporter run in-process
```

`pnpm build` (esbuild) writes:

- `dist/nodes/Fragments/Fragments.node.js`: the node; only `n8n-workflow` stays external.
- `dist/nodes/Fragments/converter.js`: the child, with fragments, three and web-ifc inlined.
- `dist/nodes/Fragments/wasm/web-ifc-node.wasm`.
- `THIRD_PARTY_NOTICES.md`.

The build fails if either bundle would require a non-built-in module at runtime.

To try it in n8n without installing it, mount `dist/` as a custom extension. Use a throwaway
container: `docker.n8n.io/n8nio/n8n` with `N8N_CUSTOM_EXTENSIONS=/custom` and the folder mounted
there. The node type is then `CUSTOM.fragments`.

Releases are published to npm from GitHub Actions with provenance when a `v*.*.*` tag is pushed;
see [RELEASING.md](RELEASING.md).

## Licence

MIT. The converter bundles web-ifc (MPL-2.0, unmodified) and MIT, ISC and Apache-2.0 packages.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not affiliated with That Open Company or n8n GmbH.
