#!/usr/bin/env python3
"""Count ember in a *render*, not in the source.

**The budget is three per screen** and it is only meaningful counted this way:
walk the laid-out DOM, keep only what is actually visible, and report every
element resolving to the ember family.

**One exemption, and it is deliberate.** The workspaces panel (`.pscroll
i.wdot`) draws a status dot on every row in both modes, uncapped. That puts
five ember marks on the Dashboard at rest and seven with a full list — the
measurement is real and it was the basis for the earlier design, which drew no
dot in Status mode and capped ember in Repository mode. **The user overruled
it on 2026-11-07, having seen it rendered both ways.** A dot that exists in one
mode and vanishes in the other makes the same panel read as alive and then
dead, with nothing explaining the difference; a capped row draws a blocked
workspace exactly like a calm one.

The exemption is scoped to this one selector rather than the check being
switched off, because an assertion that fails on intended behaviour is an
assertion somebody deletes. Both numbers are reported: `budgeted` is what the
rule still governs, `exempt` is this panel's own.
"""
import subprocess, pathlib, sys, re
ART="/Users/kevinpiacentini/.firetower/worker/worktrees/agent-redesign-w5z9f71c/.firetower/artifacts/firetower-redesign/index.html"
EXEMPT = ".pscroll i.wdot"   # the workspaces panel; see the docstring
BUDGET = 3
tab, extra = sys.argv[1], (sys.argv[2] if len(sys.argv)>2 else "")
s = pathlib.Path(ART).read_text().replace('</body>', f'''<script>
setTimeout(function(){{
  function hit(t){{var b=[...document.querySelectorAll("#ctl button")].find(e=>e.textContent.trim()===t); if(b)b.click();}}
  hit({tab!r}); {extra}
  setTimeout(function(){{
    var EM=["rgb(255, 94, 26)","rgb(191, 71, 20)","rgb(255, 107, 44)","rgb(255, 154, 107)"];
    var ex=new Set(document.querySelectorAll({EXEMPT!r}));
    var out=[], exempt=[], seen=new Set();
    document.querySelectorAll("#win *").forEach(function(e){{
      var r=e.getBoundingClientRect(); if(!r.width||!r.height) return;
      var cs=getComputedStyle(e);
      if(cs.visibility==="hidden"||cs.display==="none"||+cs.opacity===0) return;
      /* **A clipped mark is not a mark anybody can see.** `overflow:hidden`
         does not zero a child's bounding rect, so counting rects alone
         counted every chip in a one-line row that had been clipped away —
         five ember on a home showing two. Walk the ancestors and drop
         anything that falls outside a clipping one. */
      var clipped=false;
      for(var p=e.parentElement; p && p!==document.body; p=p.parentElement){{
        var ps=getComputedStyle(p);
        if(ps.overflow==="visible" && ps.overflowX==="visible" && ps.overflowY==="visible") continue;
        var pr=p.getBoundingClientRect();
        if(r.bottom<=pr.top+0.5||r.top>=pr.bottom-0.5||r.right<=pr.left+0.5||r.left>=pr.right-0.5){{clipped=true;break;}}
      }}
      if(clipped) return;
      var where=[];
      if(EM.includes(cs.color) && e.textContent.trim() && ![...e.children].some(function(k){{
          return getComputedStyle(k).color===cs.color && k.textContent.trim()===e.textContent.trim();}})) where.push("text");
      if(EM.includes(cs.backgroundColor)) where.push("fill");
      if(EM.some(function(c){{return cs.borderColor.includes(c)}}) && parseFloat(cs.borderTopWidth)>0) where.push("border");
      if(EM.includes(cs.fill)) where.push("glyph");
      if(!where.length) return;
      var key=Math.round(r.x)+","+Math.round(r.y)+","+where[0];
      if(seen.has(key)) return; seen.add(key);
      var line=where.join("+")+"  "+e.tagName.toLowerCase()+"."+(e.className.baseVal||e.className||"")
        .toString().split(" ")[0]+"  @"+Math.round(r.x)+","+Math.round(r.y);
      (ex.has(e)?exempt:out).push(line);
    }});
    document.title="EMBER budgeted="+out.length+" exempt="+exempt.length
      +" || "+(out.join(" || ")||"none");
  }},400);
}},60);
</script></body>''')
pathlib.Path("/tmp/_em.html").write_text(s)
r=subprocess.run(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","--headless","--disable-gpu",
  "--no-sandbox","--virtual-time-budget=9000","--dump-dom","/tmp/_em.html"],capture_output=True,text=True)
m=re.search(r'<title>(EMBER[^<]*)</title>', r.stdout)
line=(m.group(1) if m else "no title")
print(line.replace(" || ","\n   "))
n=int(re.search(r'budgeted=(\d+)',line).group(1)) if m else 99
if n>BUDGET: print(f"\nOVER BUDGET: {n} > {BUDGET}"); sys.exit(1)
