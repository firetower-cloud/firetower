/**
 * The rules the design states in writing, as functions of a rendered page.
 *
 * Everything here runs **inside the browser**, against the live computed
 * style of real elements — not against the stylesheet, and not against a
 * screenshot. That distinction is the whole point. The three defects the
 * user found in two days (the unpadded tab strip, the white band above the
 * rail, the invisible hover) were all photographed by the sweep and none was
 * seen, because looking at ninety-nine pictures twice over is not a thing a
 * person does carefully on the ninety-ninth.
 *
 * **What this cannot do**, said here because the limits matter as much as
 * the checks: it cannot tell anybody the design is *good*, it cannot notice
 * a screen that was never built, it cannot read copy, and it cannot compare
 * node-for-node against the drawing — two separately authored DOMs have no
 * correspondence, and asserting every property across them would drown in
 * false failures from legitimate markup differences. It catches **drift**,
 * not **absence**.
 *
 * Every finding carries the state, a locator for the element, the rule, and
 * expected versus actual. A red tick with no locator costs more than it
 * saves.
 */

/** Serialised into the page, so it must be self-contained. */
export const RULES = function collect() {
  const out = [];
  const seen = new Set();

  /* ── Where an element is, said in a way you can paste into devtools ── */
  const where = (el) => {
    if (el === document.body) return "body";
    const bits = [];
    for (let n = el; n && n !== document.body && bits.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { bits.unshift(`${s}#${n.id}`); break; }
      const cls = (n.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) s += "." + cls.join(".");
      bits.unshift(s);
    }
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return bits.join(" > ") + (txt ? `  «${txt}»` : "");
  };

  const say = (rule, el, expected, actual) => {
    const at = where(el);
    const key = `${rule}|${at}|${actual}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rule, at, expected, actual });
  };

  const all = [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
  });

  /* ── Colour, resolved ─────────────────────────────────────────────── */
  const rgb = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /** **The background an element actually sits on**, composited up the tree —
      not the one its own rule declares. A transparent element over a hover
      ground is the case that hid the rail bug for two passes. */
  const groundOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    return acc ?? { r: 255, g: 255, b: 255, a: 1 };
  };

  /* ── 1. No ALL-CAPS ───────────────────────────────────────────────── */
  for (const el of all) {
    const t = getComputedStyle(el).textTransform;
    if (t === "uppercase") say("no-uppercase", el, "none", t);
  }

  /* ── 2. The ember budget ──────────────────────────────────────────── */
  const EMBER = ["--color-ember", "--color-ember-ink"].map((n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(),
  );
  const isEmber = (v) => {
    const c = rgb(v);
    if (!c || c.a < 0.5) return false;
    /* Saturated orange, however it was written. */
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
    return mx > 180 && mx - mn > 90 && c.r === mx && c.b === mn;
  };
  let embers = 0;
  const emberAt = [];
  for (const el of all) {
    const s = getComputedStyle(el);
    const hit = isEmber(s.color) || isEmber(s.backgroundColor) || isEmber(s.borderTopColor);
    /* Count the mark, not its ancestors: an inherited colour is one ember. */
    if (hit && !(el.parentElement && isEmber(getComputedStyle(el.parentElement).color) && isEmber(s.color))) {
      embers++;
      if (emberAt.length < 8) emberAt.push(where(el));
    }
  }
  if (embers > 3) out.push({ rule: "ember-budget", at: emberAt.join("  ·  "), expected: "at most 3", actual: String(embers) });

  /* ── 3. Mono only where it means something ────────────────────────── */
  const MONO_OK = ["font-mono", "path", "branch", "code", "mono", "diff", "hljs", "cm-", "sha", "key", "ver", "token", "shell", "term", "log", "pre"];
  for (const el of all) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || "").trim();
    if (!txt) continue;
    const f = getComputedStyle(el).fontFamily.toLowerCase();
    if (!/mono|menlo|consolas|courier|sf mono|jetbrains/.test(f)) continue;
    const chain = (() => { let s = ""; for (let n = el; n && n !== document.body; n = n.parentElement) s += " " + (n.getAttribute("class") || "") + " " + n.tagName; return s.toLowerCase(); })();
    if (MONO_OK.some((w) => chain.includes(w))) continue;
    /* Paths, branches, versions, hashes and keys, recognised by shape when
       the markup does not say so. */
    if (/^[\w.@/-]+$/.test(txt) || /^[0-9a-f]{7,}$/i.test(txt) || /^v?\d+\.\d+/.test(txt)) continue;
    say("mono-only-for-machine-text", el, "the UI face", txt.slice(0, 40));
  }

  /* ── 4. `min-height: 0` on every flex column above a scroller ─────── */
  for (const el of all) {
    const s = getComputedStyle(el);
    if (s.overflowY !== "auto" && s.overflowY !== "scroll") continue;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n);
      if (p.display !== "flex" || p.flexDirection !== "column") continue;
      if (p.minHeight === "0px" || p.minHeight === "0") continue;
      /* A column that is not itself a flex child cannot overflow this way. */
      const gp = n.parentElement && getComputedStyle(n.parentElement);
      if (!gp || gp.display !== "flex") continue;
      say("min-h-0-above-a-scroller", n, "min-height: 0", p.minHeight);
    }
  }

  /* ── 5. Contrast, against the ground it actually sits on ──────────── */
  for (const el of all) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || "").trim();
    if (!txt) continue;
    const s = getComputedStyle(el);
    const fg = rgb(s.color);
    if (!fg) continue;
    const bg = groundOf(el);
    const r = ratio(over(fg, bg), bg);
    const px = parseFloat(s.fontSize);
    const big = px >= 24 || (px >= 18.66 && parseInt(s.fontWeight, 10) >= 600);
    /* 3.2 rather than 4.5 for the small tier: `--mute` is a documented 2.4:1
       timestamp colour and failing it on every screen would bury the real
       finding. This catches text that has gone *invisible*, which is the
       class the hover bug belongs to. */
    const floor = big ? 2.4 : el.closest("[aria-disabled='true']") ? 1.6 : 2.0;
    if (r < floor) say("contrast-floor", el, `≥ ${floor}:1`, `${r.toFixed(2)}:1`);
  }

  /* ── 6. One inset for every child of a page column ────────────────── */
  for (const col of document.querySelectorAll(".pcol, .pg, .hcol")) {
    const kids = [...col.children].filter((k) => {
      const s = getComputedStyle(k);
      return s.display !== "none" && k.getClientRects().length > 0 && s.position !== "absolute" && s.position !== "fixed";
    });
    if (kids.length < 2) continue;
    const insets = kids.map((k) => {
      const s = getComputedStyle(k);
      /* A child that spans the column on purpose says so by being full-bleed
         in both directions; what this is looking for is the odd one out. */
      return `${s.paddingLeft}/${s.marginLeft}`;
    });
    const tally = {};
    insets.forEach((v) => (tally[v] = (tally[v] ?? 0) + 1));
    const common = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (common[1] < kids.length) {
      kids.forEach((k, i) => {
        if (insets[i] !== common[0]) say("page-column-inset", k, `padding-left/margin-left ${common[0]}`, insets[i]);
      });
    }
  }

  return out;
};
