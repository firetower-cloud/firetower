# What is in here

Everything one run of [`../check.sh`](../check.sh) produced. Written by the
harness, read by [`../FINDINGS.md`](../FINDINGS.md). Regenerate the lot with
`../run.sh`; it overwrites rather than accumulates.

| | |
|---|---|
| `window-*.png` | the application's own window, cropped out of the root, so a blank *window* is distinguishable from a blank desktop |
| `window-default` / `-nodmabuf` / `-nodmabuf-softgl` / `-compositing-off` | the same build under the four renderer environments. They are identical, which is the finding |
| `window-gtk-light` / `window-gtk-dark` | the same build under the two GTK themes, which is what `prefers-color-scheme` answers from |
| `window-appimage` | the AppImage rather than the installed `.deb` — same build, different packaging, pixel-equivalent |
| `window-after-drag`, `window-resized` | the frameless window moved, and resized by the window manager |
| `connect-*.png` | the first-run flow, driven with `xdotool` against `scripts/mock-server.mjs` |
| `app-rail-*.png` | four rail destinations, named by the shortcut that reached them |
| `app-dark-after-restart.png` | the same application relaunched after signing in, on a box with no Secret Service. It is signed out |
| `root-empty-desktop.png` | the baseline: `mean=0 sd=0 colours=1`. This is what blank actually looks like |
| `probe-*.json` | what the webview said about itself from inside the real window — `*.json` is the page, `*-bridge.json` is the shell, `*-alive.json` is only "the script ran" |
| `facts.txt` | every measurement the run made, one per line |
| `Firetower.desktop` | the entry the `.deb` installs, as installed |
| `logs/` | the build and application transcripts, including `cargo-tree-linux.txt` |
