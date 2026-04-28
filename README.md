# Postman Automation (No Postman Changes)

This project runs Postman collections in an isolated way:

- No writes to the Postman app
- No save back to your collections/environments
- Pre-request scripts are removed from copied collection files before execution

It also includes “required vs optional” parameter validation by replaying calls and removing one parameter at a time.

## 1) Put exported JSON files

Export from Postman once and place files here:

- `input/collections/*.postman_collection.json`
- `input/environments/*.postman_environment.json`

See `examples/` for safe templates you can copy.

## 2) Configure run matrix

Copy `run-config.example.json` to `run-config.json` and list all collection/environment pairs.

## 3) Install dependencies

```bash
npm install
```

## 4) Run everything

```bash
npm run automate
```

Run only matching jobs (example: dev):

```bash
npm run automate:dev
```

## 5) Parameter validation

Validate **POST/PUT JSON body** required/optional fields:

```bash
npm run validate:params
```

Validate **GET query params** + **POST/PUT body params** (ignores DELETE and skips the `Auth / 2FA` folder):

```bash
npm run validate:all
```

Build the simplified `required=true/false` report for the all-method run:

```bash
npm run build:simple:all
```

## What happens during run

1. Input files are read from `input/`
2. Sanitized copies are written to `tmp/` (all pre-request events removed)
3. Newman runs using sanitized copies
4. Reports are generated in `reports/`

## Output

- Per-run JSON report in `reports/`
- Final summary in `reports/summary.json`
- Detailed param report(s) in `reports/required-params-report*.json`
- Simplified param report(s) in `reports/required-params-simple*.json`
