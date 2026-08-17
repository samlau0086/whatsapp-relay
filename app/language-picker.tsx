"use client";

import {useId,useMemo,useState,type KeyboardEvent} from "react";

export const LANGUAGES=[
  ["zh-CN","简体中文","Simplified Chinese"],["zh-TW","繁體中文","Traditional Chinese"],
  ["en","English"],["en-US","English (US)"],["en-GB","English (UK)"],
  ["id","Bahasa Indonesia","Indonesian"],["ms","Bahasa Melayu","Malay"],["fil","Filipino"],["jv","Basa Jawa","Javanese"],
  ["th","ไทย","Thai"],["vi","Tiếng Việt","Vietnamese"],["km","ខ្មែរ","Khmer"],["lo","ລາວ","Lao"],["my","မြန်မာ","Burmese"],
  ["ja","日本語","Japanese"],["ko","한국어","Korean"],["mn","Монгол","Mongolian"],
  ["hi","हिन्दी","Hindi"],["bn","বাংলা","Bengali"],["gu","ગુજરાતી","Gujarati"],["kn","ಕನ್ನಡ","Kannada"],
  ["ml","മലയാളം","Malayalam"],["mr","मराठी","Marathi"],["ne","नेपाली","Nepali"],["pa","ਪੰਜਾਬੀ","Punjabi"],
  ["si","සිංහල","Sinhala"],["ta","தமிழ்","Tamil"],["te","తెలుగు","Telugu"],["ur","اردو","Urdu"],
  ["kk","Қазақша","Kazakh"],["ky","Кыргызча","Kyrgyz"],["uz","Oʻzbekcha","Uzbek"],
  ["es","Español","Spanish"],["fr","Français","French"],["de","Deutsch","German"],["it","Italiano","Italian"],
  ["pt","Português","Portuguese"],["pt-BR","Português (Brasil)","Brazilian Portuguese"],["nl","Nederlands","Dutch"],
  ["ca","Català","Catalan"],["eu","Euskara","Basque"],["gl","Galego","Galician"],
  ["da","Dansk","Danish"],["fi","Suomi","Finnish"],["is","Íslenska","Icelandic"],["no","Norsk","Norwegian"],["sv","Svenska","Swedish"],
  ["et","Eesti","Estonian"],["lv","Latviešu","Latvian"],["lt","Lietuvių","Lithuanian"],
  ["pl","Polski","Polish"],["cs","Čeština","Czech"],["sk","Slovenčina","Slovak"],["sl","Slovenščina","Slovenian"],
  ["hu","Magyar","Hungarian"],["ro","Română","Romanian"],["bg","Български","Bulgarian"],["el","Ελληνικά","Greek"],
  ["hr","Hrvatski","Croatian"],["bs","Bosanski","Bosnian"],["sr","Српски","Serbian"],["sq","Shqip","Albanian"],["mk","Македонски","Macedonian"],
  ["ru","Русский","Russian"],["uk","Українська","Ukrainian"],["be","Беларуская","Belarusian"],
  ["ga","Gaeilge","Irish"],["cy","Cymraeg","Welsh"],["mt","Malti","Maltese"],
  ["ar","العربية","Arabic"],["he","עברית","Hebrew"],["fa","فارسی","Persian Farsi"],["tr","Türkçe","Turkish"],
  ["az","Azərbaycanca","Azerbaijani"],["hy","Հայերեն","Armenian"],["ka","ქართული","Georgian"],["ku","Kurdî","Kurdish"],
  ["ps","پښتو","Pashto"],["sd","سنڌي","Sindhi"],
  ["af","Afrikaans"],["am","አማርኛ","Amharic"],["ha","Hausa"],["sw","Kiswahili","Swahili"],
  ["so","Soomaali","Somali"],["xh","isiXhosa","Xhosa"],["yo","Yorùbá","Yoruba"],["zu","isiZulu","Zulu"],
] as const;

