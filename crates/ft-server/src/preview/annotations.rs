//! HTML-only streaming instrumentation. No application files are changed and
//! neither API credentials nor a chat-writing capability enter the preview.
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use lol_html::{html_content::ContentType, HtmlRewriter};
use std::sync::{Arc, Mutex};

pub const RUNTIME_PATH: &str = "/__firetower/annotations.js";

pub fn runtime() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        include_str!("annotations.js"),
    )
        .into_response()
}

/// Asking for identity avoids changing the encoding of assets and needs no
/// full-response decompression buffer. Servers ignoring it remain plain previews.
pub fn eligible(headers: &HeaderMap) -> bool {
    let content = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    content
        .split(';')
        .next()
        .is_some_and(|s| s.trim() == "text/html")
        && (!content.contains("charset=")
            || content.contains("charset=utf-8")
            || content.contains("charset=\"utf-8\""))
        && headers
            .get(header::CONTENT_ENCODING)
            .is_none_or(|v| v == "identity")
        && !headers.contains_key(header::CONTENT_DISPOSITION)
}

/// Give just our bootstrap and styles a nonce. Existing CSP directives remain
/// enforced; in particular we do not weaken frame-src to embed the panel.
fn nonce_policy(policy: &str, nonce: &str) -> String {
    let default = policy
        .split(';')
        .map(str::trim)
        .find(|d| d.split_whitespace().next() == Some("default-src"))
        .map(|d| d.split_whitespace().skip(1).collect::<Vec<_>>().join(" "));
    let mut directives: Vec<String> = policy
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();
    for name in [
        "script-src",
        "script-src-elem",
        "style-src",
        "style-src-elem",
    ] {
        if let Some(d) = directives
            .iter_mut()
            .find(|d| d.split_whitespace().next() == Some(name))
        {
            // Adding a nonce disables unsafe-inline in CSP. Do not break an
            // application which intentionally allows inline scripts or styles.
            if d.split_whitespace().any(|s| s == "'unsafe-inline'")
                && !d.contains("'nonce-")
                && !d.contains("'sha")
            {
                continue;
            }
            // 'none' cannot be combined with source expressions.
            *d = d
                .split_whitespace()
                .filter(|s| *s != "'none'")
                .collect::<Vec<_>>()
                .join(" ");
            d.push_str(&format!(" 'nonce-{nonce}'"));
        } else if matches!(name, "script-src" | "style-src") {
            if let Some(default) = &default {
                let default = default
                    .split_whitespace()
                    .filter(|s| *s != "'none'")
                    .collect::<Vec<_>>()
                    .join(" ");
                if default.split_whitespace().any(|s| s == "'unsafe-inline'")
                    && !default.contains("'nonce-")
                    && !default.contains("'sha")
                {
                    directives.push(format!("{name} {default}"));
                } else {
                    directives.push(format!("{name} {default} 'nonce-{nonce}'"));
                }
            }
        }
    }
    directives.join("; ")
}

