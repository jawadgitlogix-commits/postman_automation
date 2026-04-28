const path = require("path");
const fs = require("fs-extra");

const ROOT = path.resolve(__dirname, "..");
const INPUT_PATH = path.join(ROOT, "reports", "required-params-report.json");
const OUTPUT_PATH = path.join(ROOT, "reports", "required-params-simple.json");

function toRequiredBoolean(classification) {
  if (classification === "optional") return false;
  // User rule: unknown should be treated as required=true.
  return true;
}

async function main() {
  const report = await fs.readJson(INPUT_PATH);
  const results = Array.isArray(report.results) ? report.results : [];

  const endpoints = results.map((endpoint) => {
    const params = Array.isArray(endpoint.params) ? endpoint.params : [];
    return {
      endpointName: endpoint.endpointName || "",
      url: endpoint.url || "",
      method: endpoint.method || "",
      parameters: params.map((p) => ({
        name: p.param || "",
        required: toRequiredBoolean(p.classification),
      })),
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    sourceFile: "reports/required-params-report.json",
    totalEndpoints: endpoints.length,
    endpoints,
  };

  await fs.writeJson(OUTPUT_PATH, output, { spaces: 2 });
  console.log(`Generated simplified report: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Failed to build simplified report:", err.message);
  process.exit(1);
});
