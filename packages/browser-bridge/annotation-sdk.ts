/**
 * Client-side annotation SDK injected into HTML artifacts.
 *
 * Captures the element and exact character range of any text selection the
 * human makes, then POSTs the result to the bridge server.  The placeholder
 * `__BRIDGE_URL__` is replaced at inject-time with the actual server origin.
 */
export const ANNOTATION_SDK = `(function(){
  document.addEventListener("mouseup",function(){
    var sel=window.getSelection();
    if(!sel||sel.rangeCount===0||sel.isCollapsed)return;
    var range=sel.getRangeAt(0);
    var el=range.commonAncestorContainer;
    if(el.nodeType===3)el=el.parentElement;
    if(!el)return;
    function xpathOf(n){
      if(!n||n===document.documentElement)return"/html";
      if(n.id)return'//*[@id="'+n.id+'"]';
      if(n===document.body)return"/html/body";
      var i=1,s=n.previousElementSibling;
      while(s){if(s.tagName===n.tagName)i++;s=s.previousElementSibling;}
      return xpathOf(n.parentElement)+"/"+n.tagName.toLowerCase()+"["+i+"]";
    }
    var pre=document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer,range.startOffset);
    var start=pre.toString().length;
    var text=range.toString();
    fetch("__BRIDGE_URL__/api/annotate",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        element:{
          tagName:el.tagName,
          id:el.id||"",
          className:typeof el.className==="string"?el.className:"",
          xpath:xpathOf(el)
        },
        charRange:{start:start,end:start+text.length,text:text},
        timestamp:new Date().toISOString()
      })
    }).catch(function(){});
  });
})();`;
