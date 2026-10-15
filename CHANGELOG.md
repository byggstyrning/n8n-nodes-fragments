# Changelog

## 0.1.0 — unreleased

First release.

- **IFC to Fragments** node: converts an IFC binary to a That Open Fragments `.frag` with
  `@thatopen/fragments` 3.4.3 `IfcImporter` and web-ifc 0.0.77, bundled with no runtime
  dependencies.
- Each conversion runs in its own child process with an empty environment. Conversions run one at a
  time per n8n process.
- Limits: Max IFC Size, Timeout and Max Memory (resident memory on Linux, V8 heap elsewhere).
  Execution cancellation is supported.
- Input that isn't IFC-SPF (no `ISO-10303-21` header, e.g. ifcZIP or ifcXML) is refused before
  conversion.
- Output keeps the input JSON and adds `fragments` stats: sizes, timings, peak memory and versions.
- Errors carry an `errorCode` with *On Error → Continue*.
