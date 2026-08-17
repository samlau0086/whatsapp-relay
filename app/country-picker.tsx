"use client";

import {ChevronDown,Search} from "lucide-react";
import {useId,useMemo,useState,type KeyboardEvent} from "react";

const COUNTRY_CODES=`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(" ");

const chineseNames=new Intl.DisplayNames(["zh-CN"],{type:"region"});
const englishNames=new Intl.DisplayNames(["en"],{type:"region"});
type CountryOption={code:string;chinese:string;english:string;searchText:string};

export const COUNTRY_OPTIONS:CountryOption[]=COUNTRY_CODES.map(code=>{
  const chinese=chineseNames.of(code)??code,english=englishNames.of(code)??code;
  return{code,chinese,english,searchText:`${code} ${chinese} ${english}`.toLocaleLowerCase()};
});

export function countryLabel(code:string){
  const country=COUNTRY_OPTIONS.find(item=>item.code===code.toUpperCase());
  return country?`${country.chinese} · ${country.english}`:code;
}

export function CountryPicker({value,onChange,label="搜索并选择国家/地区"}:{value:string;onChange:(value:string)=>void;label?:string}){
  const listboxId=useId(),[open,setOpen]=useState(false),[query,setQuery]=useState(""),[highlighted,setHighlighted]=useState(-1);
  const normalizedValue=value.trim().toUpperCase();
  const visible=useMemo(()=>{const term=query.trim().toLocaleLowerCase();return COUNTRY_OPTIONS.filter(item=>!term||item.searchText.includes(term));},[query]);
  function choose(code:string){onChange(code);setOpen(false);setQuery("");setHighlighted(-1);}
  function openPicker(){setOpen(true);setQuery("");setHighlighted(Math.max(0,COUNTRY_OPTIONS.findIndex(item=>item.code===normalizedValue)));}
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
    if(event.key==="Enter"&&open&&highlighted>=0&&visible[highlighted]){event.preventDefault();choose(visible[highlighted].code);}
  }
  return <div className="country-picker">
    <div className="country-search-field"><Search size={14}/><input type="search" value={open?query:countryLabel(normalizedValue)} placeholder="搜索中文、English 或代码" onFocus={openPicker} onChange={event=>{setOpen(true);setQuery(event.target.value);setHighlighted(0);}} onKeyDown={onKeyDown} onBlur={()=>window.setTimeout(()=>setOpen(false),120)} aria-label={label} role="combobox" aria-expanded={open} aria-controls={listboxId} aria-autocomplete="list" aria-activedescendant={open&&highlighted>=0?`${listboxId}-${highlighted}`:undefined} autoComplete="off"/><ChevronDown size={14}/></div>
    {open&&<div id={listboxId} className="country-options" role="listbox">
      {!query.trim()&&<button type="button" role="option" aria-selected={!normalizedValue} className={!normalizedValue?"selected":""} onMouseDown={event=>event.preventDefault()} onClick={()=>choose("")}><span><b>未设置</b><small>不指定国家/地区</small></span><em>—</em></button>}
      {visible.length?visible.map((country,index)=><button id={`${listboxId}-${index}`} type="button" role="option" aria-selected={country.code===normalizedValue} className={country.code===normalizedValue||index===highlighted?"selected":""} key={country.code} onMouseEnter={()=>setHighlighted(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(country.code)}><span><b>{country.chinese}</b><small>{country.english}</small></span><em>{country.code}</em></button>):<span className="country-empty">没有匹配的国家/地区</span>}
    </div>}
  </div>;
}
