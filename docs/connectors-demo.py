#!/usr/bin/env python3
"""The two demonstrations criteria 19 and 20 ask for, as a script to replay.

    ./docs/connectors-demo.py

1. A connector against a server that needs **no authentication**, from adding
   it by URL to its tools being read live. Google Drive, against the real one.

2. A connector against a server that needs **OAuth**, covering the scopes
   screen, the browser leg, the grant landing in the vault, and a tool call
   returning real data.

**What is real and what is stood in for.** Every request Firetower makes here is
the real one: the probe, the RFC 9728 -> 8414 -> 7591 chain, dynamic client
registration, PKCE, the token exchange, the vault write and the access log.
Google Drive and Canva are the real public servers, reached over the network.

The one thing a script cannot do is press Approve on somebody else's consent
screen. That is the only step `connectors-oauth-server.mjs` stands in for: it is
a conformant authorization server written to the specification, whose
`/authorize` redirects straight back with a code instead of drawing a page. It
verifies PKCE and **refuses a request with no RFC 8707 `resource`**, so it is
the strict server a lenient one would have hidden. Canva's half of the chain —
registration, metadata, the authorize request — runs live against Canva.

Needs: a Postgres (`just db`), `node`, and `cargo build -p ft-cli --bin
firetower`. Override with FTDEMO_PORT, FTDEMO_MCP_PORT, FTDEMO_DB, FTDEMO_WORK.
"""

import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.environ.get("FTDEMO_PORT", "14911"))
MCP_PORT = int(os.environ.get("FTDEMO_MCP_PORT", "14913"))
DB = os.environ.get("FTDEMO_DB", "postgres://firetower:firetower@localhost:5433/ftdemo")
WORK = pathlib.Path(os.environ.get("FTDEMO_WORK", "/tmp/ftdemo"))
API = "http://127.0.0.1:%d/api/v1" % PORT
PASSWORD = "demo-connectors-2026"
ROOT = pathlib.Path(__file__).resolve().parent.parent

TOKEN = ""
CHILDREN = []


# ── saying things ────────────────────────────────────────────────────────


def say(what):
    print("\n\033[1m── %s\033[0m" % what)


def step(what):
    print("   \033[2m%s\033[0m" % what)


def out(what):
    print("      %s" % what)


def kv(key, value, width=22):
    print("        %s %s" % (key.ljust(width), value))


# ── talking to Firetower ─────────────────────────────────────────────────


