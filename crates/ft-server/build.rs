//! Make sure the interface's output directory exists before the crate compiles.
//!
//! `web.rs` embeds `web/out` at compile time, and a derive that names a missing
//! folder is a hard error — so a clone that has never run `pnpm build` would
//! fail to compile, which is not a reasonable thing to ask of somebody changing
//! Rust.
//!
//! A committed placeholder file was the first attempt and does not survive:
//! `next build` deletes `out/` before writing it, so the placeholder disappears
//! the first time anyone builds the interface, and the next `git add -A`
//! records the deletion. Creating the directory here cannot be undone by
//! anything, because it happens on the way into every build.
fn main() {
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/out");

    if let Err(e) = std::fs::create_dir_all(&out) {
        // Not fatal on its own: if the directory is missing *and* cannot be
        // created, the derive below will say so far more clearly than this can.
        println!("cargo:warning=could not create {}: {e}", out.display());
    }

    // Watch the directory itself, which does two things.
    //
    // A path that does not exist counts as changed, so deleting `web/out` —
    // `just reset`, a stray `rm`, a fresh clone — re-runs this and it comes
    // back. Watching `build.rs` instead would leave cargo believing the script
    // was still fresh and fail the build with a message about a derive.
    //
    // And it makes rebuilding the interface rebuild the binary that carries it.
    // The embed happens at compile time, so without this a `pnpm build` leaves
    // the old interface inside an otherwise up-to-date binary.
    println!("cargo:rerun-if-changed=../../web/out");
}
