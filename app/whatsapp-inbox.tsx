"use client";

import {
  Archive, Bell, Bookmark, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, FileText,
  Inbox, Info, Languages, Menu, MessageCircle, Mic, MonitorSmartphone, Paperclip, Phone, Plus,
  Pencil, RefreshCw, Search, Send, Settings, ShieldCheck, ShoppingBag, Smile, Sparkles, Star, Trash2, UploadCloud, UserPlus,
  Users, Wifi, WifiOff, X, ClipboardList, ExternalLink, Bot, Brain, BookOpen, MapPin, Copy, CreditCard,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { OrderTemplateEditor, type TemplateFormat } from "./order-template-editor";
import { ProductCardTemplateEditor } from "./product-card-template-editor";
import { ProductCardSendDialog } from "./product-card-send-dialog";
import { ProductEditorDialog } from "./product-editor-dialog";
import { ProductImportDialog } from "./product-import-dialog";
import { ProductImageMediaDialog } from "./product-image-media-dialog";

const API_URL = (process.env.NEXT_PUBLIC_RELAY_API_URL ?? "").replace(/\/$/, "");
const COLORS = ["#6b4f3a", "#305f72", "#9b5f72", "#477a62", "#705b86"];
let refreshPromise:Promise<string>|null=null;

type Account = { id:string; name:string; phone:string; status:string; reason:string; lastEvent?:string };
type Conversation = {
  id:string; name:string; initials:string; color:string; account:string; accountId:string; phone:string;
  alias:string; contactName:string;
  preview:string; time:string; unread:number; accountStatus:string; assignedUserId:string|null;
  favorite:boolean; conversationStatus:string; customerStage:string; tags:TagItem[]; remindAt:string|null;
};
type TagItem={id:string;name:string;color:string};
type ProductPriceTier={minQuantity:number;unitAmount:number};
type ProductItem={id:string;sku:string;name:string;description:string;defaultUnitAmount:number;priceTiers:ProductPriceTier[];currency:string;imageMediaId:string|null;imageName:string;tags:TagItem[];createdAt:string;updatedAt:string};
type NoteItem={id:string;body:string;userId:string|null;authorName:string;createdAt:string;updatedAt:string};
type OrderProductItem={id:string;name:string;quantity:number;unitAmount:number;imageMediaId:string|null;imageName:string;productId:string|null};
type OrderFeeItem={id:string;name:string;amount:number};
type CustomerAddress={id:string;label:string;recipientName:string;phone:string;address:string};
type PaymentRequest={id:string;invoiceId:string|null;url:string|null;status:string;amount:number;currency:string;environment:string;createdAt:string;lastSyncedAt:string|null};
type OrderItem={id:string;orderNumber:string;conversationId:string;accountId:string;accountName:string;customerName:string;customerPhone:string;amount:number;currency:string;description:string;status:string;sendFormat:string;translateOnSend:boolean;targetLanguage:string;createdAt:string;createdByName:string;messageStatus:string;items:OrderProductItem[];fees:OrderFeeItem[];addressId:string|null;address:CustomerAddress|null;paymentRequest:PaymentRequest|null};
type OrderSendTarget={order:OrderItem};
type ConversationDetails={customerStage:string;tags:TagItem[];notes:NoteItem[];reminder:{id:string;remindAt:string;createdAt:string;updatedAt:string}|null;orders:OrderItem[]};
type ChatMessage = {
  id:string; direction:"in"|"out"; kind:string; text:string; time:string;
  translationSourceText?:string;
  status?:"received"|"queued"|"dispatching"|"sent"|"delivered"|"read"|"failed"|"uncertain";
  attachment?:{id:string;name:string;size:string;mime:string};
};
type User = {id:string;email:string;displayName:string;role:string};
type WorkspaceView = "inbox"|"orders"|"products"|"agents"|"settings"|"help";
type ManagedAgent = {id:string;name:string;status:string;version?:string;protocol_version?:number;platform?:string;last_seen_at?:string;last_acked_cursor:number;created_at:string;accounts:Array<{id:string;display_name:string;phone_e164?:string;status:string;status_reason?:string;last_event_at?:string}>};
type MediaAsset = {id:string;fileName:string;mimeType:string;size:number;sha256:string;createdAt:string;usageCount:number};
type TtsProviderId="openai"|"elevenlabs"|"azure"|"openai_compatible";
type TtsProviderConfig={provider:TtsProviderId;enabled:boolean;keyConfigured:boolean;baseUrl:string;model:string;voice:string;updatedAt:string|null};
type TranslationProviderId="openai"|"openai_compatible";
type TranslationProviderConfig={provider:TranslationProviderId;enabled:boolean;keyConfigured:boolean;baseUrl:string;model:string;transcriptionModel:string;updatedAt:string|null};
type TranslationPreference={enabled:boolean;agentLanguage:string;customerLanguage:string;updatedAt:string|null};
type CurrencyItem={code:string;name:string;rate:number};
type CurrencyConfig={baseCurrency:string;currencies:CurrencyItem[];rateSource?:string|null;rateDate?:string|null;rateUpdatedAt?:string|null};
type MessageTranslation={status:"idle"|"loading"|"translated"|"failed";text?:string;sourceText?:string;message?:string};
type KnowledgeBaseItem={id:string;name:string;description:string;document_count?:number;faq_count?:number};
type AgentDraft={id:string;text_content:string;reply_zh:string|null;reason:string;citations:string[];created_at:string};
const DEFAULT_TRANSLATION_PREFERENCE:TranslationPreference={enabled:false,agentLanguage:"zh-CN",customerLanguage:"en",updatedAt:null};
const DEFAULT_CURRENCY_CONFIG:CurrencyConfig={baseCurrency:"USD",currencies:[{code:"USD",name:"美元",rate:1},{code:"CNY",name:"人民币",rate:7.2},{code:"EUR",name:"欧元",rate:.92},{code:"GBP",name:"英镑",rate:.78},{code:"JPY",name:"日元",rate:157},{code:"HKD",name:"港币",rate:7.8},{code:"SGD",name:"新加坡元",rate:1.35},{code:"AUD",name:"澳元",rate:1.5},{code:"CAD",name:"加元",rate:1.37},{code:"AED",name:"阿联酋迪拉姆",rate:3.6725}]};

function convertCurrency(amount:number,from:string,to:string,config:CurrencyConfig):number{if(from===to)return amount;const source=config.currencies.find(item=>item.code===from)?.rate,target=config.currencies.find(item=>item.code===to)?.rate;if(!source||!target)return amount;return amount/source*target;}

function mapOrder(item:Record<string,unknown>,defaults:Partial<OrderItem>={}):OrderItem{return{
  id:String(item.id),orderNumber:String(item.display_order_number??item.order_number??""),conversationId:String(item.conversation_id??defaults.conversationId??""),accountId:String(item.account_id??defaults.accountId??""),accountName:String(item.account_name??defaults.accountName??""),customerName:String(item.customer_name??defaults.customerName??""),customerPhone:String(item.customer_phone??defaults.customerPhone??""),amount:Number(item.amount),currency:String(item.currency),description:String(item.description??""),status:String(item.status??"draft"),sendFormat:String(item.send_format??""),translateOnSend:Boolean(item.translate_on_send),targetLanguage:String(item.target_language??""),createdAt:String(item.created_at),createdByName:String(item.created_by_name??"已离职坐席"),messageStatus:String(item.message_status??item.status??"draft"),items:Array.isArray(item.items)?(item.items as Array<Record<string,unknown>>).map(product=>({id:String(product.id),name:String(product.name),quantity:Number(product.quantity),unitAmount:Number(product.unitAmount),imageMediaId:product.imageMediaId?String(product.imageMediaId):null,imageName:String(product.imageName??""),productId:product.productId?String(product.productId):null})):[],fees:Array.isArray(item.fees)?(item.fees as Array<Record<string,unknown>>).map(fee=>({id:String(fee.id),name:String(fee.name),amount:Number(fee.amount)})):[],addressId:item.address_id?String(item.address_id):null,address:item.shipping_address_snapshot?mapCustomerAddress(item.shipping_address_snapshot as Record<string,unknown>,item.address_id?String(item.address_id):""):null,paymentRequest:item.payment_request?mapPaymentRequest(item.payment_request as Record<string,unknown>):defaults.paymentRequest??null,
};}

function mapPaymentRequest(item:Record<string,unknown>):PaymentRequest{return{id:String(item.id),invoiceId:item.invoiceId?String(item.invoiceId):null,url:item.url?String(item.url):null,status:String(item.status??"UNKNOWN"),amount:Number(item.amount),currency:String(item.currency),environment:String(item.environment??"sandbox"),createdAt:String(item.createdAt??""),lastSyncedAt:item.lastSyncedAt?String(item.lastSyncedAt):null};}

function mapCustomerAddress(item:Record<string,unknown>,id=String(item.id??"")):CustomerAddress{return{id,label:String(item.label??"地址"),recipientName:String(item.recipientName??item.recipient_name??""),phone:String(item.phone??""),address:String(item.address??"")};}

export function WhatsAppInbox() {
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const [messages,setMessages]=useState<Record<string,ChatMessage[]>>({});
  const [activeId,setActiveId]=useState("");
  const [selectedAccount,setSelectedAccount]=useState("");
  const [filter,setFilter]=useState("全部会话");
  const [query,setQuery]=useState("");
  const [draft,setDraft]=useState("");
  const [detailsOpen,setDetailsOpen]=useState(true);
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [toast,setToast]=useState("");
  const [apiToken,setApiToken]=useState("");
  const [user,setUser]=useState<User|null>(null);
  const [authOpen,setAuthOpen]=useState(false);
  const [sessionReady,setSessionReady]=useState(false);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState("");
  const [view,setView]=useState<WorkspaceView>("inbox");
  const [newConversationOpen,setNewConversationOpen]=useState(false);
  const [mediaOpen,setMediaOpen]=useState(false);
  const [productCardsOpen,setProductCardsOpen]=useState(false);
  const [ttsOpen,setTtsOpen]=useState(false);
  const [emojiOpen,setEmojiOpen]=useState(false);
  const [emojiCategory,setEmojiCategory]=useState("常用");
  const [translationPreferences,setTranslationPreferences]=useState<Record<string,TranslationPreference>>({});
  const [translationConfigured,setTranslationConfigured]=useState(false);
  const [translationReadyConversationId,setTranslationReadyConversationId]=useState("");
  const [translationMenuOpen,setTranslationMenuOpen]=useState(false);
  const [messageTranslations,setMessageTranslations]=useState<Record<string,MessageTranslation>>({});
  const [translationPreview,setTranslationPreview]=useState<{source:string;translated:string}|null>(null);
  const [translatingDraft,setTranslatingDraft]=useState(false);
  const [translationError,setTranslationError]=useState("");
  const [clock,setClock]=useState(()=>Date.now());
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const messagesRef=useRef<HTMLDivElement>(null);
  const translationLoadSequence=useRef(0);
  const notifiedReminders=useRef(new Set<string>());

  const userId=user?.id??tokenSubject(apiToken);
  const counts=useMemo(()=>({
    all:conversations.filter(item=>item.conversationStatus!=="archived").length,
    mine:conversations.filter(item=>item.assignedUserId===userId).length,
    unassigned:conversations.filter(item=>!item.assignedUserId).length,
    favorite:conversations.filter(item=>item.favorite).length,
    closed:conversations.filter(item=>item.conversationStatus==="closed").length,
    archived:conversations.filter(item=>item.conversationStatus==="archived").length,
    reminders:conversations.filter(item=>item.remindAt).length,
  }),[conversations,userId]);
  const visible=useMemo(()=>conversations.filter(item=>{
    if(selectedAccount&&item.accountId!==selectedAccount)return false;
    if(!`${item.name} ${item.phone} ${item.preview}`.toLowerCase().includes(query.toLowerCase()))return false;
    if(filter==="分配给我")return item.assignedUserId===userId;
    if(filter==="未分配")return !item.assignedUserId;
    if(filter==="收藏")return item.favorite;
    if(filter==="已关闭")return item.conversationStatus==="closed";
    if(filter==="已归档")return item.conversationStatus==="archived";
    if(filter==="我的提醒")return Boolean(item.remindAt);
    return item.conversationStatus!=="archived";
  }).sort((a,b)=>filter==="我的提醒"?new Date(a.remindAt??8640000000000000).getTime()-new Date(b.remindAt??8640000000000000).getTime():0),[conversations,selectedAccount,query,filter,userId]);
  const effectiveActiveId=visible.some(item=>item.id===activeId)?activeId:(visible[0]?.id??"");
  const active=visible.find(item=>item.id===effectiveActiveId)??null;
  const translationPreference=active?translationPreferences[active.id]??DEFAULT_TRANSLATION_PREFERENCE:DEFAULT_TRANSLATION_PREFERENCE;
  const translationReady=Boolean(active&&translationReadyConversationId===active.id);
  const currentMessages=useMemo(()=>active?messages[active.id]??[]:[],[active,messages]);
  const latestMessageId=currentMessages.at(-1)?.id??"";
  const scrollMessagesToEnd=useCallback((behavior:ScrollBehavior="smooth")=>{
    window.requestAnimationFrame(()=>{
      const container=messagesRef.current;
      if(container)container.scrollTo({top:container.scrollHeight,behavior});
    });
  },[]);

  useLayoutEffect(()=>{
    if(!effectiveActiveId)return;
    const container=messagesRef.current;
    if(container)container.scrollTop=container.scrollHeight;
  },[effectiveActiveId,latestMessageId]);

  useEffect(()=>{
    if(latestMessageId)scrollMessagesToEnd("smooth");
  },[latestMessageId,scrollMessagesToEnd]);

  const logout=useCallback(()=>{
    sessionStorage.removeItem("relayAccessToken");sessionStorage.removeItem("relayUser");
    setApiToken("");setUser(null);setAccounts([]);setConversations([]);setMessages({});setMessageTranslations({});setTranslationPreferences({});setTranslationReadyConversationId("");setActiveId("");setAuthOpen(false);setSessionReady(true);setLoading(false);
  },[]);

  const loadWorkspace=useCallback(async(token:string,quiet=false)=>{
    if(!quiet)setLoading(true);setLoadError("");
    try{
      const [accountResult,conversationResult]=await Promise.all([
        authorizedFetch("/api/v1/accounts",token),authorizedFetch("/api/v1/conversations?limit=100",token),
      ]);
      const accountResponse=accountResult.response,conversationResponse=conversationResult.response;
      const refreshedToken=accountResult.token!==token?accountResult.token:conversationResult.token;
      if(refreshedToken!==token)setApiToken(refreshedToken);
      if(accountResponse.status===401||conversationResponse.status===401){logout();return;}
      if(!accountResponse.ok||!conversationResponse.ok)throw new Error(`中心 API 响应异常（${accountResponse.status}/${conversationResponse.status}）`);
      const accountBody=await accountResponse.json() as {data:Array<Record<string,unknown>>};
      const conversationBody=await conversationResponse.json() as {data:Array<Record<string,unknown>>};
      setAccounts(accountBody.data.map(item=>({id:String(item.id),name:String(item.display_name),phone:String(item.phone_e164??""),status:String(item.status),reason:String(item.status_reason??""),lastEvent:item.last_event_at?String(item.last_event_at):undefined})));
      const mapped=conversationBody.data.map((item,index)=>mapConversation(item,index));
      setConversations(mapped);setActiveId(previous=>mapped.some(item=>item.id===previous)?previous:(mapped[0]?.id??""));
    }catch(error){setLoadError(error instanceof Error?error.message:"中心数据加载失败");}
    finally{if(!quiet)setLoading(false);}
  },[logout]);

  const loadMessages=useCallback(async(token:string,conversationId:string,markRead=false)=>{
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/messages?limit=100`,token);
      const response=result.response;if(result.token!==token)setApiToken(result.token);
      if(response.status===401){logout();return;}if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.json() as {data:Array<Record<string,unknown>>};
      setMessages(all=>({...all,[conversationId]:body.data.map(mapMessage)}));
      if(markRead)await authorizedFetch(`/api/v1/conversations/${conversationId}`,result.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({read:true})});
    }catch{setToast("消息加载失败，正在等待下次同步");}
  },[logout]);

  const loadTranslationSettings=useCallback(async(token:string,conversationId:string)=>{
    const sequence=++translationLoadSequence.current;
    try{
      const [preferenceResult,statusResult]=await Promise.all([authorizedFetch(`/api/v1/me/translation-preferences?conversationId=${encodeURIComponent(conversationId)}`,token),authorizedFetch("/api/v1/translation/status",token)]);
      const refreshedToken=preferenceResult.token!==token?preferenceResult.token:statusResult.token;if(refreshedToken!==token)setApiToken(refreshedToken);
      const preferenceBody=await preferenceResult.response.json() as Partial<TranslationPreference>;
      const statusBody=await statusResult.response.json() as {configured?:boolean};
      if(preferenceResult.response.ok)setTranslationPreferences(all=>({...all,[conversationId]:{enabled:Boolean(preferenceBody.enabled),agentLanguage:preferenceBody.agentLanguage??"zh-CN",customerLanguage:preferenceBody.customerLanguage??"en",updatedAt:preferenceBody.updatedAt??null}}));
      if(sequence===translationLoadSequence.current){setTranslationConfigured(Boolean(statusBody.configured));setTranslationReadyConversationId(conversationId);}
    }catch{if(sequence===translationLoadSequence.current){setTranslationConfigured(false);setTranslationReadyConversationId(conversationId);}}
  },[]);

  const loadIncomingTranslations=useCallback(async(token:string,messageIds:string[],targetLanguage:string,retry=false,generateAudio=false)=>{
    const ids=messageIds.filter(id=>retry||!messageTranslations[id]);if(!ids.length)return;
    setMessageTranslations(all=>({...all,...Object.fromEntries(ids.map(id=>[id,{status:"loading" as const}]))}));
    let accessToken=token;
    for(let offset=0;offset<ids.length;offset+=50){const chunk=ids.slice(offset,offset+50);try{
      const result=await authorizedFetch("/api/v1/translations/messages",accessToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messageIds:chunk,targetLanguage,generateAudio})});accessToken=result.token;if(result.token!==token)setApiToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {data?:Array<{messageId:string;status:string;translatedText?:string;sourceText?:string;message?:string}>;message?:string};
      if(!result.response.ok||!body.data){setMessageTranslations(all=>({...all,...Object.fromEntries(chunk.map(id=>[id,{status:"failed" as const,message:body.message??"翻译服务暂时不可用"}]))}));continue;}
      setMessageTranslations(all=>({...all,...Object.fromEntries(body.data!.map(item=>[item.messageId,item.status==="translated"?{status:"translated" as const,text:item.translatedText??"",sourceText:item.sourceText}:item.status==="skipped"?{status:"idle" as const}:{status:"failed" as const,message:item.message}]))}));
    }catch{setMessageTranslations(all=>({...all,...Object.fromEntries(chunk.map(id=>[id,{status:"failed" as const}]))}));}}
  },[messageTranslations]);

  useEffect(()=>{
    const timer=window.setTimeout(()=>{
      const token=sessionStorage.getItem("relayAccessToken")??"";
      const storedUser=sessionStorage.getItem("relayUser");
      if(!token){setLoading(false);setSessionReady(true);return;}
      setApiToken(token);if(storedUser)try{setUser(JSON.parse(storedUser) as User);}catch{}
      setAuthOpen(false);setSessionReady(true);void loadWorkspace(token);
    },0);
    return()=>window.clearTimeout(timer);
  },[loadWorkspace]);
  useEffect(()=>{const timer=window.setTimeout(()=>{if(window.matchMedia("(max-width: 1280px)").matches)setDetailsOpen(false);},0);return()=>window.clearTimeout(timer);},[]);

  useEffect(()=>{if(!apiToken)return;const timer=window.setInterval(()=>void loadWorkspace(apiToken,true),5000);return()=>window.clearInterval(timer);},[apiToken,loadWorkspace]);
  useEffect(()=>{if(!apiToken||!effectiveActiveId)return;const initial=window.setTimeout(()=>void loadMessages(apiToken,effectiveActiveId,true),0);const timer=window.setInterval(()=>void loadMessages(apiToken,effectiveActiveId),3000);return()=>{window.clearTimeout(initial);window.clearInterval(timer);};},[apiToken,effectiveActiveId,loadMessages]);
  useEffect(()=>{if(!apiToken||!effectiveActiveId)return;const timer=window.setTimeout(()=>void loadTranslationSettings(apiToken,effectiveActiveId),0);return()=>window.clearTimeout(timer);},[apiToken,view,effectiveActiveId,loadTranslationSettings]);
  useEffect(()=>{const timer=window.setTimeout(()=>setMessageTranslations({}),0);return()=>window.clearTimeout(timer);},[translationPreference.agentLanguage]);
  useEffect(()=>{if(!apiToken||!translationPreference.enabled||!translationConfigured)return;const ids=currentMessages.filter(message=>message.direction==="in"&&((message.kind==="text"&&message.text.trim())||(message.kind==="audio"&&message.attachment))&&!messageTranslations[message.id]).map(message=>message.id);if(!ids.length)return;const timer=window.setTimeout(()=>void loadIncomingTranslations(apiToken,ids,translationPreference.agentLanguage),0);return()=>window.clearTimeout(timer);},[apiToken,currentMessages,translationPreference.enabled,translationPreference.agentLanguage,translationConfigured,messageTranslations,loadIncomingTranslations]);
  useEffect(()=>{if(!toast)return;const timer=window.setTimeout(()=>setToast(""),3200);return()=>window.clearTimeout(timer);},[toast]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),30_000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{const due=conversations.find(item=>item.remindAt&&new Date(item.remindAt).getTime()<=Date.now()&&!notifiedReminders.current.has(item.id));if(due){notifiedReminders.current.add(due.id);setToast(`${due.name} 的会话提醒已到期`);}},[conversations]);

  async function updateConversation(change:Record<string,unknown>){
    if(!active||!apiToken)return;
    const result=await authorizedFetch(`/api/v1/conversations/${active.id}`,apiToken,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(change)});const response=result.response;if(result.token!==apiToken)setApiToken(result.token);
    if(!response.ok){setToast(`操作失败（HTTP ${response.status}）`);return;}await loadWorkspace(apiToken,true);
  }

  async function saveTranslationPreference(next:TranslationPreference){
    if(!apiToken||!active)return;if(next.enabled&&!translationConfigured){setToast("管理员尚未启用 AI 翻译 Provider");return;}
    const conversationId=active.id,previous=translationPreferences[conversationId]??DEFAULT_TRANSLATION_PREFERENCE;setTranslationPreferences(all=>({...all,[conversationId]:next}));
    const result=await authorizedFetch("/api/v1/me/translation-preferences",apiToken,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({conversationId,enabled:next.enabled,agentLanguage:next.agentLanguage,customerLanguage:next.customerLanguage})});if(result.token!==apiToken)setApiToken(result.token);
    if(!result.response.ok){setTranslationPreferences(all=>({...all,[conversationId]:previous}));const body=await result.response.json().catch(()=>({})) as {message?:string};setToast(body.message??"该会话的翻译偏好保存失败");return;}
    const body=await result.response.json() as TranslationPreference;setTranslationPreferences(all=>({...all,[conversationId]:body}));
  }

  async function sendMessage(){
    if(!active||!apiToken||!draft.trim()||translatingDraft)return;
    const source=draft.trim();
    if(translationPreference.enabled){
      if(!translationConfigured){setToast("AI 翻译暂不可用，请联系管理员配置 Provider");return;}
      setTranslatingDraft(true);setTranslationError("");
      try{const result=await authorizedFetch("/api/v1/translations/preview",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:source,targetLanguage:translationPreference.customerLanguage})});if(result.token!==apiToken)setApiToken(result.token);const body=await result.response.json().catch(()=>({})) as {translatedText?:string;message?:string};if(!result.response.ok||!body.translatedText)throw new Error(body.message??"翻译失败");setTranslationPreview({source,translated:body.translatedText});}catch(reason){setTranslationError(reason instanceof Error?reason.message:"翻译失败");setToast("AI 翻译失败，原文未发送");}finally{setTranslatingDraft(false);}return;
    }
    await queueTextMessage(source);
  }

  async function queueTextMessage(text:string,translationSourceText?:string){
    if(!active||!apiToken||!text.trim())return;
    const clientMessageId=crypto.randomUUID();setDraft("");setTranslationPreview(null);setTranslationError("");
    setMessages(all=>({...all,[active.id]:[...(all[active.id]??[]),{id:clientMessageId,direction:"out",kind:"text",text,translationSourceText,time:formatTime(new Date()),status:"queued"}]}));
    const result=await authorizedFetch("/api/v1/messages",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:active.accountId,conversationId:active.id,clientMessageId,type:"text",text,...(translationSourceText?{translationSourceText}:{})})});const response=result.response;if(result.token!==apiToken)setApiToken(result.token);
    if(!response.ok){setToast(`消息入队失败（HTTP ${response.status}）`);setMessages(all=>({...all,[active.id]:(all[active.id]??[]).map(item=>item.id===clientMessageId?{...item,status:"failed"}:item)}));return;}
    setToast(active.accountStatus==="online"?"消息已进入发送队列":"账号离线，消息已持久化排队");void loadMessages(apiToken,active.id);
  }

  async function sendMediaAsset(asset:MediaAsset,caption:string){
    if(!active||!apiToken)return;
    const kind=mediaKind(asset.mimeType),clientMessageId=crypto.randomUUID();setDraft("");
    setMessages(all=>({...all,[active.id]:[...(all[active.id]??[]),{id:clientMessageId,direction:"out",kind,text:caption,time:formatTime(new Date()),status:"queued",attachment:{id:asset.id,name:asset.fileName,mime:asset.mimeType,size:formatBytes(asset.size)}}]}));
    const queued=await authorizedFetch("/api/v1/messages",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:active.accountId,conversationId:active.id,clientMessageId,type:kind,text:caption||undefined,mediaId:asset.id})});if(queued.token!==apiToken)setApiToken(queued.token);
    if(!queued.response.ok){setToast(`附件消息入队失败（HTTP ${queued.response.status}）`);setMessages(all=>({...all,[active.id]:(all[active.id]??[]).map(item=>item.id===clientMessageId?{...item,status:"failed"}:item)}));return;}
    setMediaOpen(false);setToast(active.accountStatus==="online"?"附件已进入发送队列":"账号离线，附件已持久化排队");void loadMessages(queued.token,active.id);
  }

  function insertEmoji(emoji:string){const input=textareaRef.current,start=input?.selectionStart??draft.length,end=input?.selectionEnd??start;setDraft(`${draft.slice(0,start)}${emoji}${draft.slice(end)}`);requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(start+emoji.length,start+emoji.length);});}

  const onlineCount=accounts.filter(item=>item.status==="online").length;
  const profileText=(user?.displayName||user?.email||"坐席").slice(0,1).toUpperCase();
  const userRole=user?.role||tokenRole(apiToken);
  const openInbox=(nextFilter="全部会话")=>{setView("inbox");setFilter(nextFilter);};
  const completeLogin=(token:string,nextUser:User)=>{sessionStorage.setItem("relayAccessToken",token);sessionStorage.setItem("relayUser",JSON.stringify(nextUser));setApiToken(token);setUser(nextUser);setAuthOpen(false);setSessionReady(true);void loadWorkspace(token);};

  if(!sessionReady)return <AccessPortal loading onLogin={()=>{}}/>;
  if(!apiToken)return <><AccessPortal loading={false} onLogin={()=>setAuthOpen(true)}/>{authOpen&&<LoginDialog connected={false} token="" canClose onClose={()=>setAuthOpen(false)} onLogin={completeLogin} onLogout={logout}/>}</>;

  return <main className="relay-shell">
    {toast&&<div className="toast"><Check size={15}/>{toast}</div>}
    <nav className="rail" aria-label="全局导航"><button className="brand-mark" onClick={()=>openInbox()} aria-label="RelayDesk 消息中心"><Sparkles size={19}/></button><div className="rail-nav">
      <button className={view==="inbox"&&filter==="全部会话"?"rail-button active":"rail-button"} onClick={()=>openInbox()} aria-label="消息中心" title="消息中心"><MessageCircle size={18}/></button>
      <button className={view==="orders"?"rail-button active":"rail-button"} onClick={()=>setView("orders")} aria-label="订单管理" title="订单管理"><ClipboardList size={18}/></button>
      <button className={view==="products"?"rail-button active":"rail-button"} onClick={()=>setView("products")} aria-label="产品库" title="产品库"><ShoppingBag size={18}/></button>
      <button className={view==="agents"?"rail-button active":"rail-button"} onClick={()=>setView("agents")} aria-label="Agent 管理" title="Agent 管理"><MonitorSmartphone size={18}/></button>
      <button className="rail-button" onClick={()=>{openInbox();window.setTimeout(()=>{const composer=document.querySelector<HTMLTextAreaElement>(".composer textarea");if(composer)composer.focus();else setToast("请先选择一个真实会话");},0);}} aria-label="发送消息" title="发送消息"><Send size={18}/></button>
      <button className={view==="inbox"&&filter==="收藏"?"rail-button active":"rail-button"} onClick={()=>openInbox("收藏")} aria-label="收藏会话" title="收藏会话"><Star size={18}/></button>
      <button className={view==="inbox"&&filter==="已关闭"?"rail-button active":"rail-button"} onClick={()=>openInbox("已关闭")} aria-label="已关闭会话" title="已关闭会话"><Clock3 size={18}/></button>
      <button className={view==="inbox"&&filter==="已归档"?"rail-button active":"rail-button"} onClick={()=>openInbox("已归档")} aria-label="已归档会话" title="已归档会话"><Archive size={18}/></button>
    </div><div className="rail-bottom"><button className={view==="help"?"rail-button active":"rail-button"} onClick={()=>setView("help")} aria-label="帮助" title="帮助"><CircleHelp size={18}/></button><button className={view==="settings"?"rail-button active":"rail-button"} onClick={()=>setView("settings")} aria-label="系统设置" title="系统设置"><Settings size={18}/></button><button className="profile-button" onClick={()=>setAuthOpen(true)} aria-label="账户"><span className="avatar small coral">{profileText}</span></button></div></nav>

    {view==="inbox"?<><aside className={`filters ${sidebarOpen?"mobile-open":""}`}><div className="mobile-filter-head"><b>收件箱</b><button onClick={()=>setSidebarOpen(false)} aria-label="关闭筛选"><X size={18}/></button></div><div className="workspace-title"><div><span className="eyebrow">工作空间</span><h1>消息中心</h1></div><button onClick={()=>setNewConversationOpen(true)} aria-label="新建会话" title="新建会话"><Plus size={16}/></button></div>
      <label className="account-switcher"><span className="wa-dot"><Phone size={13}/></span><span><b>WhatsApp 账号</b><small>{onlineCount} 在线 · {accounts.length-onlineCount} 离线</small></span><ChevronDown size={15}/><select aria-label="筛选 WhatsApp 账号" value={selectedAccount} onChange={event=>setSelectedAccount(event.target.value)}><option value="">全部账号</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <section><p className="section-label">收件箱</p>{[
        {label:"全部会话",icon:Inbox,count:counts.all},{label:"分配给我",icon:Users,count:counts.mine},{label:"未分配",icon:UserPlus,count:counts.unassigned},{label:"我的提醒",icon:Bell,count:counts.reminders},{label:"收藏",icon:Star,count:counts.favorite},{label:"已关闭",icon:Check,count:counts.closed},{label:"已归档",icon:Archive,count:counts.archived},
      ].map(({label,icon:Icon,count})=><button key={label} onClick={()=>{setFilter(label);setSidebarOpen(false)}} className={filter===label?"filter-row selected":"filter-row"}><span><Icon size={15}/>{label}</span><em>{count}</em></button>)}</section>
      <section className="accounts-block"><p className="section-label">账号连接</p>{accounts.length?accounts.map((account,index)=><AccountStatus key={account.id} initials={account.name.slice(0,2).toUpperCase()} color={["green","blue","gray"][index%3]} name={account.name} detail={account.status==="online"?"已连接":account.reason||statusText(account.status)} online={account.status==="online"}/>):<p className="empty-note">暂无已绑定账号</p>}</section>
    </aside>

    <section className="conversation-panel"><header className="conversation-head"><button className="mobile-menu" onClick={()=>setSidebarOpen(true)} aria-label="打开筛选"><Menu size={18}/></button><div><h2>{filter}</h2><span>{visible.length} 个真实会话</span></div><button className="icon-button" onClick={()=>void loadWorkspace(apiToken)} aria-label="刷新"><RefreshCw size={17}/></button></header><label className="search-box"><Search size={15}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索会话、联系人或号码"/></label><div className="conversation-list">{loading?<EmptyState title="正在读取中心数据" text="请稍候…"/>:loadError?<EmptyState title="中心数据加载失败" text={loadError}/>:visible.length?visible.map(item=><button key={item.id} onClick={()=>setActiveId(item.id)} className={item.id===effectiveActiveId?"conversation active":"conversation"}><span className="avatar" style={{background:item.color}}>{item.initials}<i className={`presence ${item.accountStatus==="online"?"online":"offline"}`}/></span><span className="conversation-copy"><span className="conversation-line"><b>{item.name}</b><time>{item.time}</time></span><span className="conversation-line preview"><span>{item.preview}</span>{item.unread>0&&<em>{item.unread}</em>}</span><small className="conversation-meta"><span>{stageName(item.customerStage)}</span>{item.tags.slice(0,1).map(tag=><i key={tag.id} style={{background:tag.color}}>{tag.name}</i>)}{item.remindAt&&<em className={new Date(item.remindAt).getTime()<=clock?"due":""}><Bell size={10}/>{formatDateTime(item.remindAt)}</em>}</small></span></button>):<EmptyState title="暂无真实会话" text={accounts.length?"该账号尚未收到一对一消息":"请先在 Windows Agent 绑定 WhatsApp 账号"}/>}</div></section>

    <section className="chat-panel">{active?<>
      <header className="chat-head"><div className="chat-person"><span className="avatar" style={{background:active.color}}>{active.initials}</span><span><b>{active.name}</b><small><i className={`status-dot ${active.accountStatus==="online"?"online":""}`}/>{active.account} · {statusText(active.accountStatus)}</small></span></div><div className="chat-actions"><button onClick={()=>void updateConversation({assignedToMe:active.assignedUserId!==userId})} className="assign-button"><UserPlus size={15}/>{active.assignedUserId===userId?"取消认领":active.assignedUserId?"转为我负责":"认领"}</button><button onClick={()=>void updateConversation({favorite:!active.favorite})} className="icon-button" aria-label="收藏"><Bookmark size={17} fill={active.favorite?"currentColor":"none"}/></button><button onClick={()=>setDetailsOpen(!detailsOpen)} className="icon-button" aria-label="联系人详情"><Info size={17}/></button></div></header>
      <AgentConversationBar conversationId={active.id} token={apiToken} refreshKey={latestMessageId} onToken={setApiToken} onToast={setToast} onUseDraft={setDraft} onSent={()=>void loadMessages(apiToken,active.id)}/>
      {active.accountStatus!=="online"&&<div className="offline-banner"><WifiOff size={15}/><span>该账号当前离线；发送请求仍会进入持久队列。</span></div>}
      <div ref={messagesRef} className="messages" aria-live="polite"><div className="day-separator"><span>真实消息记录</span></div>{currentMessages.length?currentMessages.map(message=><article key={message.id} className={`message-row ${message.direction}`}>{message.direction==="in"&&<span className="avatar message-avatar" style={{background:active.color}}>{active.initials}</span>}<div className={`message-bubble ${message.attachment?.name.startsWith("sticker-")?"sticker-bubble":""}`}>{message.text&&<p>{message.text}</p>}{message.direction==="out"&&message.translationSourceText&&<div className="outgoing-translation-source"><span><Languages size={12}/>原文（仅坐席可见）</span><p>{message.translationSourceText}</p></div>}{translationPreference.enabled&&message.direction==="in"&&message.kind==="text"&&message.text&&<IncomingTranslation value={messageTranslations[message.id]} language={translationPreference.agentLanguage} onRetry={()=>void loadIncomingTranslations(apiToken,[message.id],translationPreference.agentLanguage,true)}/>} {message.attachment&&<MessageMedia attachment={message.attachment} token={apiToken} onToken={setApiToken} onReady={scrollMessagesToEnd}/>} {translationPreference.enabled&&message.direction==="in"&&message.kind==="audio"&&<VoiceTranslation value={messageTranslations[message.id]} language={translationPreference.agentLanguage} configured={translationConfigured} onTranslate={()=>void loadIncomingTranslations(apiToken,[message.id],translationPreference.agentLanguage,true,true)}/>}<footer><time>{message.time}</time>{message.direction==="out"&&<MessageStatus status={message.status}/>}</footer></div></article>):<EmptyState title="暂无消息" text="收到或发送的消息将显示在这里"/>}</div>
      <div className="composer-wrap">
        <div className="composer-tools"><div className="composer-tool-actions"><button onClick={()=>setMediaOpen(true)} aria-label="打开媒体与附件" title="媒体与附件"><Paperclip size={17}/></button><button onClick={()=>setProductCardsOpen(true)} aria-label="发送产品卡片" title="发送产品卡片"><ShoppingBag size={17}/></button><button className={`translation-trigger ${translationPreference.enabled?"active":""}`} onClick={()=>setTranslationMenuOpen(value=>!value)} aria-expanded={translationMenuOpen} aria-label="AI 翻译设置"><Languages size={15}/><span>{translationPreference.enabled?`${languageName(translationPreference.agentLanguage)} → ${languageName(translationPreference.customerLanguage)}`:"AI 翻译"}</span></button></div><span>回复给 {active.name}</span></div>
        {translationMenuOpen&&<TranslationMenu preference={translationPreference} configured={translationConfigured} ready={translationReady} onChange={next=>void saveTranslationPreference(next)} onClose={()=>setTranslationMenuOpen(false)}/>}
        {emojiOpen&&<EmojiPicker category={emojiCategory} onCategory={setEmojiCategory} onSelect={insertEmoji} onClose={()=>setEmojiOpen(false)}/>}
        <div className="composer"><textarea ref={textareaRef} value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();void sendMessage();}if(event.key==="Escape"){setEmojiOpen(false);setTranslationMenuOpen(false);}}} placeholder="输入消息，Enter 发送，Shift + Enter 换行"/><div className="composer-icons"><button className={emojiOpen?"active":""} onClick={()=>setEmojiOpen(value=>!value)} aria-label="选择表情" title="选择表情"><Smile size={18}/></button><button onClick={()=>setTtsOpen(true)} aria-label="AI 文字转语音" title="AI 文字转语音"><Mic size={18}/></button><button onClick={()=>void sendMessage()} className="send-button" aria-label={translationPreference.enabled?"翻译并预览":"发送"} disabled={translatingDraft}>{translatingDraft?<RefreshCw className="spin" size={18}/>:<Send size={18}/>}</button></div></div>
        {translationError&&<p className="composer-error">{translationError}</p>}
        <p className="delivery-hint">{active.accountStatus==="online"?<><Wifi size={13}/>Agent 在线</>:<><Clock3 size={13}/>离线队列已启用</>}</p>
      </div>
    </>:<div className="chat-empty"><MessageCircle size={31}/><h2>选择一个真实会话</h2><p>这里不会再显示演示联系人或模拟消息。</p></div>}</section>

    {detailsOpen&&active&&<CrmDetailsPanel key={active.id} active={active} token={apiToken} user={user} role={userRole} translationPreference={translationPreference} onToken={setApiToken} onClose={()=>setDetailsOpen(false)} onToast={setToast} onConversationChange={async change=>{await updateConversation(change);}} onChanged={async()=>{await Promise.all([loadWorkspace(apiToken,true),loadMessages(apiToken,active.id)]);}}/>}</>
      :view==="orders"?<OrderManagement token={apiToken} accounts={accounts} onToken={setApiToken} onToast={setToast} onConversation={conversationId=>{const found=conversations.find(item=>item.id===conversationId);if(!found){setToast("该会话不在当前列表，请在消息中心搜索客户");openInbox();return;}setActiveId(conversationId);setDetailsOpen(true);openInbox();}}/>
      :view==="products"?<ProductManagement token={apiToken} role={userRole} onToken={setApiToken} onToast={setToast}/>
      :view==="agents"?<AgentManagement token={apiToken} role={userRole} onToken={setApiToken} onToast={setToast}/>
      :view==="settings"?<SettingsPanel token={apiToken} role={userRole} accounts={accounts} onToken={setApiToken} onToast={setToast}/>
      :<HelpPanel onInbox={()=>openInbox()} onAgents={()=>setView("agents")}/>
    }

    {authOpen&&<LoginDialog
      connected={Boolean(apiToken)} token={apiToken} canClose={Boolean(apiToken)}
      onClose={()=>setAuthOpen(false)}
      onLogin={completeLogin}
      onLogout={logout}
    />}
    {newConversationOpen&&<NewConversationDialog accounts={accounts} token={apiToken} onToken={setApiToken} onClose={()=>setNewConversationOpen(false)} onCreated={async(conversationId,accountId,accessToken)=>{setNewConversationOpen(false);setView("inbox");setFilter("全部会话");setSelectedAccount(accountId);await loadWorkspace(accessToken,true);setActiveId(conversationId);setToast("新会话已创建，首条消息已进入发送队列");}}/>}
    {mediaOpen&&active&&<MediaDialog accountId={active.accountId} token={apiToken} initialCaption={draft} onToken={setApiToken} onToast={setToast} onClose={()=>setMediaOpen(false)} onSend={sendMediaAsset}/>}
    {productCardsOpen&&active&&<ProductCardSendDialog accountId={active.accountId} conversationId={active.id} request={(path,init)=>authorizedFetch(path,apiToken,init)} onToken={setApiToken} onClose={()=>setProductCardsOpen(false)} onSent={text=>{setToast(text);void loadMessages(apiToken,active.id);}}/>}
    {ttsOpen&&active&&<TextToSpeechDialog accountId={active.accountId} token={apiToken} initialText={draft} onToken={setApiToken} onClose={()=>setTtsOpen(false)} onSend={async asset=>{setTtsOpen(false);await sendMediaAsset(asset,"");}}/>}
    {translationPreview&&<TranslationPreviewDialog source={translationPreview.source} translated={translationPreview.translated} targetLanguage={translationPreference.customerLanguage} onClose={()=>setTranslationPreview(null)} onConfirm={text=>void queueTextMessage(text,translationPreview.source)}/>}
  </main>;
}

const CUSTOMER_STAGES=[
  ["new","新线索"],["considering","待考量"],["qualified","合格"],["won","已成交"],["lost","已流失"],
] as const;

function stageName(value:string){return CUSTOMER_STAGES.find(item=>item[0]===value)?.[1]??"新线索";}

function CrmDetailsPanel({
  active,
  token,
  user,
  role,
  translationPreference,
  onToken,
  onClose,
  onToast,
  onConversationChange,
  onChanged,
}: {
  active: Conversation;
  token: string;
  user: User | null;
  role: string;
  translationPreference: TranslationPreference;
  onToken: (token: string) => void;
  onClose: () => void;
  onToast: (text: string) => void;
  onConversationChange: (change: Record<string, unknown>) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [details, setDetails] = useState<ConversationDetails | null>(null),
    [catalog, setCatalog] = useState<TagItem[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tagQuery, setTagQuery] = useState(""),
    [tagName, setTagName] = useState(""),
    [tagColor, setTagColor] = useState("#DFF5E8"),
    [noteDraft, setNoteDraft] = useState(""),
    [reminderValue, setReminderValue] = useState(""),
    [orderOpen, setOrderOpen] = useState(false),
    [editOrderTarget, setEditOrderTarget] = useState<OrderItem | null>(null),
    [sendOrderTarget, setSendOrderTarget] = useState<OrderSendTarget | null>(null),
    [aliasEditing, setAliasEditing] = useState(false),
    [aliasDraft, setAliasDraft] = useState(active.alias),
    [aliasBusy, setAliasBusy] = useState(false),
    [currentTime] = useState(() => Date.now());
  const canManageTags = ["admin", "supervisor"].includes(role);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [detailResult, tagResult] = await Promise.all([
        authorizedFetch(`/api/v1/conversations/${active.id}/details`, token),
        authorizedFetch("/api/v1/tags", token),
      ]);
      const nextToken =
        detailResult.token !== token ? detailResult.token : tagResult.token;
      if (nextToken !== token) onToken(nextToken);
      if (!detailResult.response.ok || !tagResult.response.ok)
        throw new Error("联系人业务资料加载失败");
      const body = (await detailResult.response.json()) as Record<
          string,
          unknown
        >,
        tagBody = (await tagResult.response.json()) as {
          data: Array<Record<string, unknown>>;
        };
      const reminder = body.reminder as Record<string, unknown> | null;
      setDetails({
        customerStage: String(body.customerStage ?? active.customerStage),
        tags: Array.isArray(body.tags)
          ? (body.tags as Array<Record<string, unknown>>).map(mapTag)
          : [],
        notes: Array.isArray(body.notes)
          ? (body.notes as Array<Record<string, unknown>>).map((item) => ({
              id: String(item.id),
              body: String(item.body ?? ""),
              userId: item.user_id ? String(item.user_id) : null,
              authorName: String(item.author_name ?? "已离职坐席"),
              createdAt: String(item.created_at),
              updatedAt: String(item.updated_at),
            }))
          : [],
        reminder: reminder
          ? {
              id: String(reminder.id),
              remindAt: String(reminder.remind_at),
              createdAt: String(reminder.created_at),
              updatedAt: String(reminder.updated_at),
            }
          : null,
        orders: Array.isArray(body.orders)
          ? (body.orders as Array<Record<string, unknown>>).map(item=>mapOrder(item,{conversationId:active.id,accountId:active.accountId,accountName:active.account,customerName:active.name,customerPhone:active.phone}))
          : [],
      });
      setCatalog(tagBody.data.map(mapTag));
      setReminderValue(
        reminder ? toDateTimeLocal(String(reminder.remind_at)) : "",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [active.id, active.customerStage, active.accountId, active.account, active.name, active.phone, token, onToken]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sendOrderTarget) setSendOrderTarget(null);
      else if (!orderOpen && !editOrderTarget) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, orderOpen, editOrderTarget, sendOrderTarget]);
  async function request(path: string, init: RequestInit) {
    setBusy(true);
    setError("");
    try {
      const result = await authorizedFetch(path, token, init);
      if (result.token !== token) onToken(result.token);
      if (!result.response.ok) {
        const body = (await result.response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error === "tag_name_exists"
            ? "标签名称已存在"
            : `保存失败（HTTP ${result.response.status}）`,
        );
      }
      await load();
      await onChanged();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveAlias(event: React.FormEvent) {
    event.preventDefault();
    setAliasBusy(true);
    setError("");
    try {
      const result=await authorizedFetch(`/api/v1/conversations/${active.id}/contact`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({alias:aliasDraft})});
      if(result.token!==token)onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {error?:string};
      if(!result.response.ok)throw new Error(body.error??`别名保存失败（HTTP ${result.response.status}）`);
      await onChanged();
      setAliasEditing(false);
      onToast(aliasDraft.trim()?"联系人别名已保存":"联系人别名已清除");
    }catch(reason){setError(reason instanceof Error?reason.message:"别名保存失败");}
    finally{setAliasBusy(false);}
  }
  async function setStage(customerStage: string) {
    await onConversationChange({ customerStage });
    setDetails((value) => (value ? { ...value, customerStage } : value));
    await onChanged();
  }
  async function toggleTag(tagId: string) {
    if (!details) return;
    const ids = details.tags.some((item) => item.id === tagId)
      ? details.tags.filter((item) => item.id !== tagId).map((item) => item.id)
      : [...details.tags.map((item) => item.id), tagId];
    await request(`/api/v1/conversations/${active.id}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: ids }),
    });
  }
  async function createTag() {
    if (!tagName.trim()) return;
    const ok = await request("/api/v1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tagName.trim(), color: tagColor }),
    });
    if (ok) setTagName("");
  }
  async function renameTag(tag: TagItem) {
    const name = window.prompt("新的标签名称", tag.name)?.trim();
    if (!name || name === tag.name) return;
    await request(`/api/v1/tags/${tag.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }
  async function deleteTag(tag: TagItem) {
    if (!window.confirm(`删除标签“${tag.name}”？所有会话都会移除它。`)) return;
    await request(`/api/v1/tags/${tag.id}`, { method: "DELETE" });
  }
  async function addNote() {
    if (!noteDraft.trim()) return;
    const ok = await request(`/api/v1/conversations/${active.id}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: noteDraft.trim() }),
    });
    if (ok) setNoteDraft("");
  }
  async function editNote(note: NoteItem) {
    const body = window.prompt("编辑备注", note.body)?.trim();
    if (!body || body === note.body) return;
    await request(`/api/v1/conversations/${active.id}/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }
  async function deleteNote(note: NoteItem) {
    if (window.confirm("删除这条备注？"))
      await request(`/api/v1/conversations/${active.id}/notes/${note.id}`, {
        method: "DELETE",
      });
  }
  async function saveReminder() {
    if (!reminderValue) return;
    await request(`/api/v1/conversations/${active.id}/reminder`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remindAt: new Date(reminderValue).toISOString() }),
    });
    onToast("提醒已设置");
  }
  async function clearReminder() {
    const ok = await request(`/api/v1/conversations/${active.id}/reminder`, {
      method: "DELETE",
    });
    if (ok) {
      setReminderValue("");
      onToast("提醒已取消");
    }
  }
  async function sendOrder(order: OrderItem, format: "text" | "image", translate: boolean, targetLanguage?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await authorizedFetch(
        `/api/v1/conversations/${active.id}/orders/${order.id}/send`,
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format, clientSendId: crypto.randomUUID(), translate, ...(translate&&targetLanguage?{targetLanguage}:{}) }),
        },
      );
      if (result.token !== token) onToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!result.response.ok)
        throw new Error(
          body.message ??
            body.error ??
            `订单发送失败（HTTP ${result.response.status}）`,
        );
      setSendOrderTarget(null);
      onToast(
        `订单 #${order.orderNumber} 已${order.status === "draft" ? "按" : "重新按"}${translate?languageName(targetLanguage??order.targetLanguage):"英文"}${format === "image" ? "完整图片版" : "文字版"}进入发送队列`,
      );
      await load();
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "订单发送失败");
    } finally {
      setBusy(false);
    }
  }
  async function deleteOrder(order: OrderItem) {
    const sent = order.status !== "draft";
    if (
      !window.confirm(
        sent
          ? `删除订单 #${order.orderNumber}？这只会从联系人资料中移除，不会撤回已发送的 WhatsApp 消息。`
          : `删除草稿订单 #${order.orderNumber}？`,
      )
    )
      return;
    const ok = await request(
      `/api/v1/conversations/${active.id}/orders/${order.id}`,
      { method: "DELETE" },
    );
    if (ok)
      onToast(
        `订单 #${order.orderNumber} 已删除${sent ? "（已发送消息未撤回）" : ""}`,
      );
  }
  const visibleTags = catalog.filter((item) =>
    item.name.toLowerCase().includes(tagQuery.toLowerCase()),
  );
  return (
    <>
      <button
        className="details-backdrop"
        onClick={onClose}
        aria-label="关闭联系人详情"
      />
      <aside className="details-panel crm-details" aria-label="联系人详情">
        <header>
          <h3>联系人详情</h3>
          <button
            onClick={onClose}
            className="icon-button"
            aria-label="关闭详情"
          >
            <X size={17} />
          </button>
        </header>
        <div className="contact-card">
          <span className="avatar large" style={{ background: active.color }}>
            {active.initials}
          </span>
          {aliasEditing?<form className="contact-alias-form" onSubmit={saveAlias}>
            <input autoFocus value={aliasDraft} maxLength={80} placeholder={active.contactName||active.phone||"输入联系人别名"} onChange={event=>setAliasDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"){setAliasDraft(active.alias);setAliasEditing(false);}}} aria-label="联系人别名"/>
            <button type="submit" disabled={aliasBusy} aria-label="保存别名"><Check size={14}/></button>
            <button type="button" disabled={aliasBusy} onClick={()=>{setAliasDraft(active.alias);setAliasEditing(false);}} aria-label="取消编辑"><X size={14}/></button>
          </form>:<div className="contact-name"><h2>{active.name}</h2><button className="contact-alias-edit" onClick={()=>setAliasEditing(true)} aria-label="编辑联系人别名" title="编辑别名"><Pencil size={13}/></button></div>}
          <p>{active.phone || "号码待同步"}</p>
          <span className="contact-online">
            <i
              className={`status-dot ${active.accountStatus === "online" ? "online" : ""}`}
            />
            {statusText(active.accountStatus)}
          </span>
        </div>
        <AgentMemoryPanel conversationId={active.id} token={token} onToken={onToken} onToast={onToast}/>
        {loading ? (
          <div className="crm-loading">
            <RefreshCw className="spin" size={18} />
            读取客户资料…
          </div>
        ) : details ? (
          <>
            <div className="detail-section crm-section">
              <div className="detail-title">
                <h4>订单状态</h4>
                <button onClick={() => setOrderOpen(true)}>
                  <Plus size={12} />
                  创建订单
                </button>
              </div>
              {details.orders.length ? (
                <div className="order-list">
                  {details.orders.map((order) => (
                    <article key={order.id} className="order-summary-card">
                      <span>
                        <b>
                          #{order.orderNumber} ·{" "}
                          {order.items.length} 件商品
                        </b>
                        <small>
                          {order.currency} {order.amount.toFixed(2)} ·{" "}
                          {formatDateTime(order.createdAt)}
                        </small>
                        {order.sendFormat && (
                          <small>
                            {order.sendFormat === "image"
                              ? "完整图片版"
                              : "文字版"}
                          </small>
                        )}
                        {order.paymentRequest&&<small className={`payment-state ${order.paymentRequest.status.toLowerCase()}`}><CreditCard size={11}/>{paymentStatusText(order.paymentRequest.status)}</small>}
                      </span>
                      <div className="order-card-actions">
                        {order.status !== "draft" && (
                          <em
                            className={`delivery-state ${order.messageStatus}`}
                          >
                            {deliveryText(order.messageStatus)}
                          </em>
                        )}
                        <button
                          className="order-edit"
                          disabled={busy}
                          onClick={() => setEditOrderTarget(order)}
                          aria-label={`编辑订单 #${order.orderNumber}`}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="order-send"
                          disabled={busy}
                          onClick={() => setSendOrderTarget({order})}
                        >
                          <Send size={12} />
                          {order.status === "draft" ? "发送" : "重新发送"}
                        </button>
                        <button
                          className="order-delete"
                          disabled={busy}
                          onClick={() => void deleteOrder(order)}
                          aria-label={`删除订单 #${order.orderNumber}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="crm-empty">尚未创建订单</p>
              )}
            </div>
            <div className="detail-section crm-section">
              <h4>客户阶段</h4>
              <select
                className="crm-select"
                value={details.customerStage}
                disabled={busy}
                onChange={(event) => void setStage(event.target.value)}
              >
                {CUSTOMER_STAGES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="detail-section crm-section">
              <div className="detail-title">
                <h4>标签</h4>
                <span>{details.tags.length}/20</span>
              </div>
              <div className="selected-tags">
                {details.tags.map((tag) => (
                  <button
                    key={tag.id}
                    style={{ background: tag.color }}
                    onClick={() => void toggleTag(tag.id)}
                  >
                    {tag.name}
                    <X size={11} />
                  </button>
                ))}
              </div>
              <label className="crm-search">
                <Search size={13} />
                <input
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  placeholder="搜索并添加标签"
                />
              </label>
              <div className="tag-options">
                {visibleTags
                  .filter(
                    (tag) => !details.tags.some((item) => item.id === tag.id),
                  )
                  .slice(0, 8)
                  .map((tag) => (
                    <button key={tag.id} onClick={() => void toggleTag(tag.id)}>
                      <i style={{ background: tag.color }} />
                      {tag.name}
                    </button>
                  ))}
              </div>
              {canManageTags && (
                <div className="tag-manager">
                  <input
                    value={tagName}
                    onChange={(event) => setTagName(event.target.value)}
                    maxLength={40}
                    placeholder="新标签名称"
                  />
                  <input
                    type="color"
                    value={tagColor}
                    onChange={(event) => setTagColor(event.target.value)}
                  />
                  <button
                    disabled={busy || !tagName.trim()}
                    onClick={() => void createTag()}
                  >
                    <Plus size={13} />
                  </button>
                  {catalog.map((tag) => (
                    <span key={tag.id}>
                      <b>{tag.name}</b>
                      <button
                        onClick={() => void renameTag(tag)}
                        aria-label={`重命名 ${tag.name}`}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => void deleteTag(tag)}
                        aria-label={`删除 ${tag.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="detail-section crm-section">
              <h4>备注</h4>
              <textarea
                className="note-input"
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                maxLength={5000}
                placeholder="添加团队共享备注"
              />
              <button
                className="crm-primary"
                disabled={busy || !noteDraft.trim()}
                onClick={() => void addNote()}
              >
                <Plus size={13} />
                添加备注
              </button>
              <div className="note-list">
                {details.notes.map((note) => {
                  const manageable = note.userId === user?.id || canManageTags;
                  return (
                    <article key={note.id}>
                      <p>{note.body}</p>
                      <footer>
                        <span>
                          {note.authorName} · {formatDateTime(note.updatedAt)}
                          {note.updatedAt !== note.createdAt ? " · 已编辑" : ""}
                        </span>
                        {manageable && (
                          <span>
                            <button onClick={() => void editNote(note)}>
                              <Pencil size={11} />
                            </button>
                            <button onClick={() => void deleteNote(note)}>
                              <Trash2 size={11} />
                            </button>
                          </span>
                        )}
                      </footer>
                    </article>
                  );
                })}
              </div>
            </div>
            <div className="detail-section crm-section">
              <h4>提醒</h4>
              {details.reminder &&
                new Date(details.reminder.remindAt).getTime() <=
                  currentTime && (
                  <p className="reminder-due">
                    <Bell size={13} />
                    此提醒已到期
                  </p>
                )}
              <input
                className="crm-select"
                type="datetime-local"
                value={reminderValue}
                min={toDateTimeLocal(new Date(currentTime).toISOString())}
                onChange={(event) => setReminderValue(event.target.value)}
              />
              <div className="reminder-actions">
                <button
                  className="crm-primary"
                  disabled={busy || !reminderValue}
                  onClick={() => void saveReminder()}
                >
                  {details.reminder ? "重新安排" : "设置提醒"}
                </button>
                {details.reminder && (
                  <button disabled={busy} onClick={() => void clearReminder()}>
                    取消提醒
                  </button>
                )}
              </div>
            </div>
            <div className="detail-section">
              <h4>会话信息</h4>
              <dl>
                <div>
                  <dt>负责坐席</dt>
                  <dd>
                    {active.assignedUserId === user?.id
                      ? "我"
                      : active.assignedUserId
                        ? "其他坐席"
                        : "未分配"}
                  </dd>
                </div>
                <div>
                  <dt>接入账号</dt>
                  <dd>{active.account}</dd>
                </div>
                <div>
                  <dt>客户阶段</dt>
                  <dd>{stageName(details.customerStage)}</dd>
                </div>
                <div>
                  <dt>会话状态</dt>
                  <dd className="green-text">
                    {active.conversationStatus === "open"
                      ? "进行中"
                      : active.conversationStatus === "closed"
                        ? "已关闭"
                        : "已归档"}
                  </dd>
                </div>
              </dl>
              <button
                className="conversation-state-button"
                onClick={() =>
                  void onConversationChange({
                    status:
                      active.conversationStatus === "closed"
                        ? "open"
                        : "closed",
                  })
                }
              >
                {active.conversationStatus === "closed"
                  ? "重新打开会话"
                  : "关闭会话"}
              </button>
            </div>
          </>
        ) : null}
        {error && <p className="crm-error">{error}</p>}
        <div className="security-note">
          <ShieldCheck size={16} />
          <span>
            <b>中心真实数据</b>
            <small>CRM 资料保存在团队 PostgreSQL 中</small>
          </span>
        </div>
      </aside>
      {orderOpen && (
        <OrderDialog
          active={active}
          token={token}
          onToken={onToken}
          onClose={() => setOrderOpen(false)}
          onCreated={async (orderNumber) => {
            setOrderOpen(false);
            onToast(
              `订单 #${orderNumber} 已保存为草稿`,
            );
            await load();
            await onChanged();
          }}
        />
      )}
      {editOrderTarget && (
        <OrderDialog
          order={editOrderTarget}
          active={active}
          token={token}
          onToken={onToken}
          onClose={() => setEditOrderTarget(null)}
          onCreated={async (orderNumber) => {
            setEditOrderTarget(null);
            onToast(`订单 #${orderNumber} 已更新`);
            await load();
            await onChanged();
          }}
        />
      )}
      {sendOrderTarget && (
        <OrderSendDialog
          order={sendOrderTarget.order}
          defaultTargetLanguage={translationPreference.customerLanguage}
          busy={busy}
          onClose={() => setSendOrderTarget(null)}
          onSend={(format,translate,targetLanguage) => void sendOrder(sendOrderTarget.order,format,translate,targetLanguage)}
        />
      )}
    </>
  );
}

function OrderSendDialog({order,defaultTargetLanguage,busy,onClose,onSend}:{order:OrderItem;defaultTargetLanguage:string;busy:boolean;onClose:()=>void;onSend:(format:"text"|"image",translate:boolean,targetLanguage?:string)=>void}){
  const initialTargetLanguage=defaultTargetLanguage||"en";
  const [format,setFormat]=useState<"text"|"image">("text"),[translate,setTranslate]=useState(!isEnglishLanguage(initialTargetLanguage)),[targetLanguage,setTargetLanguage]=useState(initialTargetLanguage);
  return <div className="modal-backdrop order-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="login-dialog order-send-dialog" role="dialog" aria-modal="true" aria-labelledby="order-send-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Send size={19}/></span><h2 id="order-send-title">发送订单 #{order.orderNumber}</h2><p>选择发送语言和客户在 WhatsApp 中收到的订单格式。</p><div className="order-send-mode"><label className={!translate?"selected":""}><input type="radio" name="order-language-mode" checked={!translate} onChange={()=>setTranslate(false)}/><span><FileText size={14}/><b>英文原文</b></span></label><label className={translate?"selected":""}><input type="radio" name="order-language-mode" checked={translate} onChange={()=>setTranslate(true)}/><span><Languages size={14}/><b>AI 翻译</b></span></label></div>{translate&&<label className="order-send-language"><span>目标翻译语言</span><LanguagePicker value={targetLanguage} onChange={setTargetLanguage}/></label>}<div className="order-send-options">
    <label className={format==="text"?"selected":""}><input type="radio" name="order-format" checked={format==="text"} onChange={()=>setFormat("text")}/><span><b><FileText size={16}/>文字版详情</b><small>发送完整订单文字，不包含产品图片</small></span></label>
    <label className={format==="image"?"selected":""}><input type="radio" name="order-format" checked={format==="image"} onChange={()=>setFormat("image")}/><span><b><ShoppingBag size={16}/>图片版完整详情</b><small>生成一张包含全部订单内容和所有产品图片的长图</small></span></label>
  </div>{translate?<p className="order-send-translation"><Languages size={13}/>点击发送后才会将订单详情翻译为 {languageName(targetLanguage)}</p>:<p className="order-send-translation english"><FileText size={13}/>订单将以英文原文发送，不调用 AI 翻译</p>}<button className="login-submit" disabled={busy} onClick={()=>onSend(format,translate,translate?targetLanguage:undefined)}>{busy?format==="image"?"正在生成订单图片…":"正在加入队列…":translate?(format==="image"?"翻译、生成图片并发送":"翻译并发送文字版"):(format==="image"?"生成英文图片并发送":"发送英文文字版")}</button></section></div>;
}

type DraftProduct={id:string;mode:"library"|"new"|"legacy";productId:string|null;clientProductId:string|null;sku:string;name:string;quantity:string;unitAmount:string;priceLocked:boolean;imageMediaId:string|null;imageName:string};
type DraftFee={id:string;name:string;amount:string};
const newDraftProduct=():DraftProduct=>({id:crypto.randomUUID(),mode:"new",productId:null,clientProductId:crypto.randomUUID(),sku:"",name:"",quantity:"1",unitAmount:"",priceLocked:false,imageMediaId:null,imageName:""});
function tierPrice(product:ProductItem,quantity:number){return [...product.priceTiers].reverse().find(tier=>quantity>=tier.minQuantity)?.unitAmount??product.defaultUnitAmount;}

function ProductSearchDropdown({
  id,
  products,
  value,
  fallbackName,
  onChange,
}: {
  id: string;
  products: ProductItem[];
  value: string | null;
  fallbackName: string;
  onChange: (productId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = products.find((item) => item.id === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return products;
    return products.filter((item) =>
      [item.name, item.sku, item.currency, item.defaultUnitAmount.toFixed(2), ...item.tags.map((tag) => tag.name)]
        .some((part) => part.toLocaleLowerCase().includes(needle)),
    );
  }, [products, query]);
  const listboxId = `${id}-product-options`;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);
  function openDropdown() {
    setQuery("");
    setActiveIndex(Math.max(0, products.findIndex((item) => item.id === value)));
    setOpen(true);
  }
  function selectProduct(product: ProductItem) {
    onChange(product.id);
    setOpen(false);
    setQuery("");
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }
  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, Math.min(index + 1, filtered.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      selectProduct(filtered[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="product-search-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="product-search-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? setOpen(false) : openDropdown())}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            openDropdown();
          }
        }}
      >
        <span>
          <b>{selected?.name ?? fallbackName}</b>
          <small>{selected ? `${selected.sku} · ${selected.currency} ${selected.defaultUnitAmount.toFixed(2)} 起` : "已从产品库移除"}</small>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="product-search-menu">
          <label className="product-search-input">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索产品名称、SKU、价格或标签"
              aria-label="搜索产品"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={filtered[activeIndex] ? `${id}-product-${filtered[activeIndex].id}` : undefined}
            />
          </label>
          <div id={listboxId} className="product-search-options" role="listbox">
            {filtered.length ? filtered.map((item, index) => (
              <button
                id={`${id}-product-${item.id}`}
                type="button"
                role="option"
                aria-selected={item.id === value}
                className={index === activeIndex ? "active" : ""}
                key={item.id}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectProduct(item)}
              >
                <span>
                  <b>{item.name}</b>
                  <small>{item.sku}{item.tags.length > 0 ? ` · ${item.tags.map((tag) => tag.name).join(" · ")}`:""}</small>
                </span>
                <strong>{item.currency} {item.defaultUnitAmount.toFixed(2)}</strong>
                {item.id === value && <Check size={14} aria-hidden="true" />}
              </button>
            )) : <p className="product-search-empty">没有匹配的产品</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function OrderDialog({
  order,
  active,
  token,
  onToken,
  onClose,
  onCreated,
}: {
  order?: OrderItem;
  active: Conversation;
  token: string;
  onToken: (token: string) => void;
  onClose: () => void;
  onCreated: (orderNumber: string) => Promise<void>;
}) {
  const [products, setProducts] = useState<DraftProduct[]>(() =>
      order
        ? order.items.map((item) => ({
            id: item.id,
            mode: item.productId ? "library" : "legacy",
            productId: item.productId,
            clientProductId: null,
            sku: "",
            name: item.name,
            quantity: String(item.quantity),
            unitAmount: item.unitAmount.toFixed(2),
            priceLocked: true,
            imageMediaId: item.imageMediaId,
            imageName: item.imageName,
          }))
        : [newDraftProduct()],
    ),
    [catalog, setCatalog] = useState<ProductItem[]>([]),
    [currencyConfig,setCurrencyConfig]=useState<CurrencyConfig>(DEFAULT_CURRENCY_CONFIG),
    [fees, setFees] = useState<DraftFee[]>(() =>
      order
        ? order.fees.map((item) => ({
            id: item.id,
            name: item.name,
            amount: item.amount.toFixed(2),
          }))
        : [],
    ),
    [currency, setCurrency] = useState(order?.currency ?? ""),
    [description, setDescription] = useState(order?.description ?? ""),
    [addresses, setAddresses] = useState<CustomerAddress[]>([]),
    [addressId, setAddressId] = useState(order?.addressId ?? ""),
    [addingAddress, setAddingAddress] = useState(Boolean(order?.address&&!order.addressId)),
    [addressDraft, setAddressDraft] = useState({label:order?.address?.label??"收货地址",recipientName:order?.address?.recipientName??active.name,phone:order?.address?.phone??active.phone,address:order?.address?.address??""}),
    [imagePickerProductId, setImagePickerProductId] = useState<string|null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const total = useMemo(
    () =>
      products.reduce(
        (sum, item) =>
          sum + (Number(item.quantity) || 0) * (Number(item.unitAmount) || 0),
        0,
      ) + fees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0),
    [products, fees],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !busy)
        void submit();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        void (async () => {
          const [result,currencyResult] = await Promise.all([authorizedFetch(
            "/api/v1/products?limit=100",token),authorizedFetch("/api/v1/currencies",token)]);
          if (result.token !== token) onToken(result.token);else if(currencyResult.token!==token)onToken(currencyResult.token);
          if (result.response.ok) {
            const body = (await result.response.json()) as {
              data: Array<Record<string, unknown>>;
            };
            setCatalog(body.data.map(mapProduct));
          }
          if(currencyResult.response.ok){const body=await currencyResult.response.json() as CurrencyConfig;setCurrencyConfig(body);if(!order)setCurrency(current=>current||body.baseCurrency);}
        })(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [token, onToken, order]);
  useEffect(()=>{let cancelled=false;void (async()=>{const result=await authorizedFetch(`/api/v1/conversations/${active.id}/addresses`,token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:Array<Record<string,unknown>>};if(!cancelled)setAddresses(body.data.map(item=>mapCustomerAddress(item)));}})();return()=>{cancelled=true;};},[active.id,token,onToken]);
  function updateProduct(id: string, change: Partial<DraftProduct>) {
    setProducts((all) =>
      all.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  }
  function updateFee(id: string, change: Partial<DraftFee>) {
    setFees((all) =>
      all.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  }
  function clearProductImage(id: string) {
    updateProduct(id, { imageMediaId: null, imageName: "" });
  }
  function chooseMediaImage(asset: MediaAsset) {
    if (!imagePickerProductId) return;
    if (products.some(item => item.id !== imagePickerProductId && item.imageMediaId === asset.id)) {
      setError("每个商品需要选择不同的产品图片");
      setImagePickerProductId(null);
      return;
    }
    updateProduct(imagePickerProductId, { imageMediaId: asset.id, imageName: asset.fileName });
    setError("");
    setImagePickerProductId(null);
  }
  function chooseCatalogProduct(rowId: string, productId: string) {
    const selected = catalog.find((item) => item.id === productId);
    if (!selected) return;
    const orderCurrency=currency||currencyConfig.baseCurrency;
    setError("");
    updateProduct(rowId, {
      mode: "library",
      productId: selected.id,
      clientProductId: null,
      sku: selected.sku,
      name: selected.name,
      unitAmount: convertCurrency(tierPrice(selected,Number(products.find(item=>item.id===rowId)?.quantity)||1),selected.currency,orderCurrency,currencyConfig).toFixed(2),
      priceLocked: false,
      imageMediaId: selected.imageMediaId,
      imageName: selected.imageName,
    });
  }
  function changeCurrency(next:string){if(!currency){setCurrency(next);return;}setProducts(all=>all.map(item=>{const selected=catalog.find(product=>product.id===item.productId),amount=selected&&!item.priceLocked?tierPrice(selected,Number(item.quantity)||1):Number(item.unitAmount);const from=selected&&!item.priceLocked?selected.currency:currency;return{...item,unitAmount:Number.isFinite(amount)?convertCurrency(amount,from,next,currencyConfig).toFixed(2):item.unitAmount};}));setFees(all=>all.map(fee=>({...fee,amount:fee.amount?convertCurrency(Number(fee.amount),currency,next,currencyConfig).toFixed(2):fee.amount})));setCurrency(next);}
  function makeNewProduct(rowId: string) {
    updateProduct(rowId, {
      mode: "new",
      productId: null,
      clientProductId: crypto.randomUUID(),
      sku: "",
      name: "",
      unitAmount: "",
      priceLocked: false,
      imageMediaId: null,
      imageName: "",
    });
  }
  async function submit() {
    const money = /^\d+(?:\.\d{1,2})?$/;
    if(!currency){setError("请先在设置中配置基准货币");return;}
    if (
      products.some(
        (item) =>
          !item.name.trim() ||
          (item.mode === "new" && !item.sku.trim()) ||
          !/^\d+$/.test(item.quantity) ||
          Number(item.quantity) < 1 ||
          !money.test(item.unitAmount),
      )
    ) {
      setError("请完整填写每件商品的名称、SKU、数量和最多两位小数的单价");
      return;
    }
    if (
      fees.some(
        (fee) =>
          !fee.name.trim() ||
          !money.test(fee.amount) ||
          Number(fee.amount) <= 0,
      )
    ) {
      setError("请完整填写每项费用的名称和金额");
      return;
    }
    if (total <= 0) {
      setError("订单总额必须大于 0");
      return;
    }
    if(addingAddress&&(!addressDraft.label.trim()||!addressDraft.address.trim())){setError("请填写地址名称和详细地址");return;}
    setBusy(true);
    setError("");
    try {
      const items = products.map((product) => ({
          name: product.name.trim(),
          ...(product.sku.trim()?{sku:product.sku.trim()}:{}),
          quantity: Number(product.quantity),
          unitAmount: Number(product.unitAmount),
          ...(product.imageMediaId ? { imageMediaId: product.imageMediaId } : {}),
          ...(product.productId ? { productId: product.productId } : {}),
          ...(product.clientProductId
            ? { clientProductId: product.clientProductId }
            : {}),
        }));
      const payload = {
        currency,
        description: description.trim() || undefined,
        translateOnSend: false,
        items,
        fees: fees.map((fee) => ({
          name: fee.name.trim(),
          amount: Number(fee.amount),
        })),
        ...(addingAddress?{newAddress:{label:addressDraft.label.trim(),recipientName:addressDraft.recipientName.trim()||undefined,phone:addressDraft.phone.trim()||undefined,address:addressDraft.address.trim()}}:{addressId:addressId||null}),
      };
      const saved = await authorizedFetch(
        order
          ? `/api/v1/conversations/${active.id}/orders/${order.id}`
          : `/api/v1/conversations/${active.id}/orders`,
        token,
        {
          method: order ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            order
              ? payload
              : { clientOrderId: crypto.randomUUID(), ...payload },
          ),
        },
      );
      if (saved.token !== token) onToken(saved.token);
      const body = (await saved.response.json().catch(() => ({}))) as {
        orderNumber?: string;
        message?: string;
        error?: string;
      };
      if (!saved.response.ok || !body.orderNumber)
        throw new Error(
          body.message ??
            body.error ??
            `${order ? "更新" : "创建"}失败（HTTP ${saved.response.status}）`,
        );
      if(order){const addressSaved=await authorizedFetch(`/api/v1/conversations/${active.id}/orders/${order.id}/address`,saved.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(addingAddress?{newAddress:{label:addressDraft.label.trim(),recipientName:addressDraft.recipientName.trim()||undefined,phone:addressDraft.phone.trim()||undefined,address:addressDraft.address.trim()}}:{addressId:addressId||null})});if(addressSaved.token!==token)onToken(addressSaved.token);if(!addressSaved.response.ok)throw new Error("订单已更新，但地址保存失败，请重试");}
      await onCreated(body.orderNumber);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `${order ? "更新" : "创建"}订单失败`,
      );
      setBusy(false);
    }
  }
  return (
    <>
    <div
      className="modal-backdrop order-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="login-dialog order-dialog order-builder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-title"
      >
        <button
          className="login-close"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭"
        >
          <X size={17} />
        </button>
        <span className="login-logo">
          <ShoppingBag size={20} />
        </span>
        <h2 id="order-title">{order ? "编辑订单" : "创建订单"}</h2>
        <p>
          {order
            ? "修改会更新后续发送的订单内容；已经发送的历史消息不会改变。"
            : "订单先保存为草稿；在右侧栏确认发送时，才会翻译并进入 WhatsApp 队列。"}
        </p>
        <div className="order-builder-head">
          <b>Products</b>
          <label>
            Currency
            <select
              value={currency}
              onChange={(event) => changeCurrency(event.target.value)}
            >
              {currencyConfig.currencies.map((item) => (
                <option key={item.code} value={item.code}>{item.code} · {item.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="order-products">
          {products.map((product, index) => {
            const available = catalog;
            const sameName =
              product.mode === "new" &&
              Boolean(product.name.trim()) &&
              catalog.some(
                (item) =>
                  item.name.trim().toLowerCase() ===
                  product.name.trim().toLowerCase(),
              );
            return <article key={product.id} className="order-product">
              <header>
                <b>商品 {index + 1}</b>
                {products.length > 1 && (
                  <button
                    onClick={() =>
                      setProducts((all) =>
                        all.filter((item) => item.id !== product.id),
                      )
                    }
                    aria-label={`删除商品 ${index + 1}`}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </header>
              <div className="order-product-mode">
                <button
                  className={product.mode === "library" ? "active" : ""}
                  disabled={!available.length}
                  onClick={() => {
                    if (available[0])
                      chooseCatalogProduct(product.id, available[0].id);
                  }}
                >
                  <Search size={12} />产品库
                </button>
                <button
                  className={product.mode === "new" ? "active" : ""}
                  onClick={() => makeNewProduct(product.id)}
                >
                  <Plus size={12} />新建产品
                </button>
                {product.mode === "legacy" && (
                  <span>历史商品 · 不自动入库</span>
                )}
              </div>
              {product.mode === "library" ? (
                <div className="order-product-selector">
                  <span className="order-product-selector-label">选择产品</span>
                  <ProductSearchDropdown
                    id={`order-${product.id}`}
                    products={available}
                    value={product.productId}
                    fallbackName={product.name}
                    onChange={(productId) => chooseCatalogProduct(product.id, productId)}
                  />
                  <small className="selected-product-note">
                    名称与图片取自产品快照，订单内可调整成交单价。
                  </small>
                </div>
              ) : (
                <>
                  <label>
                    产品名称
                    <input
                      value={product.name}
                      onChange={(event) =>
                        updateProduct(product.id, { name: event.target.value })
                      }
                      maxLength={120}
                      placeholder="产品名称"
                      autoFocus={index === 0}
                    />
                  </label>
                  {sameName && (
                    <span className="duplicate-warning">
                      <Info size={12} />产品库已有同名产品，仍可作为新产品入库。
                    </span>
                  )}
                  <label>
                    SKU
                    <input value={product.sku} onChange={event=>updateProduct(product.id,{sku:event.target.value})} maxLength={80} placeholder="唯一 SKU"/>
                  </label>
                </>
              )}
              <div className="order-item-grid">
                <label>
                  数量
                  <input
                    value={product.quantity}
                    onChange={(event) => {const quantity=event.target.value,selectedProduct=catalog.find(item=>item.id===product.productId);updateProduct(product.id,{quantity,...(product.mode==="library"&&!product.priceLocked&&selectedProduct&&/^\d+$/.test(quantity)?{unitAmount:convertCurrency(tierPrice(selectedProduct,Number(quantity)),selectedProduct.currency,currency,currencyConfig).toFixed(2)}:{})});}}
                    inputMode="numeric"
                  />
                </label>
                <label>
                  成交单价
                  <input
                    value={product.unitAmount}
                    onChange={(event) => updateProduct(product.id, {unitAmount:event.target.value,priceLocked:true})}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </label>
              </div>
              {product.mode !== "library" && <><label className="product-image-input">
                产品图片 · 可选
                <button type="button" onClick={() => setImagePickerProductId(product.id)}>
                  <Paperclip size={14} />
                  {product.imageName || "从媒体与附件中选择"}
                </button>
              </label>
              {product.imageMediaId && (
                <button
                  className="product-image-remove"
                  onClick={() => clearProductImage(product.id)}
                >
                  <Trash2 size={11} />
                  移除图片
                </button>
              )}
              </>}
              {product.imageMediaId && (
                <div className="order-product-image-preview">
                  <ProductImage
                    mediaId={product.imageMediaId}
                    token={token}
                    onToken={onToken}
                    alt={product.imageName || product.name || "产品图片"}
                    className="order-product-image"
                  />
                  <span title={product.imageName}>{product.imageName || "已选择产品图片"}</span>
                </div>
              )}
            </article>;
          })}
        </div>
        <button
          className="order-add-row"
          disabled={products.length >= 50}
          onClick={() => setProducts((all) => [...all, newDraftProduct()])}
        >
          <Plus size={13} />
          添加商品
        </button>
        <div className="order-fees-head">
          <b>Additional fees</b>
          <button
            disabled={fees.length >= 20}
            onClick={() =>
              setFees((all) => [
                ...all,
                { id: crypto.randomUUID(), name: "", amount: "" },
              ])
            }
          >
            <Plus size={12} />
            Add fee
          </button>
        </div>
        {fees.length ? (
          <div className="order-fees">
            {fees.map((fee, index) => (
              <div key={fee.id}>
                <input
                  value={fee.name}
                  onChange={(event) =>
                    updateFee(fee.id, { name: event.target.value })
                  }
                  maxLength={80}
                  placeholder={`Fee ${index + 1} name`}
                />
                <input
                  value={fee.amount}
                  onChange={(event) =>
                    updateFee(fee.id, { amount: event.target.value })
                  }
                  inputMode="decimal"
                  placeholder="0.00"
                />
                <button
                  onClick={() =>
                    setFees((all) => all.filter((item) => item.id !== fee.id))
                  }
                  aria-label={`删除费用 ${index + 1}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="order-empty-fees">No additional fees</p>
        )}
        <section className="order-address-section">
          <div className="order-fees-head"><span><b>收货地址 · 可选</b><small>地址会保存到当前客户，下次创建订单可直接选择</small></span><button onClick={()=>{setAddingAddress(true);setAddressId("");}}><Plus size={13}/>新增地址</button></div>
          <div className="order-address-cards">
            <button className={!addingAddress&&!addressId?"selected":""} onClick={()=>{setAddingAddress(false);setAddressId("");}}><MapPin size={15}/><span><b>不添加地址</b><small>此订单无需收货地址</small></span></button>
            {addresses.map(item=><button key={item.id} className={!addingAddress&&addressId===item.id?"selected":""} onClick={()=>{setAddingAddress(false);setAddressId(item.id);}}><MapPin size={15}/><span><b>{item.label}</b><small>{[item.recipientName,item.phone].filter(Boolean).join(" · ")}</small><em>{item.address}</em></span></button>)}
          </div>
          {addingAddress&&<div className="order-address-editor"><label>地址名称<input value={addressDraft.label} maxLength={40} placeholder="例如：公司、家" onChange={event=>setAddressDraft(value=>({...value,label:event.target.value}))}/></label><div><label>收件人<input value={addressDraft.recipientName} maxLength={80} onChange={event=>setAddressDraft(value=>({...value,recipientName:event.target.value}))}/></label><label>联系电话<input value={addressDraft.phone} maxLength={40} onChange={event=>setAddressDraft(value=>({...value,phone:event.target.value}))}/></label></div><label>详细地址<textarea value={addressDraft.address} maxLength={1000} placeholder="请输入完整收货地址" onChange={event=>setAddressDraft(value=>({...value,address:event.target.value}))}/></label><small>保存订单后，这张地址卡会自动绑定到 {active.name}</small></div>}
        </section>
        <label>
          Order notes · Optional
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
            placeholder="Order notes in English"
          />
        </label>
        <div className="order-total">
          <span>Total</span>
          <b>
            {currency} {total.toFixed(2)}
          </b>
        </div>
        {error && <span className="login-error">{error}</span>}
        <p className="order-disclosure">
          {order
            ? "Saving changes the reusable order. It does not edit previously sent WhatsApp messages."
            : "Saving creates a draft only. Nothing will be sent to the customer yet."}
        </p>
        <button
          className="login-submit"
          disabled={busy || total <= 0}
          onClick={() => void submit()}
        >
          {busy
            ? order
              ? "Saving changes…"
              : "Saving draft…"
            : order
              ? "Save changes"
              : "Save order draft"}
        </button>
        <small className="dialog-hint">Ctrl / Cmd + Enter</small>
      </section>
    </div>
    {imagePickerProductId && (
      <ProductImageMediaDialog
        request={(path,init)=>authorizedFetch(path,token,init)}
        onToken={onToken}
        onClose={() => setImagePickerProductId(null)}
        onSelect={chooseMediaImage}
        libraryPath={`/api/v1/media?accountId=${encodeURIComponent(active.accountId)}&limit=100`}
        uploadPath={`/api/v1/media?accountId=${encodeURIComponent(active.accountId)}`}
        description="仅显示当前 WhatsApp 账号中可用的 PNG 和 JPG 图片。"
      />
    )}
    </>
  );
}

function toDateTimeLocal(value:string){const date=new Date(value),offset=date.getTimezoneOffset()*60000;return new Date(date.getTime()-offset).toISOString().slice(0,16);}
function formatDateTime(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function deliveryText(status:string){return({queued:"排队中",dispatching:"发送中",sent:"已发送",delivered:"已送达",read:"已读",failed:"失败",uncertain:"待确认"} as Record<string,string>)[status]??status;}

function AccessPortal({loading,onLogin}:{loading:boolean;onLogin:()=>void}){
  return <main className="access-shell">
    <header className="access-header"><Link className="access-brand" href="/" aria-label="RelayDesk 主页"><span><Sparkles size={19}/></span><b>RelayDesk</b></Link><span className="operator-badge">由 GeekMT 运营</span></header>
    <section className="access-hero" aria-labelledby="access-title">
      <div className="access-copy"><span className="access-eyebrow">私有消息工作台</span><h1 id="access-title">清楚身份，再安全登录。</h1><p>RelayDesk 是 GeekMT 为获授权团队成员运营的内部消息工作台。这里使用的是 RelayDesk 坐席账号，不是 WhatsApp 或 Meta 账号。</p><button className="access-login" onClick={onLogin} disabled={loading}><ShieldCheck size={18}/>{loading?"正在检查会话…":"使用 RelayDesk 账号登录"}</button><small>没有账号？请联系你的 GeekMT 管理员。本站不会要求安装浏览器更新或远程控制软件。</small></div>
      <aside className="trust-card" aria-label="身份与安全说明"><div className="trust-card-head"><ShieldCheck size={24}/><span><b>登录前请确认</b><small>保护你的账号和个人信息</small></span></div><ul><li><b>独立服务</b><span>RelayDesk 不属于 WhatsApp LLC 或 Meta Platforms，也未获其赞助或背书。</span></li><li><b>专用凭据</b><span>只输入管理员发放的 RelayDesk 邮箱与密码。不要输入 WhatsApp / Meta 密码、短信验证码或两步验证 PIN。</span></li><li><b>授权访问</b><span>此工作台仅供获授权的 GeekMT 团队成员处理已许可的业务会话。</span></li></ul></aside>
    </section>
    <section className="access-purpose" aria-label="服务说明"><div><MessageCircle size={20}/><span><b>服务用途</b><small>集中处理经授权接入的客户消息</small></span></div><div><Wifi size={20}/><span><b>连接方式</b><small>通过受管的 RelayDesk Agent 同步</small></span></div><div><ShieldCheck size={20}/><span><b>凭据用途</b><small>仅验证 RelayDesk 坐席身份</small></span></div></section>
    <footer className="access-footer"><p><b>商标说明：</b>WhatsApp 是 WhatsApp LLC 的商标；Meta 是 Meta Platforms, Inc. 的商标。提及这些名称仅为说明兼容的消息渠道。</p><p>© {new Date().getFullYear()} GeekMT · RelayDesk 私有系统</p></footer>
  </main>;
}

const LANGUAGES=[
  ["zh-CN","简体中文"],["zh-TW","繁體中文"],["en","English"],["en-US","English (US)"],["en-GB","English (UK)"],
  ["ms","Bahasa Melayu"],["id","Bahasa Indonesia"],["th","ไทย"],["vi","Tiếng Việt"],["ja","日本語"],["ko","한국어"],
  ["es","Español"],["fr","Français"],["de","Deutsch"],["it","Italiano"],["pt-BR","Português (Brasil)"],["ru","Русский"],
  ["ar","العربية"],["hi","हिन्दी"],["tr","Türkçe"],["nl","Nederlands"],["pl","Polski"],
] as const;

function languageName(code:string){return LANGUAGES.find(item=>item[0]===code)?.[1]??code;}
function isEnglishLanguage(code:string){return /^en(?:-|$)/i.test(code);}

function TranslationMenu({preference,configured,ready,onChange,onClose}:{preference:TranslationPreference;configured:boolean;ready:boolean;onChange:(value:TranslationPreference)=>void;onClose:()=>void}){
  return <section className="translation-menu" role="dialog" aria-label="AI 翻译设置"><header><span><Languages size={16}/><b>当前会话 · AI 双向翻译</b></span><button onClick={onClose} aria-label="关闭翻译设置"><X size={15}/></button></header><label className="translation-toggle"><span><b>为当前会话启用</b><small>{!ready?"正在读取会话配置…":configured?"此会话偏好会跨浏览器同步":"管理员尚未配置翻译 Provider"}</small></span><input type="checkbox" checked={preference.enabled} disabled={!ready||(!configured&&!preference.enabled)} onChange={event=>onChange({...preference,enabled:event.target.checked})}/></label><div className="translation-language-grid"><label><span>收到消息译为</span><LanguagePicker value={preference.agentLanguage} onChange={agentLanguage=>onChange({...preference,agentLanguage})}/></label><label><span>发送消息译为</span><LanguagePicker value={preference.customerLanguage} onChange={customerLanguage=>onChange({...preference,customerLanguage})}/></label></div><p><Info size={13}/>设置只影响当前会话；发送前会显示可编辑预览。</p></section>;
}

function LanguagePicker({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState("");
  const visible=LANGUAGES.filter(([code,name])=>`${code} ${name}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="language-picker"><input type="search" value={open?query:languageName(value)} onFocus={()=>{setOpen(true);setQuery("");}} onChange={event=>{setOpen(true);setQuery(event.target.value);}} onBlur={()=>window.setTimeout(()=>setOpen(false),120)} aria-label="搜索并选择语言" autoComplete="off"/>{open&&<div className="language-options" role="listbox">{visible.length?visible.map(([code,name])=><button type="button" role="option" aria-selected={code===value} className={code===value?"selected":""} key={code} onMouseDown={event=>event.preventDefault()} onClick={()=>{onChange(code);setOpen(false);setQuery("");}}><span>{name}</span><small>{code}</small></button>):<span className="language-empty">没有匹配语言</span>}</div>}</div>;
}

function IncomingTranslation({value,language,onRetry}:{value?:MessageTranslation;language:string;onRetry:()=>void}){
  if(value?.status==="idle")return null;
  if(!value||value.status==="loading")return <div className="incoming-translation loading"><RefreshCw className="spin" size={12}/>正在翻译为 {languageName(language)}…</div>;
  if(value.status==="failed")return <div className="incoming-translation failed"><span>{value.message??"译文加载失败"}</span><button onClick={onRetry}>重试</button></div>;
  return <div className="incoming-translation"><span><Languages size={12}/>{languageName(language)}</span><p>{value.text}</p></div>;
}

function VoiceTranslation({value,language,configured,onTranslate}:{value?:MessageTranslation;language:string;configured:boolean;onTranslate:()=>void}){
  if(!value||value.status==="idle")return <button className="voice-translate-action" disabled={!configured} onClick={onTranslate}><Languages size={12}/>{configured?`AI 翻译语音为 ${languageName(language)}`:"管理员尚未配置翻译 Provider"}</button>;
  if(value.status==="loading")return <div className="incoming-translation loading"><RefreshCw className="spin" size={12}/>正在转写并翻译语音…</div>;
  if(value.status==="failed")return <div className="incoming-translation failed"><span>{value.message??"语音翻译失败"}</span><button onClick={onTranslate}>重试</button></div>;
  return <div className="incoming-translation voice-translation">{value.sourceText&&<><span><Mic size={12}/>语音原文</span><p>{value.sourceText}</p></>}<span><Languages size={12}/>{languageName(language)}译文</span><p>{value.text}</p></div>;
}

function TranslationPreviewDialog({source,translated,targetLanguage,onClose,onConfirm}:{source:string;translated:string;targetLanguage:string;onClose:()=>void;onConfirm:(text:string)=>void}){
  const [text,setText]=useState(translated);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section className="login-dialog translation-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="translation-preview-title"><button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Languages size={21}/></span><h2 id="translation-preview-title">确认翻译后发送</h2><p>目标语言：{languageName(targetLanguage)}。译文可以在发送前继续修改。</p><label>原文<textarea value={source} readOnly/></label><label>将发送的译文 <span className="tts-count">{text.length}/65536</span><textarea value={text} onChange={event=>setText(event.target.value)} maxLength={65536} autoFocus/></label><div className="translation-preview-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" disabled={!text.trim()} onClick={()=>onConfirm(text.trim())}><Send size={14}/>确认并发送</button></div></section></div>;
}

const EMOJI_GROUPS:Record<string,string[]>={
  "常用":["😀","😂","😍","🥰","😊","🙏","👍","❤️","😭","😘","🤣","😁","🎉","🔥","👌","🤔","😅","😎","👏","💪","🙌","😉","😢","🤝"],
  "表情":["😀","😃","😄","😁","😆","😅","😂","🤣","🥲","☺️","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🫣","🤭","🫢","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🤢","🤮","🤧","😷","🤒","🤕"],
  "手势":["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉","👆","👇","☝️","🫵","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️","💅","💪"],
  "动物":["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐻‍❄️","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦄","🐝","🦋","🐌","🐞","🐢","🐍","🦎","🐙","🦑","🦀","🐠","🐬","🐳","🌸","🌹","🌻","🌴","🌵","🍀"],
  "食物":["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥕","🌽","🌶️","🍞","🥐","🧀","🥚","🍔","🍟","🍕","🌭","🥪","🌮","🍜","🍣","🍱","🍚","🍰","🎂","🍫","🍿","☕","🍵","🥤","🍺","🍷"],
  "活动":["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🏒","🏑","🥍","🏏","⛳","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🚲","🏆","🥇","🎯","🎮","🎲","🎸","🎹","🎤","🎧","🎨","🎬","🎉","🎊"],
  "旅行":["🚗","🚕","🚌","🚎","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚲","🛵","🏍️","✈️","🚀","🚁","⛵","🚢","🚆","🚇","🚉","🗺️","🗽","🗼","🏰","🏯","🏖️","🏝️","🏜️","🌋","⛰️","🏕️","🌅","🌇","🌃","🌍","🌎","🌏"],
  "符号":["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☪️","🕉️","☯️","✡️","🔯","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","✅","❌","❗","❓","💯","⚠️","🔔","✨","🔥","⭐"]
};
const EMOJI_TABS:Record<string,string>={"常用":"🕘","表情":"😀","手势":"👋","动物":"🐻","食物":"🍔","活动":"⚽","旅行":"🚗","符号":"❤️"};

function EmojiPicker({category,onCategory,onSelect,onClose}:{category:string;onCategory:(value:string)=>void;onSelect:(emoji:string)=>void;onClose:()=>void}){return <section className="emoji-picker" role="dialog" aria-label="选择表情"><header><b>表情</b><button onClick={onClose} aria-label="关闭表情面板"><X size={15}/></button></header><nav>{Object.entries(EMOJI_TABS).map(([name,icon])=><button key={name} className={category===name?"active":""} onClick={()=>onCategory(name)} title={name} aria-label={name}>{icon}</button>)}</nav><div className="emoji-grid">{(EMOJI_GROUPS[category]??EMOJI_GROUPS["常用"]).map((emoji,index)=><button key={`${emoji}-${index}`} onClick={()=>onSelect(emoji)} aria-label={`插入 ${emoji}`}>{emoji}</button>)}</div></section>}

function TextToSpeechDialog({accountId,token,initialText,onToken,onClose,onSend}:{accountId:string;token:string;initialText:string;onToken:(token:string)=>void;onClose:()=>void;onSend:(asset:MediaAsset)=>Promise<void>}){
  const [text,setText]=useState(initialText),[speed,setSpeed]=useState(1),[instructions,setInstructions]=useState("用自然、友好、适合客户沟通的语气朗读"),[busy,setBusy]=useState(false),[error,setError]=useState(""),[provider,setProvider]=useState<string|null>(null),[configured,setConfigured]=useState<boolean|null>(null);
  useEffect(()=>{void (async()=>{const result=await authorizedFetch("/api/v1/tts/status",token);if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {configured?:boolean;provider?:string};setConfigured(Boolean(body.configured));setProvider(body.provider??null);})().catch(()=>setConfigured(false));},[token,onToken]);
  async function generate(){
    if(!text.trim()||busy)return;setBusy(true);setError("");
    try{
      const result=await authorizedFetch("/api/v1/text-to-speech",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,text:text.trim(),speed,instructions:instructions.trim()||undefined})});if(result.token!==token)onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;
      if(!result.response.ok)throw new Error(String(body.message??(body.error==="tts_not_configured"?"管理员尚未启用语音 Provider":`生成失败（HTTP ${result.response.status}）`)));
      await onSend({id:String(body.mediaId),fileName:String(body.fileName),mimeType:String(body.mimeType),size:Number(body.size),sha256:String(body.sha256),createdAt:new Date().toISOString(),usageCount:0});
    }catch(reason){setError(reason instanceof Error?reason.message:"AI 语音生成失败，请稍后重试");setBusy(false);}
  }
  return <div className="modal-backdrop media-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="login-dialog tts-dialog" role="dialog" aria-modal="true" aria-labelledby="tts-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><div className="login-logo"><Sparkles size={20}/></div><h2 id="tts-title">AI 文字转语音</h2><p>输入要发送的内容，生成后会作为 WhatsApp 语音消息直接排队发送。</p><label>朗读文字 <span className="tts-count">{text.length}/4096</span><textarea value={text} onChange={event=>setText(event.target.value)} maxLength={4096} autoFocus placeholder="输入需要朗读并发送的文字"/></label><label>语速 <span className="tts-speed">{speed.toFixed(2)}×</span><input type="range" min="0.75" max="1.5" step="0.05" value={speed} onChange={event=>setSpeed(Number(event.target.value))}/></label><label>语气要求（部分 Provider 支持）<input value={instructions} onChange={event=>setInstructions(event.target.value)} maxLength={500} placeholder="例如：专业、亲切，稍微放慢语速"/></label><div className={`tts-disclosure ${configured===false?"warning":""}`}><Info size={14}/><span>{configured===null?"正在读取 Provider 配置…":configured?`文字会发送给 ${providerName(provider)} 生成 AI 音频。`:`管理员尚未在系统设置中启用语音 Provider。`}</span></div>{error&&<span className="login-error">{error}</span>}<button className="login-submit" onClick={()=>void generate()} disabled={busy||!text.trim()||configured!==true}>{busy?<><RefreshCw className="spin" size={15}/>正在生成并发送…</>:<><Mic size={15}/>生成并发送语音</>}</button></section></div>;
}

function MediaDialog({accountId,token,initialCaption,onToken,onToast,onClose,onSend}:{accountId:string;token:string;initialCaption:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onClose:()=>void;onSend:(asset:MediaAsset,caption:string)=>Promise<void>}){
  const [assets,setAssets]=useState<MediaAsset[]>([]),[selectedId,setSelectedId]=useState(""),[query,setQuery]=useState(""),[filter,setFilter]=useState("all"),[caption,setCaption]=useState(initialCaption),[busy,setBusy]=useState(false),[dragging,setDragging]=useState(false),[error,setError]=useState("");const inputRef=useRef<HTMLInputElement>(null);
  const load=useCallback(async()=>{const result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}&limit=100`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok){setError(`媒体库加载失败（HTTP ${result.response.status}）`);return;}const body=await result.response.json() as {data:Array<Record<string,unknown>>};setAssets(body.data.map(mapMediaAsset));},[accountId,token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy)onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[busy,onClose]);
  useEffect(()=>{const paste=(event:ClipboardEvent)=>{const files=Array.from(event.clipboardData?.files??[]);if(!files.length||busy)return;event.preventDefault();void upload(files);};window.addEventListener("paste",paste);return()=>window.removeEventListener("paste",paste);});
  const visible=assets.filter(item=>(!query||item.fileName.toLowerCase().includes(query.toLowerCase()))&&(filter==="all"||mediaKind(item.mimeType)===filter)),selected=assets.find(item=>item.id===selectedId)??null;
  async function upload(files:FileList|File[]){const list=Array.from(files);if(!list.length)return;setBusy(true);setError("");try{let last:MediaAsset|null=null;for(const file of list){if(file.size>64*1024*1024)throw new Error(`${file.name} 超过 64 MB`);const form=new FormData();form.append("file",file);const result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}`,token,{method:"POST",body:form});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`${file.name} 上传失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {mediaId:string;fileName:string;mimeType:string;size:number;sha256:string};last={id:body.mediaId,fileName:body.fileName,mimeType:body.mimeType,size:body.size,sha256:body.sha256,createdAt:new Date().toISOString(),usageCount:0};}await load();if(last)setSelectedId(last.id);onToast(list.length>1?`${list.length} 个文件已加入媒体库`:"文件已加入媒体库");}catch(reason){setError(reason instanceof Error?reason.message:"上传失败");}finally{setBusy(false);setDragging(false);}}
  async function remove(asset:MediaAsset){if(asset.usageCount>0){setError("该文件已被消息使用，不能删除");return;}if(!window.confirm(`从媒体库删除“${asset.fileName}”？`))return;setBusy(true);const result=await authorizedFetch(`/api/v1/media/${asset.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){setError(result.response.status===409?"该文件已被消息使用，不能删除":`删除失败（HTTP ${result.response.status}）`);return;}if(selectedId===asset.id)setSelectedId("");await load();onToast("文件已从媒体库删除");}
  return <div className="modal-backdrop media-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="media-dialog" role="dialog" aria-modal="true" aria-labelledby="media-dialog-title"><header><div><span className="login-logo"><Paperclip size={21}/></span><span><h2 id="media-dialog-title">媒体与附件</h2><p>上传一次，之后可在该 WhatsApp 账号的会话中复用。</p></span></div><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button></header><div className={`media-dropzone ${dragging?"dragging":""}`} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();void upload(event.dataTransfer.files)}} onClick={()=>inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")inputRef.current?.click();}}><UploadCloud size={30}/><b>{busy?"正在上传…":"拖拽文件到这里、直接粘贴，或点击选择"}</b><span>图片、MP4、OGG、MP3、PDF、ZIP；单文件最大 64 MB</span><input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,audio/ogg,audio/mpeg,application/pdf,application/zip" onChange={event=>{if(event.target.files)void upload(event.target.files);event.currentTarget.value="";}}/></div><div className="media-library-head"><div><b>媒体库</b><span>{assets.length} 个文件</span></div><label><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索文件名"/></label></div><div className="media-filters">{[["all","全部"],["image","图片"],["video","视频"],["audio","音频"],["document","文档"]].map(([value,label])=><button key={value} className={filter===value?"active":""} onClick={()=>setFilter(value)}>{label}</button>)}</div><div className="media-grid">{visible.length?visible.map(asset=>{const kind=mediaKind(asset.mimeType);return <button key={asset.id} className={`media-item ${kind==="image"?"with-image-preview":""} ${selectedId===asset.id?"selected":""}`} onClick={()=>setSelectedId(asset.id)}>{kind==="image"?<ProductImage mediaId={asset.id} token={token} onToken={onToken} alt={asset.fileName} className="media-library-preview"/>:<span className={`media-kind ${kind}`}><FileText size={22}/></span>}<span><b title={asset.fileName}>{asset.fileName}</b><small>{formatBytes(asset.size)} · {asset.usageCount?`已使用 ${asset.usageCount} 次`:"未使用"}</small></span><i role="button" tabIndex={0} aria-label={`删除 ${asset.fileName}`} onClick={event=>{event.stopPropagation();void remove(asset)}} onKeyDown={event=>{if(event.key==="Enter"){event.stopPropagation();void remove(asset);}}}><Trash2 size={14}/></i></button>}):<div className="media-empty"><FileText size={28}/><b>媒体库中暂无匹配文件</b><span>可从上方拖拽或粘贴上传</span></div>}</div>{error&&<span className="login-error media-error">{error}</span>}<footer><label>附件说明（可选）<input value={caption} onChange={event=>setCaption(event.target.value)} maxLength={65536} placeholder="随附件一起发送的文字"/></label><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" disabled={!selected||busy} onClick={()=>selected&&void onSend(selected,caption.trim())}>发送所选附件</button></footer></section></div>;
}

function mapMediaAsset(item:Record<string,unknown>):MediaAsset{return{id:String(item.id),fileName:String(item.file_name??"未命名文件"),mimeType:String(item.mime_type??"application/octet-stream"),size:Number(item.byte_size??0),sha256:String(item.sha256??""),createdAt:String(item.created_at??""),usageCount:Number(item.usage_count??0)};}
function mediaKind(mime:string){return mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":"document";}

function mapConversation(item:Record<string,unknown>,index:number):Conversation {const name=String(item.display_name??item.phone_e164??"未知联系人");return{id:String(item.id),name,initials:name.slice(0,2).toUpperCase(),color:COLORS[index%COLORS.length],account:String(item.account_name??"未知账号"),accountId:String(item.account_id),phone:String(item.phone_e164??""),alias:String(item.alias??""),contactName:String(item.contact_name??item.phone_e164??""),preview:String(item.last_message??kindText(String(item.last_message_kind??""))),time:item.last_message_at?formatTime(new Date(String(item.last_message_at))):"",unread:Number(item.unread_count??0),accountStatus:String(item.account_status??"offline"),assignedUserId:item.assigned_user_id?String(item.assigned_user_id):null,favorite:Boolean(item.favorite),conversationStatus:String(item.status??"open"),customerStage:String(item.customer_stage??"new"),tags:Array.isArray(item.tags)?item.tags.map(mapTag):[],remindAt:item.remind_at?String(item.remind_at):null};}
function mapTag(item:Record<string,unknown>):TagItem{return{id:String(item.id),name:String(item.name??"标签"),color:String(item.color??"#DFF5E8")};}
function mapMessage(item:Record<string,unknown>):ChatMessage {const kind=String(item.kind??"text"),mediaId=String(item.media_id??"");return{id:String(item.id),direction:item.direction as "in"|"out",kind,text:String(item.text_content??(mediaId?"":kindText(kind))),translationSourceText:item.translation_source_text?String(item.translation_source_text):undefined,time:formatTime(new Date(String(item.occurred_at))),status:item.status as ChatMessage["status"],attachment:item.file_name&&mediaId?{id:mediaId,name:String(item.file_name),mime:String(item.mime_type??"文件"),size:formatBytes(Number(item.byte_size??0))}:undefined};}
function kindText(kind:string){return({audio:"[语音消息]",image:"[图片]",video:"[视频]",document:"[文档]",location:"[位置]",contact:"[联系人名片]"} as Record<string,string>)[kind]??"暂无消息";}
function statusText(status:string){return({online:"在线",pairing:"等待配对",offline:"离线",logged_out:"已退出",error:"异常"} as Record<string,string>)[status]??status;}
function formatTime(date:Date){return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});}
function formatBytes(size:number){if(size<1024)return`${size} B`;if(size<1048576)return`${(size/1024).toFixed(1)} KB`;return`${(size/1048576).toFixed(1)} MB`;}
function tokenSubject(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).sub??"");}catch{return"";}}
function tokenRole(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role??"");}catch{return"";}}
async function authorizedFetch(path:string,token:string,init:RequestInit={}):Promise<{response:Response;token:string}>{
  const send=(accessToken:string)=>fetch(`${API_URL}${path}`,{...init,credentials:"include",headers:{...init.headers,authorization:`Bearer ${accessToken}`}});
  let response=await send(token);if(response.status!==401)return{response,token};
  refreshPromise??=refreshAccessToken();
  let refreshedToken="";try{refreshedToken=await refreshPromise;}finally{refreshPromise=null;}
  if(!refreshedToken)return{response,token};
  sessionStorage.setItem("relayAccessToken",refreshedToken);response=await send(refreshedToken);return{response,token:refreshedToken};
}
async function refreshAccessToken(){const response=await fetch(`${API_URL}/api/v1/auth/refresh`,{method:"POST",credentials:"include"});if(!response.ok)return"";const body=await response.json() as {accessToken?:string};return body.accessToken??"";}

function EmptyState({title,text}:{title:string;text:string}){return <div className="empty-state"><b>{title}</b><span>{text}</span></div>;}
function AccountStatus({initials,color,name,detail,online=false}:{initials:string;color:string;name:string;detail:string;online?:boolean}){return <div className={`account-status ${online?"":"muted"}`}><span className={`avatar tiny ${color}`}>{initials}</span><span><b>{name}</b><small><i className={`status-dot ${online?"online":""}`}/>{detail}</small></span></div>;}
function MessageStatus({status}:{status?:ChatMessage["status"]}){if(status==="queued"||status==="dispatching")return <span className="message-state queued"><Clock3 size={12}/>{status==="queued"?"排队中":"发送中"}</span>;if(status==="failed"||status==="uncertain")return <span className="message-state failed"><X size={12}/>{status==="failed"?"失败":"待确认"}</span>;if(status==="read")return <span className="message-state read"><CheckCheck size={13}/>已读</span>;if(status==="delivered")return <span className="message-state"><CheckCheck size={13}/>已送达</span>;return <span className="message-state"><Check size={13}/>已发送</span>;}

function MessageMedia({attachment,token,onToken,onReady}:{attachment:{id:string;name:string;size:string;mime:string};token:string;onToken:(token:string)=>void;onReady:()=>void}){
  const [url,setUrl]=useState("");const [error,setError]=useState("");
  useEffect(()=>{const controller=new AbortController();let objectUrl="";void (async()=>{try{const result=await authorizedFetch(`/api/v1/media/${attachment.id}`,token,{signal:controller.signal});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`HTTP ${result.response.status}`);objectUrl=URL.createObjectURL(await result.response.blob());setUrl(objectUrl);setError("");}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"媒体加载失败");}})();return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[attachment.id,token,onToken]);
  if(error)return <div className="message-media message-media-error">媒体加载失败 · {error}</div>;if(!url)return <div className="message-media message-media-loading">正在加载媒体…</div>;
  if(attachment.mime.startsWith("image/"))return <div className="message-media"><button className="message-media-preview" onClick={()=>window.open(url,"_blank","noopener,noreferrer")} aria-label={`查看图片 ${attachment.name}`}><Image src={url} alt={attachment.name} width={440} height={440} unoptimized onLoad={onReady}/></button></div>;
  if(attachment.mime.startsWith("video/"))return <div className="message-media"><video src={url} controls preload="metadata" aria-label={attachment.name} onLoadedMetadata={onReady}/></div>;
  if(attachment.mime.startsWith("audio/"))return <div className="message-media"><audio src={url} controls preload="metadata" aria-label={attachment.name} onLoadedMetadata={onReady}/></div>;
  return <button className="attachment-card" onClick={()=>{const link=document.createElement("a");link.href=url;link.download=attachment.name;link.click();}}><span><FileText size={20}/></span><span><b>{attachment.name}</b><small>{attachment.mime} · {attachment.size}</small></span></button>;
}

function AgentConversationBar({conversationId,token,refreshKey,onToken,onToast,onUseDraft,onSent}:{conversationId:string;token:string;refreshKey:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onUseDraft:(text:string)=>void;onSent:()=>void}){
  const [state,setState]=useState<{mode:string;account_enabled:boolean;draft:AgentDraft|null}|null>(null),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{try{const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/agent`,token);if(result.token!==token)onToken(result.token);if(result.response.ok)setState(await result.response.json());}catch{}},[conversationId,token,onToken]);
  useEffect(()=>{const first=window.setTimeout(()=>void load(),0),poll=window.setInterval(()=>void load(),8000);return()=>{window.clearTimeout(first);window.clearInterval(poll);};},[load,refreshKey]);
  async function setMode(mode:"cautious"|"full"|"human_paused"){setBusy(true);const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/agent`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({mode})});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){onToast(mode==="cautious"?"已启用谨慎接管，证据不足时将等待人工确认":mode==="full"?"已启用完全接管，Agent 回复无需人工确认":"已切换人工接管，待跟进任务已取消");await load();}}
  async function resolveDraft(action:"send"|"dismiss"){if(!state?.draft)return;setBusy(true);const result=await authorizedFetch(`/api/v1/ai-drafts/${state.draft.id}/${action}`,token,{method:"POST",headers:{"content-type":"application/json"},body:action==="send"?JSON.stringify({text:state.draft.text_content}):undefined});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){onToast(action==="send"?"AI 草稿已进入发送队列，Agent 已转为人工接管":"AI 草稿已忽略");await load();onSent();}}
  if(!state)return null;const paused=state.mode==="human_paused",full=state.mode==="full",enabled=state.account_enabled;
  return <div className={`agent-conversation-bar ${paused?"paused":full?"full":""} ${enabled?"":"disabled"}`}><span><Bot size={15}/><b>{enabled?(paused?"人工接管":full?"完全接管":"谨慎接管"):"AI 自动回复未配置"}</b><small>{enabled?(paused?"当前会话不会自动回复或跟进":full?"当前会话完全由 Agent 回复，无需人工确认":"可靠回复自动发送，证据不足时等待人工确认"):"请先在系统设置中启用该账号的 AI 能力"}</small></span><div className="takeover-switch" role="group" aria-label="会话接管方式"><button className={!paused&&!full&&enabled?"active cautious":""} disabled={busy||!enabled} onClick={()=>void setMode("cautious")} aria-pressed={!paused&&!full&&enabled}><ShieldCheck size={13}/>谨慎接管</button><button className={full&&enabled?"active full":""} disabled={busy||!enabled} onClick={()=>void setMode("full")} aria-pressed={full&&enabled}><Bot size={13}/>完全接管</button><button className={paused&&enabled?"active human":""} disabled={busy||!enabled} onClick={()=>void setMode("human_paused")} aria-pressed={paused&&enabled}><Users size={13}/>人工接管</button></div>{state.draft&&<div className="agent-draft"><span><Sparkles size={14}/><b>AI 建议回复</b><small>{state.draft.reason}</small></span><div className="agent-draft-copy"><section><b>发送内容</b><p>{state.draft.text_content}</p></section><section className="zh"><b>中文参考</b><p>{state.draft.reply_zh||"历史建议未生成中文参考"}</p></section></div><div><button onClick={()=>onUseDraft(state.draft!.text_content)}>放入输入框</button><button onClick={()=>void resolveDraft("dismiss")}>忽略</button><button className="primary" onClick={()=>void resolveDraft("send")}>确认发送</button></div></div>}</div>;
}

