const path = require("path");
const fs = require("fs-extra");

const ROOT = path.resolve(__dirname, "..");
const INPUT_COLLECTIONS = path.join(ROOT, "input", "collections");
const INPUT_ENVIRONMENTS = path.join(ROOT, "input", "environments");
const REPORTS_DIR = path.join(ROOT, "reports");
const RUN_CONFIG_PATH = path.join(ROOT, "run-config.json");

function toVarMap(environmentJson = {}, collectionJson = {}) {
  const envVars = {};
  for (const item of environmentJson.values || []) {
    if (item && item.enabled !== false && item.key) {
      envVars[item.key] = item.value ?? "";
    }
  }

  const collectionVars = {};
  for (const item of collectionJson.variable || []) {
    if (item && item.key) {
      collectionVars[item.key] = item.value ?? "";
    }
  }

  return { ...collectionVars, ...envVars };
}

function resolveVars(text, vars) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (_, rawKey) => {
    const key = String(rawKey || "").trim();
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    if (key !== "baseUrl" && Object.prototype.hasOwnProperty.call(vars, "baseUrl")) {
      return vars.baseUrl;
    }
    return `{{${key}}}`;
  });
}

function walkRequests(items, parentPath = [], out = []) {
  for (const item of items || []) {
    if (item.item) {
      walkRequests(item.item, [...parentPath, item.name], out);
      continue;
    }
    if (item.request) {
      out.push({
        name: item.name || "Unnamed",
        folderPath: parentPath,
        request: item.request,
      });
    }
  }
  return out;
}

