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
    // User rule: any unknown variable should fall back to baseUrl.
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

function isIgnoredFolder(folderPath) {
  return folderPath.some((p) => String(p || "").toLowerCase() === "2fa");
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
    return { json, message: typeof message === "string" ? message : JSON.stringify(message) };
  } catch (_) {
    return { json: null, message: String(text).slice(0, 300) };
  }
}

function getBearerToken(authObj, vars) {
  if (!authObj || authObj.type !== "bearer") return "";
  const tokenEntry = (authObj.bearer || []).find((x) => x.key === "token");
  if (!tokenEntry) return "";
  return resolveVars(tokenEntry.value || "", vars);
}

function buildHeaders(request, vars, collectionAuth) {
  const headers = {};
  for (const h of request?.header || []) {
    if (!h || h.disabled || !h.key) continue;
    headers[h.key] = resolveVars(h.value ?? "", vars);
  }

  const auth = request?.auth || collectionAuth;
  if (auth && auth.type !== "noauth" && auth.type === "bearer") {
    const token = getBearerToken(auth, vars);
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  return headers;
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

function getEnabledQueryParams(request, vars) {
  const query = request?.url?.query || [];
  return query
    .filter((q) => q && q.key && !q.disabled)
    .map((q) => ({ key: q.key, value: resolveVars(q.value ?? "", vars) }));
}

function buildUrlWithQuery({ request, vars, queryOverride }) {
  const rawUrl = request?.url?.raw || "";
  const resolved = resolveVars(rawUrl, vars);
  if (/\{\{[^}]+\}\}/.test(resolved)) {
    throw new Error(`Unresolved URL variables in "${resolved}"`);
  }
  const u = new URL(resolved);
  if (queryOverride) {
    u.search = "";
    for (const { key, value } of queryOverride) {
      u.searchParams.append(key, value);
    }
  }
  return u.toString();
}

async function executeRequest({ request, vars, collectionAuth, urlOverride, bodyOverride }) {
  const method = request.method || "GET";
  const url = urlOverride || buildUrlWithQuery({ request, vars });
  const headers = buildHeaders(request, vars, collectionAuth);

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
  return { status: res.status, ok: res.ok, message: parsed.message, body: parsed.json };
}

function inferRequired({ baseline, variant }) {
  if (!baseline.ok && !variant.ok) return "unknown";
  if (baseline.ok && !variant.ok) return "required";
  if (baseline.ok && variant.ok) return "optional";
  if (!baseline.ok && variant.ok) return "optional";
  return "unknown";
}

async function main() {
  await fs.ensureDir(REPORTS_DIR);

  const config = await fs.readJson(RUN_CONFIG_PATH);
  const run = (config.runs || [])[0];
  if (!run) throw new Error("No runs found in run-config.json");

  const collectionPath = path.join(INPUT_COLLECTIONS, run.collectionFile);
  const environmentPath = path.join(INPUT_ENVIRONMENTS, run.environmentFile);
  const collection = await fs.readJson(collectionPath);
  const environment = await fs.readJson(environmentPath);
  const vars = toVarMap(environment, collection);
  const collectionAuth = collection.auth || null;

  const allRequests = walkRequests(collection.item || []).filter(
    (r) => !isIgnoredFolder(r.folderPath)
  );

  // Ignore DELETE, run GET/POST/PUT only.
  const selected = allRequests.filter((r) => {
    const m = String(r.request?.method || "").toUpperCase();
    return m === "GET" || m === "POST" || m === "PUT";
  });

  const results = [];
  const skipped = [];

  for (const entry of selected) {
    const method = String(entry.request.method || "").toUpperCase();
    const folder = entry.folderPath.join(" / ");

    try {
      if (method === "GET") {
        const enabledQuery = getEnabledQueryParams(entry.request, vars);
        if (!enabledQuery.length) {
          // No query params to validate; still include endpoint in report with empty params.
          const url = buildUrlWithQuery({ request: entry.request, vars, queryOverride: enabledQuery });
          const baseline = await executeRequest({
            request: entry.request,
            vars,
            collectionAuth,
            urlOverride: url,
          });
          results.push({
            endpointName: entry.name,
            folder,
            method,
            url,
            baselineStatus: baseline.status,
            baselineMessage: baseline.message,
            params: [],
            paramType: "query",
          });
          continue;
        }

        const baselineUrl = buildUrlWithQuery({
          request: entry.request,
          vars,
          queryOverride: enabledQuery,
        });
        const baseline = await executeRequest({
          request: entry.request,
          vars,
          collectionAuth,
          urlOverride: baselineUrl,
        });

        const params = [];
        for (const { key } of enabledQuery) {
          const variantQuery = enabledQuery.filter((q) => q.key !== key);
          const variantUrl = buildUrlWithQuery({
            request: entry.request,
            vars,
            queryOverride: variantQuery,
          });
          const variant = await executeRequest({
            request: entry.request,
            vars,
            collectionAuth,
            urlOverride: variantUrl,
          });
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
          folder,
          method,
          url: baselineUrl,
          baselineStatus: baseline.status,
          baselineMessage: baseline.message,
          params,
          paramType: "query",
        });
        continue;
      }

      // POST/PUT: validate JSON body fields (raw JSON only).
      const baseBody = getJsonBodyObject(entry.request);
      const url = buildUrlWithQuery({ request: entry.request, vars });
      const baseline = await executeRequest({
        request: entry.request,
        vars,
        collectionAuth,
        urlOverride: url,
        bodyOverride: baseBody || undefined,
      });

      const params = [];
      if (baseBody) {
        for (const key of Object.keys(baseBody)) {
          const variantBody = { ...baseBody };
          delete variantBody[key];
          const variant = await executeRequest({
            request: entry.request,
            vars,
            collectionAuth,
            urlOverride: url,
            bodyOverride: variantBody,
          });
          params.push({
            param: key,
            classification: inferRequired({ baseline, variant }),
            baselineStatus: baseline.status,
            withoutParamStatus: variant.status,
            withoutParamMessage: variant.message,
          });
        }
      }

      results.push({
        endpointName: entry.name,
        folder,
        method,
        url,
        baselineStatus: baseline.status,
        baselineMessage: baseline.message,
        params,
        paramType: "body",
      });
    } catch (err) {
      skipped.push({
        endpointName: entry.name,
        folder,
        method,
        reason: err.message,
      });
    }
  }

  const outPath = path.join(REPORTS_DIR, "required-params-report-all.json");
  await fs.writeJson(
    outPath,
    {
      generatedAt: new Date().toISOString(),
      note: "GET params tested by omitting enabled query params; POST/PUT tested by omitting JSON body fields. DELETE ignored. Auth/2FA folder ignored.",
      selectedEndpoints: selected.length,
      processedEndpoints: results.length,
      skippedEndpoints: skipped.length,
      skipped,
      results,
    },
    { spaces: 2 }
  );

  console.log(`All-method required-params report generated: ${outPath}`);
}

main().catch((err) => {
  console.error("All-method parameter validation failed:", err.message);
  process.exit(1);
});