function AgentMemoryPanel({conversationId,token,onToken,onToast}:{conversationId:string;token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [memory,setMemory]=useState<{summary:string;updatedAt:string|null;facts:Array<{id:string;fact_key:string;fact_value:string;confidence:number;source_text?:string}>}|null>(null),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory`,token);if(result.token!==token)onToken(result.token);if(result.response.ok)setMemory(await result.response.json());},[conversationId,token,onToken]);useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  async function remove(id:string){const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/facts/${id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(result.response.ok)await load();}
  async function edit(fact:{id:string;fact_key:string;fact_value:string}){const key=window.prompt("记忆字段",fact.fact_key),value=window.prompt("记忆内容",fact.fact_value);if(!key?.trim()||!value?.trim())return;const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/facts/${fact.id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({key,value})});if(result.token!==token)onToken(result.token);if(result.response.ok)await load();}
  async function rebuild(){setBusy(true);const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/rebuild`,token,{method:"POST"});if(result.token!==token)onToken(result.token);setBusy(false);onToast(result.response.ok?"记忆更新任务已创建":"记忆更新失败");}
  return <div className="detail-section agent-memory"><div className="detail-title"><h4><Brain size={13}/>聊天记忆</h4><button disabled={busy} onClick={()=>void rebuild()}><RefreshCw size={11}/>重新整理</button></div><p className="memory-summary">{memory?.summary||"Agent 尚未生成会话摘要。"}</p><div className="memory-facts">{memory?.facts.map(fact=><span key={fact.id} title={fact.source_text||"来源消息已删除"}><b>{fact.fact_key}</b><em>{fact.fact_value}</em><i><button onClick={()=>void edit(fact)} aria-label={`编辑记忆 ${fact.fact_key}`}><Pencil size={10}/></button><button onClick={()=>void remove(fact.id)} aria-label={`删除记忆 ${fact.fact_key}`}><X size={10}/></button></i></span>)}</div></div>;
}

