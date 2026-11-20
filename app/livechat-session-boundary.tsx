"use client";

import {Mail} from "lucide-react";
import {Button} from "./ui/button";

export function LivechatSessionBoundary({id,onSend}:{id:string;onSend:()=>void}){
  return <section id={`message-${id}`} className="rd-livechat-boundary" aria-label="会话已结束">
    <div role="separator">-------Chat Ended-------</div>
    <Button size="compact" icon={Mail} onClick={onSend}>发送 transcript</Button>
  </section>;
}
