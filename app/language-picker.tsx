"use client";

import {useId,useMemo,useState,type KeyboardEvent} from "react";

export const LANGUAGES=[
  ["zh-CN","简体中文"],["zh-TW","繁體中文"],["en","English"],["en-US","English (US)"],["en-GB","English (UK)"],
  ["ms","Bahasa Melayu"],["id","Bahasa Indonesia"],["th","ไทย"],["vi","Tiếng Việt"],["ja","日本語"],["ko","한국어"],
  ["es","Español"],["fr","Français"],["de","Deutsch"],["it","Italiano"],["pt","Português"],["pt-BR","Português (Brasil)"],["ru","Русский"],
  ["ar","العربية"],["hi","हिन्दी"],["tr","Türkçe"],["nl","Nederlands"],["pl","Polski"],
] as const;

export function languageName(code:string){return LANGUAGES.find(item=>item[0]===code)?.[1]??code;}
const LANGUAGE_COUNTRIES:Record<string,string>={zh:"CN",en:"US",ms:"MY",id:"ID",th:"TH",vi:"VN",ja:"JP",ko:"KR",es:"ES",fr:"FR",de:"DE",it:"IT",pt:"PT",ru:"RU",ar:"SA",hi:"IN",tr:"TR",nl:"NL",pl:"PL"};
export function languageShortCode(code:string){return code.split("-")[0]?.toUpperCase()??code.toUpperCase();}
export function languageCountryCode(code:string){
  const [language,...parts]=code.split("-"),region=parts.find(part=>/^[A-Za-z]{2}$/.test(part)),country=(region??LANGUAGE_COUNTRIES[language.toLowerCase()])?.toUpperCase();
  return country?.toLowerCase()??null;
}
export function LanguageFlagIcon({code,className=""}:{code:string;className?:string}){
  const country=languageCountryCode(code);
  return country?<span className={`language-flag fi fi-${country} ${className}`.trim()} role="img" aria-label={`${country.toUpperCase()} 国旗`}/>:<span className={`language-flag-fallback ${className}`.trim()} aria-hidden="true">🌐</span>;
}

export function LanguagePicker({value,onChange,label="搜索并选择语言",allowEmpty=false,placeholder="搜索语言名称或代码"}:{value:string;onChange:(value:string)=>void;label?:string;allowEmpty?:boolean;placeholder?:string}){
  const listboxId=useId(),[open,setOpen]=useState(false),[query,setQuery]=useState(""),[highlighted,setHighlighted]=useState(-1);
  const visible=useMemo(()=>{const term=query.trim().toLocaleLowerCase();return LANGUAGES.filter(([code,name])=>!term||`${name} ${code}`.toLocaleLowerCase().includes(term));},[query]);
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
