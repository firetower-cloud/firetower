"""Does dynamic registration actually work, or is it only advertised?

Exactly what `connectors::register` posts, to every entry in the catalogue.
This is the step the earlier probe skipped: it read `registration_endpoint`
out of the AS metadata and called that "one click".
"""
import json, ssl, pathlib, urllib.request, urllib.error
import concurrent.futures as cf

ctx = ssl.create_default_context()
UA = {"user-agent": "firetower-probe", "accept": "application/json, text/event-stream",
      "content-type": "application/json"}
REDIRECT = "http://127.0.0.1:14400/api/v1/connectors/callback"
REPO = pathlib.Path("/Users/kevinpiacentini/.firetower/worker/worktrees/agent-plguins-ze1b6r8z/firetower-marketplace")

def get(u, t=15):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=t, context=ctx) as f:
            return json.load(f)
    except Exception:
        return None

def hit401(url):
    try:
        r = urllib.request.Request(url, data=b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', headers=UA)
        urllib.request.urlopen(r, timeout=15, context=ctx)
        return ""
    except urllib.error.HTTPError as e:
        return e.headers.get("www-authenticate", "") or ""
    except Exception:
        return ""

def inserted(iss, leaf):
    sch, rest = iss.split("://"); host, _, path = rest.partition("/")
    return f"https://{host}/.well-known/{leaf}/{path}" if path else f"https://{host}/.well-known/{leaf}"

def discover(url):
    hdr = hit401(url)
    pr = None
    if "resource_metadata=" in hdr:
        pr = get(hdr.split('resource_metadata="', 1)[1].split('"', 1)[0])
    if not pr:
        sch, rest = url.split("://"); host, _, path = rest.partition("/")
        pr = get(f"https://{host}/.well-known/oauth-protected-resource/{path.strip('/')}") \
             or get(f"https://{host}/.well-known/oauth-protected-resource")
    if not pr:
        return None, "no RFC 9728"
    iss = (pr.get("authorization_servers") or [""])[0].rstrip("/")
    if not iss:
        return None, "no auth server"
    asm = None
    for cand in (inserted(iss, "oauth-authorization-server"),
                 f"{iss}/.well-known/oauth-authorization-server",
                 inserted(iss, "openid-configuration"),
                 f"{iss}/.well-known/openid-configuration"):
        asm = get(cand)
        if asm:
            break
    if not asm:
        return None, "no AS metadata"
    return asm.get("registration_endpoint") or "", ""

def register(at):
    body = json.dumps({
        "client_name": "Firetower",
        "redirect_uris": [REDIRECT],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    }).encode()
    try:
        r = urllib.request.Request(at, data=body, headers=UA, method="POST")
        with urllib.request.urlopen(r, timeout=25, context=ctx) as f:
            out = json.load(f)
            return ("REGISTERS", "") if out.get("client_id") else ("no client_id", str(out)[:60])
    except urllib.error.HTTPError as e:
        return (f"REFUSES {e.code}", (e.read(300).decode('utf8','replace') or '').strip()[:90])
    except Exception as e:
        return ("unreachable", str(e)[:70])

def one(d):
    slug = d.name
    doc = json.loads((d / ".mcp.json").read_text())
    url = next(iter(doc["mcpServers"].values()))["url"]
    at, why = discover(url)
    if at is None:
        return slug, "NO DISCOVERY", why, ""
    if not at:
        return slug, "needs a client id", "advertises no registration endpoint", ""
    verdict, detail = register(at)
    return slug, verdict, detail, at

dirs = sorted(p for p in (REPO / "mcp").iterdir() if p.is_dir())
with cf.ThreadPoolExecutor(10) as ex:
    rows = list(ex.map(one, dirs))

rows.sort(key=lambda r: (not r[1].startswith("REFUSES"), r[1], r[0]))
for slug, verdict, detail, at in rows:
    print(f"{slug:<15} {verdict:<18} {detail[:80]}")
ok = sum(1 for r in rows if r[1] == "REGISTERS")
print(f"\n{ok} of {len(rows)} actually register. Problems:")
for slug, verdict, detail, at in rows:
    if verdict != "REGISTERS":
        print(f"  {slug:<15} {verdict:<18} {at}")
json.dump([{"slug": r[0], "verdict": r[1], "detail": r[2], "at": r[3]} for r in rows],
          open("/tmp/dcr.json", "w"), indent=1)
