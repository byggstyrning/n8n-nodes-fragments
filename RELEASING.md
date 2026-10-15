# Releasing

`.github/workflows/publish.yml` publishes to npm with a provenance statement when a `v*.*.*` tag is
pushed. The tag must match `package.json`'s `version`, and `prepublishOnly` (typecheck, lint, test)
must pass. npm only issues provenance for public GitHub repositories on GitHub-hosted runners.

## Every release

1. Bump `version` in `package.json` and move the `CHANGELOG.md` entry from "unreleased" to the date.
2. Run `pnpm typecheck && pnpm lint && pnpm test`. After a dependency bump, also run `pnpm compare`
   on a few real models.
3. Commit, then `git tag v<version> && git push origin main v<version>`.
4. Check the run under Actions and the "Provenance" badge on npmjs.com.

## First release (one time)

npm can't set up Trusted Publishing for a package that doesn't exist yet. So bootstrap it with a
short-lived token; the first release still comes from CI with provenance:

1. On npmjs.com, create a **granular access token**:
   - read/write;
   - scoped to "all packages", or to the not-yet-existing name if offered;
   - 1-day expiry.
2. Add it to the repository as the Actions secret `NPM_TOKEN`.
3. Push the `v0.1.0` tag.
4. On npmjs.com, open `n8n-nodes-fragments` → Settings → **Trusted publishing**, and add a
   publisher (fields are case-sensitive):
   - GitHub Actions;
   - owner `byggstyrning`;
   - repository `n8n-nodes-fragments`;
   - workflow `publish.yml`;
   - no environment.
5. Delete the `NPM_TOKEN` secret and revoke the token. Optionally set the package's publishing
   access to "Require two-factor authentication and disallow tokens".

## n8n

- No submission step is needed for self-hosted users: anything on npm with the
  `n8n-community-node-package` keyword can be installed from **Settings → Community Nodes**.
- Don't submit to n8n's verified-node programme (Creator Portal). Its scan forbids `child_process`,
  `fs` and timer globals, which this node needs by design, so it would be rejected.
- To see exactly what that scan reports, run its lint locally against the source and the packed
  tarball (provenance leg skipped): `analyzePackage` from `@n8n/scan-community-package`. Expect
  only the three rule families that `eslint.config.mjs` turns off, plus findings in the bundled
  third-party code.