function SettingsPanel({token,role,accounts,onToken,onToast}:{token:string;role:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [tab,setTab]=useState<"agent"|"knowledge"|"translation"|"speech"|"currency"|"orders">("agent");
  if(role!=="admin")return <section className="management-panel"><EmptyState title="需要管理员权限" text="只有管理员可以查看或修改 AI Provider 与密钥配置。"/></section>;
  return <section className="management-panel settings-panel"><header className="management-head"><div><span className="eyebrow">系统设置</span><h1>工作区配置</h1><p>集中管理自动回复、知识库、AI Provider 和业务规则。</p></div></header><nav className="settings-tabs" aria-label="系统设置"><button className={tab==="agent"?"active":""} onClick={()=>setTab("agent")}><Bot size={15}/>AI Agent</button><button className={tab==="knowledge"?"active":""} onClick={()=>setTab("knowledge")}><BookOpen size={15}/>知识库</button><button className={tab==="translation"?"active":""} onClick={()=>setTab("translation")}><Languages size={15}/>AI 翻译</button><button className={tab==="speech"?"active":""} onClick={()=>setTab("speech")}><Mic size={15}/>AI 语音</button><button className={tab==="currency"?"active":""} onClick={()=>setTab("currency")}><CreditCard size={15}/>货币管理</button><button className={tab==="orders"?"active":""} onClick={()=>setTab("orders")}><ClipboardList size={15}/>订单设置</button></nav>{tab==="agent"?<AiAgentSettingsPanel token={token} accounts={accounts} onToken={onToken} onToast={onToast}/>:tab==="knowledge"?<KnowledgeBaseSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="translation"?<TranslationSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="speech"?<TtsSettingsPanel token={token} role={role} onToken={onToken} onToast={onToast}/>:tab==="currency"?<CurrencySettingsPanel token={token} role={role} onToken={onToken} onToast={onToast}/>:<OrderSettingsPanel token={token} onToken={onToken} onToast={onToast}/>}</section>;
}

function AiAgentSettingsPanel({token,accounts,onToken,onToast}:{token:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<Array<{provider:string;enabled:boolean;key_configured:boolean;base_url:string;model:string;embedding_model:string}>>([]),[providerId,setProviderId]=useState("openai"),[secret,setSecret]=useState(""),[accountId,setAccountId]=useState(accounts[0]?.id??""),[kbs,setKbs]=useState<KnowledgeBaseItem[]>([]),[settings,setSettings]=useState({enabled:false,persona:"You are a helpful, concise customer service agent.",replyLanguage:"auto",timezone:"Asia/Shanghai",businessStart:"09:00",businessEnd:"18:00",confidenceThreshold:.8,followupEnabled:true,followupDelaysHours:[24,72],knowledgeBaseIds:[] as string[]}),[saving,setSaving]=useState(false);
  const loadProvider=useCallback(async()=>{const result=await authorizedFetch("/api/v1/admin/agent-provider",token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:typeof providers};setProviders(body.data);setProviderId(value=>body.data.some(item=>item.provider===value)?value:(body.data.find(item=>item.enabled)?.provider??"openai"));}},[token,onToken]);
  const loadAccount=useCallback(async()=>{if(!accountId)return;const [result,kbResult]=await Promise.all([authorizedFetch(`/api/v1/accounts/${accountId}/agent-settings`,token),authorizedFetch("/api/v1/knowledge-bases",token)]);if(result.token!==token)onToken(result.token);if(kbResult.token!==token)onToken(kbResult.token);if(kbResult.response.ok)setKbs((await kbResult.response.json()).data);if(result.response.ok){const body=await result.response.json() as Record<string,unknown>;setSettings({enabled:Boolean(body.enabled),persona:String(body.persona??""),replyLanguage:String(body.reply_language??"auto"),timezone:String(body.timezone??"UTC"),businessStart:String(body.business_start??"09:00").slice(0,5),businessEnd:String(body.business_end??"18:00").slice(0,5),confidenceThreshold:Number(body.confidence_threshold??.8),followupEnabled:body.followup_enabled!==false,followupDelaysHours:(body.followup_delays_hours as number[])??[24,72],knowledgeBaseIds:(body.knowledgeBaseIds as string[])??[]});}},[accountId,token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void loadProvider(),0);return()=>window.clearTimeout(timer);},[loadProvider]);useEffect(()=>{if(!accountId&&accounts[0]){const timer=window.setTimeout(()=>setAccountId(accounts[0].id),0);return()=>window.clearTimeout(timer);}},[accountId,accounts]);useEffect(()=>{const timer=window.setTimeout(()=>void loadAccount(),0);return()=>window.clearTimeout(timer);},[loadAccount]);const provider=providers.find(item=>item.provider===providerId);
  async function saveProvider(){if(!provider)return;setSaving(true);const result=await authorizedFetch(`/api/v1/admin/agent-provider/${providerId}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:provider.enabled,apiKey:secret||undefined,baseUrl:provider.base_url,model:provider.model,embeddingModel:provider.embedding_model})});if(result.token!==token)onToken(result.token);setSaving(false);onToast(result.response.ok?"Agent Provider 已保存":"Provider 保存失败");if(result.response.ok){setSecret("");await loadProvider();}}
  async function saveAccount(){if(!accountId)return;setSaving(true);const result=await authorizedFetch(`/api/v1/accounts/${accountId}/agent-settings`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({...settings,businessDays:[1,2,3,4,5]})});if(result.token!==token)onToken(result.token);setSaving(false);onToast(result.response.ok?"账号 Agent 规则已保存":"账号 Agent 规则保存失败");}
  const patchProvider=(change:Record<string,unknown>)=>setProviders(items=>items.map(item=>item.provider===providerId?{...item,...change}:item));
return <div className="agent-settings-grid"><section className="provider-form agent-card"><header><div><h2>Agent Provider</h2><p>用于回复决策、记忆整理和知识检索。</p></div></header><label>Provider<select value={providerId} onChange={event=>{setProviderId(event.target.value);setSecret("");}}><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option><option value="siliconflow">SiliconFlow</option><option value="openai_compatible">OpenAI Compatible</option></select></label>{provider&&<><label className="provider-toggle"><input type="checkbox" checked={provider.enabled} onChange={event=>patchProvider({enabled:event.target.checked})}/><span>启用此 Provider</span></label><label>API Key<input type="password" value={secret} onChange={event=>setSecret(event.target.value)} placeholder={provider.key_configured?"已加密保存；留空不修改":"请输入 API Key"}/></label><label>Endpoint<input value={provider.base_url} onChange={event=>patchProvider({base_url:event.target.value})}/></label><label>生成模型<input value={provider.model} onChange={event=>patchProvider({model:event.target.value})}/></label><label>嵌入模型<input value={provider.embedding_model} onChange={event=>patchProvider({embedding_model:event.target.value})}/><small>必须返回 1536 维向量。</small></label><button className="primary-action" disabled={saving} onClick={()=>void saveProvider()}><Check size={14}/>保存 Provider</button></>}</section><section className="provider-form agent-card"><header><div><h2>账号自动化</h2><p>配置账号级 AI 能力；是否接管及运行模式由每个会话单独选择。</p></div></header><label>WhatsApp 账号<select value={accountId} onChange={event=>setAccountId(event.target.value)}>{accounts.map(account=><option value={account.id} key={account.id}>{account.name}</option>)}</select></label><label className="provider-toggle"><input type="checkbox" checked={settings.enabled} onChange={event=>setSettings(value=>({...value,enabled:event.target.checked}))}/><span>启用该账号的 AI 接管能力</span></label><label>Agent 人设<textarea value={settings.persona} onChange={event=>setSettings(value=>({...value,persona:event.target.value}))}/></label><div className="provider-form-grid"><label>时区<input value={settings.timezone} onChange={event=>setSettings(value=>({...value,timezone:event.target.value}))}/></label><label>回复语言<input value={settings.replyLanguage} onChange={event=>setSettings(value=>({...value,replyLanguage:event.target.value}))}/></label><label>营业开始<input type="time" value={settings.businessStart} onChange={event=>setSettings(value=>({...value,businessStart:event.target.value}))}/></label><label>营业结束<input type="time" value={settings.businessEnd} onChange={event=>setSettings(value=>({...value,businessEnd:event.target.value}))}/></label></div><label>自动发送置信度：{settings.confidenceThreshold.toFixed(2)}<input type="range" min="0.6" max="0.95" step="0.01" value={settings.confidenceThreshold} onChange={event=>setSettings(value=>({...value,confidenceThreshold:Number(event.target.value)}))}/></label><label className="provider-toggle"><input type="checkbox" checked={settings.followupEnabled} onChange={event=>setSettings(value=>({...value,followupEnabled:event.target.checked}))}/><span>24 小时与 72 小时主动跟进</span></label><fieldset className="kb-assignment"><legend>分配知识库</legend>{kbs.map(kb=><label key={kb.id}><input type="checkbox" checked={settings.knowledgeBaseIds.includes(kb.id)} onChange={event=>setSettings(value=>({...value,knowledgeBaseIds:event.target.checked?[...value.knowledgeBaseIds,kb.id]:value.knowledgeBaseIds.filter(id=>id!==kb.id)}))}/>{kb.name}</label>)}</fieldset><button className="primary-action" disabled={saving||!accountId} onClick={()=>void saveAccount()}><Check size={14}/>保存账号规则</button></section></div>;
}

function KnowledgeBaseSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [items,setItems]=useState<KnowledgeBaseItem[]>([]),[selected,setSelected]=useState(""),[detail,setDetail]=useState<{documents:Array<{id:string;file_name:string;status:string;error?:string}>;faqs:Array<{id:string;question:string;answer:string}>}|null>(null),[name,setName]=useState(""),[editingId,setEditingId]=useState(""),[editName,setEditName]=useState(""),[question,setQuestion]=useState(""),[answer,setAnswer]=useState(""),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const result=await authorizedFetch("/api/v1/knowledge-bases",token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:KnowledgeBaseItem[]};setItems(body.data);setSelected(value=>body.data.some(item=>item.id===value)?value:(body.data[0]?.id??""));}},[token,onToken]);const loadDetail=useCallback(async()=>{if(!selected){setDetail(null);return;}const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}`,token);if(result.token!==token)onToken(result.token);if(result.response.ok)setDetail(await result.response.json());},[selected,token,onToken]);useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);useEffect(()=>{const first=window.setTimeout(()=>void loadDetail(),0),poll=window.setInterval(()=>void loadDetail(),5000);return()=>{window.clearTimeout(first);window.clearInterval(poll);};},[loadDetail]);
  async function create(){if(!name.trim())return;setBusy(true);const result=await authorizedFetch("/api/v1/knowledge-bases",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){const created=await result.response.json() as {id:string};setName("");await load();setSelected(created.id);}}
  function startEdit(item:KnowledgeBaseItem){setEditingId(item.id);setEditName(item.name);}
  async function saveEdit(id:string){const nextName=editName.trim();if(!nextName)return;setBusy(true);const result=await authorizedFetch(`/api/v1/knowledge-bases/${id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:nextName})});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){onToast("知识库名称修改失败");return;}setEditingId("");setEditName("");await load();onToast("知识库名称已更新");}
  async function removeKnowledgeBase(item:KnowledgeBaseItem){if(!window.confirm(`确定删除知识库“${item.name}”？其中的文档和问答也会全部删除，此操作无法撤销。`))return;setBusy(true);const result=await authorizedFetch(`/api/v1/knowledge-bases/${item.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){onToast("知识库删除失败");return;}if(selected===item.id){setSelected("");setDetail(null);}if(editingId===item.id){setEditingId("");setEditName("");}await load();onToast("知识库已删除");}
  async function upload(file:File){setBusy(true);const form=new FormData();form.append("file",file);const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/documents`,token,{method:"POST",body:form});if(result.token!==token)onToken(result.token);setBusy(false);onToast(result.response.ok?"文档已上传，正在建立索引":"文档上传失败");await loadDetail();}
  async function addFaq(){if(!question.trim()||!answer.trim())return;setBusy(true);const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/faqs`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question,answer})});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){setQuestion("");setAnswer("");await loadDetail();}}
  async function removeDocument(id:string){if(!window.confirm("删除该文档及其全部检索内容？"))return;const result=await authorizedFetch(`/api/v1/knowledge-documents/${id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(result.response.ok)await loadDetail();}
  async function editFaq(faq:{id:string;question:string;answer:string}){const nextQuestion=window.prompt("问题",faq.question),nextAnswer=window.prompt("答案",faq.answer);if(!nextQuestion?.trim()||!nextAnswer?.trim())return;const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/faqs/${faq.id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({question:nextQuestion,answer:nextAnswer})});if(result.token!==token)onToken(result.token);if(result.response.ok)await loadDetail();}
  async function removeFaq(id:string){const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/faqs/${id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(result.response.ok)await loadDetail();}
  return <div className="knowledge-layout"><aside className="knowledge-list"><div className="knowledge-create"><input value={name} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void create();}} placeholder="新知识库名称"/><button disabled={busy||!name.trim()} onClick={()=>void create()} aria-label="创建知识库"><Plus size={14}/></button></div>{items.map(item=><div className={`knowledge-list-item ${selected===item.id?"active":""}`} key={item.id}>{editingId===item.id?<form className="knowledge-name-editor" onSubmit={event=>{event.preventDefault();void saveEdit(item.id);}}><input value={editName} onChange={event=>setEditName(event.target.value)} maxLength={120} autoFocus aria-label="知识库名称"/><button type="submit" disabled={busy||!editName.trim()} aria-label={`保存 ${item.name}`}><Check size={13}/></button><button type="button" disabled={busy} onClick={()=>{setEditingId("");setEditName("");}} aria-label="取消编辑"><X size={13}/></button></form>:<><button className="knowledge-select" onClick={()=>setSelected(item.id)}><span><b>{item.name}</b><small>{item.document_count??0} 文档 · {item.faq_count??0} 问答</small></span></button><div className="knowledge-item-actions"><button disabled={busy} onClick={()=>startEdit(item)} aria-label={`编辑知识库 ${item.name}`} title="编辑知识库"><Pencil size={12}/></button><button disabled={busy} onClick={()=>void removeKnowledgeBase(item)} aria-label={`删除知识库 ${item.name}`} title="删除知识库"><Trash2 size={12}/></button></div></>}</div>)}</aside><section className="knowledge-detail">{selected?<><header><div><h2>{items.find(item=>item.id===selected)?.name}</h2><p>上传 PDF、DOCX、TXT 或 Markdown，索引完成后才会用于自动回复。</p></div><label className="secondary-action upload-action"><UploadCloud size={14}/>上传文档<input type="file" accept=".pdf,.docx,.txt,.md,text/plain,application/pdf" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);event.target.value="";}}/></label></header><div className="knowledge-documents">{detail?.documents.map(doc=><article key={doc.id}><FileText size={17}/><span><b>{doc.file_name}</b><small>{doc.error||({pending:"等待索引",indexing:"正在索引",ready:"可用于回答",failed:"索引失败"}[doc.status]??doc.status)}</small></span><em className={doc.status}>{doc.status}</em><button onClick={()=>void removeDocument(doc.id)} aria-label={`删除文档 ${doc.file_name}`}><Trash2 size={13}/></button></article>)}</div><div className="faq-editor"><h3>常见问答</h3><input value={question} onChange={event=>setQuestion(event.target.value)} placeholder="客户可能会问什么？"/><textarea value={answer} onChange={event=>setAnswer(event.target.value)} placeholder="可靠、可直接发送的标准答案"/><button className="primary-action" disabled={busy||!question.trim()||!answer.trim()} onClick={()=>void addFaq()}><Plus size={14}/>添加问答</button></div><div className="faq-list">{detail?.faqs.map(faq=><article key={faq.id}><b>{faq.question}</b><p>{faq.answer}</p><div><button onClick={()=>void editFaq(faq)}><Pencil size={11}/>编辑</button><button onClick={()=>void removeFaq(faq.id)}><Trash2 size={11}/>删除</button></div></article>)}</div></>:<EmptyState title="先创建知识库" text="知识库可分配给一个或多个 WhatsApp 账号。"/>}</section></div>;
}

function previewOrderNumber(template:string,timezone:string):string{
  try{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()),value=(type:string)=>parts.find(part=>part.type===type)?.value??"";const year=value("year");return template.replace(/\{(?:YYYY|YY|MM|DD|SEQ:\d+)\}/g,token=>token==="{YYYY}"?year:token==="{YY}"?year.slice(-2):token==="{MM}"?value("month"):token==="{DD}"?value("day"):"1".padStart(Number(token.slice(5,-1)),"0"));}catch{return "时区或模板无效";}
}

function CurrencySettingsPanel({
  token,
  role,
  onToken,
  onToast,
}: {
  token: string;
  role: string;
  onToken: (token: string) => void;
  onToast: (text: string) => void;
}) {
  const [config, setConfig] = useState<CurrencyConfig>(DEFAULT_CURRENCY_CONFIG),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [refreshingRates, setRefreshingRates] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await authorizedFetch("/api/v1/currencies", token);
      if (result.token !== token) onToken(result.token);
      const body = (await result.response.json()) as CurrencyConfig & {
        message?: string;
      };
      if (!result.response.ok)
        throw new Error(body.message ?? `HTTP ${result.response.status}`);
      setConfig(body);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "货币配置加载失败");
    } finally {
      setLoading(false);
    }
  }, [token, onToken]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  function update(code: string, change: Partial<CurrencyItem>) {
    setConfig((value) => ({
      ...value,
      currencies: value.currencies.map((item) =>
        item.code === code ? { ...item, ...change } : item,
      ),
    }));
  }
  function changeBase(code: string) {
    setConfig((value) => {
      const divisor =
        value.currencies.find((item) => item.code === code)?.rate ?? 1;
      return {
        ...value,
        baseCurrency: code,
        currencies: value.currencies.map((item) => ({
          ...item,
          rate: item.code === code ? 1 : item.rate / divisor,
        })),
      };
    });
  }
  function remove(code: string) {
    setConfig((value) => ({
      ...value,
      currencies: value.currencies.filter((item) => item.code !== code),
    }));
  }
  async function refreshRates() {
    const codes = config.currencies.map((item) =>
      item.code.trim().toUpperCase(),
    );
    if (
      !config.currencies.length ||
      codes.some((code) => !/^[A-Z]{3}$/.test(code)) ||
      new Set(codes).size !== codes.length ||
      config.currencies.some((item) => !item.name.trim())
    ) {
      setError("更新汇率前，请先填写不重复的三位币种代码和显示名称");
      return;
    }
    setRefreshingRates(true);
    setError("");
    try {
      const payload = {
          baseCurrency: config.baseCurrency,
          currencies: config.currencies.map((item) => ({
            ...item,
            code: item.code.toUpperCase(),
            rate:
              item.code === config.baseCurrency
                ? 1
                : Math.max(Number(item.rate) || 1, 0.00000001),
          })),
        },
        result = await authorizedFetch(
          "/api/v1/admin/currencies/refresh-rates",
          token,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
      if (result.token !== token) onToken(result.token);
      const body = (await result.response
        .json()
        .catch(() => ({}))) as CurrencyConfig & {
        message?: string;
        error?: string;
        updatedCount?: number;
      };
      if (!result.response.ok)
        throw new Error(
          body.message ??
            (result.response.status === 403
              ? "只有管理员可以更新汇率"
              : body.error) ??
            `HTTP ${result.response.status}`,
        );
      setConfig(body);
      onToast(
        `已从 ${body.rateSource ?? "公共汇率服务"} 更新并保存 ${body.updatedCount ?? Math.max(0, body.currencies.length - 1)} 个汇率${body.rateDate ? `（数据日期 ${body.rateDate}）` : ""}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "公共汇率更新失败");
    } finally {
      setRefreshingRates(false);
    }
  }
  async function save() {
    const codes = config.currencies.map((item) =>
      item.code.trim().toUpperCase(),
    );
    if (
      !config.currencies.length ||
      codes.some((code) => !/^[A-Z]{3}$/.test(code)) ||
      new Set(codes).size !== codes.length ||
      config.currencies.some(
        (item) =>
          !item.name.trim() || !Number.isFinite(item.rate) || item.rate <= 0,
      )
    ) {
      setError("请填写不重复的三位币种代码、名称和大于 0 的汇率");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
          baseCurrency: config.baseCurrency,
          currencies: config.currencies.map((item) => ({
            ...item,
            code: item.code.toUpperCase(),
            rate: item.code === config.baseCurrency ? 1 : item.rate,
          })),
        },
        result = await authorizedFetch("/api/v1/admin/currencies", token, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      if (result.token !== token) onToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!result.response.ok)
        throw new Error(
          body.message ??
            (result.response.status === 403
              ? "只有管理员可以修改货币配置"
              : body.error) ??
            `HTTP ${result.response.status}`,
        );
      onToast("货币、基准货币和汇率已保存");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "货币配置保存失败");
    } finally {
      setSaving(false);
    }
  }
  if (loading) return <EmptyState title="正在读取货币配置" text="请稍候…" />;
  return (
    <div className="settings-provider-section currency-settings">
      <div className="settings-section-head">
        <div>
          <h2>货币管理</h2>
          <p>
            汇率表示 1 单位基准货币可兑换的目标币种数量；订单会按“原金额 ÷
            原币汇率 × 目标币汇率”换算。
          </p>
        </div>
        <div className="currency-head-actions">
          <button
            className="secondary-action"
            disabled={refreshingRates || saving || role !== "admin"}
            onClick={() => void refreshRates()}
          >
            {refreshingRates ? (
              <RefreshCw className="spin" size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            一键更新汇率
          </button>
          <button
            className="secondary-action"
            disabled={refreshingRates}
            onClick={() => void load()}
          >
            <RefreshCw size={15} />
            刷新配置
          </button>
        </div>
      </div>
      <div className="currency-rate-source">
        <span>
          汇率来源：Frankfurter 免费公共接口（无需 API
          Key，参考汇率按数据源工作日更新）。
        </span>
        <b>
          {config.rateUpdatedAt
            ? `上次汇率更新：${new Date(config.rateUpdatedAt).toLocaleString("zh-CN", { hour12: false })}${config.rateDate ? ` · 数据日期 ${config.rateDate}` : ""}`
            : "上次汇率更新：尚未通过公共接口更新"}
        </b>
      </div>
      <div className="currency-base-card">
        <label>
          基准货币
          <select
            value={config.baseCurrency}
            onChange={(event) => changeBase(event.target.value)}
          >
            {config.currencies.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <small>
          切换基准货币会自动重算当前列表中的汇率，保持币种之间的兑换关系不变。
        </small>
      </div>
      <div className="currency-table">
        <div className="currency-row currency-head">
          <span>币种代码</span>
          <span>显示名称</span>
          <span>相对 {config.baseCurrency} 汇率</span>
          <span />
        </div>
        {config.currencies.map((item, index) => (
          <div className="currency-row" key={`${item.code}-${index}`}>
            <input
              value={item.code}
              maxLength={3}
              disabled={item.code === config.baseCurrency}
              onChange={(event) => {
                const next = event.target.value
                  .toUpperCase()
                  .replace(/[^A-Z]/g, "");
                setConfig((value) => ({
                  ...value,
                  currencies: value.currencies.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, code: next } : row,
                  ),
                }));
              }}
              aria-label="币种代码"
            />
            <input
              value={item.name}
              maxLength={80}
              onChange={(event) =>
                update(item.code, { name: event.target.value })
              }
              aria-label={`${item.code} 显示名称`}
            />
            <input
              type="number"
              min="0.00000001"
              step="any"
              value={item.rate}
              disabled={item.code === config.baseCurrency}
              onChange={(event) =>
                update(item.code, { rate: Number(event.target.value) })
              }
              aria-label={`${item.code} 汇率`}
            />
            <button
              className="danger-text"
              disabled={
                item.code === config.baseCurrency ||
                config.currencies.length === 1
              }
              onClick={() => remove(item.code)}
              aria-label={`删除 ${item.code}`}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="secondary-action currency-add"
        onClick={() =>
          setConfig((value) => ({
            ...value,
            currencies: [...value.currencies, { code: "", name: "", rate: 1 }],
          }))
        }
        disabled={config.currencies.length >= 100}
      >
        <Plus size={14} />
        添加货币
      </button>
      {role !== "admin" && (
        <p className="provider-permission-note">
          当前账号可查看货币与汇率；仅管理员可以保存修改或更新汇率。
        </p>
      )}
      {error && <span className="login-error">{error}</span>}
      <button
        className="primary-action provider-save"
        disabled={saving || refreshingRates || role !== "admin"}
        onClick={() => void save()}
      >
        {saving ? (
          <>
            <RefreshCw className="spin" size={14} />
            正在保存
          </>
        ) : (
          <>
            <Check size={14} />
            保存货币配置
          </>
        )}
      </button>
    </div>
  );
}

function OrderSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [section,setSection]=useState<"number"|"paypal"|"product-card"|TemplateFormat>("number"),[dirty,setDirty]=useState(false);
  const request=useCallback((path:string,init?:RequestInit)=>authorizedFetch(path,token,init),[token]);
  function select(next:"number"|"paypal"|"product-card"|TemplateFormat){if(next===section)return;if(dirty&&!window.confirm("当前模板有未保存修改，确定离开吗？"))return;setDirty(false);setSection(next);}
  return <div className="order-settings-shell"><nav className="order-settings-tabs" aria-label="订单设置"><button className={section==="number"?"active":""} onClick={()=>select("number")}>编号规则</button><button className={section==="text"?"active":""} onClick={()=>select("text")}>文字模板</button><button className={section==="image"?"active":""} onClick={()=>select("image")}>图片模板</button><button className={section==="product-card"?"active":""} onClick={()=>select("product-card")}>产品卡片模板</button><button className={section==="paypal"?"active":""} onClick={()=>select("paypal")}><CreditCard size={13}/>PayPal 收款</button></nav>{section==="number"?<OrderNumberSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:section==="paypal"?<PayPalSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:section==="product-card"?<ProductCardTemplateEditor request={request} onToken={onToken} onToast={onToast} onDirtyChange={setDirty}/>:<OrderTemplateEditor format={section} request={request} onToken={onToken} onToast={onToast} onDirtyChange={setDirty}/>}</div>;
}

function OrderNumberSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [template,setTemplate]=useState("{YYYY}{MM}{DD}-{SEQ:3}"),[timezone,setTimezone]=useState("Asia/Shanghai"),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/order-settings",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {numberTemplate?:string;timezone?:string;message?:string};if(!result.response.ok)throw new Error(body.message??`HTTP ${result.response.status}`);setTemplate(body.numberTemplate??"{YYYY}{MM}{DD}-{SEQ:3}");setTimezone(body.timezone??"Asia/Shanghai");setError("");}catch(reason){setError(reason instanceof Error?reason.message:"订单设置加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  async function save(){setSaving(true);setError("");try{const result=await authorizedFetch("/api/v1/admin/order-settings",token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({numberTemplate:template,timezone})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};if(!result.response.ok)throw new Error(body.message??body.error??`HTTP ${result.response.status}`);onToast("订单编号规则已保存，仅影响此后创建的订单");await load();}catch(reason){setError(reason instanceof Error?reason.message:"订单设置保存失败");}finally{setSaving(false);}}
  if(loading)return <EmptyState title="正在读取订单设置" text="请稍候…"/>;
  return <div className="settings-provider-section order-settings"><div className="settings-section-head"><div><h2>订单编号规则</h2><p>订单号在创建时固化；修改规则不会改变任何历史订单。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div><div className="order-settings-form"><label>编号模板<input value={template} onChange={event=>setTemplate(event.target.value)} maxLength={80}/><small>必须包含年份、月份、日期和当日序号各一次。</small></label><div className="order-variable-buttons">{["{YYYY}","{YY}","{MM}","{DD}","{SEQ:3}"].map(variable=><button key={variable} onClick={()=>setTemplate(value=>value+variable)}>{variable}</button>)}</div><label>业务时区<input value={timezone} onChange={event=>setTimezone(event.target.value)} list="order-timezones" placeholder="Asia/Shanghai"/><datalist id="order-timezones"><option value="Asia/Shanghai"/><option value="Asia/Hong_Kong"/><option value="Asia/Singapore"/><option value="Europe/London"/><option value="America/New_York"/><option value="America/Los_Angeles"/></datalist><small>使用 IANA 时区计算日期和每日序号重置边界。</small></label><div className="order-number-preview"><span>下一个订单号示例</span><b>#{previewOrderNumber(template,timezone)}</b></div>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||!template.trim()||!timezone.trim()} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在保存</>:<><Check size={14}/>保存订单设置</>}</button></div></div>;
}

function PayPalSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [setting,setSetting]=useState({enabled:false,environment:"sandbox" as "sandbox"|"live",clientIdConfigured:false,clientSecretConfigured:false}),[clientId,setClientId]=useState(""),[clientSecret,setClientSecret]=useState(""),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError("");try{const result=await authorizedFetch("/api/v1/admin/paypal-settings",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));setSetting({enabled:Boolean(body.enabled),environment:body.environment==="live"?"live":"sandbox",clientIdConfigured:Boolean(body.clientIdConfigured),clientSecretConfigured:Boolean(body.clientSecretConfigured)});}catch(reason){setError(reason instanceof Error?reason.message:"PayPal 配置加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  async function save(){setSaving(true);setError("");try{const result=await authorizedFetch("/api/v1/admin/paypal-settings",token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:setting.enabled,environment:setting.environment,clientId:clientId.trim()||undefined,clientSecret:clientSecret.trim()||undefined})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));setClientId("");setClientSecret("");onToast(`PayPal ${setting.environment==="live"?"Live":"Sandbox"} 配置已保存${setting.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"PayPal 配置保存失败");}finally{setSaving(false);}}
  if(loading)return <EmptyState title="正在读取 PayPal 配置" text="请稍候…"/>;
  const credentialsReady=(setting.clientIdConfigured||Boolean(clientId.trim()))&&(setting.clientSecretConfigured||Boolean(clientSecret.trim()));
  return <div className="settings-provider-section paypal-settings"><div className="settings-section-head"><div><h2>PayPal 收款</h2><p>订单付款请求使用 PayPal Invoicing v2；凭据加密保存且不会回传明文。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div><div className="provider-form paypal-settings-form"><header><div><h2>Payment Request Provider</h2><p>先在 Sandbox 完成测试，再切换到 Live 接收真实付款。</p></div><label className="provider-toggle"><input type="checkbox" checked={setting.enabled} onChange={event=>setSetting(value=>({...value,enabled:event.target.checked}))}/><span>启用 PayPal 收款</span></label></header><label>环境<select value={setting.environment} onChange={event=>setSetting(value=>({...value,environment:event.target.value as "sandbox"|"live"}))}><option value="sandbox">Sandbox（测试）</option><option value="live">Live（真实付款）</option></select><small>{setting.environment==="live"?"Live 环境会生成真实付款请求，请确认使用正式应用凭据。":"Sandbox 链接只能使用 PayPal 测试账号付款。"}</small></label><label>Client ID<input type="password" autoComplete="new-password" value={clientId} onChange={event=>setClientId(event.target.value)} placeholder={setting.clientIdConfigured?"已加密保存；留空表示不修改":"输入 PayPal REST App Client ID"}/></label><label>Client Secret<input type="password" autoComplete="new-password" value={clientSecret} onChange={event=>setClientSecret(event.target.value)} placeholder={setting.clientSecretConfigured?"已加密保存；留空表示不修改":"输入 PayPal REST App Client Secret"}/><small>启用时会立即向 PayPal 验证凭据；验证失败不会保存。</small></label>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||(setting.enabled&&!credentialsReady)} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在验证并保存</>:<><Check size={14}/>保存 PayPal 配置</>}</button></div></div>;
}

