/* Firetower preview instrumentation. Runs in the application's origin, never
 * receives authentication, and sends only element context to a trusted panel. */
(() => {
  "use strict";
  if (window.__firetowerAnnotations) return;
  window.__firetowerAnnotations = true;
  // The panel is the window this preview is embedded in — the desktop app.
  // In a browser tab of its own there is no panel to talk to, and the page
  // is simply the page.
  if (window.parent === window) return;
  const script = document.currentScript;
  const session = script.dataset.session;
  // A preview carries a port; an artifact carries a version id. Exactly one
  // of the two is present, and whichever it is travels with every message.
  const port = script.dataset.port ? Number(script.dataset.port) : null;
  const artifact = script.dataset.artifact || null;
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
    // A desktop client embeds the preview from an origin of its own scheme,
    // whose `origin` the URL parser reports as "null" — so it is rebuilt.
    const origin =
      candidate.protocol === "tauri:"
        ? "tauri://" + candidate.host
        : candidate.origin;
    if (
      ["http:", "https:", "tauri:"].includes(candidate.protocol) &&
      origin !== location.origin
    ) {
      uiOrigin = origin;
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
  // Where the page is, for the panel's address bar — a frame's location is
  // not readable from outside its origin, so the page says. Client-side
  // routers move without loading, so history is watched as well as popstate.
  function here() {
    // Without the fragment that named the interface — that is ours, not the page's.
    const fragment = new URLSearchParams(location.hash.slice(1));
    fragment.delete("__firetower_ui");
    const hash = fragment.toString();
    return (location.pathname + location.search + (hash ? "#" + hash : "")).slice(0, 2048);
  }
  function moved() {
    tell("navigated", { path: here() });
  }
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(moved);
      return result;
    };
  }
  window.addEventListener("popstate", moved);
  window.addEventListener("hashchange", moved);

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
  /* The handle of the layout-following timer, or null while it is not
     running. Declared with the rest of the state rather than beside `follow`
     so that an early `setMode` cannot reach it in its dead zone. */
  let following = null;
  function tell(type, data = {}) {
    if (panelWindow && channel && uiOrigin)
      panelWindow.postMessage(
        { source: "firetower-picker", channel, type, ...data },
        uiOrigin,
      );
  }
  function panelURL() {
    const url = new URL("/preview-annotations", uiOrigin);
    url.search = new URLSearchParams(
      artifact
        ? { session, artifact, origin: location.origin }
        : { session, port: String(port), origin: location.origin },
    ).toString();
    return url.href;
  }
  function openPanel() {
    expanded = true;
    // The window this preview sits in is the panel — a desktop client draws
    // its own — so there is nothing to embed here.
    if (panelWindow && panelWindow === window.parent) return;
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
    follow();
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
  // `point` is where the pointer was, in this page's viewport. The panel puts
  // its card there — an element taller than the view has no on-screen edge to
  // hang it off, but the click that chose it is always somewhere visible.
  function select(el, point) {
    selected = el;
    hovered = null;
    openPanel();
    tell("selection", { snapshot: snapshot(el), parents: parentChoices(el), point });
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
          if (el) select(el, [event.clientX, event.clientY]);
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
    follow();
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
  //
  // **Only while there is something drawn to follow.** `paint` calls
  // `getBoundingClientRect`, which forces a synchronous layout, and this
  // runtime is injected into every HTML response from an artifact origin —
  // including the thumbnail of every tile in the library and every card in the
  // transcript. Those frames can never be annotated and never have a pin, so
  // the timer there was ten forced layouts a second, per tile, for the life of
  // the window, to move an outline nobody had asked for. Unconditionally
  // installing it was most of why the client felt heavy.
  //
  // `annotating` changes only in `setMode` and `pins` only in `updatePins`, so
  // those two are the whole of the transition and both already end in `paint`.
  function follow() {
    const wanted = annotating || pins.length > 0;
    if (wanted && !following) following = setInterval(paint, 100);
    else if (!wanted && following) {
      clearInterval(following);
      following = null;
    }
  }
  // ── Find in the page ─────────────────────────────────────────────
  //
  // ⌘F, for a document in a frame. The window around the page is another
  // origin and cannot read a word of it, so the search runs here and only
  // what was found travels back: how many, and which one is lit. The desktop
  // client draws the bar and sends the query; this is the half that has the
  // text.
  //
  // Same shape as the client's own find in the conversation
  // (`desktop/src/ui/FindInChat.tsx`), for the same reasons. Matches are
  // painted with the Custom Highlight API — ranges, which own no DOM — so a
  // page whose script is still drawing is never handed an element it did not
  // make. Where the API is missing the current match is selected instead.
  // One text node at a time, so a phrase split across an inline element is
  // not found; that is the price of never touching the tree.
  const FIND_ALL = "__firetower-find";
  const FIND_ON = "__firetower-find-on";
  // Past this the answer is a longer query rather than more highlights. The
  // same number the client's bar prints as `600+`.
  const FIND_CAP = 600;
  let findQuery = "",
    findFound = [],
    findAt = 0,
    findWatch = null,
    findAgain = null,
    findStyled = false;
  // Where `needle` sits in `hay`, case-insensitively: the start of each
  // non-overlapping match. Plain text, not a pattern — somebody looking for
  // `total(net)` means those ten characters.
  function hits(hay, needle) {
    const a = hay.toLowerCase();
    const b = needle.toLowerCase();
    const found = [];
    for (let at = a.indexOf(b); at !== -1; at = a.indexOf(b, at + b.length))
      found.push(at);
    return found;
  }
  function findRanges(needle) {
    const found = [];
    if (!needle || !document.body) return found;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Script and style text is in the tree and not on the page. A page
        // that inlines a chart library would fill the cap with its source
        // before a single visible word was reached.
        const parent = node.parentElement;
        return parent &&
          !/^(script|style|noscript|template)$/i.test(parent.localName)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    for (
      let node = walk.nextNode();
      node && found.length < FIND_CAP;
      node = walk.nextNode()
    ) {
      for (const at of hits(node.nodeValue || "", needle)) {
        if (found.length >= FIND_CAP) break;
        const span = document.createRange();
        span.setStart(node, at);
        span.setEnd(node, at + needle.length);
        // Text the page has hidden — a closed tab, a collapsed section — is
        // nothing a person can be shown, so it is not counted either. The
        // browser's own find bar draws the same line.
        if (span.getClientRects().length > 0) found.push(span);
      }
    }
    return found;
  }
  function findStyle() {
    if (findStyled) return;
    findStyled = true;
    // Into the document rather than the shadow root: a highlight pseudo is
    // styled from the tree its text is in. The picker's own blue, so a match
    // reads as Firetower pointing at something and not as the page's
    // emphasis — translucent for the many, so the text keeps its colour, and
    // solid for the one you are on, with the text forced dark so it stays
    // readable whatever the page set.
    const sheet = document.createElement("style");
    sheet.nonce = nonce;
    sheet.textContent =
      "::highlight(" + FIND_ALL + "){background-color:rgba(114,159,255,.35)}" +
      "::highlight(" + FIND_ON + "){background-color:#729fff;color:#0b0b0c}";
    (document.head || document.documentElement).append(sheet);
  }
  function findPaint() {
    if (window.CSS && CSS.highlights && window.Highlight) {
      if (findFound.length === 0) {
        CSS.highlights.delete(FIND_ALL);
        CSS.highlights.delete(FIND_ON);
        return;
      }
      findStyle();
      CSS.highlights.set(FIND_ALL, new Highlight(...findFound));
      // Above the rest, whatever order the registry ended up in.
      const one = new Highlight(findFound[findAt]);
      one.priority = 1;
      CSS.highlights.set(FIND_ON, one);
      return;
    }
    const sel = getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    if (findFound[findAt]) sel.addRange(findFound[findAt].cloneRange());
  }
  // Bring the current match into view, and only when it is not already
  // there — a bar that scrolls on every keystroke twitches the page under a
  // word you can already see. Into the upper third rather than the middle,
  // because what you are reading is usually the line after the one you
  // searched for.
  function findShow() {
    const span = findFound[findAt];
    if (!span) return;
    const spot = span.getBoundingClientRect();
    // Zero on both edges means the text has left the document.
    if (spot.width === 0 && spot.height === 0) return;
    const room = innerHeight * 0.2;
    if (spot.top >= room && spot.bottom <= innerHeight - room) return;
    // A page may scroll inside an element rather than as a window — a
    // dashboard with panes of its own — so the element the match is in goes
    // first, through every scroller between it and here, and the window is
    // then adjusted so the line itself sits where it should. Instant on both
    // counts: a page that asked for smooth scrolling would otherwise still be
    // animating the first move while the second measured where it had got to.
    span.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "instant",
    });
    const again = span.getBoundingClientRect();
    scrollBy({ top: again.top - innerHeight / 3, behavior: "instant" });
  }
  // `scroll` is false when the page moved on its own: a dashboard with a
  // clock in it redraws every second, and a bar that dragged you back to the
  // match each time would make the rest of the page unreadable while it was
  // open. Only a key you pressed moves the view.
  function findLook(scroll) {
    findFound = findRanges(findQuery);
    findAt = Math.min(findAt, Math.max(findFound.length - 1, 0));
    findPaint();
    if (scroll) findShow();
    tell("found", { count: findFound.length, at: findAt });
  }
  // The page is live. A script still drawing replaces the very text nodes
  // these ranges point at, and a stale range paints nothing — so the search
  // is re-run once the writing settles. Watched only while there is a query,
  // for the same reason `follow` only runs while there is something drawn.
  function findWatching(wanted) {
    if (wanted && !findWatch) {
      findWatch = new MutationObserver(() => {
        clearTimeout(findAgain);
        findAgain = setTimeout(() => findLook(false), 250);
      });
      findWatch.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } else if (!wanted && findWatch) {
      findWatch.disconnect();
      findWatch = null;
      clearTimeout(findAgain);
    }
  }
  // ⌘F pressed in the page — which is where focus is after clicking or
  // scrolling it, and a key pressed in a frame never reaches the window
  // around it. The bar is the panel's to draw; this only says the key was
  // pressed, and swallows it so nothing else answers. Only when that window
  // *is* the panel: anywhere else the browser's own find bar is the right
  // answer and is left alone. Escape with a search painted closes it, for the
  // same reason — the bar is in the other window and the key is in this one.
  document.addEventListener(
    "keydown",
    (event) => {
      if (ours(event) || !panelWindow || panelWindow !== window.parent) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        tell("find-bar", { open: true });
      } else if (event.key === "Escape" && findQuery && !annotating) {
        // Only when there is nothing more urgent for Escape to do. Annotating
        // has its own Escape — leaving the mode — and that wins, so one press
        // undoes one thing and a second press then closes the search.
        tell("find-bar", { open: false });
      }
    },
    true,
  );
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
    // The panel is the iframe this script opened, a popup it opened, or the
    // window the preview is embedded in — when that window is the configured
    // interface, which is how a desktop client takes the panel's place.
    const embedder = window.parent !== window && event.source === window.parent;
    if (
      event.origin !== uiOrigin ||
      (event.source !== frame.contentWindow &&
        event.source !== panelWindow &&
        !embedder) ||
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
      if (embedder) {
        // Nothing of the script's own panel is wanted any more, and the
        // toolbar's toggle is drawn by the window around the preview.
        frame.hidden = true;
        fallback.hidden = true;
        collapse.hidden = true;
        toolbar.hidden = true;
      }
      const newConnection =
        panelWindow !== event.source || channel !== data.channel;
      panelWindow = event.source;
      channel = data.channel;
      clearTimeout(handshakeTimer);
      status.hidden = true;
      // `find: true` is what lets a client tell this runtime from an older
      // one that would ignore a search, and say so rather than draw a bar
      // that answers nothing.
      tell("ready", {
        session,
        port,
        artifact,
        enabled: annotating,
        path: here(),
        find: true,
      });
      if (newConnection && selected?.isConnected)
        tell("selection", {
          snapshot: snapshot(selected),
          parents: parentChoices(selected),
        });
      return;
    }
    if (data.channel !== channel) return;
    if (data.type === "mode") setMode(data.enabled === true);
    if (data.type === "go") history.go(Math.max(-10, Math.min(10, Number(data.delta) || 0)));
    if (data.type === "reload") location.reload();
    if (
      data.type === "navigate" &&
      typeof data.path === "string" &&
      data.path.startsWith("/") &&
      !data.path.startsWith("//")
    )
      location.assign(data.path);
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
    // An empty query is how the bar closes: the highlights are the page's,
    // and a page left glowing after esc would be the app remembering a
    // search nobody is running.
    if (data.type === "find") {
      const next =
        typeof data.query === "string" ? data.query.trim().slice(0, 500) : "";
      if (next !== findQuery) findAt = 0;
      findQuery = next;
      findWatching(!!next);
      findLook(true);
    }
    if (data.type === "find-step" && findFound.length > 0) {
      const n = findFound.length;
      findAt = (findAt + (data.by === -1 ? -1 : 1) + n) % n;
      findPaint();
      findShow();
      tell("found", { count: n, at: findAt });
    }
  });
  // Advertise to an embedded PreviewTab, using the configured exact UI origin.
  if (uiOrigin && window.parent !== window)
    window.parent.postMessage(
      { source: "firetower-picker", type: "available" },
      uiOrigin,
    );
})();
