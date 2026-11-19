"use client";
import {useEffect,useRef,useState} from "react";
import {Link,RefreshCw} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import {AsyncState,Button,FormField} from "./ui";

const labels:Record<string,string>={queued:"等待回传",sending:"正在回传",accepted:"API 已接收，待处理",sent:"Google 处理成功（不代表已归因）",failed:"回传失败",uncertain:"结果不确定，未自动重发",skipped_consent:"已拒绝广告数据使用",skipped_config:"未配置或配置已变更",skipped_attribution:"无有效广告归因"};
type AdsData={mode:string;canRecord:boolean;attribution:null|{sourceConversationId:string;consent:string;available:boolean;lockedAt:string};candidates:{id:string;name:string;lockedAt:string}[];data:{id:string;event_name:string;delivery_state:string;created_at:string}[]};
export function GoogleAdsAttribution({conversationId,target,token,onToken,revision,busy}:{conversationId:string;target:string;token:string;onToken:(value:string)=>void;revision:number;busy:boolean}){
  const [data,setData]=useState<AdsData>(),[error,setError]=useState(""),[source,setSource]=useState(""),[saving,setSaving]=useState(false),[refresh,setRefresh]=useState(0);
  const linkLock=useRef(false);
  const pending=data?.data.some(e=>['queued','sending','accepted'].includes(e.delivery_state));
  useEffect(()=>{
    const controller=new AbortController();let reading=false;
    async function load(){if(reading)return;reading=true;try{
      const r=await authorizedFetch(`/api/v1/conversations/${conversationId}/ads-conversions?targetConversationId=${target}`,token,{signal:controller.signal});
      const body=await r.response.json();if(controller.signal.aborted)return;if(r.token!==token)onToken(r.token);
      if(!r.response.ok)throw Error(body.message??"读取 Ads 归因失败");setData(body);setError("");
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"读取失败");}finally{reading=false;}}
    void load();const timer=pending?setInterval(()=>void load(),4000):undefined;
    return()=>{controller.abort();clearInterval(timer);};
  },[conversationId,target,token,onToken,revision,refresh,pending]);
  async function link(){if(linkLock.current||busy||!source.trim())return;linkLock.current=true;setSaving(true);try{
    const r=await authorizedFetch(`/api/v1/conversations/${conversationId}/ads-attribution`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({targetConversationId:target,sourceConversationId:source.trim()})});
    const body=await r.response.json();if(r.token!==token)onToken(r.token);if(!r.response.ok)throw Error(body.message??body.error??"关联失败");setRefresh(v=>v+1);
  }catch(e){setError(e instanceof Error?e.message:"关联失败");}finally{linkLock.current=false;setSaving(false);}}
  return <div className="rd-ads-attribution"><h4>Google Ads</h4><AsyncState status={error?(data?'partial':'error'):data?'ready':'loading'} message={error||undefined} onRetry={()=>setRefresh(v=>v+1)}>
    {data&&<><p>{data.attribution?`${data.attribution.available?'已锁定广告访问':'未取得有效点击标识'} · ${data.attribution.consent==='denied'?'广告同意已拒绝':data.attribution.consent==='granted'?'广告同意已授予':'广告同意未设置'} · ${new Date(data.attribution.lockedAt).toLocaleString()}`:'尚未关联广告来源'}</p>
      {data.mode==='email'&&!data.attribution&&data.canRecord&&<><FormField label="原 LiveChat 会话 ID">{p=><input {...p} list={`rd-ads-sources-${target}`} value={source} disabled={saving||busy} onChange={e=>setSource(e.target.value)} />}</FormField><datalist id={`rd-ads-sources-${target}`}>{data.candidates.map(c=><option key={c.id} value={c.id}>{c.name} · {new Date(c.lockedAt).toLocaleString()}</option>)}</datalist><Button icon={Link} size="compact" loading={saving} disabled={busy||!source.trim()} onClick={()=>void link()}>确认关联</Button></>}
      <Button icon={RefreshCw} size="compact" disabled={saving} onClick={()=>setRefresh(v=>v+1)}>刷新 Ads 状态</Button>
      {data.data.length?<ul aria-label="Google Ads 转化历史">{data.data.map(e=><li key={e.id}><strong>{e.event_name}</strong><span>Ads：{labels[e.delivery_state]??e.delivery_state} · {new Date(e.created_at).toLocaleString()}</span></li>)}</ul>:<p>暂无 Ads 转化记录</p>}
    </>}
  </AsyncState></div>;
}
