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

function normalizeBaseUrl(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
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

function stripRequestScriptsFromCollection(node, counter) {
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
      stripRequestScriptsFromCollection(child, counter);
    }
  }
}

function parseResponseBody(text) {
  if (!text) return { json: null, message: "" };
  try {
    const json = JSON.parse(text);
    const message = extractErrorMessage(json);
    return { json, message };
  } catch (_) {
    return { json: null, message: String(text).slice(0, 300) };
  }
}

function extractErrorMessage(json) {
  const seen = new Set();

  function firstString(x) {
    if (typeof x === "string" && x.trim()) return x.trim();
    if (typeof x === "number" || typeof x === "boolean") return String(x);
    if (!x || typeof x !== "object") return "";
    if (seen.has(x)) return "";
    seen.add(x);

    if (Array.isArray(x)) {
      for (const item of x) {
        const s = firstString(item);
        if (s) return s;
      }
      return "";
    }

    const preferredKeys = [
      "message",
      "error",
      "detail",
      "title",
      "description",
      "key",
      "code",
      "non_field_errors",
      "errors",
      "error_description",
    ];
    for (const k of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(x, k)) {
        const s = firstString(x[k]);
        if (s) return s;
      }
    }

    for (const v of Object.values(x)) {
      const s = firstString(v);
      if (s) return s;
    }
    return "";
  }

  const msg = firstString(json);
  if (msg) return msg;
  try {
    return JSON.stringify(json).slice(0, 300);
  } catch (_) {
    return "";
  }
}

function getBearerToken(authObj, vars) {
  if (!authObj || authObj.type !== "bearer") return "";
  const tokenEntry = (authObj.bearer || []).find((x) => x.key === "token");
  if (!tokenEntry) return "";
  return resolveVars(tokenEntry.value || "", vars);
}

function inferAuthRole({ folderPath = [], resolvedUrl = "", headers = {} }) {
  const headerKeys = new Set(Object.keys(headers).map((k) => String(k || "").toLowerCase()));
  if (headerKeys.has("token")) return "candidate";

  const folder = folderPath.map((p) => String(p || "").toLowerCase()).join(" / ");
  const url = String(resolvedUrl || "").toLowerCase();

  if (folder.includes("candidate") || url.includes("/candidate")) {
    return "candidate";
  }
  if (folder.includes("staff") || url.includes("/staff")) {
    return "staff";
  }
  return "default";
}

