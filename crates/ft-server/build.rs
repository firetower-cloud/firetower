//! Make sure both interface bundles' output directories exist before the crate
//! compiles.
//!
//! `web.rs` embeds `desktop/dist` and `web/out` at compile time, and a derive
//! that names a missing folder is a hard error — so a clone that has never
//! built the front ends would fail to compile, which is not a reasonable thing
//! to ask of somebody changing Rust.
//!
//! A committed placeholder file was the first attempt and does not survive:
//! `next build` deletes `out/` before writing it, and Vite empties `dist/` the
//! same way, so the placeholder disappears the first time anyone builds and the
//! next `git add -A` records the deletion. Creating the directories here cannot
//! be undone by anything, because it happens on the way into every build.
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

    // The application first, in the order `web.rs` embeds them.
    for bundle in ["../../desktop/dist", "../../web/out"] {
        let out = root.join(bundle);

        if let Err(e) = std::fs::create_dir_all(&out) {
            // Not fatal on its own: if the directory is missing *and* cannot be
            // created, the derive will say so far more clearly than this can.
            println!("cargo:warning=could not create {}: {e}", out.display());
        }

        // Watch the directory itself, which does two things.
        //
        // A path that does not exist counts as changed, so deleting a bundle —
        // `just reset`, a stray `rm`, a fresh clone — re-runs this and it comes
        // back. Watching `build.rs` instead would leave cargo believing the
        // script was still fresh and fail the build with a message about a
        // derive.
        //
        // And it makes rebuilding a front end rebuild the binary that carries
        // it. The embed happens at compile time, so without this a `pnpm build`
        // leaves the old interface inside an otherwise up-to-date binary.
        println!("cargo:rerun-if-changed={bundle}");
    }
}
