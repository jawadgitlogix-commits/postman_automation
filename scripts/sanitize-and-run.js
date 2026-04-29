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

function shouldDropItem(item) {
  const name = String(item?.name || "").toLowerCase();
  if (name === "2fa") return true;
  const method = String(item?.request?.method || "").toUpperCase();
  if (method === "DELETE") return true;
  return false;
}

function filterItemsInPlace(node, counter) {
  if (!node || typeof node !== "object") return;
  if (!Array.isArray(node.item)) return;

  const kept = [];
  for (const child of node.item) {
    if (!child) continue;
    if (shouldDropItem(child)) {
      counter.removedItems += 1;
      continue;
    }
    // recurse into folders
    if (Array.isArray(child.item)) {
      filterItemsInPlace(child, counter);
      // If folder becomes empty after filtering, drop it.
      if (!child.item.length) {
        counter.removedItems += 1;
        continue;
      }
    }
    kept.push(child);
  }
  node.item = kept;
}

function stripPreRequestEvents(node, counter) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node.event)) {
    const kept = [];
    for (const event of node.event) {
      if (event && (event.listen === "prerequest" || event.listen === "test")) {
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
  const counter = { removedEvents: 0, removedItems: 0 };
  filterItemsInPlace(raw, counter);
  const eventsCounter = { removed: 0 };
  stripPreRequestEvents(raw, eventsCounter);
  counter.removedEvents = eventsCounter.removed;
  await fs.writeJson(outputPath, raw, { spaces: 2 });
  SANITIZE_STATS.collections[path.basename(inputPath)] = {
    removedEvents: counter.removedEvents,
    removedItems: counter.removedItems,
  };
}

async function sanitizeEnvironment(inputPath, outputPath) {
  const raw = await fs.readJson(inputPath);

  // Make runs more robust across collections by ensuring common URL aliases exist.
  // This avoids unresolved {{localhost}}, {{devUrl}}, etc. when collections differ.
  const values = Array.isArray(raw.values) ? raw.values : [];
  const byKey = new Map(values.filter((v) => v && v.key).map((v) => [String(v.key), v]));

  const baseUrlRaw = byKey.get("baseUrl")?.value;
  const baseUrl =
    typeof baseUrlRaw === "string" ? baseUrlRaw.trim().replace(/\/$/, "") : String(baseUrlRaw || "");

  if (baseUrl) {
    const aliases = [
      "localhost",
      "testUrl",
      "devUrl",
      "qaUrl",
      "prodUrl",
      "mainUrl",
      "mainurl",
      "awsUrl",
      "awsurl",
      "apiUrl",
      "apiURL",
      "hostUrl",
      "url",
    ];
    for (const key of aliases) {
      if (!byKey.has(key)) {
        values.push({ key, value: baseUrl, type: "default", enabled: true });
      }
    }
    // Also normalize baseUrl itself (no trailing slash) to reduce double-slash URLs.
    if (byKey.has("baseUrl")) {
      byKey.get("baseUrl").value = baseUrl;
    }
  }

  raw.values = values;
  await fs.writeJson(outputPath, raw, { spaces: 2 });
  SANITIZE_STATS.environments[path.basename(inputPath)] = baseUrl ? "copied+aliases" : "copied";
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
