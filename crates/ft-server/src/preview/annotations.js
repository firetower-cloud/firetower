/* Firetower preview instrumentation. Runs in the application's origin, never
 * receives authentication, and sends only element context to a trusted panel. */
(() => {
  "use strict";
  if (window.__firetowerAnnotations) return;
  window.__firetowerAnnotations = true;
  const script = document.currentScript;
  const session = script.dataset.session;
  const port = Number(script.dataset.port);
  const nonce = script.nonce;
  const connectionKey = "firetower.annotation-ui";
  let uiOrigin = null;
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const supplied = fragment.get("__firetower_ui");
    const remembered = localStorage.getItem(connectionKey);
    const candidate = new URL(
      supplied || remembered || script.dataset.ui || "",
    );
    if (
      ["http:", "https:"].includes(candidate.protocol) &&
      candidate.origin !== location.origin
    ) {
      uiOrigin = candidate.origin;
      localStorage.setItem(connectionKey, uiOrigin);
    }
    if (supplied)
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
  } catch {
    /* A plain preview can still offer connection instructions. */
  }

  const host = document.createElement("div");
  host.id = "__firetower_annotations";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.nonce = nonce;
  style.textContent = `
    :host { all: initial; position:fixed; inset:0; z-index:2147483647; pointer-events:none; color-scheme:dark; }
    * { box-sizing:border-box; }
    .toolbar { position:fixed; bottom:16px; right:16px; pointer-events:auto; background:#1b1b1b; color:#eee; border:1px solid #555; border-radius:10px; padding:8px; font:13px system-ui; box-shadow:0 8px 30px #0006; max-width:calc(100vw - 24px); }
    button,input { font:inherit; } button { background:#333; color:#fff; border:1px solid #666; padding:8px 10px; border-radius:6px; cursor:pointer; } button:focus-visible,input:focus-visible { outline:2px solid #a3c4ff; outline-offset:2px; }
    input { width:220px; max-width:100%; padding:8px; } .hint { max-width:310px; line-height:1.5; margin:8px 0; }
    iframe { display:block; width:380px; max-width:calc(100vw - 44px); height:min(540px, calc(100dvh - 110px)); border:0; margin-top:8px; border-radius:6px; background:#171717; }
    .outline { position:fixed; border:2px solid #729fff; background:#729fff18; pointer-events:none; }
    .badge { position:fixed; background:#3667c8; color:white; padding:3px 7px; border-radius:10px; font:12px system-ui; pointer-events:auto; cursor:pointer; }
    [hidden] { display:none !important; }
  `;
  shadow.append(style);
  const outline = document.createElement("div");
  outline.className = "outline";
  outline.hidden = true;
  shadow.append(outline);
  const toolbar = document.createElement("section");
  toolbar.className = "toolbar";
  toolbar.setAttribute("aria-label", "Firetower preview feedback");
  shadow.append(toolbar);
  const toggle = document.createElement("button");
  toggle.textContent = "Firetower · Annotate";
  toolbar.append(toggle);
  const move = document.createElement("button");
  move.textContent = "Move left";
  toolbar.append(move);
  move.onclick = () => {
    const left = move.textContent === "Move left";
    toolbar.style.left = left ? "16px" : "auto";
    toolbar.style.right = left ? "auto" : "16px";
    move.textContent = left ? "Move right" : "Move left";
  };
  const collapse = document.createElement("button");
  collapse.textContent = "Hide panel";
  collapse.hidden = true;
  toolbar.append(collapse);
  const status = document.createElement("p");
  status.className = "hint";
  status.hidden = true;
  status.setAttribute("role", "status");
  toolbar.append(status);
  const frame = document.createElement("iframe");
  frame.title = "Firetower preview annotations";
  frame.hidden = true;
  // A trusted UI has its own origin and credentials. No sandbox with same-origin
  // removed: doing that would prevent it from authenticating to Firetower.
  frame.referrerPolicy = "no-referrer";
  toolbar.append(frame);
  const fallback = document.createElement("button");
  fallback.textContent = "Open feedback panel ↗";
  fallback.hidden = true;
  toolbar.append(fallback);
  document.documentElement.append(host);
  let panelWindow = null,
    channel = null,
    annotating = false,
    selected = null,
    hovered = null;
  let pins = [],
    pinNodes = [],
    expanded = false;
  let frameStarted = false,
    handshakeTimer = null;
  let lastPinPaint = 0;
  function tell(type, data = {}) {
    if (panelWindow && channel && uiOrigin)
      panelWindow.postMessage(
        { source: "firetower-picker", channel, type, ...data },
        uiOrigin,
      );
  }
  function panelURL() {
    const url = new URL("/preview-annotations", uiOrigin);
    url.search = new URLSearchParams({
      session,
      port: String(port),
      origin: location.origin,
    }).toString();
    return url.href;
  }
  function openPanel() {
    expanded = true;
    collapse.hidden = false;
    if (!uiOrigin) {
      status.hidden = false;
      status.textContent =
        "Connect this preview by entering your Firetower address, or open it from Firetower’s Preview screen.";
      if (!toolbar.querySelector("input")) {
        const input = document.createElement("input");
        input.type = "url";
        input.placeholder = "https://firetower.example.com";
        input.setAttribute("aria-label", "Firetower address");
        const connect = document.createElement("button");
        connect.textContent = "Connect";
        connect.onclick = () => {
          try {
            const u = new URL(input.value);
            if (
              !["http:", "https:"].includes(u.protocol) ||
              u.origin === location.origin
            )
              throw new Error();
            uiOrigin = u.origin;
            try {
              localStorage.setItem(connectionKey, uiOrigin);
            } catch {}
            input.remove();
            connect.remove();
            openPanel();
          } catch {
            status.textContent =
              "Enter the full HTTP or HTTPS address of your Firetower installation.";
          }
        };
        toolbar.append(input, connect);
      }
      return;
    }
    frame.hidden = false;
    fallback.hidden = false;
    if (!frameStarted) {
      frameStarted = true;
      frame.src = panelURL();
      status.hidden = false;
      status.textContent = "Connecting to Firetower…";
      handshakeTimer = setTimeout(() => {
        if (!channel)
          status.textContent =
            "If the panel is blocked by this app’s security policy or browser storage settings, open it in a separate window.";
      }, 6000);
    }
  }
  fallback.onclick = () => {
    const popup = window.open(
      panelURL(),
      "firetower-annotations-" + session,
      "popup,width=440,height=720",
    );
    if (!popup) {
      status.hidden = false;
      status.textContent = "Allow the feedback window to open, then try again.";
    } else panelWindow = popup;
  };
  function setMode(value) {
    annotating = value;
    hovered = null;
    toggle.textContent = value
      ? "● Annotating · Browse"
      : "Firetower · Annotate";
    toggle.setAttribute("aria-pressed", String(value));
    if (!value) selected = null;
    paint();
    tell("mode", { enabled: value });
  }
  toggle.onclick = () => {
    openPanel();
    setMode(!annotating);
  };
  collapse.onclick = () => {
    expanded = false;
    frame.hidden = true;
    fallback.hidden = true;
    collapse.hidden = true;
    status.hidden = true;
    setMode(false);
  };
  function descriptor(el) {
    if (!(el instanceof Element)) return "";
    const tag = el.localName;
    if (el.id) return tag + "#" + CSS.escape(el.id).slice(0, 150);
    const test = el.getAttribute("data-testid");
    if (test)
      return tag + '[data-testid="' + CSS.escape(test).slice(0, 150) + '"]';
    return (
      tag +
      Array.from(el.classList)
        .slice(0, 2)
        .map((c) => "." + CSS.escape(c).slice(0, 60))
        .join("")
    );
  }
  function selectorFor(el) {
    const segments = [];
    for (
      let current = el;
      current && segments.length < 10;
      current = current.parentElement
    ) {
      if (
        current.id &&
        document.querySelectorAll("#" + CSS.escape(current.id)).length === 1
      ) {
        segments.unshift("#" + CSS.escape(current.id));
        break;
      }
      let segment = current.localName;
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (e) => e.localName === current.localName,
          )
        : [];
      if (siblings.length > 1)
        segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      segments.unshift(segment);
    }
    return segments.join(" > ").slice(0, 2048);
  }
  function safeHTML(el) {
    let count = 0,
      truncated = false;
    const escape = (text) =>
      text.replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
    function visit(node, depth) {
      if (++count > 160 || depth > 8) {
        truncated = true;
        return "";
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent || "";
        if (t.length > 250) truncated = true;
        return escape(t.slice(0, 250));
      }
      if (
        !(node instanceof Element) ||
        node === host ||
        /^(script|style|noscript|template|meta|link)$/i.test(node.localName)
      )
        return "";
      const tag = node.localName;
      if (
        /^(input|textarea|select)$/i.test(tag) ||
        node.hasAttribute("contenteditable") ||
        node.matches("[data-private], [data-sensitive]")
      )
        return "<" + tag + ">[redacted]</" + tag + ">";
      const attrs = ["id", "class", "role", "aria-label", "data-testid"]
        .filter((a) => node.hasAttribute(a))
        .map(
          (a) =>
            " " + a + '="' + escape(node.getAttribute(a).slice(0, 200)) + '"',
        )
        .join("");
      let children = "";
      for (const child of node.childNodes) {
        if (count > 160 || children.length > 12000) {
          truncated = true;
          break;
        }
        children += visit(child, depth + 1);
      }
      return "<" + tag + attrs + ">" + children + "</" + tag + ">";
    }
    let html = visit(el, 0);
    // 3,500 UTF-16 code units fit in the server's 16KB UTF-8 budget.
    if (html.length > 3500) {
      html = html.slice(0, 3500) + "\n<!-- truncated -->";
      truncated = true;
    }
    return { html, truncated };
  }
  function snapshot(el) {
    const bounds = el.getBoundingClientRect();
    const ancestors = [];
    for (
      let p = el.parentElement;
      p && ancestors.length < 10;
      p = p.parentElement
    )
      ancestors.unshift(descriptor(p));
    return {
      path: location.pathname.slice(0, 2048),
      selector: selectorFor(el),
      ancestors,
      label: descriptor(el).slice(0, 400),
      ...safeHTML(el),
      capturedAt: new Date().toISOString(),
      viewport: [innerWidth, innerHeight],
      scroll: [scrollX, scrollY],
      bounds: [bounds.x, bounds.y, bounds.width, bounds.height],
    };
  }
  function select(el) {
    selected = el;
    hovered = null;
    openPanel();
    tell("selection", { snapshot: snapshot(el), parents: parentChoices(el) });
    paint();
  }
  function parentChoices(el) {
    const choices = [];
    for (
      let p = el.parentElement;
      p && choices.length < 10;
      p = p.parentElement
    )
      choices.push(descriptor(p));
    return choices;
  }
  function target(event) {
    return event.composedPath().find((e) => e instanceof Element && e !== host);
  }
  function ours(event) {
    return event.composedPath().includes(host);
  }
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!annotating || selected || ours(event)) return;
      hovered = target(event);
    },
    true,
  );
  for (const kind of [
    "pointerdown",
    "mousedown",
    "mouseup",
    "pointerup",
    "click",
    "dblclick",
    "contextmenu",
  ]) {
    document.addEventListener(
      kind,
      (event) => {
        if (!annotating || ours(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (kind === "click") {
          const el = target(event);
          if (el) select(el);
        }
      },
      true,
    );
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (!annotating || ours(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setMode(false);
      } else if (event.key === "ArrowUp" && selected?.parentElement) {
        event.preventDefault();
        select(selected.parentElement);
      } else if (event.key === "Enter" && event.target instanceof Element) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select(event.target);
      }
    },
    true,
  );
  function findPin(pin) {
    if (pin.path !== location.pathname) return null;
    try {
      const matches = document.querySelectorAll(pin.selector);
      return matches.length === 1 &&
        descriptor(matches[0]) === pin.label &&
        safeHTML(matches[0]).html === pin.html
        ? matches[0]
        : null;
    } catch {
      return null;
    }
  }
  function updatePins(next) {
    pinNodes.forEach((n) => n.remove());
    pins = next.slice(0, 100);
    pinNodes = pins.map((pin, index) => {
      const button = document.createElement("button");
      button.className = "badge";
      button.textContent = String(index + 1);
      button.setAttribute("aria-label", "Preview note " + (index + 1));
      button.onclick = () => {
        openPanel();
        tell("focus-note", { id: pin.id });
      };
      shadow.append(button);
      return button;
    });
    lastPinPaint = 0;
    paint();
  }
  function paint() {
    if (!host.isConnected) document.documentElement.append(host);
    const el = annotating ? selected || hovered : null;
    outline.hidden = !el?.isConnected;
    if (el?.isConnected) {
      const b = el.getBoundingClientRect();
      Object.assign(outline.style, {
        left: b.x + "px",
        top: b.y + "px",
        width: b.width + "px",
        height: b.height + "px",
      });
    }
    if (performance.now() - lastPinPaint < 250) return;
    lastPinPaint = performance.now();
    pins.forEach((pin, i) => {
      const el = findPin(pin);
      const b = el?.getBoundingClientRect();
      const node = pinNodes[i];
      node.hidden = !b || b.bottom < 0 || b.top > innerHeight;
      if (b) {
        node.style.left = Math.max(0, b.x - 8) + "px";
        node.style.top = Math.max(0, b.y - 8) + "px";
      }
    });
  }
  // Layout updates are capped instead of installing a mutation observer on every
  // React commit. Selection still follows scrolling, resizing and hot reload.
  setInterval(paint, 100);
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (
      event.origin === uiOrigin &&
      event.source === window.parent &&
      window.parent !== window &&
      data.source === "firetower-preview" &&
      data.type === "annotate"
    ) {
      openPanel();
      setMode(true);
      return;
    }
    if (
      event.origin !== uiOrigin ||
      (event.source !== frame.contentWindow && event.source !== panelWindow) ||
      data.source !== "firetower-panel"
    )
      return;
    if (data.type === "hello" && typeof data.channel === "string") {
      if (
        panelWindow &&
        panelWindow !== frame.contentWindow &&
        !panelWindow.closed &&
        event.source === frame.contentWindow
      )
        return;
      const newConnection =
        panelWindow !== event.source || channel !== data.channel;
      panelWindow = event.source;
      channel = data.channel;
      clearTimeout(handshakeTimer);
      status.hidden = true;
      tell("ready", { session, port, enabled: annotating });
      if (newConnection && selected?.isConnected)
        tell("selection", {
          snapshot: snapshot(selected),
          parents: parentChoices(selected),
        });
      return;
    }
    if (data.channel !== channel) return;
    if (data.type === "mode") setMode(data.enabled === true);
    if (data.type === "parent" && selected) {
      let p = selected;
      const steps = Math.min(10, Math.max(1, Number(data.steps) || 1));
      for (let i = 0; i < steps; i++) {
        if (p.parentElement) p = p.parentElement;
      }
      select(p);
    }
    if (data.type === "clear") {
      selected = null;
      hovered = null;
      paint();
    }
    if (data.type === "pins" && Array.isArray(data.pins)) updatePins(data.pins);
    if (data.type === "locate") {
      const pin = pins.find((p) => p.id === data.id);
      const el = pin && findPin(pin);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setMode(true);
        selected = el;
        paint();
      }
      tell("located", { id: data.id, found: !!el });
    }
  });
  // Advertise to an embedded PreviewTab, using the configured exact UI origin.
  if (uiOrigin && window.parent !== window)
    window.parent.postMessage(
      { source: "firetower-picker", type: "available" },
      uiOrigin,
    );
})();
