# Supported Languages & Scanners

claude-crap supports 14 languages for workspace metrics and 6 scanner
integrations for static analysis. This document explains how each
language is detected, analyzed, and scanned.

## Overview

| Language | Extensions | AST analysis | Scanner | Setup |
| :------- | :--------- | :----------: | :------ | :---- |
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | Cyclomatic complexity | ESLint | **Auto-installed** via npm |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | Cyclomatic complexity | ESLint | **Auto-installed** via npm |
| Python | `.py` `.pyi` | Cyclomatic complexity | Bandit | `pip install bandit` |
| Java | `.java` | Cyclomatic complexity | Semgrep | `brew install semgrep` |
| C# / .NET | `.cs` | Cyclomatic complexity | `dotnet format` | **Included in .NET SDK** |
| Dart / Flutter | `.dart` | LOC only | `dart analyze` | **Included in Dart/Flutter SDK** |
| Vue | `.vue` | LOC only | ESLint (via root config) | Auto with TypeScript |
| Go | `.go` | LOC only | -- | -- |
| Rust | `.rs` | LOC only | -- | -- |
| Ruby | `.rb` | LOC only | -- | -- |
| PHP | `.php` | LOC only | -- | -- |
| Swift | `.swift` | LOC only | -- | -- |
| Kotlin | `.kt` | LOC only | -- | -- |
| Scala | `.scala` | LOC only | -- | -- |

**AST analysis** means tree-sitter parses the file and reports
per-function cyclomatic complexity. These functions appear in the
dashboard's "hottest files" view and can trigger the
`complexity/cyclomatic-max` SARIF finding.

**LOC only** means the file is counted toward workspace physical lines
of code (used in TDR computation) but no per-function analysis is
available.

---

## TypeScript & JavaScript

**Detection:** `package.json` at the project root. If `tsconfig.json`
is also present, the type is `typescript`; otherwise `javascript`.

**Scanner:** ESLint (flat config, ESLint 9+).

**Auto-install:** When the bootstrap detects a JS/TS project and
ESLint is not installed, it runs:

```bash
npm install --save-dev eslint @eslint/js            # JavaScript
npm install --save-dev eslint @eslint/js typescript-eslint  # TypeScript
```

It also generates `eslint.config.mjs` with recommended rules and
standard ignores (`dist/`, `node_modules/`, `coverage/`, `**/bundle/`,
`**/vendor/`, `**/*.min.js`).

**AST analysis:** tree-sitter parses `.ts`, `.tsx`, `.mts`, `.cts`,
`.js`, `.jsx`, `.mjs`, `.cjs` files and reports cyclomatic complexity
per function. Functions above the configured threshold (default: 15)
produce error-level SARIF findings.

**Monorepo behavior:** ESLint is installed at the monorepo root (npm
hoists it). The scanner runs `npx eslint -f json .` from the root,
which covers all JS/TS files across workspaces.

**Vue files:** `.vue` files are counted for LOC. ESLint can lint them
if the root config includes a Vue plugin, but tree-sitter does not
parse the `<script>` block for cyclomatic complexity.

---

## Python

**Detection:** `pyproject.toml`, `setup.py`, or `requirements.txt`.

