# Packaging Cline for use in agentic-dx

For the Cline exploration branch, agentic-dx consumes Cline as a **tarball dependency**, matching how agentic-dx already depends on `@salesforce/gemini-fork-core`.

## 1. Produce the tarball (from the cline repo)

The publishable package is the **cli** workspace (it has `"name": "cline"`). Build and pack from the cline repo root:

```bash
cd /path/to/cline
npm run cli:build          # or: cd cli && npm run build
cd cli && npm run package  # creates cli/dist/cline-<version>.tgz
```

Or in one go from repo root:

```bash
cd /path/to/cline
npm run cli:build && (cd cli && npm pack --pack-destination ./dist)
```

Output: `cline/cli/dist/cline-2.4.1.tgz` (version from `cli/package.json`).

## 2. Add the tarball to agentic-dx

Copy the tarball into agentic-dx’s vendor directory (same pattern as gemini-fork-core):

```bash
cp /path/to/cline/cli/dist/cline-2.4.1.tgz /path/to/agentic-dx/vendor/
```

Create `agentic-dx/vendor/` if it doesn’t exist.

## 3. Declare the dependency in agentic-dx

The dependency lives in **agentic-dx-core** (the package that imports `cline/service-api`). It is already declared in `agentic-dx/packages/agentic-dx-core/package.json` as:

```json
"cline": "file:../../vendor/cline-2.4.1.tgz"
```

After copying a new tarball into `vendor/`, reinstall so npm unpacks it:

```bash
cd /path/to/agentic-dx
rm -rf node_modules/cline
npm install
```

If you get an **EINTEGRITY** error, the lockfile’s integrity hash no longer matches the new tarball. Update it:

```bash
cd /path/to/agentic-dx
node -e "const c=require('crypto'),f=require('fs');console.log('sha512-'+c.createHash('sha512').update(f.readFileSync('vendor/cline-2.4.1.tgz')).digest('base64'))"
```

In `package-lock.json`, find the `"node_modules/cline"` entry and set its `"integrity"` to the printed value (e.g. `sha512-...`). Then run `npm install` again.

## 4. Import the service API in agentic-dx

In **agentic-dx-core**, the service API is imported via the subpath export:

```ts
import { createClineEngine } from "cline/service-api";
```

Node resolves this to the `./dist/service-api.mjs` entry in the installed tarball (the `exports` field in `cline/cli/package.json`). The inner-vibes-service uses agentic-dx-core and does not depend on cline directly.

## Alternatives (not used for this exploration)

- **Local path**: `"cline": "file:../../cline/cli"` — requires cline and agentic-dx to live side-by-side and requires building cline first; no single artifact.
- **Git dependency**: `"cline": "github:forcedotcom/cline#t/jcarver/cline-agentic-engine-exploration"` — would require the branch to be pushed and the repo to have a build that publishes the CLI artifact (e.g. from `cli/`); more setup than a tarball for a short-lived exploration.
- **Private npm registry** — same idea as tarball but with publish/install from registry; use if you standardize on that for internal packages.

Using a **tarball in `vendor/`** keeps the exploration self-contained and consistent with the existing gemini-fork-core workflow.
