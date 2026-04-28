const path = require("path");
const fs = require("fs-extra");

const ROOT = path.resolve(__dirname, "..");
const INPUT_PATH = path.join(ROOT, "reports", "required-params-report-all.json");
const OUTPUT_PATH = path.join(ROOT, "reports", "required-params-simple-all.json");

function toRequiredBoolean(classification) {
  // User rule:
  // - unknown => required: true
  // - optional => required: false
  // - required => required: true
  return classification === "optional" ? false : true;
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
      paramType: endpoint.paramType || "",
      parameters: params.map((p) => ({
        name: p.param || "",
        required: toRequiredBoolean(p.classification),
      })),
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    sourceFile: "reports/required-params-report-all.json",
    totalEndpoints: endpoints.length,
    endpoints,
  };

  await fs.writeJson(OUTPUT_PATH, output, { spaces: 2 });
  console.log(`Generated simplified all-method report: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Failed to build simplified all-method report:", err.message);
  process.exit(1);
});