const TRANSLATION_PROVIDER_META:Record<TranslationProviderId,{name:string;description:string;keyLabel:string;endpointHint:string;modelHint:string;transcriptionModelHint:string}>={
  openai:{name:"OpenAI",description:"OpenAI 官方 Chat Completions 与 Audio Transcriptions API",keyLabel:"OpenAI API Key",endpointHint:"https://api.openai.com/v1",modelHint:"gpt-5.6-luna",transcriptionModelHint:"gpt-4o-mini-transcribe"},
  openai_compatible:{name:"Custom Provider",description:"兼容 /chat/completions 与 /audio/transcriptions 的服务",keyLabel:"API Key",endpointHint:"https://provider.example.com/v1",modelHint:"Provider 的翻译模型 ID",transcriptionModelHint:"Provider 的语音转写模型 ID"},
};

function TranslationSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<TranslationProviderConfig[]>([]),[selected,setSelected]=useState<TranslationProviderId>("openai"),[secret,setSecret]=useState(""),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/translation-providers",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {data?:TranslationProviderConfig[];error?:string};if(!result.response.ok||!body.data)throw new Error(body.error??`HTTP ${result.response.status}`);setProviders(body.data);setSelected(previous=>body.data?.some(item=>item.provider===previous)?previous:(body.data?.find(item=>item.enabled)?.provider??"openai"));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"翻译 Provider 配置加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(initial);},[load]);
  const current=providers.find(item=>item.provider===selected);const meta=TRANSLATION_PROVIDER_META[selected];
  function change(values:Partial<TranslationProviderConfig>){setProviders(items=>items.map(item=>item.provider===selected?{...item,...values}:item));}
  async function save(){if(!current||saving)return;setSaving(true);setError("");try{const result=await authorizedFetch(`/api/v1/admin/translation-providers/${selected}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:current.enabled,apiKey:secret.trim()||undefined,baseUrl:current.baseUrl,model:current.model,transcriptionModel:current.transcriptionModel})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));setSecret("");onToast(`${meta.name} 翻译配置已保存${current.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setSaving(false);}}
  return <div className="settings-provider-section"><div className="settings-section-head"><div><h2>AI 翻译 Provider</h2><p>用于文字翻译与语音转写；转写原文和译文都会缓存。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>{loading?<EmptyState title="正在读取翻译 Provider" text="请稍候…"/>:<div className="provider-settings-layout"><nav className="provider-list" aria-label="翻译 Provider">{providers.map(item=><button key={item.provider} className={selected===item.provider?"active":""} onClick={()=>{setSelected(item.provider);setSecret("");}}><span><b>{TRANSLATION_PROVIDER_META[item.provider].name}</b><small>{TRANSLATION_PROVIDER_META[item.provider].description}</small></span><em className={item.enabled?"enabled":item.keyConfigured?"configured":""}>{item.enabled?"使用中":item.keyConfigured?"已配置":"未配置"}</em></button>)}</nav>{current&&<div className="provider-form"><header><div><h2>{meta.name}</h2><p>{meta.description}</p></div><label className="provider-toggle"><input type="checkbox" checked={current.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>设为当前 Provider</span></label></header><label>{meta.keyLabel}<input type="password" value={secret} onChange={event=>setSecret(event.target.value)} autoComplete="new-password" placeholder={current.keyConfigured?"已加密保存；留空表示不修改":"请输入 API Key"}/><small>保存后仅显示配置状态，不会回传密钥。</small></label><label>API Endpoint<input type="url" value={current.baseUrl} onChange={event=>change({baseUrl:event.target.value})} placeholder={meta.endpointHint}/></label><label>文字翻译模型 ID<input value={current.model} onChange={event=>change({model:event.target.value})} placeholder={meta.modelHint}/></label><label>语音转写模型 ID<input value={current.transcriptionModel} onChange={event=>change({transcriptionModel:event.target.value})} placeholder={meta.transcriptionModelHint}/><small>OpenAI 默认使用 gpt-4o-mini-transcribe。</small></label>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||!current.baseUrl.trim()||!current.model.trim()||!current.transcriptionModel.trim()||(!current.keyConfigured&&!secret.trim())} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在保存</>:<><Check size={14}/>保存配置</>}</button></div>}</div>}</div>;
}

