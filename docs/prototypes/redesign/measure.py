#!/usr/bin/env python3
"""Measure where each component is used, by driving the artifact.

    python3 docs/prototypes/redesign/measure.py

Writes `usage.json` beside itself: for every CSS class the redesign draws, the
set of screens it appears on and the most instances on any one screen. The
component list reads that file, so "used on 50 screens" is a measurement rather
than a claim — and anything used once is flagged without a person noticing.

Needs Chrome. Override the path with $CHROME.

Three traps, all of which cost a wrong measurement before they were found, and
all of which are handled below:

  * Reset global state between screens. `Threw` latches the error screen, and a
    tab press clears only per-tab state — so once it had been pressed, every
    later screen in the walk *was* the error screen.
  * Click the two in-window triggers the masthead cannot reach: the profile
    menu and the Firetower switcher.
  * Skip the document tabs. They draw no window and `render()` leaves `#win`
    holding whatever was last in it, so walking them measures a stale screen.
"""
import subprocess, pathlib, json, sys, os, tempfile
ART = str(pathlib.Path(__file__).with_name("desktop-redesign.html"))
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

COLLECT = r"""<script>
/* Two passes, because they answer different questions.

   A — the baseline. Each tab and each view inside it, with nothing opened
   over the top. This is the denominator for "used on N screens".

   B — the overlays. Each one opened from a freshly reset screen, so what it
   adds is attributed to it rather than smeared across every screen that
   happened to be visited after it. The first pass leaked exactly that way
   and reported every class on all 74 screens. */
var seen = {}, overlay = {}, screens = [], fails = [];
function classesIn(){
  var win = document.getElementById("win"), here = {};
  if(!win) return here;
  win.querySelectorAll("[class]").forEach(function(el){
    (el.getAttribute("class")||"").split(/\s+/).forEach(function(c){
      if(c && /^[a-zA-Z][\w-]*$/.test(c)) here[c] = (here[c]||0) + 1;
    });
  });
  return here;
}
function note(screen){
  var here = classesIn();
  if(screens.indexOf(screen) < 0) screens.push(screen);
  Object.keys(here).forEach(function(c){
    var r = seen[c] || (seen[c] = { screens:{}, max:0 });
    r.screens[screen] = true;
    if(here[c] > r.max) r.max = here[c];
  });
  return here;
}
function press(label){
  var b = [].slice.call(document.querySelectorAll("#ctl button"))
            .filter(function(e){ return e.textContent.trim() === label; })[0];
  if(!b) return false;
  b.click(); return true;
}
/* Document tabs draw no window. `render()` leaves `#win` holding whatever was
   last in it, so walking them attributes a stale screen's classes to a screen
   that has none — measuring nothing and reporting it as something. */
var DOCS = ["Every screen", "Coverage", "Grouping", "Spec", "Notes"];
var tabs = [].slice.call(document.querySelectorAll("#ctl .seg:first-child button"))
              .map(function(b){ return b.textContent.trim(); })
              .filter(function(t){ return DOCS.indexOf(t) < 0; });
function views(){
  var segs = document.querySelectorAll("#ctl .seg");
  if(segs.length < 2) return [null];
  return [].slice.call(segs[1].querySelectorAll("button")).map(function(b){ return b.textContent.trim(); });
}
function others(){
  return [].slice.call(document.querySelectorAll("#ctl .seg")).slice(2).reduce(function(a, sg){
    return a.concat([].slice.call(sg.querySelectorAll("button")).map(function(b){ return b.textContent.trim(); }));
  }, []).filter(function(l){ return l !== "Light" && l !== "Dark"; });
}
/* A total reset.

   Pressing a tab clears the overlays that belong to a tab, but not the global
   ones — and `Threw` latches the error screen, so once it had been pressed on
   the first tab every later screen in the walk *was* the error screen and
   nothing else was ever measured. `S` is a top-level `const` in a classic
   script, so it is reachable as a bare identifier from here. */
function reset(tab, view, then){
  S.threw = false; S.pal = null; S.confirm = false; S.voice = null; S.hand = null;
  S.find = null; S.addagent = false; S.ctx = false; S.repos = null; S.gate = null;
  S.scopesheet = false; S.menu = null; S.pick = null; S.pane = null; S.conn = null;
  S.mach = null; S.share = null; S.first = null;
  press(tabs[0] === tab ? tabs[1] : tabs[0]);
  setTimeout(function(){ press(tab); setTimeout(function(){ if(view) press(view); setTimeout(then, 14); }, 14); }, 14);
}
var ti = 0, plan = [];
function passA(){
  if(ti >= tabs.length){ ti = 0; return setTimeout(passB, 20); }
  var t = tabs[ti++];
  S.threw = false; S.pal = null; S.confirm = false; S.voice = null; S.hand = null;
  press(t);
  setTimeout(function(){
    var vs = views(), vi = 0;
    (function nextView(){
      if(vi >= vs.length){ setTimeout(passA, 12); return; }
      var v = vs[vi++];
      if(v) press(v);
      setTimeout(function(){
        var screen = v ? t + " / " + v : t;
        note(screen);
        plan.push([t, v, screen]);
        nextView();
      }, 16);
    })();
  }, 22);
}
/* Two things in the window open only by clicking the window: the profile menu
   and the Firetower switcher under it. Nothing in the masthead reaches them,
   so the walk clicks them where they are. */
function inWindow(screen){
  ["profile","switch"].forEach(function(which){
    var b = document.querySelector('#win [data-act="menu"][data-menu="' + which + '"]');
    if(b){ b.click(); note(screen); }
  });
}
function passB(){
  if(ti >= tabs.length){
    var out = {};
    Object.keys(seen).forEach(function(c){
      out[c] = { screens: Object.keys(seen[c].screens), max: seen[c].max };
    });
    document.title = "USAGE " + JSON.stringify({ classes: out, screens: screens, overlays: overlay, fails: fails });
    return;
  }
  var t = tabs[ti++];
  press(t);
  setTimeout(function(){
    var vs = views(), vi = 0, os = others();
    (function nextView(){
      if(vi >= vs.length){ setTimeout(passB, 12); return; }
      var v = vs[vi++], oi = 0;
      (function step(){
      if(oi >= os.length){ nextView(); return; }
      var label = os[oi++];
      reset(t, v, function(){
        var before = classesIn();
        if(!press(label)) fails.push(t + " :: " + label);
        setTimeout(function(){
          /* The overlay's classes belong to the screen it was opened over —
             a dialog reachable from fourteen screens is used on fourteen. */
          var after = note(v ? t + " / " + v : t);
          if(oi === 1) inWindow(v ? t + " / " + v : t);
          var added = Object.keys(after).filter(function(c){ return !before[c]; });
          if(added.length){
            var r = overlay[label] || (overlay[label] = { adds:{}, on:[] });
            added.forEach(function(c){ r.adds[c] = true; });
            if(r.on.indexOf(t) < 0) r.on.push(t);
          }
          step();
        }, 16);
      });
      })();
    })();
  }, 22);
}
passA();
</script>"""

s = pathlib.Path(ART).read_text().replace("</body>", COLLECT + "</body>")
pathlib.Path(tempfile.gettempdir(), "ft-usage.html").write_text(s)
out = subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                      "--virtual-time-budget=600000", "--dump-dom", str(pathlib.Path(tempfile.gettempdir(), "ft-usage.html"))],
                     capture_output=True, text=True).stdout
i = out.find("<title>USAGE ")
if i < 0:
    print("the walk did not finish", file=sys.stderr); sys.exit(1)
raw = json.loads(out[i + len("<title>USAGE "): out.index("</title>", i)]
                 .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
pathlib.Path(__file__).with_name("usage.json").write_text(json.dumps(raw, indent=0, sort_keys=True))
cls, screens, ov = raw["classes"], raw["screens"], raw["overlays"]
print(f"{len(cls)} classes across {len(screens)} baseline screens, {len(ov)} overlays")
once = sorted(c for c, v in cls.items() if len(v["screens"]) == 1)
print(f"{len(once)} appear on exactly one screen")
top = sorted(cls.items(), key=lambda kv: -len(kv[1]["screens"]))[:8]
print("most reused:", ", ".join(f'.{c} ({len(v["screens"])})' for c, v in top))
