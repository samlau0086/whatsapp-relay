export function parseCsv(text:string):string[][]{
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false;
  const source=text.replace(/^\uFEFF/,"");
  for(let index=0;index<source.length;index++){
    const char=source[index];
    if(quoted){
      if(char==='"'&&source[index+1]==='"'){field+='"';index++;}
      else if(char==='"')quoted=false;
      else field+=char;
    }else if(char==='"'&&!field)quoted=true;
    else if(char===","){row.push(field);field="";}
    else if(char==="\n"){row.push(field);if(row.some(value=>value.trim()))rows.push(row);row=[];field="";}
    else if(char!=="\r")field+=char;
  }
  row.push(field);if(row.some(value=>value.trim()))rows.push(row);
  return rows;
}

function csvCell(value:unknown){
  const text=String(value??"");
  return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}

export function downloadCsv(fileName:string,headers:string[],rows:unknown[][]){
  const csv=[headers,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8"}));
  const link=document.createElement("a");link.href=url;link.download=fileName;link.click();
  window.setTimeout(()=>URL.revokeObjectURL(url),0);
}

export function dateFileSuffix(){
  const now=new Date(),part=(value:number)=>String(value).padStart(2,"0");
  return`${now.getFullYear()}${part(now.getMonth()+1)}${part(now.getDate())}`;
}