const TTS_PROVIDER_META:Record<TtsProviderId,{name:string;description:string;keyLabel:string;endpointHint:string;modelHint:string;voiceHint:string}>={
  openai:{name:"OpenAI",description:"OpenAI 官方 Audio Speech API",keyLabel:"OpenAI API Key",endpointHint:"https://api.openai.com/v1",modelHint:"gpt-4o-mini-tts",voiceHint:"coral"},
  elevenlabs:{name:"ElevenLabs",description:"多语言语音与自定义 Voice ID",keyLabel:"ElevenLabs API Key",endpointHint:"https://api.elevenlabs.io/v1",modelHint:"eleven_multilingual_v2",voiceHint:"Voice ID"},
  azure:{name:"Azure Speech",description:"Microsoft Azure AI Speech REST API",keyLabel:"Speech Resource Key",endpointHint:"https://资源名.cognitiveservices.azure.com",modelHint:"Azure 不需要填写模型",voiceHint:"zh-CN-XiaoxiaoNeural"},
  openai_compatible:{name:"OpenAI 兼容接口",description:"自托管或第三方兼容 /audio/speech 的服务",keyLabel:"API Key",endpointHint:"https://provider.example.com/v1",modelHint:"Provider 的模型 ID",voiceHint:"Provider 的音色 ID"},
};
function providerName(provider:string|null){return provider&&provider in TTS_PROVIDER_META?TTS_PROVIDER_META[provider as TtsProviderId].name:(provider??"已配置的 Provider");}

