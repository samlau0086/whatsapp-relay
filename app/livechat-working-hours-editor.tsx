"use client";
import {FormField} from "./ui/form-field";
import type {LivechatWorkingHours} from "../services/api/src/livechat-working-hours";

const timeZones=[...new Set(["UTC","Asia/Shanghai",...Intl.supportedValuesOf("timeZone")])];

export function LivechatWorkingHoursEditor({value,onChange}:{value:LivechatWorkingHours;onChange:(value:LivechatWorkingHours)=>void}){
  return <section className="rd-livechat-hours livechat-editor-wide" aria-label="工作时段">
    <h3>工作时段</h3>
    <label className="rd-livechat-hours-toggle"><input type="checkbox" checked={value.enabled} onChange={event=>onChange({...value,enabled:event.target.checked})}/>启用工作时段</label>
    <FormField label="工作时区">{props=><select {...props} value={value.timeZone} onChange={event=>onChange({...value,timeZone:event.target.value})}>{[...new Set([value.timeZone,...timeZones])].map(zone=><option key={zone} value={zone}>{zone}</option>)}</select>}</FormField>
    <div className="rd-livechat-hours-times">
      <FormField label="每日开始时间">{props=><input {...props} type="time" required value={value.start} onChange={event=>onChange({...value,start:event.target.value})}/>}</FormField>
      <FormField label="每日结束时间" error={value.enabled&&value.start===value.end?"开始与结束时间不能相同":undefined}>{props=><input {...props} type="time" required value={value.end} onChange={event=>onChange({...value,end:event.target.value})}/>}</FormField>
    </div>
  </section>;
}