pub fn instrument(mut response: Response, session: &str, port: u16, ui: &str) -> Response {
    if !response.status().is_success() || !eligible(response.headers()) {
        return response;
    }
    let nonce = ulid::Ulid::new().to_string();
    // Session ids are encoded as JSON in a data attribute rather than executable
    // inline text. Escape it even though current session ids are generated.
    let session = session
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    let ui = ui
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    let script = format!(
        r#"<script nonce="{nonce}" src="{RUNTIME_PATH}" data-session="{session}" data-port="{port}" data-ui="{ui}" defer></script>"#
    );
    let policies: Vec<_> = response
        .headers()
        .get_all(header::CONTENT_SECURITY_POLICY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|p| nonce_policy(p, &nonce))
        .collect();
    response
        .headers_mut()
        .remove(header::CONTENT_SECURITY_POLICY);
    for p in policies {
        if let Ok(p) = HeaderValue::from_str(&p) {
            response
                .headers_mut()
                .append(header::CONTENT_SECURITY_POLICY, p);
        }
    }
    for h in [
        header::CONTENT_LENGTH,
        header::ETAG,
        header::LAST_MODIFIED,
        header::ACCEPT_RANGES,
    ] {
        response.headers_mut().remove(h);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let (parts, body) = response.into_parts();
    let (send, receive) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = output.clone();
        let nonce_for_meta = nonce.clone();
        let injected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let in_element = injected.clone();
        let fallback = script.clone();
        let settings = lol_html::send::Settings {
            element_content_handlers: vec![
                (
                    std::borrow::Cow::Owned("head, body".parse::<lol_html::Selector>().unwrap()),
                    lol_html::send::ElementContentHandlers::default().element(
                        move |el: &mut lol_html::send::Element| {
                            if !in_element.swap(true, std::sync::atomic::Ordering::Relaxed) {
                                el.prepend(&script, ContentType::Html);
                            }
                            Ok(())
                        },
                    ),
                ),
                (
                    std::borrow::Cow::Owned(
                        "meta[http-equiv]".parse::<lol_html::Selector>().unwrap(),
                    ),
                    lol_html::send::ElementContentHandlers::default().element(
                        move |el: &mut lol_html::send::Element| {
                            if el
                                .get_attribute("http-equiv")
                                .is_some_and(|s| s.eq_ignore_ascii_case("content-security-policy"))
                            {
                                if let Some(policy) = el.get_attribute("content") {
                                    el.set_attribute(
                                        "content",
                                        &nonce_policy(&policy, &nonce_for_meta),
                                    )?;
                                }
                            }
                            Ok(())
                        },
                    ),
                ),
            ],
            document_content_handlers: vec![lol_html::send::DocumentContentHandlers::default()
                .end(move |end: &mut lol_html::html_content::DocumentEnd| {
                    if !injected.load(std::sync::atomic::Ordering::Relaxed) {
                        end.append(&fallback, ContentType::Html);
                    }
                    Ok(())
                })],
            ..lol_html::send::Settings::new_send()
        };
        let mut rewriter = HtmlRewriter::new(settings, move |bytes: &[u8]| {
            sink.lock().unwrap().extend_from_slice(bytes)
        });
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let result = chunk
                .map_err(|e| e.to_string())
                .and_then(|bytes| rewriter.write(&bytes).map_err(|e| e.to_string()));
            if let Err(e) = result {
                let _ = send.send(Err(std::io::Error::other(e))).await;
                return;
            }
            let bytes = std::mem::take(&mut *output.lock().unwrap());
            if !bytes.is_empty() && send.send(Ok(Bytes::from(bytes))).await.is_err() {
                return;
            }
        }
        if let Err(e) = rewriter.end() {
            let _ = send.send(Err(std::io::Error::other(e.to_string()))).await;
            return;
        }
        let bytes = std::mem::take(&mut *output.lock().unwrap());
        if !bytes.is_empty() {
            let _ = send.send(Ok(Bytes::from(bytes))).await;
        }
    });
    Response::from_parts(
        parts,
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receive)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leaves_assets_and_compressed_bodies_alone() {
        let mut h = HeaderMap::new();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        assert!(!eligible(&h));
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        assert!(eligible(&h));
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        assert!(!eligible(&h));
    }
    #[test]
    fn preserves_csp_restrictions() {
        let p = nonce_policy(
            "default-src 'none'; frame-src 'none'; script-src 'self'; script-src-elem 'none'",
            "abc",
        );
        assert!(p.contains("frame-src 'none'"));
        assert!(p.contains("script-src 'self' 'nonce-abc'"));
        assert!(p.contains("script-src-elem 'nonce-abc'"));
        assert!(!p.contains("unsafe-inline"));
    }
    #[tokio::test]
    async fn rewrites_split_stream_and_preserves_doctype() {
        let body = Body::from_stream(futures::stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"<!DOCTYPE html><ht")),
            Ok(Bytes::from_static(
                b"ml><head><title>App</title></head><body>Hello</body></html>",
            )),
        ]));
        let response = Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CONTENT_LENGTH, "100")
            .header(header::ETAG, "old")
            .body(body)
            .unwrap();
        let response = instrument(response, "s_test", 3000, "http://localhost:3000");
        assert!(!response.headers().contains_key(header::CONTENT_LENGTH));
        assert!(!response.headers().contains_key(header::ETAG));
        let bytes = axum::body::to_bytes(response.into_body(), 10000)
            .await
            .unwrap();
        let html = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains(RUNTIME_PATH));
        assert!(html.contains("<body>Hello</body>"));
        assert_eq!(html.matches(RUNTIME_PATH).count(), 1);
    }
}
