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

  /**
   * **A clipped child still has a bounding rect.** `overflow: hidden` on an
   * ancestor does not zero it, so a chip on a hidden second row counted
   * against the ember budget while the page showed nothing there — five
   * reported where two were drawn.
   *
   * So "on screen" means inside every clipping ancestor, not merely laid
   * out. Checked against the ancestor's *padding box*, which is what
   * `overflow` clips to.
   */
  const onScreen = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflow === "visible" && s.overflowX === "visible" && s.overflowY === "visible") continue;
      const clip = n.getBoundingClientRect();
      /* Wholly outside the clip in either axis means it cannot be seen. */
      if (box.bottom <= clip.top + 1 || box.top >= clip.bottom - 1) return false;
      if (box.right <= clip.left + 1 || box.left >= clip.right - 1) return false;
    }
    return true;
  };

  const all = [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0 && onScreen(el);
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
  /* **The token, resolved — not "orange-ish".** The heuristic read amber as
     ember, so a skill's five risk lines, which are amber by design, counted
     against a budget that is about ember alone. Resolving the two ember
     tokens through a probe and comparing exactly has no hue to get wrong. */
  const EMBER = (() => {
    const d = document.createElement("div");
    document.body.append(d);
    const out = new Set();
    for (const n of ["--color-ember", "--color-ember-ink"]) {
      d.style.color = `var(${n})`;
      out.add(getComputedStyle(d).color.replace(/\s/g, ""));
    }
    d.remove();
    return out;
  })();
  const isEmber = (v) => {
    const c = rgb(v);
    if (!c || c.a < 0.5) return false;
    return EMBER.has(`rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`);
  };
  /**
   * **The two exemptions, and the count of what each one suppressed.**
   *
   * An exemption keyed on something that can move is an exemption with an
   * expiry, and it expires in the worst possible direction: as a *violation*,
   * so the first person to see the count jump concludes the design broke. The
   * designer hit exactly this — the panel's exemption was written as
   * `.pscroll i.wdot`, the panel stopped drawing `.wdot`, and the budget went
   * 3 → 5 with nothing about the design having changed.
   *
   * These are anchored on `[data-rail-panel]` and on `[data-mark]`, which are
   * attributes that exist *for* assertions rather than for styling — but that
   * is an argument, not a guarantee. So each one reports how many ember marks
   * it suppressed, and `assert-design.mjs` fails if one of them suppressed
   * nothing anywhere in the whole sweep. A silent expiry becomes a named
   * finding that says which anchor moved.
   */
  const EXEMPT = [
    /* **An agent's mark is not an ember.** Claude's glyph is orange because
       Claude's glyph is orange; the budget is about ember used as a *signal*
       — somebody is waiting on you — and counting brand marks against it
       made a workspace with four agents in it permanently over budget.

       **Defensive, and measured as such.** It suppressed nothing across 103
       states in two themes — which is right: it was load-bearing against the
       *old* counter, which read "orange-ish" and so caught Claude's glyph,
       and it stopped being needed the moment the counter was corrected to
       compare resolved ember tokens exactly. A brand mark drawn in
       `currentColor` is never literally `--color-ember`. It stays so the old
       false positive cannot come back, and the sweep alarms if it ever
       *starts* suppressing something — which would mean it has. */
    ["an agent's brand mark", "[data-mark], .face, .agentmark, [data-agent]", "defensive"],
    /* **The workspaces panel is exempt, by the user, on 7 November 2026.**
       Every row carries its own status mark in both modes — they were shown
       it with the marks capped and without them, and a panel where one row of
       three has a mark reads as missing rather than restrained. Four waiting
       rows are four ember marks and that is the intended drawing.

       Scoped rather than removed: a rule that fails on intended behaviour is
       one the next person switches off wholesale, and it is still worth
       having everywhere else. */
    ["the workspaces panel", "[data-rail-panel]", "load-bearing"],
  ];
  const suppressed = new Map(EXEMPT.map(([name]) => [name, 0]));
  const intentOf = new Map(EXEMPT.map(([name, , intent]) => [name, intent]));

  let embers = 0;
  const emberAt = [];
  for (const el of all) {
    const s = getComputedStyle(el);
    const hit = isEmber(s.color) || isEmber(s.backgroundColor) || isEmber(s.borderTopColor);
    /* Count the mark, not its ancestors: an inherited colour is one ember. */
    if (!hit || (el.parentElement && isEmber(getComputedStyle(el.parentElement).color) && isEmber(s.color))) continue;
    /* Tested *after* the hit, so a count of nothing means the anchor moved
       rather than that there was nothing on screen to exempt. */
    const excused = EXEMPT.find(([, sel]) => el.closest(sel));
    if (excused) {
      suppressed.set(excused[0], suppressed.get(excused[0]) + 1);
      continue;
    }
    embers++;
    if (emberAt.length < 8) emberAt.push(where(el));
  }
  if (embers > 3) out.push({ rule: "ember-budget", at: emberAt.join("  ·  "), expected: "at most 3", actual: String(embers) });
  /* Not a finding — a tally the driver aggregates across the sweep. Filtered
     out of the report there. */
  for (const [name, n] of suppressed) {
    out.push({ rule: "ember-exemption-tally", at: `${intentOf.get(name)}|${name}`, expected: "applies somewhere", actual: String(n) });
  }

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
      /* **The automatic minimum size is a main-axis rule.** `min-height:
         auto` only refuses to shrink when height *is* the main axis — that
         is, when the column is a flex item in a column-direction parent. A
         column sitting in a row has height as its cross axis and stretches
         rather than overflowing, so the whole chrome was being reported and
         the eight real candidates were buried under three hundred. */
      const gp = n.parentElement && getComputedStyle(n.parentElement);
      if (!gp || gp.display !== "flex" || gp.flexDirection !== "column") continue;
      /* **And only when it actually overflowed.** A missing `min-height: 0`
         is harmless on a column whose height is constrained some other way —
         `h-full`, an explicit height, a parent that clips. What the handoff's
         trap looks like from outside is a column *taller than the box it
         sits in*, with a scroller inside it that therefore never scrolls. So
         measure that, not the property: the property is the usual cause, not
         the defect. */
      const box = n.getBoundingClientRect();
      const room = n.parentElement.getBoundingClientRect();
      if (box.height <= room.height + 1) continue;
      say("min-h-0-above-a-scroller", n, `fits its ${Math.round(room.height)}px parent`, `${Math.round(box.height)}px, so the scroller inside cannot scroll`);
    }
  }

  /* ── 5. Contrast, against the ground it actually sits on ──────────── */
  for (const el of all) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || "").trim();
    if (!txt) continue;
    /* A separator is drawn, not read. The drawing sets `.ftid .sep` to
       `--hair` on purpose, and measuring it as text reported the same false
       finding on eighty-five screens. */
    if (!/[\p{L}\p{N}]/u.test(txt)) continue;
    const s = getComputedStyle(el);
    const fg = rgb(s.color);
    if (!fg) continue;
    const bg = groundOf(el);
    const r = ratio(over(fg, bg), bg);
    const px = parseFloat(s.fontSize);
    const big = px >= 24 || (px >= 18.66 && parseInt(s.fontWeight, 10) >= 600);
    /* **The floor is the scale's own faintest step, not a WCAG number.**
       `--color-mute` is a documented timestamp colour that measures about
       1.95:1 over `--color-raise`; failing it would report every secondary
       line in the app and bury the finding that matters. What this is for is
       text that has gone *invisible* — the class the rail hover belonged to,
       where a colour meant for one ground ended up on another. */
    const floor = big ? 1.8 : el.closest("[aria-disabled='true'],[disabled]") ? 1.4 : 1.9;
    if (r < floor) say("contrast-floor", el, `≥ ${floor}:1`, `${r.toFixed(2)}:1`);
  }

  /* ── 6. A surface used outside the role it was defined for ────────
     `--color-overlay` is the *recessed* fill — a pressed chip, an inset
     track, a sunk well. A card that floats above the page wearing the colour
     of a dent in it reads as a grey slab, and **the user reported it three
     times**: the context menu, the annotate popover, and the sharing modal.

     ## Why the first version of this rule passed the third one

     It asked the element about **its own `position`**:

         position: fixed|absolute  &&  box-shadow  &&  radius > 0

     A modal card does not position itself. `Sharing.tsx` puts a `fixed`
     scrim and a `fixed` centring wrapper around a card that is a plain flex
     child — `position: static` — so the predicate was false and the card was
     never looked at. The same was true of `QuickOpen`, `voice/Dialogs`,
     `SkillPicker`, `attach`'s drop chip, and the three floating pills in
     `FileTab`, `Chat` and `ImageTab`. The rule reported only the handful of
     popovers that happen to position themselves, which is why it was green
     while the defect was on screen.

     ## What it asks now — two questions, neither about `position`

     **A. A recessed fill may not cast a shadow.** A shadow says *above* and
     the recessed fill says *below*; an element claiming both is wrong
     whatever it is and wherever it sits. This is the whole of the reported
     bug — every one of those cards carries `--shadow-float` — and it also
     catches a *lifted* control painted with the dent, which is what three
     segmented thumbs were doing with `--shadow-raise`.

     **B. A card in an overlay may not be the recessed fill**, for the ones
     with no shadow. "In an overlay" is read from the tree: an ancestor that
     is `fixed` and covers most of the viewport. Only the **outermost**
     surface-painting box in there is the card — otherwise every pressed chip
     inside a popover would be reported, and those are correctly recessed. */
  {
    const d = document.createElement("div");
    document.body.append(d);
    const named = {};
    for (const t of ["overlay", "line", "line-soft"]) {
      d.style.background = `var(--color-${t})`;
      named[getComputedStyle(d).backgroundColor.replace(/\s/g, "")] = t;
    }
    d.remove();
    const roleOf = (el) => named[getComputedStyle(el).backgroundColor.replace(/\s/g, "")];
    const says = (el, role) =>
      say(
        "surface-role",
        el,
        "a raised surface — `lift`, or `.pop`/`.sheet2`/`.dlg`",
        `--color-${role}, which is ${role === "overlay" ? "the recessed fill" : "a rule colour"}`,
      );

    /* A — the contradiction, asked of everything. */
    for (const el of all) {
      const s = getComputedStyle(el);
      if (s.boxShadow === "none") continue;
      /* An inset shadow *is* how you draw a well, so it argues the other way. */
      if (s.boxShadow.includes("inset")) continue;
      const role = roleOf(el);
      if (role) says(el, role);
    }

    /* B — a shadowless card inside an overlay. */
    const roomy = (el) => {
      const b = el.getBoundingClientRect();
      return b.width > innerWidth * 0.6 && b.height > innerHeight * 0.6;
    };
    const inOverlay = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.position === "fixed" && roomy(n)) return true;
      }
      return false;
    };
    const painted = all.filter((el) => {
      const s = getComputedStyle(el);
      const c = rgb(s.backgroundColor);
      return !!c && c.a > 0.5 && parseFloat(s.borderRadius) > 0 && inOverlay(el);
    });
    const cards = painted.filter((el) => !painted.some((other) => other !== el && other.contains(el)));
    for (const el of cards) {
      const role = roleOf(el);
      if (role) says(el, role);
    }
  }

  /* ── 7. One inset for every child of a page column ────────────────── */
  for (const col of document.querySelectorAll(".pcol, .pg, .hcol")) {
    const kids = [...col.children].filter((k) => {
      const s = getComputedStyle(k);
      return s.display !== "none" && k.getClientRects().length > 0 && s.position !== "absolute" && s.position !== "fixed";
    });
    if (kids.length < 2) continue;
    /* **Where the child's box starts, not what it pads inside itself.** A
       `.whereto` note has 18px of its own padding and still begins at the
       column's edge like everything else; measuring padding called that a
       different inset on thirty screens. The `.sk-tabs` defect was the box
       itself starting at the column edge while its siblings started 32px
       in — which is a geometry fact, so measure geometry. */
    const edge = col.getBoundingClientRect().left + parseFloat(getComputedStyle(col).paddingLeft);
    const insets = kids.map((k) => String(Math.round(k.getBoundingClientRect().left - edge)));
    const tally = {};
    insets.forEach((v) => (tally[v] = (tally[v] ?? 0) + 1));
    const common = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (common[1] < kids.length) {
      kids.forEach((k, i) => {
        /* Within a pixel is the same inset; sub-pixel layout is not a bug.
           And **a bleed two siblings share is a pattern** — rows commonly
           extend past the text so their hover ground does, and reporting
           eight identical rows says nothing. The `.sk-tabs` defect was the
           *lone* odd one out, so that is what this reports. */
        if (Math.abs(Number(insets[i]) - Number(common[0])) <= 1) return;
        if (tally[insets[i]] > 1) return;
        say("page-column-inset", k, `${common[0]}px from the column edge`, `${insets[i]}px`);
      });
    }
  }

  return out;
};
