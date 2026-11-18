# Checking a download you installed by hand

Firetower verifies every **automatic** update before it installs it: the
updater fetches a manifest, downloads the bundle it names, and checks a
signature against a public key compiled into the application. Nothing in that
sequence trusts the network, and nobody has to remember to do it.

A bundle you download from the administration site's *Get the app* page and
open yourself gets none of that. That is the trade the manual install makes,
and it is the one thing it is worth doing by hand in exchange — most of all on
the beta route, where installing by hand once is the only way onto the channel
for a copy that predates it.

## What each platform does on its own

| | What checks it |
|---|---|
| **macOS** | The disk image is notarised. Gatekeeper checks it when you open it, and refuses it if it has been altered. Nothing else to do. |
| **Windows** | **The installer is not signed.** Windows will warn about an unrecognised application, and there is no publisher on it to recognise. See [#455](https://github.com/firetower-cloud/firetower/issues/455). |
| **Linux** | Nothing. An AppImage is a file with the executable bit set, and running it runs it. |

So on Windows and Linux there is nothing between the bytes GitHub served and
the application you are about to run — unless you check the signature below.

## The signature that is published, and the key it is made with

Every release carries a detached signature beside each updater bundle:

```
Firetower_0.30.0_x64-setup.exe        Firetower_0.30.0_x64-setup.exe.sig
Firetower_0.30.0_x64_en-US.msi        Firetower_0.30.0_x64_en-US.msi.sig
Firetower_0.30.0_amd64.AppImage       Firetower_0.30.0_amd64.AppImage.sig
Firetower_universal.app.tar.gz        Firetower_universal.app.tar.gz.sig
```

These are [minisign](https://jedisct1.github.io/minisign/) signatures, made
with the same key the updater checks — the one in
`desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, which is
that key base64-encoded a second time. Written out, it is:

```
RWQN3dDhlYmi8ewYeJJYCM5cBnPKJ1ldT1WOB9DXgB8lRC0w24UReAsL
```

The private half is a repository secret, referenced only by
`.github/workflows/desktop-release.yml`. So a signature that checks out
against the key above was made by a release of this project, and not by
whoever served you the file.

**The macOS `.dmg` has no `.sig`.** The signed macOS artifact is the
`.app.tar.gz`, which is what the updater installs; the disk image is the
human-facing installer and is notarised instead. On macOS, Gatekeeper is the
check.

## Checking one

[Install minisign](https://jedisct1.github.io/minisign/#installation) —
`brew install minisign` on a Mac, `apt install minisign` on Debian or Ubuntu,
a binary from that page on Windows — then, with the bundle and its `.sig` in
the same directory:

```sh
# The published .sig is base64; minisign wants the decoded form, named
# after the file it signs.
base64 --decode Firetower_0.30.0_amd64.AppImage.sig > Firetower_0.30.0_amd64.AppImage.minisig

minisign -Vm Firetower_0.30.0_amd64.AppImage \
  -P RWQN3dDhlYmi8ewYeJJYCM5cBnPKJ1ldT1WOB9DXgB8lRC0w24UReAsL
```

A good file reports that the signature and the comment signature were
verified, and prints the trusted comment. Anything else — a verification
failure, a missing file, a key mismatch — means do not run it, and say so on
an issue.

The decoded signature's trusted comment names the file it was made for, so a
signature lifted from a different bundle does not pass:

```
trusted comment: timestamp:1794739146	file:Firetower_0.30.0_x64-setup.exe
```

## Why there is no checksums file

A `SHA256SUMS` published on the same release as the bundle it describes proves
only that the two agree. Whoever was able to replace the bundle was able to
replace the digest beside it, and a reader who checks it comes away more
confident and no safer.

The separate signing key is the whole guarantee, which is why this page tells
you to check a signature rather than a hash.
