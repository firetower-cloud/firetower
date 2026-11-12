# Connectors v1 — acceptance criteria

What "done" means for the first connectors build. Each criterion is numbered
and independently testable, because QA tests against this list and a criterion
nobody can fail is not one.

The drawings are `connectors` and `connectors-discover` (published artifacts).
Where the build cannot match them, that is a finding to report, not a licence
to reinterpret.

**Scope.** Outbound remote MCP connectors, added by URL, for Claude Code.
Not in this build: the catalogue service and Discover screens, the other three
agents' config writers, per-profile defaults, and everything inbound.

---

## Phase A — safety. Nothing else is safe until these hold

1. Every connector a session loads has a `permissions.ask` entry written for
   its tools in the file Firetower already writes. A connector **write** tool
   reaches the approver under `--permission-mode auto`, which is what Firetower
   passes today.
2. A denial at that prompt stops the tool call. The agent reports the denial
   rather than proceeding.
3. The rule holds even when the machine account's own `~/.claude/settings.json`
   carries a `permissions.allow` entry for that tool. This was demonstrated to
   bypass approval before the fix.
4. `--strict-mcp-config` is passed, and a session does not load MCP servers
   from the machine account's `~/.claude.json`. Two sessions for two people on
   one worker do not see each other's servers.

## Phase B — connecting one, end to end

5. **Configuration → Connectors** exists, in the **Harness** group, directly
   beneath Skills (`desktop/src/ui/config/panes.ts`).
6. A connector is added by URL from a two-field form — **Name** and **MCP
   server URL** — matching the drawing. No command field: v1 is remote only.
   The form carries the trust warning.
7. A URL that is not an MCP server, or is unreachable, fails at the form with a
   message naming what went wrong. It does not create a half-made row.
8. **A server needing no authentication connects and is usable.** Verified
   against a real one.
9. **A server needing OAuth connects and is usable.** Discovery runs from the
   `401`'s `WWW-Authenticate` → RFC 9728 protected-resource metadata → RFC 8414
   authorization-server metadata, with dynamic client registration where there
   is no static client, and PKCE throughout.
10. Before the browser opens, the person sees **the scopes they are about to
    grant, in the server's own words, read live from the server** — not from a
    stored list. For a server that refuses `tools/list` unauthenticated, this is
    what the detail view shows instead of tools.
11. The access token, refresh token and expiry are stored in the vault under
    this person's name, and every read is written to the access log before the
    value is returned.
12. **No route returns a connector credential.** Connector grants are
    explicitly excluded from the authorised reveal route at
    `crates/ft-server/src/api/secrets.rs`.

## Phase C — what the session sees

13. `tools/list` is probed by the control plane at connect, and the tool count
    is shown on the connector. Where the server answers unauthenticated, tools
    are shown **before** connecting; where it does not, they appear after.
14. A per-tool hash over each tool's full definition — name, description and
    schema — is stored at the time the list is first read. A later probe whose
    hash differs for a tool is recorded as drift.
15. A connector turned on for a session appears in the agent's `init` frame as
    connected, and its tools are callable.
16. A connector tool call renders in the transcript as an MCP tool call
    (`ItemKind::McpToolCall`), in every client that shows a transcript.
17. **A connector filed where this person has no grant is shown, counted at
    zero, and not sent to the worker.** Sending it would produce a server that
    fails to authenticate and a confusing line in somebody's transcript.
18. A session whose grant has expired says so, and offers to reconnect. It does
    not tell the person to run `/mcp`.

## Phase C2 — conformance. Added after reading the specification

The MCP specification sanctions **exactly one** authorization scheme for remote
servers, and declares authorization OPTIONAL. It says nothing about API keys.
These were established by reading the spec and driving the installed agents at
a conformance probe.

18a. The OAuth leg sends the **RFC 8707 `resource` parameter**. The spec
     mandates it wherever authorization is used, and omitting it is the kind of
     thing that works against a lenient server and fails against a strict one.
18b. **No credential is ever placed in a query string.** The specification
     forbids it outright.
18c. The server's declared `capabilities` and its `protocolVersion` are
     recorded at probe time, beside the tool hashes. Not interpreted yet —
     recorded, so the matrix is a probe rather than a document somebody has to
     keep true.
18d. A **protocol version mismatch is surfaced to the person**, not swallowed.
     It already fails loudly — Claude Code reports `status: "failed"` at connect
     in a field Firetower already reads — so this is about showing it, with the
     versions each side wanted.
18e. A server that declares it needs a client capability **no agent offers** —
     `sampling` being the live case, which none of the three installed agents
     provides — is detected at connect and said plainly. The specification has
     no field for a server to announce this, so detection is best-effort and the
     criterion is honesty rather than completeness: never report a connector as
     working when its declared needs cannot be met.

## Phase D — the demos

19. A recorded demonstration of a connector against a server that needs **no
    authentication**, from adding it to a tool call returning real data.
20. A recorded demonstration of a connector against a server that needs
    **OAuth**, covering the scopes screen, the browser leg, the grant landing
    in the vault, and a tool call returning real data.