def call(method, path, body=None, token=True, follow=True):
    """One request. Returns (status, parsed-or-text)."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(path if path.startswith("http") else API + path, data=data)
    request.get_method = lambda: method
    if data is not None:
        request.add_header("content-type", "application/json")
    if token and TOKEN:
        request.add_header("authorization", "Bearer " + TOKEN)

    opener = urllib.request.build_opener()
    if not follow:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None

        opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=40) as answer:
            text = answer.read().decode()
            return answer.status, try_json(text)
    except urllib.error.HTTPError as e:
        return e.code, try_json(e.read().decode())
    except Exception as e:  # noqa: BLE001 — a demo says what went wrong
        return 0, {"message": str(e)}


def try_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


def started(command, log, env=None):
    handle = open(log, "wb")
    child = subprocess.Popen(command, cwd=ROOT, stdout=handle, stderr=handle, env=env)
    CHILDREN.append(child)
    return child


def waited_for(url, seconds=45):
    for _ in range(seconds * 2):
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    return False


def port_is_taken(port):
    import socket
    with socket.socket() as probe:
        probe.settimeout(0.6)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def psql(statement):
    subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "firetower", "-d", "postgres",
         "-c", statement],
        cwd=ROOT, capture_output=True, text=True,
    )


# ── a Firetower, from an empty database ──────────────────────────────────


def a_control_plane():
    global TOKEN
    say("A control plane, from an empty database")
    WORK.mkdir(parents=True, exist_ok=True)
    key = WORK / "rootkey"
    if not key.exists():
        key.write_text(subprocess.run(["openssl", "rand", "-base64", "32"],
                                      capture_output=True, text=True).stdout.strip())
    home = WORK / "home"
    subprocess.run(["rm", "-rf", str(home)])
    home.mkdir(parents=True)

    env = dict(os.environ,
               FIRETOWER_ROOT_KEY=key.read_text().strip(),
               FIRETOWER_HOME=str(home),
               FIRETOWER_PORT=str(PORT),
               FIRETOWER_DEV="1",
               DATABASE_URL=DB,
               FIRETOWER_PUBLIC_URL="http://127.0.0.1:%d" % PORT)
    # **Anything already on this port goes first**, and if something that is
    # not ours is there, say so and stop.
    #
    # Both halves were learned the hard way. A previous run left orphaned
    # answers `/bootstrap` perfectly well while pointing at the database this
    # one just dropped — and then the sign-in fails against a database with
    # nobody in it. Worse, on a machine shared with other work, *somebody
    # else's* Firetower container had this port: the demo talked to theirs,
    # wrote the password into its own database, and reported a password
    # mismatch. A port check costs a line and that cost half an hour.
    subprocess.run(["pkill", "-f", "debug/firetower serve"], capture_output=True)
    subprocess.run(["pkill", "-f", "connectors-oauth-server"], capture_output=True)
    time.sleep(1)
    for port in (PORT, MCP_PORT):
        if port_is_taken(port):
            sys.exit("something is already listening on %d. Set FTDEMO_PORT and "
                     "FTDEMO_MCP_PORT to ports nothing else has." % port)

    # **After the servers are down, never before.** Postgres refuses to drop a
    # database something is connected to, and a previous run left running is
    # connected to it — so dropping first silently did nothing, and the demo
    # ran against a database that already had its own connectors in it and
    # refused every one of them as a duplicate.
    psql("DROP DATABASE IF EXISTS ftdemo;")
    psql("CREATE DATABASE ftdemo;")

    child = started(["./target/debug/firetower", "serve"], WORK / "server.log", env)
    if not waited_for(API + "/bootstrap") or child.poll() is not None:
        sys.exit("the control plane did not come up — see %s" % (WORK / "server.log"))

    subprocess.run(["./target/debug/firetower", "passwd", "admin"], cwd=ROOT,
                   input="%s\n%s\n" % (PASSWORD, PASSWORD), text=True,
                   capture_output=True, env=dict(os.environ, DATABASE_URL=DB))
    _, answer = call("POST", "/auth/login",
                     {"username": "admin", "password": PASSWORD}, token=False)
    if not isinstance(answer, dict) or "token" not in answer:
        sys.exit("could not sign in: %s" % answer)
    TOKEN = answer["token"]
    # Past the setup wizard, or every screen is the wizard. A demo that
    # photographs "Name this Firetower" is not a demo of connectors.
    call("POST", "/setup/organization", {"name": "Westlabs"})
    call("POST", "/setup/complete")

    _, library = call("GET", "/connectors")
    step("signed in · the library holds %d connectors" % len(library))


# ── demo 1 ───────────────────────────────────────────────────────────────


def demo_one():
    say("DEMO 1 · Google Drive, which needs no authentication (criteria 8, 13, 19)")

    step("Adding it by URL — two fields, a name and an address. No command field:")
    step("v1 is remote only, so nothing a connector brings runs on a machine.")
    code, made = call("POST", "/connectors", {
        "name": "Google Drive",
        "url": "https://drivemcp.googleapis.com/mcp/v1",
        "description": "Search, read and create files in Google Drive.",
    })
    if code != 201:
        out("FAILED: %s" % made.get("message"))
        return None
    probe = made["probed"]
    print()
    out("it answered the probe without a credential · signIn=%s" % made["signIn"])
    out("%s %s · MCP %s (Firetower asked for %s)"
        % (probe["serverName"], probe["serverVersion"], probe["protocolVersion"], probe["askedFor"]))
    out("%d tools, %d of them write — listed BEFORE connecting, which is criterion 13's"
        % (probe["toolCount"], probe["writeCount"]))
    out("first half: where a server answers a stranger, its tools are shown up front.")
    out("capabilities, recorded verbatim and not interpreted (18c): %s"
        % ", ".join(sorted(probe["capabilities"])))
    out("a client capability nobody can meet (18e): %s"
        % (probe["unmet"] or "none declared"))

    print()
    step("What it can do — read from the server, not from anything stored here")
    _, detail = call("GET", "/connectors/" + made["id"])
    for tool in detail["tools"]:
        kv("WRITE" if tool["writes"] else "read ",
           "%-24s %s" % (tool["name"], tool["description"].splitlines()[0][:46]), width=6)
    return made["id"]


def demo_one_refusals():
    say("Criterion 7 · an address that is not an MCP server fails at the form")
    for bad in [
        {"name": "Not a server", "url": "https://example.com/nope"},
        {"name": "Nowhere", "url": "https://mcp.does-not-exist-9f3a.invalid/mcp"},
        {"name": "Plain http", "url": "http://mcp.example.com/mcp"},
        {"name": "Token in the URL", "url": "https://mcp.example.com/mcp?api_key=sk-live-abc"},
    ]:
        code, answer = call("POST", "/connectors", bad)
        out(bad["url"])
        print("        ↳ %s" % (answer.get("message", "ADDED — which it should not have been")
                                if isinstance(answer, dict) else answer)[:112])
    print()
    _, library = call("GET", "/connectors")
    step("and nothing half-made was left behind: %s" % [c["name"] for c in library])


# ── demo 2a: Canva, live ─────────────────────────────────────────────────


def demo_two_canva():
    say("DEMO 2a · Canva, live — the discovery chain and the authorize request")
    code, made = call("POST", "/connectors", {
        "name": "Canva",
        "url": "https://mcp.canva.com/mcp",
        "description": "Read and edit designs, folders and brand templates.",
    })
    if code != 201:
        out("FAILED: %s" % made.get("message"))
        return
    probe = made["probed"]
    out("it refused the probe · signIn=%s · shape=%s" % (made["signIn"], probe["shape"]))
    out("and still published %d permissions, live, from %s"
        % (len(probe["scopes"]), probe["authority"]))
    out("tools: %d — it will not list them to a stranger" % probe["toolCount"])

    print()
    step("Criterion 10 · the scopes screen, fetched from the server when it opens")
    _, opening = call("GET", "/connectors/%s/scopes" % made["id"])
    out("from %s · no authorize URL yet (%s): step 1 only shows."
        % (opening["at"], opening["authorize"]))
    for scope in opening["scopes"]:
        print("        • %s" % scope)

    print()
    step("Criterion 9 · 401 → RFC 9728 → RFC 8414 → RFC 7591 → PKCE → the URL")
    _, leg = call("POST", "/connectors/%s/authorize" % made["id"])
    if not leg.get("authorize"):
        out("trouble: %s" % leg.get("trouble"))
        return
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(leg["authorize"]).query))
    out("consent screen at %s · this attempt expires %s" % (leg["at"], leg["expiresAt"]))
    for field in ("response_type", "client_id", "redirect_uri", "code_challenge_method", "resource"):
        kv(field, query.get(field))
    kv("code_challenge", query.get("code_challenge", "")[:20] + "…   S256")
    kv("state", query.get("state", "")[:14] + "…   single-use, 15 minutes")
    out("the client_id was registered with Canva a moment ago — RFC 7591, public,")
    out("no secret anywhere, because PKCE is what replaces one.")
    out("resource is the metadata's canonical identifier (RFC 8707, mandated by MCP).")
    out("code_verifier in the URL? %s  ← has to be False" % ("code_verifier" in query))


# ── demo 2b: OAuth end to end ────────────────────────────────────────────


def demo_two_whole():
    say("DEMO 2b · OAuth end to end (criteria 9, 10, 11, 12, 13, 20)")
    step("Starting a conformant authorization server. Its /authorize redirects")
    step("straight back with a code — the one step a person would otherwise do.")
    started(["node", "docs/connectors-oauth-server.mjs"], WORK / "oauth.log")
    if not waited_for("http://127.0.0.1:%d/.well-known/oauth-authorization-server" % MCP_PORT, 20):
        out("the demo server did not come up — see %s" % (WORK / "oauth.log"))
        return

    code, made = call("POST", "/connectors", {
        "name": "westlabs-internal",
        "url": "http://127.0.0.1:%d/mcp" % MCP_PORT,
        "description": "Deploy status, feature flags and the on-call rota.",
    })
    if code != 201:
        out("FAILED: %s" % made.get("message"))
        return
    probe = made["probed"]
    print()
    out("added · signIn=%s · shape=%s · connected=%s"
        % (made["signIn"], probe["shape"], made["connected"]))
    out("it publishes: %s" % ", ".join(probe["scopes"]))

    print()
    step("Following the authorize URL exactly as a browser does")
    _, leg = call("POST", "/connectors/%s/authorize" % made["id"])
    landed, page = call("GET", leg["authorize"], token=False)
    out("the browser ended on Firetower's own callback: %d" % landed)
    if isinstance(page, str):
        import re
        said = re.findall(r"<h1[^>]*>([^<]+)", page)
        out("the page says: %s" % (said[0] if said else "?"))

    print()
    step("Criterion 11 · the grant, in the vault, under this person")
    _, detail = call("GET", "/connectors/" + made["id"])
    out("connected=%s · expires %s · renewable=%s"
        % (detail["connected"], detail["expiresAt"], detail["renewable"]))
    out("and NOW it lists its tools — criterion 13's second half, the one that")
    out("needs a credential. The probe ran the moment the grant landed.")
    for tool in detail["tools"]:
        kv("WRITE" if tool["writes"] else "read ",
           "%-14s %s" % (tool["name"], tool["description"]), width=6)

    print()
    _, vault = call("GET", "/secrets")
    out("the vault holds:")
    for held in vault["held"]:
        if held["scope"].startswith("connector"):
            kv("%s/%s" % (held["scope"], held["name"]),
               "mine=%s · filed at %s" % (held["mine"], held["path"]), width=34)
    out("and every read is a line in the access log, written before the value")
    out("came back — never the value itself:")
    for entry in vault["access"]:
        if entry["scope"].startswith("connector"):
            kv(entry["at"][:19], "%-7s %s" % (entry["action"], entry["reason"]), width=20)

    print()
    step("Criterion 12 · and no route returns it, including the one that reveals")
    code, refusal = call("POST", "/secrets/connector/westlabs_internal/reveal")
    kv("connector/westlabs_internal", "%d — %s" % (code, refusal.get("message", "")[:70]), width=30)
    code, _ = call("POST", "/secrets/git/github/reveal")
    kv("git/github", "%d — the route still works for what it is for" % code, width=30)

    print()
    step("Criterion 20's last clause · a tool call returning real data, with the")
    step("token the exchange produced — the same bearer header the worker is sent.")
    access = last_token()
    if not access:
        out("could not read the issued token out of the demo server's log")
        return
    for tool in ("whoami", "oncall_rota"):
        answered = mcp_call(access, tool)
        kv(tool, answered, width=14)
    print()
    out("and the same call with no token, so it is clear the token is what opened it:")
    kv("whoami", mcp_call(None, "whoami"), width=14)
    return made["id"]


def last_token():
    """The token the exchange just produced, from the demo server.

    A demo affordance on that server and nothing else — no real authorization
    server hands a token back to a bystander. What it buys is the ability to
    make the tool call a session would make, with the credential Firetower
    actually obtained, from a script with no agent in it.
    """
    _, said = call("GET", "http://127.0.0.1:%d/demo/last-token" % MCP_PORT, token=False)
    return said.get("access_token") if isinstance(said, dict) else None


def mcp_call(access, tool):
    body = json.dumps({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                       "params": {"name": tool, "arguments": {}}}).encode()
    request = urllib.request.Request("http://127.0.0.1:%d/mcp" % MCP_PORT, data=body)
    request.add_header("content-type", "application/json")
    request.add_header("accept", "application/json, text/event-stream")
    if access:
        request.add_header("authorization", "Bearer " + access)
    try:
        with urllib.request.urlopen(request, timeout=20) as answer:
            said = json.loads(answer.read().decode())
            return said.get("result", {}).get("content", [{}])[0].get("text", said)
    except urllib.error.HTTPError as e:
        return "%d %s" % (e.code, e.read().decode()[:60])


# ── the library, afterwards ──────────────────────────────────────────────


def the_library():
    say("Criterion 17 · a connector with no grant of yours is shown, counted at zero")
    _, library = call("GET", "/connectors")
    for row in sorted(library, key=lambda c: c["name"]):
        kv(row["name"], "signIn=%-6s connected=%-5s onIn=%d"
           % (row["signIn"], row["connected"], row["onIn"]), width=20)
    print()
    out("Canva is in the library with no sign-in of this person's. A session that")
    out("turned it on would show it, count it at zero, and send nothing to the")
    out("worker — see `connectors::Connectors::for_session`, which is where that")
    out("is enforced rather than asked politely.")


def main():
    # **Not a `finally` that returns.** A `return` inside one discards whatever
    # exception was in flight, which is how a run that died in the first
    # function printed one cheerful line and exited zero.
    try:
        a_control_plane()
        demo_one()
        demo_one_refusals()
        demo_two_canva()
        demo_two_whole()
        the_library()
        say("Done. The control plane's log is at %s" % (WORK / "server.log"))
    except BaseException:
        for child in CHILDREN:
            child.terminate()
        raise

    # `FTDEMO_KEEP=1` leaves both servers up, which is what the screenshot
    # script needs: it photographs this control plane, with these real
    # connectors in it, rather than a mock agreeing with itself.
    if os.environ.get("FTDEMO_KEEP"):
        pathlib.Path(WORK / "token").write_text(TOKEN)
        print("\n   servers left running · TOKEN=$(cat %s)" % (WORK / "token"))
        return
    for child in CHILDREN:
        child.terminate()


if __name__ == "__main__":
    main()