export function languageName(code:string){return LANGUAGES.find(item=>item[0]===code)?.[1]??code;}
const LANGUAGE_COUNTRIES:Record<string,string>={
  zh:"CN",en:"US",id:"ID",ms:"MY",fil:"PH",jv:"ID",th:"TH",vi:"VN",km:"KH",lo:"LA",my:"MM",ja:"JP",ko:"KR",mn:"MN",
  hi:"IN",bn:"BD",gu:"IN",kn:"IN",ml:"IN",mr:"IN",ne:"NP",pa:"IN",si:"LK",ta:"IN",te:"IN",ur:"PK",kk:"KZ",ky:"KG",uz:"UZ",
  es:"ES",fr:"FR",de:"DE",it:"IT",pt:"PT",nl:"NL",ca:"ES",eu:"ES",gl:"ES",da:"DK",fi:"FI",is:"IS",no:"NO",sv:"SE",
  et:"EE",lv:"LV",lt:"LT",pl:"PL",cs:"CZ",sk:"SK",sl:"SI",hu:"HU",ro:"RO",bg:"BG",el:"GR",hr:"HR",bs:"BA",sr:"RS",sq:"AL",mk:"MK",
  ru:"RU",uk:"UA",be:"BY",ga:"IE",cy:"GB",mt:"MT",ar:"SA",he:"IL",fa:"IR",tr:"TR",az:"AZ",hy:"AM",ka:"GE",ku:"IQ",ps:"AF",sd:"PK",
  af:"ZA",am:"ET",ha:"NG",sw:"KE",so:"SO",xh:"ZA",yo:"NG",zu:"ZA",
};
export function languageShortCode(code:string){return code.split("-")[0]?.toUpperCase()??code.toUpperCase();}
export function languageCountryCode(code:string){
  const [language,...parts]=code.split("-"),region=parts.find(part=>/^[A-Za-z]{2}$/.test(part)),country=(region??LANGUAGE_COUNTRIES[language.toLowerCase()])?.toUpperCase();
  return country?.toLowerCase()??null;
}
export function LanguageFlagIcon({code,countryCode,title,className=""}:{code:string;countryCode?:string;title?:string;className?:string}){
  const explicitCountry=countryCode?.trim().toUpperCase();
  const country=/^[A-Z]{2}$/.test(explicitCountry??"")?explicitCountry.toLowerCase():languageCountryCode(code);
  return country?<span className={`language-flag fi fi-${country} ${className}`.trim()} role="img" title={title} aria-label={title||`${country.toUpperCase()} 国旗`}/>:<span className={`language-flag-fallback ${className}`.trim()} title={title} aria-hidden="true">🌐</span>;
}

export function LanguagePicker({value,onChange,label="搜索并选择语言",allowEmpty=false,placeholder="搜索语言名称或代码"}:{value:string;onChange:(value:string)=>void;label?:string;allowEmpty?:boolean;placeholder?:string}){
  const listboxId=useId(),[open,setOpen]=useState(false),[query,setQuery]=useState(""),[highlighted,setHighlighted]=useState(-1);
  const visible=useMemo(()=>{const term=query.trim().toLocaleLowerCase();return LANGUAGES.filter(([code,name,searchTerms])=>!term||`${name} ${code} ${searchTerms??""}`.toLocaleLowerCase().includes(term));},[query]);
  function choose(code:string){onChange(code);setOpen(false);setQuery("");setHighlighted(-1);}
  function openPicker(){setOpen(true);setQuery("");setHighlighted(Math.max(0,LANGUAGES.findIndex(([code])=>code===value)));}
  function onKeyDown(event:KeyboardEvent<HTMLInputElement>){
    if(event.key==="Escape"){setOpen(false);setQuery("");setHighlighted(-1);return;}
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();
      if(!open){openPicker();return;}
      if(!visible.length)return;
      const direction=event.key==="ArrowDown"?1:-1;
      setHighlighted(index=>index<0?(direction>0?0:visible.length-1):(index+direction+visible.length)%visible.length);
      return;
    }
    if(event.key==="Enter"&&open&&highlighted>=0&&visible[highlighted]){
      event.preventDefault();
      choose(visible[highlighted][0]);
    }
  }
  return <div className="language-picker"><input type="search" value={open?query:languageName(value)} placeholder={placeholder} onFocus={openPicker} onChange={event=>{setOpen(true);setQuery(event.target.value);setHighlighted(0);}} onKeyDown={onKeyDown} onBlur={()=>window.setTimeout(()=>setOpen(false),120)} aria-label={label} role="combobox" aria-expanded={open} aria-controls={listboxId} aria-autocomplete="list" aria-activedescendant={open&&highlighted>=0?`${listboxId}-${highlighted}`:undefined} autoComplete="off"/>{open&&<div id={listboxId} className="language-options" role="listbox">{allowEmpty&&!query.trim()&&<button type="button" role="option" aria-selected={!value} className={!value?"selected":""} onMouseDown={event=>event.preventDefault()} onClick={()=>choose("")}><span>未设置</span><small>—</small></button>}{visible.length?visible.map(([code,name],index)=><button id={`${listboxId}-${index}`} type="button" role="option" aria-selected={code===value} className={code===value||index===highlighted?"selected":""} key={code} onMouseEnter={()=>setHighlighted(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(code)}><span className="language-option-name"><LanguageFlagIcon code={code}/>{name}</span><small>{code}</small></button>):<span className="language-empty">没有匹配语言</span>}</div>}</div>;
}