function buildHeaders({ request, vars, collectionAuth, folderPath, resolvedUrl }) {
  const headers = {};
  for (const h of request?.header || []) {
    if (!h || h.disabled || !h.key) continue;
    headers[h.key] = resolveVars(h.value ?? "", vars);
  }

  const role = inferAuthRole({ folderPath, resolvedUrl, headers });
  const lowered = new Set(Object.keys(headers).map((k) => String(k || "").toLowerCase()));

  // Candidate auth style: raw token in `token` header (no Bearer).
  if (role === "candidate" && !lowered.has("token")) {
    const ct = typeof vars.candidate_token === "string" ? vars.candidate_token.trim() : "";
    if (ct) headers.token = ct;
  }

  // Apply bearer auth only when:
  // - request isn't explicitly noauth
  // - request doesn't already specify Authorization
  // - request isn't using candidate token header style
  const auth = request?.auth || collectionAuth;
  const hasAuthorizationHeader = lowered.has("authorization");
  const hasCandidateTokenHeader = lowered.has("token");
  if (
    auth &&
    auth.type !== "noauth" &&
    auth.type === "bearer" &&
    !hasAuthorizationHeader &&
    !hasCandidateTokenHeader
  ) {
    const tokenEntry = (auth.bearer || []).find((x) => x.key === "token");
    const rawTokenValue = tokenEntry?.value || "";

    let token = resolveVars(rawTokenValue, vars);
    // Heuristic: if collection uses {{token}}, prefer staff/candidate-specific tokens when available.
    if (/\{\{\s*token\s*\}\}/i.test(rawTokenValue)) {
      if (role === "staff" && typeof vars.staff_token === "string" && vars.staff_token.trim()) {
        token = vars.staff_token.trim();
      }
      if (
        role === "candidate" &&
        typeof vars.candidate_token === "string" &&
        vars.candidate_token.trim()
      ) {
        token = vars.candidate_token.trim();
      }
    }

    if (!token && typeof vars.token === "string") token = vars.token.trim();
    if (!token && typeof vars.staff_token === "string") token = vars.staff_token.trim();
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

function findLoginRequest(allRequests) {
  // Prefer an explicit "login" request name, otherwise find /auth/token/ endpoint.
  const byName = allRequests.find((r) => String(r.name || "").toLowerCase() === "login");
  if (byName) return byName;

  return allRequests.find((r) => {
    const raw = String(r.request?.url?.raw || "").toLowerCase();
    return raw.includes("/auth/token") || raw.includes("/auth/token/");
  });
}

function setTokenVars(vars, token) {
  if (!token || typeof token !== "string") return;
  const t = token.trim();
  if (!t) return;
  vars.token = t;
  // Force one fresh login token for all auth styles in this run.
  vars.staff_token = t;
  vars.candidate_token = t;
}

async function bootstrapTokens({ allRequests, vars, collectionAuth }) {
  const loginEntry = findLoginRequest(allRequests);
  if (!loginEntry) {
    // Fallback to any pre-supplied token if login endpoint doesn't exist.
    const hasToken = typeof vars.token === "string" && vars.token.trim().length > 0;
    if (hasToken) setTokenVars(vars, vars.token);
    return;
  }

  const loginBody = getJsonBodyObject(loginEntry.request);
  if (!loginBody) {
    const hasToken = typeof vars.token === "string" && vars.token.trim().length > 0;
    if (hasToken) setTokenVars(vars, vars.token);
    return;
  }

  let login;
  try {
    const loginUrl = buildUrlWithQuery({ request: loginEntry.request, vars });
    login = await executeRequest({
      request: loginEntry.request,
      vars,
      collectionAuth,
      folderPath: loginEntry.folderPath,
      urlOverride: loginUrl,
      bodyOverride: loginBody,
    });
  } catch (_) {
    const hasToken = typeof vars.token === "string" && vars.token.trim().length > 0;
    if (hasToken) setTokenVars(vars, vars.token);
    return;
  }

  // Common response shapes:
  // - { access, refresh }
  // - { token }
  const access = login?.body?.access || login?.body?.token || "";
  if (typeof access === "string" && access.trim()) {
    setTokenVars(vars, access);
    return;
  }

  // Login returned but token not found in response; fallback to existing vars if available.
  const hasToken = typeof vars.token === "string" && vars.token.trim().length > 0;
  if (hasToken) setTokenVars(vars, vars.token);
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

async function executeRequest({
  request,
  vars,
  collectionAuth,
  folderPath,
  urlOverride,
  bodyOverride,
}) {
  const method = request.method || "GET";
  const url = urlOverride || buildUrlWithQuery({ request, vars });
  const headers = buildHeaders({
    request,
    vars,
    collectionAuth,
    folderPath,
    resolvedUrl: url,
  });

  let body;
  if (bodyOverride) {
    body = JSON.stringify(bodyOverride);
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  let res;
  try {
    const controller = new AbortController();
    const timeoutMs = Number(vars.requestTimeoutMs || 30000);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const cause = err?.cause;
    const parts = [
      `fetch failed`,
      `method=${method}`,
      `url=${url}`,
      err?.name ? `error=${err.name}` : "",
      cause?.code ? `code=${cause.code}` : "",
      cause?.errno ? `errno=${cause.errno}` : "",
      cause?.syscall ? `syscall=${cause.syscall}` : "",
      cause?.message ? `cause=${cause.message}` : err?.message ? `cause=${err.message}` : "",
    ].filter(Boolean);
    throw new Error(parts.join(" | "));
  }

  const text = await res.text();
  const parsed = parseResponseBody(text);
  return { status: res.status, ok: res.ok, message: parsed.message, body: parsed.json };
}

function inferRequired({ baseline, variant }) {
  // User-requested strict rule:
  // - if omitted-param request fails/errors => required
  // - if omitted-param request succeeds => optional
  // Baseline is still captured for visibility but does not affect classification.
  return variant.ok ? "optional" : "required";
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

  // Sanitize collection in-memory before replaying requests:
  // remove both pre-request scripts and test scripts.
  const sanitizeCounter = { removed: 0 };
  stripRequestScriptsFromCollection(collection, sanitizeCounter);

  const vars = toVarMap(environment, collection);
  // Map common aliases to baseUrl for safety.
  vars.baseUrl = normalizeBaseUrl(vars.baseUrl);
  if (vars.baseUrl) {
    if (!vars.localhost) vars.localhost = vars.baseUrl;
  }

  const collectionAuth = collection.auth || null;

  const allRequests = walkRequests(collection.item || []).filter(
    (r) => !isIgnoredFolder(r.folderPath)
  );

  // If the environment doesn't provide a token, try to obtain one via the collection's login call.
  // This reduces "unknown" classifications caused by 401 baselines.
  try {
    await bootstrapTokens({ allRequests, vars, collectionAuth });
  } catch (_) {
    // If bootstrap fails, continue; requests may still succeed without auth.
  }

  // Ignore DELETE, run GET/POST/PUT only.
  const selected = allRequests.filter((r) => {
    const m = String(r.request?.method || "").toUpperCase();
    return m === "GET" || m === "POST" || m === "PUT";
  });

  const results = [];
  const skipped = [];

  let processedSoFar = 0;
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
            folderPath: entry.folderPath,
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
          folderPath: entry.folderPath,
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
          try {
            const variant = await executeRequest({
              request: entry.request,
              vars,
              collectionAuth,
              folderPath: entry.folderPath,
              urlOverride: variantUrl,
            });
            params.push({
              param: key,
              classification: inferRequired({ baseline, variant }),
              baselineStatus: baseline.status,
              withoutParamStatus: variant.status,
              withoutParamMessage: variant.message,
            });
          } catch (err) {
            params.push({
              param: key,
              classification: "required",
              baselineStatus: baseline.status,
              withoutParamStatus: null,
              withoutParamMessage: err.message,
            });
          }
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
        folderPath: entry.folderPath,
        urlOverride: url,
        bodyOverride: baseBody || undefined,
      });

      const params = [];
      if (baseBody) {
        for (const key of Object.keys(baseBody)) {
          const variantBody = { ...baseBody };
          delete variantBody[key];
          try {
            const variant = await executeRequest({
              request: entry.request,
              vars,
              collectionAuth,
              folderPath: entry.folderPath,
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
          } catch (err) {
            params.push({
              param: key,
              classification: "required",
              baselineStatus: baseline.status,
              withoutParamStatus: null,
              withoutParamMessage: err.message,
            });
          }
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

    processedSoFar += 1;
    if (processedSoFar % 10 === 0) {
      console.log(`Processed ${processedSoFar}/${selected.length} endpoints...`);
    }
  }

  const outPath = path.join(REPORTS_DIR, "required-params-report-all.json");
  await fs.writeJson(
    outPath,
    {
      generatedAt: new Date().toISOString(),
      note: "GET params tested by omitting enabled query params; POST/PUT tested by omitting JSON body fields. DELETE ignored. Auth/2FA folder ignored. Collection scripts removed (prerequest + test) before replaying.",
      sanitize: { removedCollectionEvents: sanitizeCounter.removed },
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