function TtsSettingsPanel({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<TtsProviderConfig[]>([]),[selected,setSelected]=useState<TtsProviderId>("openai"),[secret,setSecret]=useState(""),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{if(role!=="admin"){setLoading(false);return;}setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/tts-providers",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {data?:TtsProviderConfig[];error?:string};if(!result.response.ok||!body.data)throw new Error(body.error??`HTTP ${result.response.status}`);setProviders(body.data);setSelected(previous=>body.data?.some(item=>item.provider===previous)?previous:(body.data?.find(item=>item.enabled)?.provider??"openai"));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"Provider 配置加载失败");}finally{setLoading(false);}},[token,role,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(initial);},[load]);
  const current=providers.find(item=>item.provider===selected);const meta=TTS_PROVIDER_META[selected];
  function change(values:Partial<TtsProviderConfig>){setProviders(items=>items.map(item=>item.provider===selected?{...item,...values}:item));}
  async function save(){if(!current||saving)return;setSaving(true);setError("");try{const result=await authorizedFetch(`/api/v1/admin/tts-providers/${selected}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:current.enabled,apiKey:secret.trim()||undefined,baseUrl:current.baseUrl,model:current.model,voice:current.voice})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));setSecret("");onToast(`${meta.name} 配置已保存${current.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setSaving(false);}}
  if(role!=="admin")return <EmptyState title="需要管理员权限" text="只有管理员可以查看或修改语音 Provider 与密钥配置。"/>;
  return <div className="settings-provider-section"><div className="settings-section-head"><div><h2>AI 语音 Provider</h2><p>管理文字转语音服务、模型与默认音色。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>{loading?<EmptyState title="正在读取语音 Provider" text="请稍候…"/>:<div className="provider-settings-layout"><nav className="provider-list" aria-label="语音 Provider">{providers.map(item=><button key={item.provider} className={selected===item.provider?"active":""} onClick={()=>{setSelected(item.provider);setSecret("");}}><span><b>{TTS_PROVIDER_META[item.provider].name}</b><small>{TTS_PROVIDER_META[item.provider].description}</small></span><em className={item.enabled?"enabled":item.keyConfigured?"configured":""}>{item.enabled?"使用中":item.keyConfigured?"已配置":"未配置"}</em></button>)}</nav>{current&&<div className="provider-form"><header><div><h2>{meta.name}</h2><p>{meta.description}</p></div><label className="provider-toggle"><input type="checkbox" checked={current.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>设为当前 Provider</span></label></header><label>{meta.keyLabel}<input type="password" value={secret} onChange={event=>setSecret(event.target.value)} autoComplete="new-password" placeholder={current.keyConfigured?"已加密保存；留空表示不修改":"请输入 API Key"}/><small>保存后仅显示配置状态，不会回传密钥。</small></label><label>API Endpoint<input type="url" value={current.baseUrl} onChange={event=>change({baseUrl:event.target.value})} placeholder={meta.endpointHint}/></label><div className="provider-form-grid"><label>模型 ID<input value={current.model} onChange={event=>change({model:event.target.value})} placeholder={meta.modelHint}/></label><label>默认音色 / Voice ID<input value={current.voice} onChange={event=>change({voice:event.target.value})} placeholder={meta.voiceHint}/></label></div>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||!current.baseUrl.trim()||!current.voice.trim()||(selected!=="azure"&&!current.model.trim())||(!current.keyConfigured&&!secret.trim())} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在保存</>:<><Check size={14}/>保存配置</>}</button></div>}</div>}</div>;
}

function OrderManagement({token,accounts,onToken,onToast,onConversation}:{token:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void;onConversation:(conversationId:string)=>void}){
  const [orders,setOrders]=useState<OrderItem[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState(""),[accountId,setAccountId]=useState(""),[status,setStatus]=useState(""),[dateFrom,setDateFrom]=useState(""),[dateTo,setDateTo]=useState(""),[total,setTotal]=useState(0),[nextCursor,setNextCursor]=useState<string|null>(null),[viewing,setViewing]=useState<OrderItem|null>(null),[editing,setEditing]=useState<OrderItem|null>(null);
  const cursorRef=useRef<string|null>(null);
  const load=useCallback(async(reset=true)=>{if(reset)setLoading(true);try{const params=new URLSearchParams({limit:"30"});if(query.trim())params.set("q",query.trim());if(accountId)params.set("accountId",accountId);if(status)params.set("status",status);if(dateFrom)params.set("dateFrom",dateFrom);if(dateTo)params.set("dateTo",dateTo);if(!reset&&cursorRef.current)params.set("cursor",cursorRef.current);const result=await authorizedFetch(`/api/v1/orders?${params}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`订单加载失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {data:Array<Record<string,unknown>>;nextCursor:string|null;total:number};const mapped=body.data.map(item=>mapOrder(item));setOrders(all=>reset?mapped:[...all,...mapped]);cursorRef.current=body.nextCursor;setNextCursor(body.nextCursor);if(reset)setTotal(Number(body.total??mapped.length));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"订单加载失败");}finally{setLoading(false);}},[token,onToken,query,accountId,status,dateFrom,dateTo]);
  useEffect(()=>{cursorRef.current=null;const timer=window.setTimeout(()=>void load(true),query?250:0);return()=>window.clearTimeout(timer);},[load,query]);
  async function remove(order:OrderItem){const sent=order.status!=="draft";if(!window.confirm(sent?`删除订单 #${order.orderNumber}？这不会撤回已经发送的 WhatsApp 消息。`:`删除草稿订单 #${order.orderNumber}？`))return;const result=await authorizedFetch(`/api/v1/conversations/${order.conversationId}/orders/${order.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`订单删除失败（HTTP ${result.response.status}）`);return;}onToast(`订单 #${order.orderNumber} 已删除${sent?"，历史消息保持不变":""}`);cursorRef.current=null;await load(true);}
  const draftCount=orders.filter(order=>order.status==="draft").length,queuedCount=orders.filter(order=>order.status!=="draft").length;
  return <section className="management-panel order-management"><header className="management-head"><div><span className="eyebrow">会话订单中心</span><h1>订单管理</h1><p>集中查看、编辑和删除从客户会话中创建的订单。</p></div><button className="secondary-action" onClick={()=>void load(true)}><RefreshCw size={15}/>刷新</button></header>
    <div className="management-summary"><SummaryCard label="匹配订单" value={total}/><SummaryCard label="当前页草稿" value={draftCount}/><SummaryCard label="当前页已发送" value={queuedCount}/></div>
    <div className="order-management-filters"><label><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索订单号、客户名称或手机号"/></label><select value={accountId} onChange={event=>setAccountId(event.target.value)} aria-label="按账号筛选"><option value="">全部账号</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select><select value={status} onChange={event=>setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option><option value="draft">草稿</option><option value="queued">已发送</option></select><input type="date" value={dateFrom} onChange={event=>setDateFrom(event.target.value)} aria-label="开始日期"/><input type="date" value={dateTo} min={dateFrom||undefined} onChange={event=>setDateTo(event.target.value)} aria-label="结束日期"/></div>
    {loading?<EmptyState title="正在读取订单" text="请稍候…"/>:error?<EmptyState title="订单加载失败" text={error}/>:orders.length?<><div className="order-table-wrap"><table className="order-table"><thead><tr><th>订单号</th><th>客户 / 账号</th><th>商品</th><th>金额</th><th>状态</th><th>创建时间</th><th aria-label="操作"/></tr></thead><tbody>{orders.map(order=><tr key={order.id} onClick={()=>setViewing(order)}><td><b>#{order.orderNumber}</b><small>{order.createdByName}</small></td><td><b>{order.customerName||order.customerPhone||"未知客户"}</b><small>{order.accountName}{order.customerPhone?` · ${order.customerPhone}`:""}</small></td><td>{order.items.length} 件<small>{order.items.slice(0,2).map(item=>item.name).join("、")}{order.items.length>2?"…":""}</small></td><td><b>{order.currency} {order.amount.toFixed(2)}</b></td><td><em className={`delivery-state ${order.messageStatus}`}>{order.status==="draft"?"草稿":deliveryText(order.messageStatus)}</em>{order.paymentRequest&&<small className={`payment-state ${order.paymentRequest.status.toLowerCase()}`}>{paymentStatusText(order.paymentRequest.status)}</small>}</td><td>{formatDateTime(order.createdAt)}</td><td><span className="order-row-actions"><button onClick={event=>{event.stopPropagation();setEditing(order);}} aria-label={`编辑订单 ${order.orderNumber}`}><Pencil size={13}/></button><button className="danger" onClick={event=>{event.stopPropagation();void remove(order);}} aria-label={`删除订单 ${order.orderNumber}`}><Trash2 size={13}/></button></span></td></tr>)}</tbody></table></div>{nextCursor&&<button className="order-load-more" onClick={()=>void load(false)}>加载更多订单</button>}</>:<EmptyState title="暂无匹配订单" text="订单需先在客户会话中创建，或调整当前筛选条件"/>}
    {viewing&&<OrderDetailsDialog order={viewing} token={token} onToken={onToken} onToast={onToast} onPaymentChange={paymentRequest=>{setViewing(current=>current?{...current,paymentRequest}:current);setOrders(items=>items.map(item=>item.id===viewing.id?{...item,paymentRequest}:item));}} onClose={()=>setViewing(null)} onEdit={()=>{setViewing(null);setEditing(viewing);}} onConversation={()=>onConversation(viewing.conversationId)}/>}
    {editing&&<OrderDialog order={editing} active={{id:editing.conversationId,name:editing.customerName,initials:"",color:"#477a62",account:editing.accountName,accountId:editing.accountId,phone:editing.customerPhone,preview:"",time:"",unread:0,accountStatus:"online",assignedUserId:null,favorite:false,conversationStatus:"open",customerStage:"new",tags:[],remindAt:null}} token={token} onToken={onToken} onClose={()=>setEditing(null)} onCreated={async orderNumber=>{setEditing(null);onToast(`订单 #${orderNumber} 已更新`);cursorRef.current=null;await load(true);}}/>}
  </section>;
}

function OrderDetailsDialog({order,token,onToken,onToast,onPaymentChange,onClose,onEdit,onConversation}:{order:OrderItem;token:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onPaymentChange:(paymentRequest:PaymentRequest)=>void;onClose:()=>void;onEdit:()=>void;onConversation:()=>void}){
  const [busy,setBusy]=useState<"create"|"refresh"|"send"|"copy"|"">(""),[error,setError]=useState("");const payment=order.paymentRequest;
  async function request(action:"create"|"refresh"|"send"){setBusy(action);setError("");try{const suffix=action==="create"?"":`/${action}`,result=await authorizedFetch(`/api/v1/orders/${order.id}/payment-request${suffix}`,token,{method:"POST"});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));if(action==="send"){onToast("付款链接已进入 WhatsApp 发送队列");return;}const next=mapPaymentRequest(body);onPaymentChange(next);onToast(action==="create"?"PayPal 付款链接已生成":"PayPal 付款状态已刷新");}catch(reason){setError(reason instanceof Error?reason.message:"操作失败");}finally{setBusy("");}}
  async function copyLink(){if(!payment?.url)return;setBusy("copy");try{await navigator.clipboard.writeText(payment.url);onToast("付款链接已复制");}catch{setError("剪贴板不可用，请手动复制链接");}finally{setBusy("");}}
  return <div className="modal-backdrop order-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="login-dialog order-details-dialog" role="dialog" aria-modal="true" aria-labelledby="order-details-title"><button className="login-close" onClick={onClose} disabled={Boolean(busy)} aria-label="关闭"><X size={17}/></button><span className="login-logo"><ClipboardList size={20}/></span><h2 id="order-details-title">订单 #{order.orderNumber}</h2><p>{order.customerName||order.customerPhone||"未知客户"} · {order.accountName}</p><dl className="order-details-meta"><div><dt>状态</dt><dd>{order.status==="draft"?"草稿":deliveryText(order.messageStatus)}</dd></div><div><dt>创建人</dt><dd>{order.createdByName}</dd></div><div><dt>创建时间</dt><dd>{formatDateTime(order.createdAt)}</dd></div><div><dt>订单金额</dt><dd>{order.currency} {order.amount.toFixed(2)}</dd></div></dl><div className="order-details-items"><h3>商品</h3>{order.items.map(item=><div key={item.id}><span><b>{item.name}</b><small>{item.quantity} × {order.currency} {item.unitAmount.toFixed(2)}</small></span><strong>{order.currency} {(item.quantity*item.unitAmount).toFixed(2)}</strong></div>)}{order.fees.map(item=><div key={item.id}><span><b>{item.name}</b><small>附加费用</small></span><strong>{order.currency} {item.amount.toFixed(2)}</strong></div>)}</div>{order.address&&<div className="order-details-address"><MapPin size={16}/><span><b>{order.address.label}</b>{(order.address.recipientName||order.address.phone)&&<small>{[order.address.recipientName,order.address.phone].filter(Boolean).join(" · ")}</small>}<p>{order.address.address}</p></span></div>}{order.description&&<div className="order-details-notes"><b>订单备注</b><p>{order.description}</p></div>}<section className="payment-request-panel"><header><span><CreditCard size={17}/><span><b>PayPal Payment Request</b><small>{payment?`${payment.environment==="live"?"Live":"Sandbox"} · ${paymentStatusText(payment.status)}`:"按当前订单金额生成可支付链接"}</small></span></span>{payment&&<button onClick={()=>void request("refresh")} disabled={Boolean(busy)}><RefreshCw className={busy==="refresh"?"spin":""} size={13}/>刷新状态</button>}</header>{payment?.url?<><div className="payment-link"><input value={payment.url} readOnly aria-label="PayPal 付款链接"/><button onClick={()=>void copyLink()} disabled={Boolean(busy)} aria-label="复制付款链接"><Copy size={14}/></button><button onClick={()=>window.open(payment.url??"","_blank","noopener,noreferrer")} disabled={Boolean(busy)} aria-label="打开付款链接"><ExternalLink size={14}/></button></div><div className="payment-request-actions"><button className="primary-action" onClick={()=>void request("send")} disabled={Boolean(busy)}><Send size={14}/>{busy==="send"?"正在发送…":"发送到 WhatsApp"}</button></div></>:<button className="primary-action create-payment-request" onClick={()=>void request("create")} disabled={Boolean(busy)}><CreditCard size={14}/>{busy==="create"?"正在生成…":"Create Payment Request"}</button>}{error&&<span className="login-error">{error}</span>}</section><footer className="order-details-actions"><button className="secondary-action" onClick={onConversation}><ExternalLink size={14}/>打开所属会话</button><button className="primary-action" onClick={onEdit}><Pencil size={14}/>编辑订单</button></footer></section></div>;
}

function paymentStatusText(status:string){return({CREATING:"生成中",DRAFT:"草稿",SENT:"待付款",SHARED:"待付款",UNPAID:"待付款",PAYMENT_PENDING:"付款审核中",PARTIALLY_PAID:"部分付款",PAID:"已付款",MARKED_AS_PAID:"已付款",PAID_EXTERNAL:"已付款",CANCELLED:"已作废",AUTO_CANCELLED:"已自动作废",REFUNDED:"已退款",MARKED_AS_REFUNDED:"已退款",REFUNDED_EXTERNAL:"已退款",FAILED:"生成失败"} as Record<string,string>)[status.toUpperCase()]??status;}

function ProductManagement({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [products,setProducts]=useState<ProductItem[]>([]),[currencyConfig,setCurrencyConfig]=useState<CurrencyConfig>(DEFAULT_CURRENCY_CONFIG),[loading,setLoading]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState(""),[currency,setCurrency]=useState(""),[tag,setTag]=useState(""),[editing,setEditing]=useState<ProductItem|"new"|null>(null),[importing,setImporting]=useState(false);
  const load=useCallback(async()=>{setLoading(true);try{const [result,currencyResult]=await Promise.all([authorizedFetch("/api/v1/products?limit=100",token),authorizedFetch("/api/v1/currencies",token)]);if(result.token!==token)onToken(result.token);else if(currencyResult.token!==token)onToken(currencyResult.token);if(!result.response.ok)throw new Error(`产品库加载失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {data:Array<Record<string,unknown>>};setProducts(body.data.map(mapProduct));if(currencyResult.response.ok)setCurrencyConfig(await currencyResult.response.json() as CurrencyConfig);setError("");}catch(reason){setError(reason instanceof Error?reason.message:"产品库加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  const tagNames=useMemo(()=>[...new Set(products.flatMap(product=>product.tags.map(item=>item.name)))].sort((a,b)=>a.localeCompare(b,"zh-CN")),[products]);
  const visible=products.filter(product=>(!query||`${product.name} ${product.sku} ${product.description}`.toLowerCase().includes(query.toLowerCase()))&&(!currency||product.currency===currency)&&(!tag||product.tags.some(item=>item.name===tag)));
  async function remove(product:ProductItem){if(!window.confirm(`删除产品“${product.name}”？历史订单不会受到影响。`))return;const result=await authorizedFetch(`/api/v1/products/${product.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(result.response.status===403?"只有主管或管理员可以删除产品":`删除失败（HTTP ${result.response.status}）`);return;}onToast("产品已从产品库移除，历史订单保持不变");await load();}
  return <section className="management-panel product-management"><header className="management-head"><div><span className="eyebrow">团队共享目录</span><h1>产品库</h1><p>集中维护产品 SKU、阶梯价格、图片和标签，创建订单或发送产品卡片时直接选用。</p></div><div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button><button className="secondary-action" onClick={()=>setImporting(true)}><UploadCloud size={15}/>CSV 导入</button><button className="primary-action" onClick={()=>setEditing("new")}><Plus size={15}/>新增产品</button></div></header>
    <div className="product-filters"><label><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索产品名称、SKU 或描述"/></label><select value={currency} onChange={event=>setCurrency(event.target.value)} aria-label="按币种筛选"><option value="">全部币种</option>{currencyConfig.currencies.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select><select value={tag} onChange={event=>setTag(event.target.value)} aria-label="按标签筛选"><option value="">全部标签</option>{tagNames.map(item=><option key={item}>{item}</option>)}</select><span>{visible.length} 个产品</span></div>
    {loading?<EmptyState title="正在读取产品库" text="请稍候…"/>:error?<EmptyState title="产品库加载失败" text={error}/>:visible.length?<div className="product-grid">{visible.map(product=>{const last=product.priceTiers.at(-1);return <article className="product-card" key={product.id}><ProductImage mediaId={product.imageMediaId} token={token} onToken={onToken} alt={product.name}/><div className="product-card-copy"><header><span><b>{product.name}</b><small>{product.sku} · 更新于 {new Date(product.updatedAt).toLocaleDateString("zh-CN")}</small></span><strong>{product.currency} {last&&last.unitAmount!==product.defaultUnitAmount?`${last.unitAmount.toFixed(2)}–${product.defaultUnitAmount.toFixed(2)}`:product.defaultUnitAmount.toFixed(2)}</strong></header>{product.description&&<p className="product-card-description">{product.description}</p>}<div className="product-tier-summary">{product.priceTiers.map(tier=><span key={tier.minQuantity}>{tier.minQuantity}+ · {product.currency} {tier.unitAmount.toFixed(2)}</span>)}</div><div className="product-card-tags">{product.tags.length?product.tags.map(item=><i key={item.id} style={{background:item.color}}>{item.name}</i>):<span>暂无标签</span>}</div><footer><button onClick={()=>setEditing(product)}><Pencil size={13}/>编辑</button>{["admin","supervisor"].includes(role)&&<button className="danger-text" onClick={()=>void remove(product)}><Trash2 size={13}/>删除</button>}</footer></div></article>;})}</div>:<EmptyState title="暂无匹配产品" text="新增产品，或调整搜索与筛选条件"/>}
    {editing&&<ProductEditorDialog product={editing==="new"?undefined:editing} products={products} currencies={currencyConfig.currencies} baseCurrency={currencyConfig.baseCurrency} request={(path,init)=>authorizedFetch(path,token,init)} onToken={onToken} onClose={()=>setEditing(null)} onSaved={async text=>{setEditing(null);onToast(text);await load();}}/>}
    {importing&&<ProductImportDialog currencies={currencyConfig.currencies} request={(path,init)=>authorizedFetch(path,token,init)} onToken={onToken} onClose={()=>setImporting(false)} onImported={async count=>{setImporting(false);onToast(`已成功导入 ${count} 个产品`);await load();}}/>}
  </section>;
}

const CURRENCIES=DEFAULT_CURRENCY_CONFIG.currencies.map(item=>item.code);
function mapProduct(item:Record<string,unknown>):ProductItem{const priceTiers=Array.isArray(item.priceTiers)?(item.priceTiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[];return{id:String(item.id),sku:String(item.sku??""),name:String(item.name),description:String(item.description??""),defaultUnitAmount:priceTiers[0]?.unitAmount??Number(item.defaultUnitAmount),priceTiers,currency:String(item.currency),imageMediaId:item.imageMediaId?String(item.imageMediaId):null,imageName:String(item.imageName??""),tags:Array.isArray(item.tags)?(item.tags as Array<Record<string,unknown>>).map(mapTag):[],createdAt:String(item.createdAt),updatedAt:String(item.updatedAt)};}

function ProductImage({
  mediaId,
  token,
  onToken,
  alt,
  className = "",
}: {
  mediaId: string | null;
  token: string;
  onToken: (token: string) => void;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!mediaId) {
      const reset = window.setTimeout(() => setUrl(""), 0);
      return () => window.clearTimeout(reset);
    }
    const controller = new AbortController();
    let objectUrl = "";
    void (async () => {
      const result = await authorizedFetch(`/api/v1/media/${mediaId}`, token, {
        signal: controller.signal,
      });
      if (result.token !== token) onToken(result.token);
      if (!result.response.ok) return;
      objectUrl = URL.createObjectURL(await result.response.blob());
      setUrl(objectUrl);
    })().catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaId, token, onToken]);
  return (
    <div className={`product-image ${className}`}>
      {url ? (
        <Image src={url} alt={alt} width={480} height={310} unoptimized />
      ) : (
        <ShoppingBag size={28} />
      )}
    </div>
  );
}

// Retained temporarily for rollback compatibility with the pre-tier product editor.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ProductDialog({product,products,token,onToken,onClose,onSaved}:{product?:ProductItem;products:ProductItem[];token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:(message:string)=>Promise<void>}){
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [name,setName]=useState(product?.name??""),[sku,setSku]=useState(product?.sku??""),[tiers,setTiers]=useState(()=>product?.priceTiers.map(tier=>({id:crypto.randomUUID(),minQuantity:String(tier.minQuantity),unitAmount:tier.unitAmount.toFixed(2)}))??[{id:crypto.randomUUID(),minQuantity:"1",unitAmount:""}]),[currency,setCurrency]=useState(product?.currency??"USD"),[imageFile,setImageFile]=useState<File|null>(null),[imagePreviewUrl,setImagePreviewUrl]=useState(""),[imageMediaId,setImageMediaId]=useState<string|null>(product?.imageMediaId??null),[imageName,setImageName]=useState(product?.imageName??""),[tags,setTags]=useState<TagItem[]>(product?.tags??[]),[tagName,setTagName]=useState(""),[tagColor,setTagColor]=useState("#E8EEF7"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const amount=tiers[0]?.unitAmount??"",setAmount=(value:string)=>setTiers(all=>all.map((tier,index)=>index===0?{...tier,unitAmount:value}:tier));
  const imagePreviewObjectUrl=useRef("");
  const duplicate=products.some(item=>item.id!==product?.id&&item.name.trim().toLowerCase()===name.trim().toLowerCase());
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy)onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[busy,onClose]);
  useEffect(()=>()=>{if(imagePreviewObjectUrl.current)URL.revokeObjectURL(imagePreviewObjectUrl.current);},[]);
  function chooseImage(file:File){if(imagePreviewObjectUrl.current)URL.revokeObjectURL(imagePreviewObjectUrl.current);const objectUrl=URL.createObjectURL(file);imagePreviewObjectUrl.current=objectUrl;setImageFile(file);setImagePreviewUrl(objectUrl);setImageMediaId(null);setImageName(file.name);}
  function clearImage(){if(imagePreviewObjectUrl.current)URL.revokeObjectURL(imagePreviewObjectUrl.current);imagePreviewObjectUrl.current="";setImageFile(null);setImagePreviewUrl("");setImageMediaId(null);setImageName("");}
  function addTag(){const value=tagName.trim();if(!value||tags.some(item=>item.name.toLowerCase()===value.toLowerCase()))return;setTags(all=>[...all,{id:crypto.randomUUID(),name:value,color:tagColor}]);setTagName("");}
  async function save(){const money=/^\d+(?:\.\d{1,2})?$/,quantities=tiers.map(tier=>Number(tier.minQuantity));if(!name.trim()||!sku.trim()||tiers[0]?.minQuantity!=="1"||tiers.some(tier=>!/^\d+$/.test(tier.minQuantity)||Number(tier.minQuantity)<1||!money.test(tier.unitAmount))||quantities.some((quantity,index)=>index>0&&quantity<=quantities[index-1])){setError("请填写名称、唯一 SKU，以及从数量 1 开始且门槛递增的阶梯单价");return;}setBusy(true);setError("");try{let accessToken=token,nextMediaId=imageMediaId;if(imageFile){const form=new FormData();form.append("file",imageFile);const uploaded=await authorizedFetch("/api/v1/products/media",accessToken,{method:"POST",body:form});accessToken=uploaded.token;if(uploaded.token!==token)onToken(uploaded.token);if(!uploaded.response.ok)throw new Error("产品图片上传失败");const body=await uploaded.response.json() as {mediaId:string};nextMediaId=body.mediaId;}const payload={name:name.trim(),sku:sku.trim(),priceTiers:tiers.map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})),currency,imageMediaId:nextMediaId,tags:tags.map(item=>({name:item.name.trim(),color:item.color}))};const result=await authorizedFetch(product?`/api/v1/products/${product.id}`:"/api/v1/products",accessToken,{method:product?"PATCH":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(product?payload:{clientProductId:crypto.randomUUID(),...payload})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {error?:string;message?:string};if(!result.response.ok)throw new Error(body.error==="sku_exists"?"SKU 已被另一个有效产品使用":body.message??`保存失败（HTTP ${result.response.status}）`);await onSaved(product?"产品资料已更新":"产品已加入团队产品库");}catch(reason){setError(reason instanceof Error?reason.message:"产品保存失败");setBusy(false);}}
  return <div className="modal-backdrop product-dialog-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="login-dialog product-dialog" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><ShoppingBag size={20}/></span><h2 id="product-dialog-title">{product?"编辑产品":"新增产品"}</h2><p>产品资料供团队创建订单时复用；修改不会影响已保存的订单。</p><label>产品名称<input value={name} onChange={event=>setName(event.target.value)} maxLength={120} autoFocus placeholder="输入产品名称"/></label>{duplicate&&<span className="duplicate-warning"><Info size={13}/>产品库已有同名产品，仍可继续创建或保存。</span>}<div className="product-form-grid"><label>默认单价<input value={amount} onChange={event=>setAmount(event.target.value)} inputMode="decimal" placeholder="0.00"/></label><label>币种<select value={currency} onChange={event=>setCurrency(event.target.value)}>{CURRENCIES.map(item=><option key={item}>{item}</option>)}</select></label></div><label className="product-image-input">产品图片 · 可选<input type="file" accept="image/png,image/jpeg" onChange={event=>{const file=event.target.files?.[0];if(file)chooseImage(file);event.currentTarget.value="";}}/><span><UploadCloud size={14}/>{imageName||"添加 PNG/JPG 图片"}</span></label>{(imageFile||imageMediaId)&&<div className="product-dialog-image-preview">{imagePreviewUrl?<Image src={imagePreviewUrl} alt={imageName||name||"产品图片预览"} width={480} height={310} unoptimized/>:<ProductImage mediaId={imageMediaId} token={token} onToken={onToken} alt={imageName||name||"产品图片预览"}/>}<span title={imageName}>{imageName||"当前产品图片"}</span></div>}{(imageFile||imageMediaId)&&<button type="button" className="product-image-remove" onClick={clearImage}><Trash2 size={11}/>移除图片</button>}<div className="product-label-editor"><b>产品标签</b>{tags.map((item,index)=><div key={item.id}><input value={item.name} maxLength={40} onChange={event=>setTags(all=>all.map((tag,tagIndex)=>tagIndex===index?{...tag,name:event.target.value}:tag))}/><input type="color" value={item.color} onChange={event=>setTags(all=>all.map((tag,tagIndex)=>tagIndex===index?{...tag,color:event.target.value}:tag))}/><button onClick={()=>setTags(all=>all.filter((_,tagIndex)=>tagIndex!==index))} aria-label={`移除标签 ${item.name}`}><Trash2 size={13}/></button></div>)}<div className="product-label-add"><input value={tagName} onChange={event=>setTagName(event.target.value)} maxLength={40} placeholder="新标签名称" onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();addTag();}}}/><input type="color" value={tagColor} onChange={event=>setTagColor(event.target.value)}/><button onClick={addTag}><Plus size={13}/></button></div></div>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!name.trim()||!amount} onClick={()=>void save()}>{busy?"正在保存…":product?"保存产品资料":"创建产品"}</button></section></div>;
}

function AgentManagement({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [agents,setAgents]=useState<ManagedAgent[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);
  const load=useCallback(async(quiet=false)=>{if(!token)return;if(!quiet)setLoading(true);try{const result=await authorizedFetch("/api/v1/agents",token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(result.response.status===403?"当前账号无权查看 Agent":"Agent 列表加载失败");const body=await result.response.json() as {data:ManagedAgent[]};setAgents(body.data);setError("");}catch(reason){setError(reason instanceof Error?reason.message:"Agent 列表加载失败");}finally{if(!quiet)setLoading(false);}},[token,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);const timer=window.setInterval(()=>void load(true),5000);return()=>{window.clearTimeout(initial);window.clearInterval(timer);};},[load]);
  async function createAgent(){const name=window.prompt("输入 Agent 设备名称","Windows Agent");if(!name?.trim())return;const result=await authorizedFetch("/api/v1/agents/enrollment",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:name.trim()})});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`创建失败（HTTP ${result.response.status}）`);return;}const body=await result.response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});void load(true);}
  async function renameAgent(agent:ManagedAgent){const name=window.prompt("修改 Agent 名称",agent.name);if(!name?.trim()||name.trim()===agent.name)return;await mutate(agent.id,{name:name.trim()},"Agent 名称已更新");}
  async function revokeAgent(agent:ManagedAgent){if(!window.confirm(`撤销「${agent.name}」后，该设备必须重新注册才能连接。确定继续？`))return;await mutate(agent.id,{revoke:true},"Agent 已撤销");}
  async function deleteAgent(agent:ManagedAgent){if(!window.confirm(`永久删除「${agent.name}」的中心登记？账号历史消息仍会保留。`))return;const result=await authorizedFetch(`/api/v1/agents/${agent.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`删除失败（HTTP ${result.response.status}）`);return;}onToast("Agent 登记已删除");void load(true);}
  async function mutate(id:string,body:Record<string,unknown>,success:string){const result=await authorizedFetch(`/api/v1/agents/${id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`操作失败（HTTP ${result.response.status}）`);return;}onToast(success);void load(true);}
  async function copyCode(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);onToast("注册码已复制");}catch{onToast("复制失败，请手动复制");}}
  return <section className="management-panel"><header className="management-head"><div><span className="eyebrow">设备与连接</span><h1>Agent 管理</h1><p>查看所有已注册 Windows Agent、连接状态和所管理的 WhatsApp 账号。</p></div><div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button>{role==="admin"&&<button className="primary-action" onClick={()=>void createAgent()}><Plus size={15}/>注册新 Agent</button>}</div></header>
    {enrollment&&<div className="management-enrollment"><span><b>一次性注册码</b><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small></span><code>{enrollment.code}</code><button onClick={()=>void copyCode()}>复制</button><button onClick={()=>setEnrollment(null)} aria-label="关闭"><X size={15}/></button></div>}
    <div className="management-summary"><SummaryCard label="全部 Agent" value={agents.length}/><SummaryCard label="当前在线" value={agents.filter(agentIsOnline).length}/><SummaryCard label="已绑定账号" value={agents.reduce((sum,agent)=>sum+agent.accounts.length,0)}/><SummaryCard label="在线账号" value={agents.filter(agentIsOnline).flatMap(agent=>agent.accounts).filter(account=>account.status==="online").length}/></div>
    {loading?<EmptyState title="正在读取 Agent" text="请稍候…"/>:error?<EmptyState title="Agent 数据加载失败" text={error}/>:agents.length?<div className="agent-grid">{agents.map(agent=>{const online=agentIsOnline(agent),effectiveStatus=online?"online":agent.status==="revoked"?"revoked":agent.status==="pending"?"pending":"offline";return <article className="agent-card" key={agent.id}><div className="agent-card-head"><span className={`agent-device ${online?"online":""}`}><MonitorSmartphone size={20}/></span><span><b>{agent.name}</b><small>{agent.platform||"平台待上报"} · v{agent.version||"未知"}</small></span><em className={`agent-badge ${effectiveStatus}`}>{agentStatusText(effectiveStatus)}</em></div><dl><div><dt>最后心跳</dt><dd>{agent.last_seen_at?formatLastSeen(agent.last_seen_at):"从未连接"}</dd></div><div><dt>确认游标</dt><dd>{agent.last_acked_cursor??0}</dd></div><div><dt>协议版本</dt><dd>{agent.protocol_version??"待协商"}</dd></div><div><dt>注册时间</dt><dd>{new Date(agent.created_at).toLocaleDateString("zh-CN")}</dd></div></dl>{!online&&agent.status!=="pending"&&agent.status!=="revoked"&&<div className="agent-timeout-note"><WifiOff size={13}/>超过 45 秒未收到心跳，已判定离线</div>}<div className="agent-accounts"><h3>WhatsApp 账号 <span>{agent.accounts.length}</span></h3>{agent.accounts.length?agent.accounts.map(account=>{const accountOnline=online&&account.status==="online";return <div key={account.id}><i className={`status-dot ${accountOnline?"online":""}`}/><span><b>{account.display_name}</b><small>{account.phone_e164||(online?account.status_reason:"Agent 已离线")||statusText(account.status)}</small></span><em>{accountOnline?"在线":"离线"}</em></div>}):<p>此 Agent 尚未绑定账号</p>}</div>{role==="admin"?<footer><button onClick={()=>void renameAgent(agent)}>编辑名称</button>{agent.status!=="revoked"&&<button onClick={()=>void revokeAgent(agent)}>撤销凭据</button>}<button className="danger-text" onClick={()=>void deleteAgent(agent)}><Trash2 size={13}/>移除 Agent</button></footer>:<p className="agent-permission-note">当前账号仅可查看；管理员登录后可移除 Agent。</p>}</article>})}</div>:<EmptyState title="尚未注册 Agent" text="点击右上角“注册新 Agent”生成一次性注册码"/>}
  </section>;
}

