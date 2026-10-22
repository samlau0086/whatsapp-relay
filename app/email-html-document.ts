export type EmailInlineImage={contentId?:string;url:string};

export function emailHtmlDocument(html:string,images:EmailInlineImage[]=[]):string {
  // Only pass server-sanitized email HTML. Sandbox + CSP provide isolation even
  // if the original mail contains hostile CSS or malformed markup.
  const resolved=html.replace(/cid:([^"'\s<>]+)/gi,(_match,cid:string)=>{
    const normalize=(value:string)=>{try{return decodeURIComponent(value).replace(/^<|>$/g,"").toLowerCase();}catch{return value.toLowerCase();}};
    return images.find(image=>image.contentId&&normalize(image.contentId)===normalize(cid))?.url||"about:blank";
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{overflow-wrap:break-word}body{margin:0;padding:8px;box-sizing:border-box;font:14px/1.45 Arial,sans-serif;color:#222;background:#fff}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${resolved}</body></html>`;
}
