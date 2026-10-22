import sanitizeHtml from "sanitize-html";

// Display HTML is deliberately separate from the restricted composer format.
// It must only be rendered inside the sandboxed email frame, never the app DOM.
export function sanitizeEmailDisplayHtml(source:string):string {
  return sanitizeHtml(source, {
    allowedTags:[...sanitizeHtml.defaults.allowedTags,"html","head","body","style","img","center","font"],
    allowedAttributes:{
      "*":["style","class","id","align","valign","width","height","bgcolor","dir","lang","role"],
      a:["href","title","target","rel"],
      img:["src","alt","title","width","height","border"],
      table:["cellpadding","cellspacing","border","width","align","bgcolor","role"],
      td:["colspan","rowspan","width","height","align","valign","bgcolor"],
      th:["colspan","rowspan","scope"],font:["color","face","size"],
    },
    allowedSchemes:["http","https","mailto"],
    allowedSchemesByTag:{img:["https","http","cid"]},
    allowProtocolRelative:false,
    allowVulnerableTags:true, // Styles are contained by the frame's sandbox and CSP.
    transformTags:{a:(_tag,attrs)=>({tagName:"a",attribs:{...attrs,target:"_blank",rel:"noopener noreferrer"}})},
    exclusiveFilter:frame=>frame.tag==="blockquote"||/^(?:gmail_quote|gmail_attr|yahoo_quoted|moz-cite-prefix)$/.test(frame.attribs.id||"")
      ||/^(?:divRplyFwdMsg|yahoo_quoted)$/.test(frame.attribs.id||"")
      ||(frame.attribs.class||"").split(/\s+/).some(name=>["gmail_quote","gmail_attr","yahoo_quoted","moz-cite-prefix"].includes(name)),
  });
}

export function normalizeEmailCid(value:string):string {
  let decoded=value;
  try{decoded=decodeURIComponent(value);}catch{}
  return decoded.replace(/^cid:/i,"").replace(/^<|>$/g,"").trim().toLowerCase();
}