function SummaryCard({label,value}:{label:string;value:number}){return <div><span>{label}</span><b>{value}</b></div>;}
function agentStatusText(status:string){return({pending:"待注册",online:"在线",offline:"离线",revoked:"已撤销"} as Record<string,string>)[status]??status;}
function agentIsOnline(agent:ManagedAgent){if(agent.status!=="online"||!agent.last_seen_at)return false;return Date.now()-new Date(agent.last_seen_at).getTime()<45_000;}
function formatLastSeen(value:string){const date=new Date(value),seconds=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));if(seconds<60)return`${seconds} 秒前`;if(seconds<3600)return`${Math.floor(seconds/60)} 分钟前`;return date.toLocaleString("zh-CN");}
function HelpPanel({onInbox,onAgents}:{onInbox:()=>void;onAgents:()=>void}){return <section className="management-panel help-panel"><header className="management-head"><div><span className="eyebrow">使用帮助</span><h1>RelayDesk 操作入口</h1><p>所有导航按钮现在都会进入对应的真实功能。</p></div></header><div className="help-grid"><button onClick={onInbox}><MessageCircle size={21}/><span><b>消息中心</b><small>查看 Agent 同步到 PostgreSQL 的真实会话和消息</small></span></button><button onClick={onAgents}><MonitorSmartphone size={21}/><span><b>Agent 管理</b><small>查看注册设备、版本、在线状态及绑定账号</small></span></button><div><ShieldCheck size={21}/><span><b>中心设置</b><small>点击左下角齿轮生成一次性注册码或退出登录</small></span></div><div><Wifi size={21}/><span><b>数据同步</b><small>Windows Agent 在线后，消息会自动进入中心工作台</small></span></div></div></section>;}

