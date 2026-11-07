#!/usr/bin/env python3
"""Assert the hover-preview rule in a render: for each of the four rows, does
a panel show, is it floating, and whose panel is it?"""
import subprocess, pathlib, re
ART="/Users/kevinpiacentini/.firetower/worker/worktrees/agent-redesign-w5z9f71c/.firetower/artifacts/firetower-redesign/index.html"
s=pathlib.Path(ART).read_text().replace('</body>','''<script>
setTimeout(function(){
  function hit(t){var b=[...document.querySelectorAll("#ctl button")].find(e=>e.textContent.trim()===t); if(b)b.click();}
  hit("Dashboard");
  var rows=["No hover","On it \\u00b7 panel open","On it \\u00b7 panel hidden",
            "Another \\u00b7 panel open","Another \\u00b7 panel hidden"], out=[];
  var i=0;
  (function step(){
    if(i>=rows.length){ document.title="PEEK "+out.join(" || "); return; }
    hit(rows[i]);
    setTimeout(function(){
      var p=document.querySelector("#win .panel");
      var head=p?(p.querySelector(".phead .nm")||p.querySelector(".phead b")):null;
      out.push(rows[i]+" => panel="+(p?"yes":"NO")
        +" float="+(p?p.dataset.float:"-")
        +" showing="+(head?head.textContent.trim():"-"));
      i++; step();
    },160);
  })();
},80);</script></body>''')
pathlib.Path("/tmp/_pk.html").write_text(s)
r=subprocess.run(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","--headless","--disable-gpu",
 "--no-sandbox","--virtual-time-budget=12000","--dump-dom","/tmp/_pk.html"],capture_output=True,text=True)
m=re.search(r'<title>(PEEK[^<]*)</title>',r.stdout)
print((m.group(1) if m else "no title").replace(" || ","\n  "))
