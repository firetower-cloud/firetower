//! Writes the API contract the typed client is generated from.
//!
//! Run by `just gen`, which then hands the document to the client generator.

use utoipa::OpenApi;

fn main() -> anyhow::Result<()> {
    let doc = ft_server::ApiDoc::openapi();
    let (_, api) = ft_server::api::router().split_for_parts();

    // Merge the paths discovered from the handlers into the document.
    let mut merged = doc;
    merged.paths = api.paths;
    if let Some(components) = api.components {
        match merged.components.as_mut() {
            Some(existing) => existing.schemas.extend(components.schemas),
            None => merged.components = Some(components),
        }
    }

    let json = merged.to_pretty_json()?;
    std::fs::create_dir_all("api")?;
    std::fs::write("api/openapi.json", &json)?;
    println!("api/openapi.json · {} bytes", json.len());
    Ok(())
}
