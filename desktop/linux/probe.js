/**
 * What the webview says about itself, from inside the real window.
 *
 * Appended to `dist/index.html` for the *probe* build only — never committed
 * into the application, and `check.sh` is the only thing that puts it there.
 * It exists because the questions this spike has to answer are not visible
 * from outside the process: whether `oklch()` parsed, whether the local
 * Archivo actually loaded or the page fell back to DejaVu, what WebKitGTK
 * reports for `navigator.platform`, and what the keychain says when there is
 * no Secret Service on the bus. A screenshot cannot tell you any of those.
 *
 * It answers over HTTP to a collector on 127.0.0.1 rather than to the console,
 * because WebKitGTK's console goes nowhere useful in a release build. The
 * application's own CSP allows this: `connect-src` already includes `http:`.
 */
(() => {
  const PORT = Number(window.__FT_PROBE_PORT__ || 4499);
  /* The run's secret, from the prelude `check.sh` writes above this file —
     lexically, rather than on `window`, so a page in this window cannot read
     it off the global object. The collector refuses a submission without it:
     it writes files, and an artifact rendered in this window is somebody
     else's HTML. */
  const WHERE = `http://127.0.0.1:${PORT}/probe?s=${encodeURIComponent(
    typeof FT_PROBE_SECRET === "string" ? FT_PROBE_SECRET : "",
  )}`;
  const out = { phase: window.__FT_PROBE_PHASE__ || "unknown" };

  const guard = (name, f) => {
    try {
      out[name] = f();
    } catch (e) {
      out[name] = { error: String(e) };
    }
  };

  const invoke = (cmd, args) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.resolve({ unavailable: "no __TAURI_INTERNALS__" });
    }
    return internals
      .invoke(cmd, args)
      .then((v) => ({ ok: v === undefined ? null : v }))
      .catch((e) => ({ err: typeof e === "string" ? e : JSON.stringify(e) }));
  };

  /** How wide a string is in a named family, so a fallback is measurable. */
  const widthIn = (family, text) => {
    const c = document.createElement("canvas").getContext("2d");
    c.font = `32px ${family}`;
    return Math.round(c.measureText(text).width * 100) / 100;
  };

  async function run() {
    guard("navigator", () => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      /* The whole point: `userAgentData` is Chromium-only and `platform.ts`
         reads it first. If this is "undefined", detection fell through. */
      userAgentDataType: typeof navigator.userAgentData,
      userAgentDataPlatform: navigator.userAgentData?.platform ?? null,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }));

    /* `platform.ts` writes its own answer here on import, so this is the
       module's verdict and not a re-derivation of it. */
    guard("platformDataset", () => document.documentElement.dataset.platform ?? null);

    /* The same arrangement for the theme, and the thing it depends on.
       `tauri.conf.json` asks for `"theme": "Dark"`; `theme.ts` resolves
       `system` through `prefers-color-scheme`, which WebKitGTK answers from
       GtkSettings. Whether those two agree is the question — so both the
       query's answer and the attribute `theme.ts` wrote are recorded. */
    guard("theme", () => ({
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      /* `no-preference` is what an engine says when it has nothing to go on,
         and it is a different answer from "light". */
      noPreference: window.matchMedia("(prefers-color-scheme: no-preference)").matches,
      datasetTheme: document.documentElement.dataset.theme ?? null,
      stored: (() => {
        try {
          return window.localStorage.getItem("firetower.theme");
        } catch {
          return "unreadable";
        }
      })(),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      gtkTheme: null,
    }));

    guard("cssSupport", () => ({
      oklch: CSS.supports("color", "oklch(0.7 0.1 200)"),
      colorMix: CSS.supports("color", "color-mix(in oklab, red, blue)"),
      registerProperty: typeof CSS.registerProperty === "function",
      relativeColor: CSS.supports("color", "rgb(from red r g b)"),
      nesting: CSS.supports("selector(&)"),
      has: CSS.supports("selector(:has(a))"),
      colorScheme: CSS.supports("color-scheme", "dark"),
      backdropFilter: CSS.supports("backdrop-filter", "blur(4px)"),
      containerQueries: CSS.supports("container-type", "inline-size"),
    }));

    /* Whether Tailwind v4's `@property` block survived parsing. A rule the
       engine does not understand is dropped silently, which is exactly the
       "grey, broken-looking page" this is looking for. */
    guard("stylesheets", () => {
      const seen = {};
      let sheets = 0;
      let unreadable = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        sheets += 1;
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          unreadable += 1;
          continue;
        }
        const walk = (list) => {
          for (const rule of Array.from(list)) {
            const kind = rule.constructor?.name || `type${rule.type}`;
            seen[kind] = (seen[kind] || 0) + 1;
            if (rule.cssRules) walk(rule.cssRules);
          }
        };
        walk(rules);
      }
      return { sheets, unreadable, kinds: seen };
    });

    /* Resolved values, which is the only proof that the token system worked.
       `--color-ground` is #0b0b0c and the page is painted out of it. */
    guard("computed", () => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const tokens = {};
      for (const name of [
        "--color-ground",
        "--color-panel",
        "--color-bone",
        "--color-ember",
        "--font-sans",
        "--chrome-title",
      ]) {
        tokens[name] = root.getPropertyValue(name).trim() || null;
      }
      return {
        tokens,
        bodyBackground: body.backgroundColor,
        bodyColor: body.color,
        bodyFontFamily: body.fontFamily,
        htmlClass: document.documentElement.className,
      };
    });

    /* Is there a page at all, or an empty root? A blank window with a healthy
       DOM is a renderer problem; a blank window with an empty root is not. */
    guard("dom", () => {
      const root = document.getElementById("root");
      const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
      return {
        rootChildren: root ? root.childElementCount : -1,
        elements: document.querySelectorAll("*").length,
        textLength: text.length,
        text: text.slice(0, 600),
        title: document.title,
      };
    });

    guard("viewport", () => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      isSecureContext: window.isSecureContext,
    }));

    /* What the page is told about the renderer. Worth having, but do not
       read too much into it: WebKit masks these strings for fingerprinting,
       and in this container it answers "Apple GPU" while `glxinfo` says
       llvmpipe. `glxinfo -B` is the honest source. */
    guard("gl", () => {
      const gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return { webgl: false };
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl: true,
        vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      };
    });

    /* Raced against a timer. `fonts.ready` resolves when the document has
       finished loading fonts *and* laid out, so a page still waiting on a
       request can hold it open indefinitely — and the whole report with it. */
    await Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((r) => window.setTimeout(r, 3000)),
    ]).catch(() => {});

    /* Ask for the three faces explicitly before reporting. Without this the
       answer depends on which screen happens to be up — a first-run screen
       has no monospace on it, so JetBrains Mono reads as `unloaded` and that
       says nothing about whether the file works. `load()` resolves when the
       face is fetched and parsed, or rejects when it is not. */
    out.fontsForced = {};
    for (const spec of ["32px Archivo", "32px 'Archivo Narrow'", "32px 'JetBrains Mono'"]) {
      try {
        const got = await Promise.race([
          document.fonts.load(spec),
          new Promise((_, no) => window.setTimeout(() => no(new Error("timed out")), 5000)),
        ]);
        out.fontsForced[spec] = { loaded: got.length, ok: got.length > 0 };
      } catch (e) {
        out.fontsForced[spec] = { error: String(e) };
      }
    }

    guard("fonts", () => {
      const faces = Array.from(document.fonts).map((f) => ({
        family: f.family,
        weight: f.weight,
        status: f.status,
      }));
      const sample = "Firetower connects to a server";
      return {
        faces,
        count: document.fonts.size,
        status: document.fonts.status,
        /* `check()` can answer true for a family it would synthesise, so the
           widths are the real test: Archivo and DejaVu Sans do not set the
           same string to the same number of pixels. */
        check: {
          archivo: document.fonts.check("32px Archivo"),
          archivoNarrow: document.fonts.check("32px 'Archivo Narrow'"),
          jetbrains: document.fonts.check("32px 'JetBrains Mono'"),
        },
        widths: {
          archivo: widthIn("Archivo", sample),
          archivoNarrow: widthIn("'Archivo Narrow'", sample),
          jetbrains: widthIn("'JetBrains Mono'", sample),
          sansSerif: widthIn("sans-serif", sample),
          dejavu: widthIn("'DejaVu Sans'", sample),
          monospace: widthIn("monospace", sample),
        },
      };
    });

    /* Sent before the shell is asked anything, and that is not tidiness.
       `notify` goes to `org.freedesktop.Notifications`, which is not on the
       bus here, and a D-Bus call to a name nobody owns can sit for its full
       timeout. Reporting the page first means a slow bridge costs the bridge
       answers and not the whole report. */
    await send(out);

    /* The shell, through the same bridge the application uses. Each of these
       is a thing the Mac and Windows builds do and Linux may not. */
    out.bridge = {
      native: !!window.__TAURI_INTERNALS__,
      secret_set: await invoke("secret_set", { key: "ft-linux-probe", value: "hunter2" }),
      secret_get: await invoke("secret_get", { key: "ft-linux-probe" }),
      secret_delete: await invoke("secret_delete", { key: "ft-linux-probe" }),
      set_badge: await invoke("set_badge", { count: 3 }),
      set_title: await invoke("set_title", { title: "Firetower" }),
      notify: await invoke("notify", { title: "probe", body: "probe" }),
      capture_poster: await invoke("capture_poster", { url: "about:blank" }),
      minimize_skipped: "not called: it would unmap the window being photographed",
    };

    out.phase = out.phase + "-bridge";
    await send(out);
  }

  async function send(report) {
    const body = JSON.stringify(report, null, 2);
    console.log("FT_PROBE " + body);
    try {
      await fetch(WHERE, {
        method: "POST",
        /* `text/plain` and not `application/json`: it is CORS-safelisted, so
           the request goes straight out instead of asking for a preflight
           first. One fewer thing between the answer and the file. */
        headers: { "content-type": "text/plain" },
        body,
      });
    } catch (e) {
      console.log("FT_PROBE_POST_FAILED " + String(e));
      /* Last resort: the window's own title. It is the one channel out of a
         release webview that needs no network and no console, and xdotool can
         read it. Truncated, because a title is not a transport. */
      try {
        window.__TAURI_INTERNALS__?.invoke("set_title", {
          title: "FT_PROBE_FAILED " + String(e).slice(0, 200),
        });
      } catch {
        /* nothing left to try */
      }
    }
  }

  /* Says "the script ran" before anything can go wrong, so a report that
     never arrives can be told apart from a script that never executed. The
     two have the same symptom and completely different causes.

     Through the window's title as well as the network, because those are two
     independent ways for the report to fail and only one of them is a finding
     about Linux. `xdotool getwindowname` reads it. */
  try {
    window.__TAURI_INTERNALS__?.invoke("set_title", { title: `FT_PROBE_ALIVE ${document.readyState}` });
  } catch {
    /* if the bridge is not there either, the fetch below is the only channel */
  }

  fetch(WHERE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: `${out.phase}-alive`, readyState: document.readyState }),
  }).catch(() => {});

  /* On a timer and not on `load`. The window's own `load` is hostage to every
     request the page has in flight — the control plane among them — and a
     probe that waits for it reports nothing on exactly the machine where
     something is hanging. React has drawn long before 4.5s. */
  window.setTimeout(run, 4500);
})();
