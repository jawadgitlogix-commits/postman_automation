const fs = require("fs");
const path = require("path");

function walkItems(items, folderPath = [], out = []) {
  for (const item of items || []) {
    if (item.item) {
      walkItems(item.item, [...folderPath, item.name], out);
      continue;
    }
    if (item.request) {
      out.push({
        folderPath,
        name: item.name || "Unnamed request",
        request: item.request,
      });
    }
  }
  return out;
}

function parseRawJsonKeys(raw) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
  } catch (_) {
    return [];
  }
  return [];
}

function extractBodyParams(body) {
  if (!body) return [];
  if (body.mode === "raw") {
    const keys = parseRawJsonKeys(body.raw);
    return keys.map((key) => ({
      name: key,
      in: "body",
      required: "unknown",
      sampleValue: (() => {
        try {
          const parsed = JSON.parse(body.raw || "{}");
          return parsed[key];
        } catch (_) {
          return "";
        }
      })(),
    }));
  }

  if (body.mode === "urlencoded") {
    return (body.urlencoded || []).map((p) => ({
      name: p.key,
      in: "body",
      required: "unknown",
      sampleValue: p.value ?? "",
      disabled: !!p.disabled,
    }));
  }

  if (body.mode === "formdata") {
    return (body.formdata || []).map((p) => ({
      name: p.key,
      in: "body",
      required: "unknown",
      sampleValue: p.value ?? "",
      disabled: !!p.disabled,
    }));
  }

  return [];
}

function extractEndpoint(entry) {
  const req = entry.request || {};
  const url = req.url || {};

  const queryParams = (url.query || []).map((q) => ({
    name: q.key,
    in: "query",
    required: "unknown",
    sampleValue: q.value ?? "",
    disabled: !!q.disabled,
  }));

  const pathVars = (url.variable || []).map((v) => ({
    name: v.key,
    in: "path",
    required: "unknown",
    sampleValue: v.value ?? "",
  }));

  const headers = (req.header || [])
    .filter((h) => (h.key || "").toLowerCase() !== "content-type")
    .map((h) => ({
      name: h.key,
      in: "header",
      required: "unknown",
      sampleValue: h.value ?? "",
      disabled: !!h.disabled,
    }));

  const bodyParams = extractBodyParams(req.body);

  return {
    endpointName: entry.name,
    folder: entry.folderPath.join(" / "),
    method: req.method || "GET",
    url: url.raw || "",
    params: [...pathVars, ...queryParams, ...headers, ...bodyParams],
  };
}

function main() {
  const root = process.cwd();
  const collectionPath = path.join(
    root,
    "input",
    "collections",
    "Extension API.postman_collection.json"
  );
  const outPath = path.join(root, "reports", "endpoint-params.json");

  const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
  const requests = walkItems(collection.item || []);
  const endpoints = requests.map(extractEndpoint);

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: "Postman collection samples do not reliably encode schema-requiredness. 'required' is set to 'unknown' unless sourced from an API schema.",
        totalEndpoints: endpoints.length,
        endpoints,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Generated ${endpoints.length} endpoints at: ${outPath}`);
}

main();
