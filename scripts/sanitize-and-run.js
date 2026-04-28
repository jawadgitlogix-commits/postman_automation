const path = require("path");
const fs = require("fs-extra");
const newman = require("newman");

const ROOT = path.resolve(__dirname, "..");
const INPUT_COLLECTIONS = path.join(ROOT, "input", "collections");
const INPUT_ENVIRONMENTS = path.join(ROOT, "input", "environments");
const TMP_COLLECTIONS = path.join(ROOT, "tmp", "collections");
const TMP_ENVIRONMENTS = path.join(ROOT, "tmp", "environments");
const REPORTS_DIR = path.join(ROOT, "reports");
const CONFIG_PATH = path.join(ROOT, "run-config.json");

const SANITIZE_STATS = {
  collections: {},
  environments: {},
};

function stripPreRequestEvents(node, counter) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node.event)) {
    const kept = [];
    for (const event of node.event) {
      if (event && event.listen === "prerequest") {
        counter.removed += 1;
        continue;
      }
      kept.push(event);
    }
    node.event = kept;
  }

  if (Array.isArray(node.item)) {
    for (const child of node.item) {
      stripPreRequestEvents(child, counter);
    }
  }
}

async function sanitizeCollection(inputPath, outputPath) {
  const raw = await fs.readJson(inputPath);
  const counter = { removed: 0 };
  stripPreRequestEvents(raw, counter);
  await fs.writeJson(outputPath, raw, { spaces: 2 });
  SANITIZE_STATS.collections[path.basename(inputPath)] = counter.removed;
}

async function sanitizeEnvironment(inputPath, outputPath) {
  const raw = await fs.readJson(inputPath);
  await fs.writeJson(outputPath, raw, { spaces: 2 });
  SANITIZE_STATS.environments[path.basename(inputPath)] = "copied";
}

function runNewman({ name, collectionPath, environmentPath }) {
  const reportJson = path.join(REPORTS_DIR, `${name}.json`);
  return new Promise((resolve, reject) => {
    newman.run(
      {
        collection: collectionPath,
        environment: environmentPath,
        reporters: ["cli", "json"],
        reporter: {
          json: { export: reportJson },
        },
        color: true,
      },
      (err, summary) => {
        if (err) return reject(err);
        resolve({
          name,
          failures: summary.run.failures.length,
          executions: summary.run.executions.length,
          reportJson,
        });
      }
    );
  });
}

async function main() {
  const envFilter = process.argv[2] || "";
  await fs.ensureDir(TMP_COLLECTIONS);
  await fs.ensureDir(TMP_ENVIRONMENTS);
  await fs.ensureDir(REPORTS_DIR);

  if (!(await fs.pathExists(CONFIG_PATH))) {
    throw new Error(
      "Missing run-config.json. Copy run-config.example.json to run-config.json and update mappings."
    );
  }

  const config = await fs.readJson(CONFIG_PATH);
  const runs = Array.isArray(config.runs) ? config.runs : [];
  const filteredRuns = envFilter
    ? runs.filter((r) => r.name.toLowerCase().includes(envFilter.toLowerCase()))
    : runs;

  if (!filteredRuns.length) {
    throw new Error(`No runs matched filter "${envFilter}"`);
  }

  const results = [];
  for (const run of filteredRuns) {
    const inCol = path.join(INPUT_COLLECTIONS, run.collectionFile);
    const inEnv = path.join(INPUT_ENVIRONMENTS, run.environmentFile);
    const outCol = path.join(TMP_COLLECTIONS, run.collectionFile);
    const outEnv = path.join(TMP_ENVIRONMENTS, run.environmentFile);

    if (!(await fs.pathExists(inCol))) {
      throw new Error(`Collection not found: ${inCol}`);
    }
    if (!(await fs.pathExists(inEnv))) {
      throw new Error(`Environment not found: ${inEnv}`);
    }

    await sanitizeCollection(inCol, outCol);
    await sanitizeEnvironment(inEnv, outEnv);

    const result = await runNewman({
      name: run.name,
      collectionPath: outCol,
      environmentPath: outEnv,
    });
    results.push(result);
  }

  const summaryPath = path.join(REPORTS_DIR, "summary.json");
  const summary = {
    generatedAt: new Date().toISOString(),
    sanitizeStats: SANITIZE_STATS,
    results,
  };
  await fs.writeJson(summaryPath, summary, { spaces: 2 });

  console.log("\n=== Automation Summary ===");
  for (const r of results) {
    console.log(`${r.name}: failures=${r.failures}, executions=${r.executions}`);
  }
  console.log(`Summary: ${summaryPath}`);

  const hasFailures = results.some((r) => r.failures > 0);
  process.exit(hasFailures ? 1 : 0);
}

main().catch((error) => {
  console.error("Automation failed:", error.message);
  process.exit(1);
});
