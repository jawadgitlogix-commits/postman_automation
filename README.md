# Postman Automation Framework (Generic)

Generic Node.js automation to run **any** Postman collection from the filesystem (via Newman), generate execution reports (including failures), and produce **required vs optional parameter** reports by replaying requests and removing one parameter at a time.

## Key features

- **Safe / isolated runs**: uses exported JSON files from disk; creates sanitized copies at runtime (pre-request scripts removed).
- **Newman execution reports**: per-run JSON output + overall summary (useful to review failed requests).
- **Required/optional parameter validation**:
  - **GET**: omit enabled query params one-by-one
  - **POST/PUT**: omit JSON body fields one-by-one (raw JSON bodies)
- **Two report levels**:
  - Detailed: status codes + extracted error messages per variant
  - Simplified: `required: true/false` (with `unknown => required: true` per rule)

## Folder structure

- `scripts/`: automation scripts (Newman + param validators + report builders)
- `input/collections/`: exported Postman collection JSON (local)
- `input/environments/`: exported Postman environment JSON (local)
- `tmp/`: sanitized runtime copies (ignored by git)
- `reports/`: generated outputs (ignored by git)
- `examples/`: safe templates to copy
- `run-config.json`: local run configuration (ignored by git)
- `run-config.example.json`: committable config template

## Setup

### 1) Put exported JSON files

Export from Postman and place files here:

- `input/collections/<collection>.postman_collection.json`
- `input/environments/<environment>.postman_environment.json`

Use `examples/` as templates (do **not** commit tokens).

### 2) Configure runs

Copy `run-config.example.json` → `run-config.json` and map your collection/environment filenames. You can define multiple runs (e.g., multiple APIs or environments).

### 3) Install

```bash
npm install
```

## Run commands

### Run Newman suite (full collection execution)

```bash
npm run automate
```

Optional filter (example: run names containing “dev”):

```bash
npm run automate:dev
```

### Validate required/optional params

POST/PUT (raw JSON body only):

```bash
npm run validate:params
```

GET + POST + PUT (ignores DELETE; can skip specific folders based on script rules):

```bash
npm run validate:all
```

Build simplified `required=true/false` report for the all-method run:

```bash
npm run build:simple:all
```

## How required/optional is inferred

For each endpoint and parameter:

- Baseline request = original request
- Variant request = same request with **one parameter removed**

Classification:

- **required**: baseline OK, variant fails
- **optional**: baseline OK, variant OK
- **unknown**: baseline fails (auth/state/other), or cannot isolate parameter effect reliably

Simplified mapping rule:

- `optional` → `required:false`
- `required` → `required:true`
- `unknown` → `required:true`

## Outputs (generated locally)

- **Newman**:
  - `reports/<run-name>.json` (Newman JSON output including failures)
  - `reports/summary.json` (rollup summary for the suite)
- **Param validation**:
  - `reports/required-params-report.json` (POST/PUT body-only)
  - `reports/required-params-report-all.json` (GET+POST+PUT)
  - `reports/required-params-simple-all.json` (simplified required boolean)

## Notes

- **Auth is API-dependent**: tokens/headers live in your Postman environment export. Keep secrets local (gitignored).
- **Unknowns happen** when endpoints are stateful (need IDs) or auth isn’t valid. Reduce unknowns by adding setup flows (create prereqs, capture IDs) and ensuring the correct role/token is used per endpoint.