function NewConversationDialog({accounts,token,onToken,onClose,onCreated}:{accounts:Account[];token:string;onToken:(token:string)=>void;onClose:()=>void;onCreated:(conversationId:string,accountId:string,accessToken:string)=>Promise<void>}){
  const preferred=accounts.find(account=>account.status==="online")?.id??accounts[0]?.id??"";const [accountId,setAccountId]=useState(preferred);const [phone,setPhone]=useState("");const [displayName,setDisplayName]=useState("");const [firstMessage,setFirstMessage]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const account=accounts.find(item=>item.id===accountId);
  async function submit(){if(!accountId||!phone.trim()||!firstMessage.trim())return;setBusy(true);setError("");try{const result=await authorizedFetch("/api/v1/conversations",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,phone,displayName:displayName.trim()||undefined,firstMessage:firstMessage.trim(),clientMessageId:crypto.randomUUID()})});if(result.token!==token)onToken(result.token);const body=await result.response.json() as {conversationId?:string;error?:string;details?:{fieldErrors?:Record<string,string[]>}};if(!result.response.ok||!body.conversationId){const detail=body.details?.fieldErrors?Object.values(body.details.fieldErrors).flat()[0]:undefined;throw new Error(detail||({account_not_found:"发送账号不存在或已解绑",invalid_request:"请检查号码和消息内容"} as Record<string,string>)[body.error??""]||`创建失败（HTTP ${result.response.status}）`);}await onCreated(body.conversationId,accountId,result.token);}catch(reason){setError(reason instanceof Error?reason.message:"新建会话失败");}finally{setBusy(false);}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="login-dialog new-conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><MessageCircle size={21}/></span><h2 id="new-conversation-title">新建 WhatsApp 会话</h2><p>仅向单个号码发送，不提供群发。号码必须包含国家或地区代码。</p><label>发送账号<select value={accountId} onChange={event=>setAccountId(event.target.value)} disabled={busy||!accounts.length}>{accounts.length?accounts.map(item=><option value={item.id} key={item.id}>{item.name}（{statusText(item.status)}）</option>):<option value="">暂无已绑定账号</option>}</select></label><div className="conversation-form-grid"><label>WhatsApp 号码<input value={phone} onChange={event=>setPhone(event.target.value)} placeholder="例如：+8613800138000" inputMode="tel" autoFocus/></label><label>联系人名称（可选）<input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={80} placeholder="客户名称"/></label></div><label>首条消息<textarea value={firstMessage} onChange={event=>setFirstMessage(event.target.value)} maxLength={65536} placeholder="输入要发送的消息" onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey))void submit();}}/></label>{account&&account.status!=="online"&&<span className="new-conversation-warning"><Clock3 size={13}/>当前账号离线，消息会先进入持久队列。</span>}{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!accountId||!phone.trim()||!firstMessage.trim()} onClick={()=>void submit()}>{busy?"正在创建…":"创建会话并发送"}</button><small className="dialog-hint">Ctrl / Cmd + Enter 快速提交</small></section></div>;
}

function LoginDialog({connected,token,canClose,onClose,onLogin,onLogout}:{connected:boolean;token:string;canClose:boolean;onClose:()=>void;onLogin:(token:string,user:User)=>void;onLogout:()=>void}){
  const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [agentName,setAgentName]=useState("Windows Agent");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);const [copied,setCopied]=useState(false);
  async function submit(){setBusy(true);setError("");try{const response=await fetch(`${API_URL}/api/v1/auth/login`,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});const body=await response.json() as {accessToken?:string;user?:User;error?:string};if(!response.ok||!body.accessToken||!body.user)throw new Error(response.status===401?"邮箱或密码错误":`登录失败（HTTP ${response.status}）`);onLogin(body.accessToken,body.user);}catch(reason){setError(reason instanceof Error?reason.message:"登录失败");}finally{setBusy(false);}}
  async function createEnrollment(){setBusy(true);setError("");setEnrollment(null);try{const response=await fetch(`${API_URL}/api/v1/agents/enrollment`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:agentName.trim()||"Windows Agent"})});if(response.status===401)throw new Error("登录已过期");if(response.status===403)throw new Error("只有管理员可以生成注册码");if(!response.ok)throw new Error(`注册码生成失败（HTTP ${response.status}）`);const body=await response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});}catch(reason){setError(reason instanceof Error?reason.message:"注册码生成失败");}finally{setBusy(false);}}
  async function copyEnrollment(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);setCopied(true);window.setTimeout(()=>setCopied(false),1500);}catch{setError("剪贴板不可用，请手动复制");}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(canClose&&event.target===event.currentTarget)onClose();}}><section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">{canClose&&<button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button>}<span className="login-logo"><ShieldCheck size={21}/></span><h2 id="login-title">{connected?"中心设置":"登录 RelayDesk"}</h2><p>{connected?"生成 Agent 一次性注册码，或退出当前坐席。":"仅限获授权的 GeekMT 团队成员。请使用管理员发放的 RelayDesk 坐席凭据。"}</p>{connected?<><div className="center-endpoint"><span>中心地址</span><strong>{API_URL||"当前站点"}</strong></div><label>Agent 设备名称<input value={agentName} onChange={event=>setAgentName(event.target.value)} maxLength={80}/></label><button className="login-submit" disabled={busy} onClick={()=>void createEnrollment()}>{busy?"正在生成...":"生成一次性注册码"}</button>{enrollment&&<div className="enrollment-result"><span>一次性注册码</span><code>{enrollment.code}</code><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small><button onClick={()=>void copyEnrollment()}>{copied?"已复制":"复制注册码"}</button></div>}{error&&<span className="login-error">{error}</span>}<button className="login-submit danger" onClick={onLogout}>退出中心平台</button></>:<><div className="login-safety"><ShieldCheck size={15}/><span>不要输入 WhatsApp / Meta 密码、短信验证码或两步验证 PIN。</span></div><label>RelayDesk 邮箱<input value={email} onChange={event=>setEmail(event.target.value)} autoComplete="username" autoFocus/></label><label>RelayDesk 密码<input type="password" value={password} onChange={event=>setPassword(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void submit();}} autoComplete="current-password"/></label>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!email||!password} onClick={()=>void submit()}>{busy?"正在验证...":"登录私有工作台"}</button><small className="login-affiliation">由 GeekMT 运营 · 与 Meta 或 WhatsApp 无隶属、赞助或背书关系</small></>}</section></div>;
}
