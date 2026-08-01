export type StatusSchedule={
  timezone:string;
  startDate:string;
  endDate:string;
  activeWeekdays:number[];
  dailyStart:string;
  dailyEnd:string;
  intervalMinutes:number;
};

export function isValidIanaTimeZone(value:string):boolean{
  try{new Intl.DateTimeFormat("en-US",{timeZone:value}).format();return true;}catch{return false;}
}

export function statusDateOnly(value:unknown):string{
  if(value instanceof Date){
    if(Number.isNaN(value.getTime()))return "";
    return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,"0")}-${String(value.getDate()).padStart(2,"0")}`;
  }
  return String(value).slice(0,10);
}

function localParts(date:Date,timeZone:string){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const get=(type:string)=>Number(parts.find(item=>item.type===type)?.value);
  return{year:get("year"),month:get("month"),day:get("day"),hour:get("hour"),minute:get("minute")};
}

export function zonedDate(year:number,month:number,day:number,hour:number,minute:number,timeZone:string):Date{
  let value=Date.UTC(year,month-1,day,hour,minute);
  for(let index=0;index<4;index++){
    const parts=localParts(new Date(value),timeZone);
    value+=Date.UTC(year,month-1,day,hour,minute)-Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute);
  }
  return new Date(value);
}

function parseDate(value:string):[number,number,number]{
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match)throw new Error("invalid_schedule_date");
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new Error("invalid_schedule_date");
  return[year,month,day];
}

function parseTime(value:string):number{
  const match=/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  if(!match)throw new Error("invalid_schedule_time");
  return Number(match[1])*60+Number(match[2]);
}

export function validateStatusSchedule(input:StatusSchedule):void{
  if(!isValidIanaTimeZone(input.timezone))throw new Error("invalid_timezone");
  const start=parseDate(input.startDate),end=parseDate(input.endDate);
  if(Date.UTC(...[start[0],start[1]-1,start[2]] as [number,number,number])>Date.UTC(...[end[0],end[1]-1,end[2]] as [number,number,number]))throw new Error("invalid_date_range");
  const from=parseTime(input.dailyStart),to=parseTime(input.dailyEnd);
  if(to<=from)throw new Error("overnight_window_not_supported");
  if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<1||input.intervalMinutes>10080)throw new Error("invalid_interval");
  if(!input.activeWeekdays.length||input.activeWeekdays.some(day=>!Number.isInteger(day)||day<0||day>6))throw new Error("invalid_weekdays");
}

export function generateStatusSlots(input:StatusSchedule,notBefore?:Date):Date[]{
  validateStatusSchedule(input);
  const [startYear,startMonth,startDay]=parseDate(input.startDate),[endYear,endMonth,endDay]=parseDate(input.endDate);
  const cursor=new Date(Date.UTC(startYear,startMonth-1,startDay)),end=Date.UTC(endYear,endMonth-1,endDay);
  const from=parseTime(input.dailyStart),to=parseTime(input.dailyEnd),weekdays=new Set(input.activeWeekdays);
  const slots:Date[]=[],seen=new Set<number>();
  while(cursor.getTime()<=end){
    if(weekdays.has(cursor.getUTCDay())){
      for(let minute=from;minute<=to;minute+=input.intervalMinutes){
        const slot=zonedDate(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,cursor.getUTCDate(),Math.floor(minute/60),minute%60,input.timezone);
        const parts=localParts(slot,input.timezone),matches=parts.year===cursor.getUTCFullYear()&&parts.month===cursor.getUTCMonth()+1&&parts.day===cursor.getUTCDate()&&parts.hour===Math.floor(minute/60)&&parts.minute===minute%60;
        if(matches&&!seen.has(slot.getTime())&&(!notBefore||slot>=notBefore)){slots.push(slot);seen.add(slot.getTime());}
      }
    }
    cursor.setUTCDate(cursor.getUTCDate()+1);
  }
  return slots;
}
