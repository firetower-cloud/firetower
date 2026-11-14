/**
 * A conformant OAuth-protected remote MCP server, for the demo.
 *
 * Implements the chain the specification mandates, so what is exercised is
 * Firetower's real client against a real server rather than against a mock of
 * its own code: RFC 9728 protected-resource metadata, RFC 8414
 * authorization-server metadata, RFC 7591 dynamic registration of a public
 * client, PKCE S256 checked at the token endpoint, and RFC 8707 `resource`
 * required on both legs.
 *
 * `/authorize` stands in for the human pressing Approve: it redirects straight
 * back with a code. That is the only step a person would otherwise do, and it
 * is the only step this does differently.
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.FTDEMO_MCP_PORT ?? 14913);
const ME = `http://127.0.0.1:${PORT}`;
const RESOURCE = `${ME}/mcp`;
const SCOPES = ["rota:read", "deploys:read", "flags:read", "flags:write"];

const clients = new Map();          // client_id -> { redirect_uris }
const codes = new Map();            // code -> { challenge, resource, client_id }
const tokens = new Map();           // access -> { expires, refresh }
const refreshes = new Map();        // refresh -> true
const log = (...a) => console.log(a.join(" "));
let lastIssued = null;   // read back by the demo script — see /demo/last-token

const b64url = (b) => b.toString("base64url");
const s256 = (v) => b64url(crypto.createHash("sha256").update(v).digest());

const TOOLS = [
  { name: "whoami", description: "Who this token belongs to.",
    inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "oncall_rota", description: "Who is on call this week.",
    inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "set_flag", description: "Turn a feature flag on or off.",
    inputSchema: { type: "object", properties: { flag: { type: "string" }, on: { type: "boolean" } },
      required: ["flag", "on"] } },
];

function json(rs, code, body, headers = {}) {
  rs.writeHead(code, { "content-type": "application/json", ...headers });
  rs.end(JSON.stringify(body));
}

function mcp(rq, rs, body) {
  const auth = rq.headers.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const held = presented && tokens.get(presented);

  if (!held || held.expires < Date.now()) {
    log("mcp 401", presented ? "(expired or unknown token)" : "(no token)");
    rs.writeHead(401, {
      "content-type": "application/json",
      // RFC 9728's pointer, which is where the whole chain starts.
      "www-authenticate": `Bearer realm="OAuth", resource_metadata="${ME}/.well-known/oauth-protected-resource/mcp"`,
    });
    return rs.end(JSON.stringify({ error: "invalid_token" }));
  }

  let r; try { r = JSON.parse(body); } catch { return json(rs, 400, {}); }
  const { method, id, params } = r;
  if (method === "initialize")
    return json(rs, 200, { jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "westlabs-internal", version: "1.4.0" } } });
  if (method === "notifications/initialized") { rs.writeHead(202); return rs.end(); }
  if (method === "tools/list") return json(rs, 200, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const n = params?.name;
    const say = (t) => json(rs, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }] } });
    if (n === "whoami") return say(`This token belongs to the Firetower demo, issued ${new Date(held.issued).toISOString()}.`);
    if (n === "oncall_rota") return say("On call this week: Dana Whitfield (primary), Lisa Wen (secondary). Next handover Monday 09:00 UTC.");
    if (n === "set_flag") return say(`Set ${params.arguments.flag} to ${params.arguments.on}.`);
    return json(rs, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "no such tool" } });
  }
  return json(rs, 200, { jsonrpc: "2.0", id, result: {} });
}

http.createServer((rq, rs) => {
  let body = "";
  rq.on("data", (c) => (body += c));
  rq.on("end", () => {
    const url = new URL(rq.url, ME);
    log(rq.method, url.pathname);

    // ── RFC 9728 ────────────────────────────────────────────────────
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json(rs, 200, {
        resource: RESOURCE,
        authorization_servers: [ME],
        scopes_supported: SCOPES,
        bearer_methods_supported: ["header"],
      });

    // ── RFC 8414 ────────────────────────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(rs, 200, {
        issuer: ME,
        authorization_endpoint: `${ME}/authorize`,
        token_endpoint: `${ME}/token`,
        registration_endpoint: `${ME}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: SCOPES,
      });

    // ── RFC 7591: a public client, no secret ────────────────────────
    if (url.pathname === "/register" && rq.method === "POST") {
      const asked = JSON.parse(body);
      const client_id = "demo-" + b64url(crypto.randomBytes(8));
      clients.set(client_id, { redirect_uris: asked.redirect_uris });
      log("registered", client_id, "->", JSON.stringify(asked.redirect_uris));
      return json(rs, 201, {
        client_id, client_name: asked.client_name,
        redirect_uris: asked.redirect_uris,
        grant_types: asked.grant_types, response_types: asked.response_types,
        token_endpoint_auth_method: "none", client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    }

    // ── The consent screen, standing in for a person pressing Approve ──
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const client = clients.get(q.get("client_id"));
      if (!client) return json(rs, 400, { error: "unauthorized_client" });
      if (!client.redirect_uris.includes(q.get("redirect_uri")))
        return json(rs, 400, { error: "invalid_redirect_uri" });
      // RFC 8707, which the specification mandates. Refused when absent:
      // that is the strict server the brief warned about.
      if (q.get("resource") !== RESOURCE)
        return json(rs, 400, { error: "invalid_target", error_description: `resource must be ${RESOURCE}` });
      if (q.get("code_challenge_method") !== "S256")
        return json(rs, 400, { error: "invalid_request", error_description: "S256 only" });

      const code = b64url(crypto.randomBytes(16));
      codes.set(code, {
        challenge: q.get("code_challenge"),
        resource: q.get("resource"),
        client_id: q.get("client_id"),
      });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      log("approved -> redirecting to", back.toString().slice(0, 80));
      rs.writeHead(302, { location: back.toString() });
      return rs.end();
    }

    // ── The token endpoint, checking PKCE and `resource` ────────────
    if (url.pathname === "/token" && rq.method === "POST") {
      const f = new URLSearchParams(body);
      const grant = f.get("grant_type");

      if (grant === "refresh_token") {
        if (!refreshes.has(f.get("refresh_token")))
          return json(rs, 400, { error: "invalid_grant" });
        refreshes.delete(f.get("refresh_token"));   // single-use, like GitLab's
        return json(rs, 200, issue());
      }

      const held = codes.get(f.get("code"));
      if (!held) return json(rs, 400, { error: "invalid_grant", error_description: "no such code" });
      codes.delete(f.get("code"));                  // single-use
      if (s256(f.get("code_verifier") ?? "") !== held.challenge)
        return json(rs, 400, { error: "invalid_grant", error_description: "PKCE verifier does not match" });
      if (f.get("resource") !== RESOURCE)
        return json(rs, 400, { error: "invalid_target", error_description: "resource missing at the token endpoint" });
      log("issued a token: PKCE verified, resource verified");
      return json(rs, 200, issue());
    }

    // **A demo affordance and nothing else.** The script needs the token the
    // exchange produced so it can make the tool call a session would make,
    // and scraping it out of a log was worse. No real authorization server
    // has this, which is the point of saying so here.
    if (url.pathname === "/demo/last-token") return json(rs, 200, { access_token: lastIssued });

    if (url.pathname === "/mcp") return mcp(rq, rs, body);
    json(rs, 404, { error: "not_found" });
  });
}).listen(PORT, "127.0.0.1", () => console.log("oauth mcp on " + PORT));

function issue() {
  const access = "wl_at_" + b64url(crypto.randomBytes(18));
  const refresh = "wl_rt_" + b64url(crypto.randomBytes(18));
  tokens.set(access, { expires: Date.now() + 3600_000, issued: Date.now(), refresh });
  refreshes.set(refresh, true);
  lastIssued = access;
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: SCOPES.join(" ") };
}
