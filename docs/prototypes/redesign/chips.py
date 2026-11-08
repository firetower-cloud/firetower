#!/usr/bin/env python3
"""The home column at a real 1280 and a real 1680.

The artifact draws a fixed 1280 window and *scales* it to fit, so a wider
browser window measures the same layout — the window's own width has to be
overridden to ask the question honestly."""
import subprocess, pathlib, sys, re
ART="/Users/kevinpiacentini/.firetower/worker/worktrees/agent-redesign-w5z9f71c/.firetower/artifacts/firetower-redesign/index.html"
extra = sys.argv[1] if len(sys.argv)>1 else ""
for W in (1280, 1680):
    s=pathlib.Path(ART).read_text().replace('</body>',f'''<script>
setTimeout(function(){{
  function hit(t){{var b=[...document.querySelectorAll("#ctl button")].find(e=>e.textContent.trim()===t);if(b)b.click();}}
  hit("Dashboard"); {extra}
  setTimeout(function(){{
    var w=document.querySelector("#win"); w.style.width="{W}px";
    document.getElementById("scaler").style.transform="scale(1)";
    trimChips();
    setTimeout(function(){{
      var col=document.querySelector("#win .hcol"), out=[];
      var cs=getComputedStyle(col);
      out.push("win={W} col="+col.clientWidth+" content="+(col.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)));
      document.querySelectorAll("#win .sect").forEach(function(sec){{
        var h2=sec.querySelector("h2"), row=sec.querySelector(".chips");
        if(!h2||!row||!row.children.length) return;
        var chips=[...row.children];
        var tops=[...new Set(chips.map(function(c){{return c.offsetTop}}))].sort(function(a,b){{return a-b}});
        /* Visible = not clipped away by the row's own max-height. */
        var h=row.clientHeight;
        var vis=chips.filter(function(c){{return c.offsetTop-chips[0].offsetTop < h-2}});
        var visRows=[...new Set(vis.map(function(c){{return c.offsetTop}}))].length;
        var all=sec.querySelector(".hd .all");
        out.push(h2.textContent.trim()+": "+vis.length+" of "+chips.length+" chips"
          +" in "+visRows+" row(s) of "+tops.length
          +" | viewall="+(all?(all.hidden?"hidden":"shown"):"none")
          +" | widest="+Math.round(Math.max.apply(null,chips.map(function(c){{return c.offsetWidth}}))));
      }});
      document.title="CHIPS "+out.join(" || ");
    }},250);
  }},400);
}},80);</script></body>''')
    pathlib.Path("/tmp/_c3.html").write_text(s)
    r=subprocess.run(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","--headless","--disable-gpu",
      "--no-sandbox","--window-size=1800,1000","--virtual-time-budget=9000","--dump-dom","/tmp/_c3.html"],
      capture_output=True,text=True)
    m=re.search(r'<title>(CHIPS[^<]*)</title>',r.stdout)
    print((m.group(1) if m else "?").replace(" || ","\n   "))