function getJsonBodyObject(request) {
  const body = request?.body;
  if (!body || body.mode !== "raw" || typeof body.raw !== "string") return null;
  try {
    const parsed = JSON.parse(body.raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    return null;
  }
  return null;
}

function buildHeaders(request, vars) {
  const headers = {};
  for (const h of request?.header || []) {
    if (!h || h.disabled || !h.key) continue;
    headers[h.key] = resolveVars(h.value ?? "", vars);
  }
  return headers;
}

function getBearerToken(authObj, vars) {
  if (!authObj || authObj.type !== "bearer") return "";
  const tokenEntry = (authObj.bearer || []).find((x) => x.key === "token");
  if (!tokenEntry) return "";
  return resolveVars(tokenEntry.value || "", vars);
}

function applyAuthHeaders({ request, collectionAuth, vars, headers }) {
  const auth = request?.auth || collectionAuth;
  if (!auth || auth.type === "noauth") return;

  if (auth.type === "bearer") {
    const token = getBearerToken(auth, vars);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
}

function parseResponseBody(text) {
  if (!text) return { json: null, message: "" };
  try {
    const json = JSON.parse(text);
    const message =
      json.message ||
      json.error ||
      json.detail ||
      json.key ||
      (Array.isArray(json.non_field_errors) ? json.non_field_errors[0] : "") ||
      "";
    return { json, message: String(message || "") };
  } catch (_) {
    return { json: null, message: String(text).slice(0, 300) };
  }
}

async function executeRequest({ request, vars, bodyOverride, collectionAuth }) {
  const method = request.method || "GET";
  const rawUrl = request?.url?.raw || "";
  const url = resolveVars(rawUrl, vars);
  if (/\{\{[^}]+\}\}/.test(url)) {
    throw new Error(`Unresolved URL variables in "${url}"`);
  }
  const headers = buildHeaders(request, vars);
  applyAuthHeaders({ request, collectionAuth, vars, headers });
  let body;

  if (bodyOverride) {
    body = JSON.stringify(bodyOverride);
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  const parsed = parseResponseBody(text);

  return {
    status: res.status,
    ok: res.ok,
    message: parsed.message,
    body: parsed.json,
  };
}

async function bootstrapTokens({ allRequests, vars, collectionAuth }) {
  const hasProvidedToken =
    typeof vars.token === "string" &&
    vars.token.trim().length > 0 &&
    typeof vars.staff_token === "string" &&
    vars.staff_token.trim().length > 0 &&
    typeof vars.candidate_token === "string" &&
    vars.candidate_token.trim().length > 0;

  if (hasProvidedToken) {
    return;
  }

  const loginEntry = allRequests.find((r) => r.name === "Login");
  if (!loginEntry) return;

  const loginBody = getJsonBodyObject(loginEntry.request);
  if (!loginBody) return;

  const login = await executeRequest({
    request: loginEntry.request,
    vars,
    bodyOverride: loginBody,
    collectionAuth,
  });

  if (login?.body?.access && (!vars.token || !vars.token.trim())) {
    vars.token = login.body.access;
  }
  if (login?.body?.refresh && (!vars.refresh_token || !vars.refresh_token.trim())) {
    vars.refresh_token = login.body.refresh;
  }
  if ((!vars.staff_token || !vars.staff_token.trim()) && vars.token) {
    vars.staff_token = vars.token;
  }
  if ((!vars.candidate_token || !vars.candidate_token.trim()) && vars.token) {
    vars.candidate_token = vars.token;
  }
}

function inferRequired({ baseline, variant }) {
  if (!baseline.ok && !variant.ok) {
    return "unknown";
  }
  if (baseline.ok && !variant.ok) {
    return "required";
  }
  if (baseline.ok && variant.ok) {
    return "optional";
  }
  if (!baseline.ok && variant.ok) {
    return "optional";
  }
  return "unknown";
}

async function main() {
  await fs.ensureDir(REPORTS_DIR);

  const config = await fs.readJson(RUN_CONFIG_PATH);
  const run = (config.runs || [])[0];
  if (!run) throw new Error("No runs found in run-config.json");

  const targetRequestNames = config.paramValidation?.requestNames || ["Login"];
  const runAll = Boolean(config.paramValidation?.runAllJsonBodyRequests);

  const collectionPath = path.join(INPUT_COLLECTIONS, run.collectionFile);
  const environmentPath = path.join(INPUT_ENVIRONMENTS, run.environmentFile);
  const collection = await fs.readJson(collectionPath);
  const environment = await fs.readJson(environmentPath);
  const vars = toVarMap(environment, collection);
  const collectionAuth = collection.auth || null;

  const allRequests = walkRequests(collection.item || []);
  await bootstrapTokens({ allRequests, vars, collectionAuth });
  const candidates = allRequests.filter((entry) => getJsonBodyObject(entry.request));

  const selected = runAll
    ? candidates
    : candidates.filter((entry) => targetRequestNames.includes(entry.name));

  if (!selected.length) {
    throw new Error("No matching JSON-body requests found for parameter validation.");
  }

  const results = [];
  const skipped = [];
  for (const entry of selected) {
    const baseBody = getJsonBodyObject(entry.request);
    let baseline;
    try {
      baseline = await executeRequest({
        request: entry.request,
        vars,
        bodyOverride: baseBody,
        collectionAuth,
      });
    } catch (err) {
      skipped.push({
        endpointName: entry.name,
        folder: entry.folderPath.join(" / "),
        reason: err.message,
      });
      continue;
    }

    const params = [];
    for (const key of Object.keys(baseBody)) {
      const variantBody = { ...baseBody };
      delete variantBody[key];
      let variant;
      try {
        variant = await executeRequest({
          request: entry.request,
          vars,
          bodyOverride: variantBody,
          collectionAuth,
        });
      } catch (err) {
        params.push({
          param: key,
          classification: "unknown",
          baselineStatus: baseline.status,
          withoutParamStatus: null,
          withoutParamMessage: err.message,
        });
        continue;
      }
      params.push({
        param: key,
        classification: inferRequired({ baseline, variant }),
        baselineStatus: baseline.status,
        withoutParamStatus: variant.status,
        withoutParamMessage: variant.message,
      });
    }

    results.push({
      endpointName: entry.name,
      folder: entry.folderPath.join(" / "),
      method: entry.request.method,
      url: resolveVars(entry.request?.url?.raw || "", vars),
      baselineStatus: baseline.status,
      baselineMessage: baseline.message,
      params,
    });
  }

  const outPath = path.join(REPORTS_DIR, "required-params-report.json");
  await fs.writeJson(
    outPath,
    {
      generatedAt: new Date().toISOString(),
      note: "Classification is based on baseline vs omit-one-param API behavior.",
      selectedEndpoints: selected.length,
      processedEndpoints: results.length,
      skippedEndpoints: skipped.length,
      skipped,
      results,
    },
    { spaces: 2 }
  );

  console.log(`Required-params report generated: ${outPath}`);
}

main().catch((err) => {
  console.error("Parameter validation failed:", err.message);
  process.exit(1);
});
