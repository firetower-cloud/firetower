/**
 * Speaking to the picker Firetower injects into a published page.
 *
 * The runtime is already in every artifact the control plane serves — but it
 * refuses to switch on in a top-level document:
 *
 *     if (window.parent === window) return;      // annotations.js:10
 *
 * A `WKWebView` loads the page top-level, so on the phone the picker has
 * always been there and always been asleep. What wakes it is being in a frame
 * whose parent speaks for a panel: send `hello` from the embedder and the
 * runtime hides its own toolbar, its own panel iframe and its own fallback,
 * and lets the window around it draw all of that instead. That is how the
 * desktop does it, and it is why the phone can draw a native sheet rather
 * than embed somebody's 380px sidebar on a 466pt screen.
 *
 * The wrapper below is the frame. It is loaded with `baseUrl` set to the
 * control plane so that it has an `http:` origin of its own — the runtime
 * rejects a panel origin that is not http, https or tauri, and rejects one
 * equal to the artifact's. An artifact is served from a hostname of its own,
 * so those two are always different.
 */

/** Picker → panel. The nine the desktop bridge handles. */
export type FromPicker =
  | { type: "available" }
  | { type: "ready"; session?: string; channel?: string }
  | { type: "navigated"; path: string }
  | { type: "mode"; enabled: boolean }
  | { type: "selection"; label?: string; path?: string; text?: string; id?: string }
  | { type: "located"; id: string; found: boolean }
  | { type: "focus-note"; id: string }
  | { type: "found"; count?: number; index?: number }
  | { type: "find-bar"; open: boolean };

/** Panel → picker. Only what the phone has a use for. */
export type ToPicker =
  | { type: "mode"; enabled: boolean }
  | { type: "clear" }
  | { type: "reload" };

/**
 * The frame the artifact is embedded in.
 *
 * Deliberately tiny and deliberately dumb: it owns no state and makes no
 * decisions. Everything it hears from the picker it forwards to React Native,
 * and everything React Native says it forwards to the picker. The channel is
 * minted here because the runtime will not accept a panel that cannot name
 * one, and it never leaves this file.
 */
export function wrapper(url: string, ui: string): string {
  const src = `${url}${url.includes("#") ? "&" : "#"}__firetower_ui=${encodeURIComponent(ui)}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;height:100%;background:#0b0b0c;overflow:hidden}
iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body><iframe id="a" src="${src}" referrerpolicy="no-referrer"></iframe>
<script>
(function(){
  var frame = document.getElementById("a");
  var channel = "ft-" + Math.random().toString(36).slice(2);
  var origin = ${JSON.stringify(new URL(url).origin)};
  function up(m){ try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} }
  function down(m){ try { frame.contentWindow.postMessage(Object.assign({source:"firetower-panel",channel:channel}, m), origin); } catch (e) {} }
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || d.source !== "firetower-picker" || e.source !== frame.contentWindow) return;
    // \`available\` carries no channel: the page just loaded and wants a hello.
    if (d.type === "available") { down({type:"hello"}); return; }
    up(d);
  });
  // React Native speaks down this one.
  window.__ft = down;
  frame.addEventListener("load", function(){ down({type:"hello"}); });
})();
</script></body></html>`;
}
