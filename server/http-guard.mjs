// Request checks for the local API. The server only listens on 127.0.0.1, but a web page open in the
// same browser could still call it (cross-site requests, DNS rebinding). The API starts Claude runs and
// reads folders, so it only answers requests that come from the dashboard itself.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// "localhost:5178" -> "localhost", "[::1]:5178" -> "[::1]"
export function hostName(header) {
  const value = String(header || "").trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.split(":")[0];
}

export function isLocalHost(header) {
  const name = hostName(header);
  return LOCAL_HOSTS.has(name) || name.endsWith(".localhost");
}

// Extra host names the API answers on, for a tunnel in front of the server (for example Cloudflare Tunnel).
// Entries are bare host names without a port; the tunnel must also authenticate its visitors (Cloudflare Access).
export function normalizeHosts(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => hostName(String(entry || "").replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")))
    .filter(Boolean);
}

function isAllowedHost(header, allowedHosts) {
  return isLocalHost(header) || allowedHosts.includes(hostName(header));
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

// Returns null when the request may use the API, or { status, error } when it is refused.
export function checkRequest(req, allowedHosts = []) {
  const headers = req.headers || {};
  // A rebound DNS name reaches 127.0.0.1 with its own Host header.
  if (!isAllowedHost(headers.host, allowedHosts)) return { status: 403, error: "The API does not answer on this host name." };
  if (headers.origin && !isAllowedHost(originHost(headers.origin), allowedHosts)) {
    return { status: 403, error: "Requests from other sites are not allowed." };
  }
  if (headers["sec-fetch-site"] === "cross-site") return { status: 403, error: "Requests from other sites are not allowed." };
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  if (!["POST", "PUT", "DELETE"].includes(method)) return { status: 405, error: "Method not allowed." };
  // A JSON content type cannot be sent cross-site without a preflight, which this server never grants.
  if (!String(headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return { status: 415, error: "Send JSON (Content-Type: application/json)." };
  }
  return null;
}
