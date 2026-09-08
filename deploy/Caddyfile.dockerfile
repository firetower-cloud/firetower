# The Caddy that the `tls` profile runs, with one DNS provider compiled in.
#
# Caddy resolves DNS providers as compiled-in modules, and `caddy:2-alpine`
# ships none of them. Obtaining a certificate over DNS-01 — the only challenge
# that needs no inbound path to this machine, and the only one that can issue
# a wildcard — therefore needs a Caddy built with the module for whatever your
# domain's DNS is behind. That is all this file does: add one module to the
# stock Caddy, and keep the stock image underneath it.
#
# Nothing here runs on the default install. The `caddy` service is behind the
# `tls` profile, so `docker compose -f firetower.yml up -d` creates no proxy
# and builds no image; shape 1 is untouched by all of this.
#
# **The first build is slow, and that is the whole cost of this approach.** It
# pulls `caddy:2-builder` — a Go toolchain, around 390 MB against the 89 MB of
# the image it produces — and compiles Caddy from source: a few minutes, once.
# It is cached afterwards, so later `up -d --build` runs are immediate until
# DNS_MODULE or DNS_MODULE_VERSION changes.
#
# **It needs the network at install time**, and specifically a working Go
# module proxy. A machine that cannot reach proxy.golang.org cannot build
# this — and a machine in that state generally cannot reach GitHub either, so
# it is the same machine that falls back to a pinned CLI release.
#
# DNS_PROVIDER=none skips the compile but not the pull: the builder image is
# still fetched, because the stage below is what the final image copies from
# either way. So an air-gapped machine has one more image to load by hand than
# it used to, on top of the ones it was already loading. Everything else about
# that path is unchanged — supply your own certificate, and uncomment the
# `tls` line in the Caddyfile.

# Which provider module to compile in, as Compose passes it from DNS_PROVIDER:
#
#   cloudflare                    →  github.com/caddy-dns/cloudflare
#   github.com/libdns/something   →  taken as written, for a module that does
#                                    not live under caddy-dns
#   none                          →  no module; the stock Caddy, for the
#                                    bring-your-own-certificate path
ARG DNS_MODULE

# Which version of it, and empty is a real answer with a real cost: the build
# takes whatever the module's default branch is on the day it runs, so the
# same .env a month apart is not the same binary. Pin it — `v1.1.0`, or a
# commit — if you would rather two installs match.
ARG DNS_MODULE_VERSION

# A Go module to substitute while building, `old=new@version`.
#
# The escape hatch for building from source, which is that a provider module can
# be broken by something it depends on rather than by anything in it. A caddy-dns
# module pinning a `libdns/*` from before the v1 `Record` interface does not
# compile against a current Caddy at all, and until its maintainer tags a
# release there is otherwise nothing an operator can do but wait.
#
#     DNS_MODULE_REPLACE=github.com/libdns/vercel=github.com/libdns/vercel@v0.1.0
#
# Passed straight to `xcaddy --replace`. Nothing validates it: a wrong value
# fails the build, which is the same place a missing one fails.
ARG DNS_MODULE_REPLACE

# Where `none` gets a Caddy from. `caddy:2-builder` carries the Go toolchain
# and xcaddy but no caddy binary of its own, so without this stage the
# no-module path would have to compile a stock Caddy to produce a file that
# already exists one line below.
FROM caddy:2-alpine AS stock

FROM caddy:2-builder AS builder

# Re-declared because a global ARG is not in scope inside a stage. Leaving
# these out does not fail the build — it substitutes an empty string, and the
# image comes out with no module and no complaint.
ARG DNS_MODULE
ARG DNS_MODULE_VERSION
ARG DNS_MODULE_REPLACE

COPY --from=stock /usr/bin/caddy /usr/bin/caddy

