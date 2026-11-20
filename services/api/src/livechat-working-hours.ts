export type LivechatWorkingHours={enabled:boolean;timeZone:string;start:string;end:string};

export const defaultWorkingHours:LivechatWorkingHours={enabled:false,timeZone:"Asia/Shanghai",start:"09:00",end:"18:00"};

// 使用渠道时区的墙上时间，自动遵循夏令时；开始包含、结束不包含。
export function isLivechatWorkingTime(hours:LivechatWorkingHours|null|undefined,now=new Date()):boolean{
  if(!hours?.enabled)return true;
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:hours.timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const time=parts.find(part=>part.type==="hour")!.value+":"+parts.find(part=>part.type==="minute")!.value;
  return hours.start<hours.end?time>=hours.start&&time<hours.end:time>=hours.start||time<hours.end;
}
