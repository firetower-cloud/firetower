# Research: can an installed Tauri app read a different updater manifest at runtime?

Resolves [#413](https://github.com/firetower-cloud/firetower/issues/413) on the map [#407](https://github.com/firetower-cloud/firetower/issues/407). Throwaway branch — never merged.

## Resolved: yes, at runtime, from Rust only — and without a restart

**The answer is yes, and the mechanism is documented with this exact use case as its example.** `UpdaterBuilder::endpoints(Vec<Url>)` is public at `src/updater.rs:224`, and `UpdaterExt::updater_builder()` constructs a fresh builder with `endpoints: None` on **every call**, so endpoints are chosen per-`check()` from whatever the Rust code computes at that moment. No restart, no stale config. Tauri's own docs section "Runtime Configuration → Endpoints" gives:

```rust
let channel = if beta { "beta" } else { "stable" };
let update_url = format!("https://{channel}.myserver.com/{{{{target}}}}-{{{{arch}}}}/{{{{current_version}}}}");
let update = app.updater_builder().endpoints(vec![update_url])?.build()?.check().await?;
```

**But it is Rust-only, and that is deliberate.** `CheckOptions` in `@tauri-apps/plugin-updater@2.11.0` accepts exactly `headers`, `timeout`, `proxy`, `target` and `allowDowngrades` — **no `endpoints`**, confirmed on both sides of the IPC boundary (`src/commands.rs:42-50` declares the same five). The docs say why: *"For security reasons some APIs are only available for Rust."*

**What that costs Firetower, against the code as written.** `desktop/src/update.ts:88-89` does `const { check } = await import("@tauri-apps/plugin-updater"); const found = await check();` — the update path is entirely frontend today, and `desktop/src-tauri/src/main.rs:355` registers a bare `tauri_plugin_updater::Builder::new().build()`. So a channel switch means **the update path moves into the Rust shell**: a Firetower `#[tauri::command]` that reads the stored channel, calls `.endpoints(...)`, and re-exposes check/download/install to the interface. That is an architectural change, not a rebuild — and emphatically **not** a restart. Filed as its own ticket.

**`tauri.conf.json` barely changes.** `pubkey` is the one required field and is the single verification key for every endpoint and every platform — `verify_signature(&buffer, &self.signature, &self.context.config.pubkey)` at `src/updater.rs:740`, and `ReleaseManifestPlatform` has exactly `url` and `signature` with **no key material, no key id, no key hint**. So signing beta builds with the same minisign key is correct and needs no config change, which is what `desktop-release.yml` already does across all three platforms. `endpoints` is `#[serde(default)]` and therefore optional; a runtime call replaces it **wholesale**, not by merge or prepend.

### The two cheap-looking alternatives are both unsuitable

Worth recording so nobody re-proposes them:

- **A two-entry `["beta…", "stable…"]` array.** It *does* fall through on 404, so the shape mechanically works — but it is **one compiled constant shared by every copy**, so it cannot express a per-user opt-in at all, which is the whole requirement. Worse: a 2xx on endpoint 1 wins the loop unconditionally, so **a beta manifest lagging stable silently reports "no update"** to every opted-in user rather than falling back, stranding them until beta overtakes. And a `204` from the beta endpoint `return Ok(None)` immediately — stable is never consulted.
- **Overloading `{{target}}`.** It is the one JS-reachable way to vary the URL per copy (`check({ target })` → `builder.target(...)`), but it requires adding `{{target}}` to the compiled endpoint — a config change and a rebuild, so existing copies are not switchable anyway — and it hijacks the same string that keys the manifest's `platforms` map, forcing the channel into the platform matrix. `get_urls` short-circuits on a user-provided target and a miss is `Error::TargetNotFound`.

### Endpoint-array semantics, for whoever writes the manifests

Ordered fallback on *failure to produce a parseable manifest*, never on content. 2xx + parseable → stop. **204 → `return Ok(None)` immediately**, remaining endpoints never tried. 2xx + unparseable → continue. Non-2xx → continue, and notably does **not** set `last_error`. Transport error → continue, sets `last_error`. The docs' one-liner is *"Tauri will only continue to the next url if a non-2XX status code is returned!"*, which omits the parse-error and transport-error fallthroughs and the 204 short-circuit.

### No first-class channel exists — a clear negative

Nothing channel-related anywhere in the plugin or the manifest format at 2.11.0; `grep -rin 'channel'` finds only `std::sync::mpsc::channel` and the IPC progress `Channel`. The manifest's complete field set is `version` (alias `name`, `v` trimmed), `notes`, `pub_date` (RFC 3339 or it fails to deserialise), and then either `platforms` (static) or `url` + `signature` (dynamic). **Firetower's channel has to be entirely its own construct: a client-side preference plus a second manifest at a second URL.**

One adjacent fact worth keeping: unknown manifest fields are ignored by the deserialiser *and* the whole parsed body is retained as `raw_json`, forwarded to the frontend as `rawJson: Record<string, unknown>`. So a `channel` field can be added to a manifest and shown in the interface — but it is **purely informational**; the plugin will never act on it. That may be the cheapest way to answer "which channel is this copy on" in the UI.

### Placeholders, with a docs/source disagreement

Four exist in 2.11.0, not three: `{{current_version}}`, `{{target}}` (the **OS name only** — `linux`/`darwin`/`windows` — unless a custom target is set), `{{arch}}` (`i686`, `x86_64`, `armv7`, `aarch64`, `riscv64`), and **`{{bundle_type}}`** (`appimage`, `deb`, `rpm`, `app`, `msi`, `nsis`, or literal `unknown`). The docs list only the first three and never mention `{{bundle_type}}`; they also omit `riscv64` from `{{arch}}`. Believe the source, but treat `{{bundle_type}}` as the least safe to depend on since it is in neither the docs nor the CHANGELOG. *"Custom variables are not supported."*

### Provenance

Read from the crates.io 2.11.0 artifact matching `Cargo.lock`'s checksum, whose `.cargo_vcs_info.json` pins it to `tauri-apps/plugins-workspace` commit `6aa2854f314481a459be1189b02c65a2450789ab`, `path_in_vcs: plugins/updater`; and from `@tauri-apps/plugin-updater@2.11.0` via `npm pack` (the crate's `exclude` drops `/guest-js`, so the npm tarball is the authority for the JS side). Docs: https://v2.tauri.app/plugin/updater/, footer "Last Updated: Nov 28, 2025". Full note on the `research/tauri-updater-endpoints` branch.