# xcaddy writes ./caddy, and this image's WORKDIR is /usr/bin — so a build
# replaces the binary copied in above, and `none` leaves it as it is.
#
# The Caddy version is not chosen here. `caddy:2-builder` sets CADDY_VERSION,
# xcaddy honours it, and it is the same version as the `caddy:2-alpine` this
# ends up on top of. Keep those two tags in step.
RUN set -eu; \
	case "${DNS_MODULE}" in \
	"" | none) \
		echo "DNS_PROVIDER=none — keeping the stock Caddy, with no DNS provider."; \
		exit 0 ;; \
	*/*) module="${DNS_MODULE}" ;; \
	*) module="github.com/caddy-dns/${DNS_MODULE}" ;; \
	esac; \
	if [ -n "${DNS_MODULE_REPLACE:-}" ]; then \
		set -- --replace "${DNS_MODULE_REPLACE}"; \
	else \
		set --; \
	fi; \
	xcaddy build --with "${module}${DNS_MODULE_VERSION:+@${DNS_MODULE_VERSION}}" "$@"

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Where "you have not set DOMAIN" is caught, and the reason it is caught here
# rather than in firetower.yml.
#
# The obvious place is a Compose `${DOMAIN:?...}` guard, and that is what the
# `tls` service used to carry. It cannot stay there: Compose interpolates
# every service in the file before it works out which profiles are on, so a
# required-variable guard inside a profile fires even when that profile is
# off. One `${DOMAIN:?}` on this container is enough to stop
# `docker compose up -d` on the default install — the one that never creates
# this container at all. `--profile` does not change it, and neither does the
# no-colon `${DOMAIN?}` form; both were checked.
#
# So the values arrive with empty defaults and are checked here instead, which
# runs only when this container does — that is, only with the profile on. The
# message is better for it, too: it names everything that is missing at once
# rather than the first one Compose happened to interpolate.
COPY <<'SCRIPT' /usr/local/bin/firetower-caddy-preflight
#!/bin/sh
# Refuse a half-configured `tls` profile, rather than starting and serving
# something that cannot work. See firetower.yml and .env.example.
set -eu

# What is required is read out of the Caddyfile rather than assumed, because
# only the Caddyfile knows. Three shapes run through this same image:
#
#   * one token          `dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}`
#   * a provider block   `dns {$DNS_PROVIDER} { … }` — route53, Azure and the
#                        rest, which take several values and no single token
#   * your own cert      the `dns` line commented out entirely
#
# Demanding DNS_API_TOKEN of the second two would refuse a correct deployment,
# and the earlier version of this did exactly that. Asking the file keeps the
# question and the answer in the same place.
CADDYFILE=/etc/caddy/Caddyfile
uses() { grep -q "$1" "$CADDYFILE" 2>/dev/null; }

missing=""
uses '{\$DOMAIN}' && [ -z "${DOMAIN:-}" ] && missing="${missing}
  DOMAIN         the name this answers for, e.g. firetower.example.com"
uses '{\$DNS_PROVIDER}' && [ -z "${DNS_PROVIDER:-}" ] && missing="${missing}
  DNS_PROVIDER   the github.com/caddy-dns module for your DNS, e.g.
                 cloudflare — or \`none\` if you supply your own certificate"
uses 'env\.DNS_API_TOKEN' && [ -z "${DNS_API_TOKEN:-}" ] && missing="${missing}
  DNS_API_TOKEN  a credential for that provider's API"

# `set -eu` would end the script on the last `uses` returning false.
true

if [ -n "$missing" ]; then
	cat >&2 <<MESSAGE
Firetower's \`tls\` profile is on, and this is not set in .env:
${missing}

Caddy obtains the certificate itself over DNS-01 and needs those to do it.
Set them beside firetower.yml and start again with:

  docker compose -f firetower.yml up -d

Turning the profile off — removing COMPOSE_PROFILES=tls — goes back to
reaching Firetower over an ssh tunnel, which needs none of this.
MESSAGE
	exit 1
fi

# Nothing to run means the CMD went missing — see the note by ENTRYPOINT.
# Without this the script would simply end, successfully, having started no
# Caddy at all.
if [ "$#" -eq 0 ]; then
	echo "firetower: no command to run — the image is built wrong." >&2
	exit 1
fi

exec "$@"
SCRIPT
RUN chmod +x /usr/local/bin/firetower-caddy-preflight

# The base image has no entrypoint and puts the whole command in CMD — and
# setting an ENTRYPOINT here resets that CMD to null, so it has to be written
# out again. Leaving it off is not an error anybody sees: the entrypoint gets
# no arguments, `exec "$@"` execs nothing, the script falls off the end with
# status 0, and `restart: unless-stopped` turns that into a container that
# restarts for ever, logs not one line, and never starts Caddy.
#
# Keep this in step with `caddy:2-alpine`'s own CMD if upstream changes it.
ENTRYPOINT ["/usr/local/bin/firetower-caddy-preflight"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