**Scanner:** [Bandit](https://bandit.readthedocs.io/) -- a security-focused
static analyzer for Python.

**Setup:** Bandit is not auto-installed because it's a pip package,
not an npm package. Install it manually:

```bash
pip install bandit       # or
pipx install bandit      # or
poetry add --group dev bandit
```

**Runner command:** `bandit -f json -r . -q`

**AST analysis:** tree-sitter parses `.py` and `.pyi` files for
cyclomatic complexity.

**SARIF mapping:** Bandit's native JSON output is adapted to SARIF
2.1.0. Each finding gets an `effortMinutes` estimate based on
severity (error: 60 min, warning: 30 min, note: 15 min).

---

## Java

**Detection:** `pom.xml`, `build.gradle`, or `build.gradle.kts`.

**Scanner:** [Semgrep](https://semgrep.dev/) -- a multi-language
static analysis tool.

**Setup:** Semgrep is not auto-installed. Install it:

```bash
brew install semgrep     # macOS
pip install semgrep      # or
pipx install semgrep
```

**Runner command:** `semgrep --sarif --quiet .`

**AST analysis:** tree-sitter parses `.java` files for cyclomatic
complexity.

**SARIF mapping:** Semgrep outputs native SARIF, which is enriched
with `effortMinutes` estimates before ingestion.

---

## C# / .NET

**Detection:** `.csproj`, `.sln`, `.slnx`, or `Directory.Build.props` files.
`.slnx` is the XML solution format introduced with .NET 9.

**Scanner:** `dotnet format` -- the built-in Roslyn analyzer included
in the .NET SDK. No extra installation needed.

**Setup:** Requires the [.NET SDK](https://dotnet.microsoft.com/download)
(version 6+). If `dotnet` is on PATH, the scanner is available
automatically.

**Runner command:**

```bash
dotnet format --verify-no-changes --report .claude-crap/dotnet-report.json
```

**Output format:** JSON array of documents with `FileChanges`, each
containing `DiagnosticId`, `LineNumber`, `CharNumber`, and
`FormatDescription`.

**AST analysis:** tree-sitter parses `.cs` files for cyclomatic
complexity using the C# grammar.

**SARIF mapping:** Each `FileChange` becomes a SARIF result at
warning level with 5 minutes estimated effort (formatting fixes are
typically quick).

**Monorepo behavior:** In monorepos, `dotnet format` runs from the
sub-project directory where the `.csproj` file was found.

---

## Dart / Flutter

**Detection:** `pubspec.yaml` or `analysis_options.yaml`.

**Scanner:** `dart analyze` -- the built-in Dart analyzer included in
the Dart SDK (also bundled with Flutter).

**Setup:** Requires the [Dart SDK](https://dart.dev/get-dart) or the
[Flutter SDK](https://flutter.dev/docs/get-started/install) (which
includes Dart). If `dart` is on PATH, the scanner is available
automatically.

**Runner command:**

```bash
dart analyze --format=json .
```

**Output format:** JSON with `version` and `diagnostics` array. Each
diagnostic has `code`, `severity` (ERROR/WARNING/INFO), `location`
(file, line, column), `problemMessage`, and optional
`correctionMessage`.

**AST analysis:** Dart files (`.dart`) are counted for LOC but
tree-sitter cyclomatic complexity is not available (no Dart grammar
in the current tree-sitter-wasms package).

> **Known limitation — Dart complexity blind spot.** The built-in
> cyclomatic complexity scanner (`complexity/cyclomatic-max`) is silent
> on `.dart` files because `tree-sitter-wasms` does not yet ship a
> Dart grammar. A Flutter sub-project can still earn a perfect
> Maintainability rating even if it contains a 150-line `build()` method,
> because the only complexity signal for Dart comes from `dart analyze`
> lint rules (which don't directly measure cyclomatic complexity).
> Mitigation: treat Dart `score_project` readings as a lint-quality
> signal rather than a complexity signal, and rely on Dart-specific
> complexity tooling (e.g. `dart_code_metrics`) for per-function
> measurement until upstream grammar support lands.

**SARIF mapping:**

| Dart severity | SARIF level | Effort estimate |
| :------------ | :---------- | --------------: |
| ERROR         | error       | 30 min          |
| WARNING       | warning     | 15 min          |
| INFO          | note        | 5 min           |

**Monorepo behavior:** In monorepos, `dart analyze` runs from the
sub-project directory where `pubspec.yaml` was found (e.g.,
`apps/mobile/`). This is critical because Dart projects resolve
packages relative to their own `pubspec.yaml`.

---

## Monorepo auto-discovery

claude-crap automatically discovers sub-projects at session boot.
The discovery probes four sources (merged, deduplicated):

### 1. npm workspaces

Reads `package.json` at the workspace root for the `workspaces` field:

```jsonc
// Array format
{ "workspaces": ["apps/frontend", "apps/backend", "packages/shared"] }

// Object format (Yarn)
{ "workspaces": { "packages": ["packages/*"] } }
```

Glob patterns like `packages/*` are expanded one level deep. Patterns
that resolve outside the workspace root (e.g. `../shared/*`) are
dropped silently so a misconfigured manifest cannot widen the scan
scope.

### 2. pnpm workspaces

pnpm stores its workspace layout in a separate `pnpm-workspace.yaml`
file rather than in `package.json`. claude-crap reads the top-level
`packages:` block, supports quoted and bare entries with or without
globs, and applies the same one-level glob expansion and workspace
containment guard as npm workspaces.

```yaml
packages:
  - "apps/*"
  - "tooling/cli"
```

Malformed YAML is swallowed rather than propagated, so an invalid
`pnpm-workspace.yaml` falls back cleanly to the other discovery
sources.

### 3. Built-in directories

The following directories are scanned one level deep automatically:

- `apps/`
- `packages/`
- `libs/`
- `modules/`
- `services/`

### 4. User-configured projectDirs

For non-standard layouts, add `projectDirs` to `.claude-crap.json`:

```jsonc
{
  "projectDirs": ["frontend", "backend", "tools/cli"]
}
```

Each entry can be:
- A **parent directory** scanned one level deep: `"frontend"`
  discovers `frontend/web`, `frontend/mobile`, etc.
- A **direct project path**: `"tools/cli"` treats that directory
  itself as a project (if it contains a project marker like
  `package.json` or `pubspec.yaml`).

### Project type detection

For each discovered directory, the type is detected by checking for
marker files in priority order:

1. `pubspec.yaml` --> **dart**
2. `tsconfig.json` + `package.json` --> **typescript**
3. `package.json` (alone) --> **javascript**
4. `pyproject.toml` / `setup.py` / `requirements.txt` --> **python**
5. `pom.xml` / `build.gradle*` --> **java**
6. `.csproj` / `.sln` / `.slnx` / `Directory.Build.props` --> **csharp**
7. None of the above --> **unknown**

### Scanner assignment

| Project type | Scanner | Auto-install? |
| :----------- | :------ | :------------ |
| typescript   | ESLint  | Yes (npm)     |
| javascript   | ESLint  | Yes (npm)     |
| python       | Bandit  | No            |
| java         | Semgrep | No            |
| csharp       | `dotnet format` | No (SDK required) |
| dart         | `dart analyze`  | No (SDK required) |
| unknown      | --      | --            |

### Example: polyglot monorepo

Given a monorepo with this structure:

```
my-project/
  package.json          (workspaces: ["apps/web", "apps/admin"])
  apps/
    web/                (package.json + tsconfig.json)
    admin/              (package.json + tsconfig.json)
    mobile/             (pubspec.yaml)
    api/                (MyApp.csproj)
```

The project map at boot:

```json
{
  "isMonorepo": true,
  "projects": [
    { "name": "web",    "path": "apps/web",    "type": "typescript", "scanner": "eslint" },
    { "name": "admin",  "path": "apps/admin",  "type": "typescript", "scanner": "eslint" },
    { "name": "mobile", "path": "apps/mobile", "type": "dart",       "scanner": "dart_analyze" },
    { "name": "api",    "path": "apps/api",    "type": "csharp",     "scanner": "dotnet_format" }
  ]
}
```

Auto-scan then runs:
1. ESLint from root (covers `web` + `admin`)
2. `dart analyze` from `apps/mobile/`
3. `dotnet format` from `apps/api/`

All findings aggregate into one SARIF store. Use
`score_project({ scope: "mobile" })` to score a single sub-project.

---

## File exclusions

All scanners and the workspace walker share a centralized exclusion
list. The following are excluded by default:

**Directories** (grouped by purpose):

- Dependencies / VCS: `node_modules`, `vendor`, `.git`
- Generic build outputs: `dist`, `build`, `bundle`, `out`, `target`,
  `coverage`, `artifacts`, `publish`
- Electron / Tauri packaging: `dist-electron`, `release`
- .NET per-project build: `bin`, `obj`
- iOS / macOS dependency + build caches: `Pods`, `DerivedData`, `Carthage`
- Framework outputs: `.next`, `.nuxt`, `.output`, `.vercel`,
  `.svelte-kit`, `.astro`, `.angular`, `.turbo`, `.parcel-cache`, `.expo`
- Language caches: `.venv`, `venv`, `__pycache__`, `.cache`,
  `.dart_tool`, `.gradle`
- IDE / plugin state: `.idea`, `.claude-crap`, `.claude-plugin`,
  `.claude-sonar`, `.codesight`

**File patterns:** `*.min.js`, `*.min.css`, `*.min.mjs`, `*.min.cjs`,
`*.bundle.js`, `*.chunk.js`

**Hidden directories** (starting with `.`) are always skipped except
`.claude-plugin`.

Custom exclusions can be added via `.claude-crap.json`:

```jsonc
{
  "exclude": ["apps/legacy/", "generated/", "*.proto.ts"]
}
```

Patterns ending with `/` match directory names. All others are
matched as globs against the workspace-relative file path.

---

## Adding support for a new language

To add a new scanner integration:

1. **Adapter** -- create `src/adapters/<scanner>.ts` that converts
   native output to SARIF 2.1.0 (see `dart-analyzer.ts` as a
   template).
2. **Common** -- add the scanner name to `KNOWN_SCANNERS` in
   `src/adapters/common.ts`.
3. **Index** -- add export + dispatch case in `src/adapters/index.ts`.
4. **Detector** -- add config file signals and binary name to
   `SCANNER_SIGNALS` in `src/scanner/detector.ts`.
5. **Runner** -- add the CLI command to `getScannerCommand()` in
   `src/scanner/runner.ts`.
6. **Bootstrap** -- add the project type and recommendation in
   `src/scanner/bootstrap.ts`.
7. **Project map** -- add the scanner/binary mapping in
   `src/monorepo/project-map.ts`.
8. **Schema** -- add the scanner to the `enum` in
   `src/schemas/tool-schemas.ts`.
9. **Tests** -- add detection and adapter tests.

See [docs/scanner-adapters.md](./scanner-adapters.md) for the adapter
API and effort estimation tables.
