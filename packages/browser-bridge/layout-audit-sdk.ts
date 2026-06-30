/**
 * Client-side layout-audit SDK injected into HTML artifacts.
 *
 * Runs on `window.load`, detects overflow, cutoff, and overlapping elements,
 * then POSTs the violation list to the bridge server.  The placeholder
 * `__BRIDGE_URL__` is replaced at inject-time with the actual server origin.
 */
export const LAYOUT_AUDIT_SDK = `(function(){
  function detectViolations(){
    var violations=[];
    var all=Array.prototype.slice.call(document.querySelectorAll("*"));
    all.forEach(function(el){
      if(el===document.documentElement||el===document.body)return;
      var overflowsX=el.scrollWidth>el.clientWidth+2;
      var overflowsY=el.scrollHeight>el.clientHeight+2;
      if(overflowsX||overflowsY){
        var cs=window.getComputedStyle(el);
        var ov=[cs.overflow,cs.overflowX,cs.overflowY].join(" ");
        var sel=el.tagName.toLowerCase()+(el.id?"#"+el.id:"");
        if(ov.indexOf("hidden")!==-1){
          violations.push({type:"cutoff",selector:sel,
            detail:"scrollWidth="+el.scrollWidth+" clientWidth="+el.clientWidth});
        } else {
          violations.push({type:"overflow",selector:sel,
            detail:"scrollWidth="+el.scrollWidth+" clientWidth="+el.clientWidth});
        }
      }
    });
    var rects=[];
    all.forEach(function(el){
      var r=el.getBoundingClientRect();
      if(r.width>0&&r.height>0)rects.push({el:el,r:r});
    });
    for(var i=0;i<rects.length;i++){
      for(var j=i+1;j<rects.length;j++){
        var a=rects[i].r,b=rects[j].r;
        if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top){
          if(!rects[i].el.contains(rects[j].el)&&!rects[j].el.contains(rects[i].el)){
            var sA=rects[i].el.tagName.toLowerCase()+(rects[i].el.id?"#"+rects[i].el.id:"");
            var sB=rects[j].el.tagName.toLowerCase()+(rects[j].el.id?"#"+rects[j].el.id:"");
            violations.push({type:"overlap",selector:sA+" + "+sB,detail:"elements overlap"});
          }
        }
      }
    }
    return violations;
  }
  window.addEventListener("load",function(){
    var violations=detectViolations();
    fetch("__BRIDGE_URL__/api/layout-audit-result",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({violations:violations})
    }).catch(function(){});
  });
})();`;
