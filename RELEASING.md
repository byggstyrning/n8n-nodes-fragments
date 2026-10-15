# Releasing

`.github/workflows/publish.yml` publishes to npm with a provenance statement when a `v*.*.*` tag is
pushed. The tag must match `package.json`'s `version`, and `prepublishOnly` (typecheck, lint, test)
must pass. npm only issues provenance for public GitHub repositories on GitHub-hosted runners.

## Every release

1. Bump `version` in `package.json` and move the `CHANGELOG.md` entry from "unreleased" to the date.
2. Run `pnpm typecheck && pnpm lint && pnpm test`. After a dependency bump, also run `pnpm compare`
   on a few real models.
3. Commit, then `git tag v<version> && git push origin main v<version>`.
4. Check the run under Actions, and the provenance badge on npmjs.com (from 0.1.1 on).

## Auth: Trusted Publishing

The workflow authenticates with npm Trusted Publishing (OIDC). There is no npm token or repository
secret. The trust is configured on npmjs.com under `n8n-nodes-fragments` → Settings → **Trusted
Publisher**, with these fields (case-sensitive):

- GitHub Actions;
- organization or user `byggstyrning`;
- repository `n8n-nodes-fragments`;
- workflow filename `publish.yml`;
- environment left empty.

If you rename the workflow file or move the repository, update that entry first, or the publish fails
with a 404/403.

## How 0.1.0 was published (history)

0.1.0 was published by hand on 2026-10-15, with `npm publish` from a clean checkout of the
`v0.1.0` tag, using an interactive 2FA login. It has no provenance; later versions have it.

- A brand-new package can't use Trusted Publishing, because the trust can only be configured once
  the package exists.
- A granular token was tried for the first release, and npm still demanded an OTP (`EOTP`): it
  won't create a new package from a token.
- The locally built tarball had the same shasum as the CI build (`830be031…`), so the build is
  reproducible.

## n8n

- No submission step is needed for self-hosted users: anything on npm with the
  `n8n-community-node-package` keyword can be installed from **Settings → Community Nodes**.
- Don't submit to n8n's verified-node programme (Creator Portal). Its scan forbids `child_process`,
  `fs` and timer globals, which this node needs by design, so it would be rejected.
- To see exactly what that scan reports, run its lint locally against the source and the packed
  tarball (provenance leg skipped): `analyzePackage` from `@n8n/scan-community-package`. Expect
  only the three rule families that `eslint.config.mjs` turns off, plus findings in the bundled
  third-party code.
