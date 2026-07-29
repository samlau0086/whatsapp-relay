"use client";

import {
  Archive, Bell, Bookmark, CalendarDays, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, FileText, FileDown,
  Inbox, Info, Languages, Mail, MessageCircle, Mic, MonitorSmartphone, Paperclip, Phone, Plus,
  Pencil, RefreshCw, Search, Send, Settings, ShieldCheck, ShoppingBag, Smile, Sparkles, Star, Trash2, UploadCloud, UserPlus,
  Users, Wifi, WifiOff, X, ClipboardList, ExternalLink, Bot, Brain, BookOpen, MapPin, Copy, CreditCard, LayoutGrid, List, Eye, EyeOff, ReceiptText, Reply, Zap, Tag,
  Facebook, Instagram, Linkedin,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { OrderTemplateEditor, type TemplateFormat } from "./order-template-editor";
import { ProductCardTemplateEditor } from "./product-card-template-editor";
import { ProductCardSendDialog } from "./product-card-send-dialog";
import { ProductEditorDialog } from "./product-editor-dialog";
import { ProductImportDialog } from "./product-import-dialog";
import { DataImportDialog } from "./data-import-dialog";
import { dateFileSuffix, downloadCsv } from "./csv-transfer";
import { ProductImageMediaDialog, type ProductImageAsset } from "./product-image-media-dialog";
import { clipboardFiles } from "./clipboard-files";
import { CollageGenerateDialog, ProductWorkspace } from "./collage-materials";
import { MaterialLibrarySendDialog } from "./material-library-send-dialog";
import { TaskCenter } from "./task-center";
import {StatusCenter} from "./status-center";
import {LanguagePicker,languageFlag,languageName,languageShortCode} from "./language-picker";
import { conversationCountsPath, conversationListPath, conversationSummaryPath, type ConversationDateFilter, type ConversationListFilter } from "./conversation-date-filter";
import { confirmAction, ConfirmationHost, promptAction, PromptHost } from "./confirmation-ui";
import {formatMessageTime,formatMessageTimeTitle} from "./message-time";
import {useConversationFeed} from "./use-conversation-feed";
import {ConversationPanel} from "./conversation-panel";
import type {ContactMethod,ContactMethodType,Conversation,TagItem} from "./conversation-types";
import { convertWeight, formatWeight, WEIGHT_UNITS, type WeightUnit } from "./weight";

const API_URL = (process.env.NEXT_PUBLIC_RELAY_API_URL ?? "").replace(/\/$/, "");
const REMEMBER_LOGIN_KEY="relayRememberLogin";
const COLORS = ["#6b4f3a", "#305f72", "#9b5f72", "#477a62", "#705b86"];
const PRODUCT_PAGE_SIZES = [24,32,36,48,64] as const;
let refreshPromise:Promise<string>|null=null;
const MESSAGE_PAGE_SIZE=50;
const MEDIA_DOWNLOAD_CONCURRENCY=4;
const MEDIA_CACHE_LIMIT=80;

type MediaCacheEntry={url:string;promise:Promise<string>;references:number;lastUsed:number};
const mediaCache=new Map<string,MediaCacheEntry>();
const mediaQueue:Array<()=>void>=[];
let activeMediaDownloads=0;

function scheduleMediaDownload<T>(task:()=>Promise<T>):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    const run=()=>{
      activeMediaDownloads++;
      void task().then(resolve,reject).finally(()=>{
        activeMediaDownloads--;
        mediaQueue.shift()?.();
      });
    };
    if(activeMediaDownloads<MEDIA_DOWNLOAD_CONCURRENCY)run();else mediaQueue.push(run);
  });
}

function pruneMediaCache(){
  if(mediaCache.size<=MEDIA_CACHE_LIMIT)return;
  const removable=[...mediaCache.entries()]
    .filter(([,entry])=>entry.references===0&&Boolean(entry.url))
    .sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
  while(mediaCache.size>MEDIA_CACHE_LIMIT&&removable.length){
    const [id,entry]=removable.shift()!;
    if(mediaCache.get(id)!==entry)continue;
    URL.revokeObjectURL(entry.url);
    mediaCache.delete(id);
  }
}

function acquireMedia(id:string,load:()=>Promise<Blob>):Promise<string>{
  const cached=mediaCache.get(id);
  if(cached){cached.references++;cached.lastUsed=Date.now();return cached.promise;}
  const entry:MediaCacheEntry={url:"",references:1,lastUsed:Date.now(),promise:Promise.resolve("")};
  entry.promise=scheduleMediaDownload(load).then(blob=>{
    entry.url=URL.createObjectURL(blob);
    entry.lastUsed=Date.now();
    pruneMediaCache();
    return entry.url;
  }).catch(error=>{if(mediaCache.get(id)===entry)mediaCache.delete(id);throw error;});
  mediaCache.set(id,entry);
  return entry.promise;
}

function releaseMedia(id:string){
  const entry=mediaCache.get(id);
  if(!entry)return;
  entry.references=Math.max(0,entry.references-1);
  entry.lastUsed=Date.now();
  pruneMediaCache();
}

type Account = { id:string; name:string; phone:string; status:string; reason:string; platform:"whatsapp"|"messenger"; pageId?:string; transport:"web"|"cloud"; webhookStatus?:string; credentialsStatus?:string; lastEvent?:string };
type ProductPriceTier={minQuantity:number;unitAmount:number};
type ProductItem={id:string;sku:string;name:string;description:string;category:string;brand:string;defaultUnitAmount:number;priceTiers:ProductPriceTier[];currency:string;weightAmount:number|null;weightUnit:WeightUnit|null;imageMediaId:string|null;imageName:string;tags:TagItem[];createdAt:string;updatedAt:string};
type ProductPageCacheEntry={products:ProductItem[];total:number;tags:string[];categories:string[];brands:string[];fetchedAt:number;lastUsed:number};
type ProductPageResponse={data:Array<Record<string,unknown>>;total:number;tags:string[];categories?:string[];brands?:string[]};
const PRODUCT_PAGE_CACHE_TTL=60_000;
const PRODUCT_PAGE_CACHE_LIMIT=60;
const PRODUCT_CURRENCY_CACHE_TTL=5*60_000;
const productPageCache=new Map<string,ProductPageCacheEntry>();
const productPageFlights=new Map<string,Promise<{entry:ProductPageCacheEntry;token:string}>>();
const productCurrencyCache=new Map<string,{config:CurrencyConfig;fetchedAt:number}>();
const productCurrencyFlights=new Map<string,Promise<{config:CurrencyConfig;token:string}>>();
const productCacheEpoch=new Map<string,number>();

function productCacheKey(subject:string,input:{page:number;pageSize:number;query:string;currency:string;category:string;brand:string;tag:string}){
  return`${subject}:${productCacheEpoch.get(subject)??0}|${JSON.stringify(input)}`;
}

function pruneProductPageCache(){
  if(productPageCache.size<=PRODUCT_PAGE_CACHE_LIMIT)return;
  const oldest=[...productPageCache.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
  while(productPageCache.size>PRODUCT_PAGE_CACHE_LIMIT&&oldest.length)productPageCache.delete(oldest.shift()![0]);
}

function invalidateProductCache(subject:string){
  productCacheEpoch.set(subject,(productCacheEpoch.get(subject)??0)+1);
  for(const key of productPageCache.keys())if(key.startsWith(`${subject}:`))productPageCache.delete(key);
}

function fetchProductPage(key:string,path:string,token:string):Promise<{entry:ProductPageCacheEntry;token:string}>{
  const current=productPageFlights.get(key);
  if(current)return current;
  const pending=authorizedFetch(path,token).then(async result=>{
    if(!result.response.ok)throw new Error(`产品库加载失败（HTTP ${result.response.status}）`);
    const body=await result.response.json() as ProductPageResponse;
    const now=Date.now(),entry:ProductPageCacheEntry={products:body.data.map(mapProduct),total:body.total,tags:body.tags,categories:body.categories??[],brands:body.brands??[],fetchedAt:now,lastUsed:now};
    productPageCache.set(key,entry);pruneProductPageCache();
    return{entry,token:result.token};
  }).finally(()=>productPageFlights.delete(key));
  productPageFlights.set(key,pending);
  return pending;
}

function fetchProductCurrencies(subject:string,token:string,force=false):Promise<{config:CurrencyConfig;token:string}>{
  const cached=productCurrencyCache.get(subject);
  if(!force&&cached&&Date.now()-cached.fetchedAt<PRODUCT_CURRENCY_CACHE_TTL)return Promise.resolve({config:cached.config,token});
  const current=productCurrencyFlights.get(subject);
  if(current)return current;
  const pending=authorizedFetch("/api/v1/currencies",token).then(async result=>{
    if(!result.response.ok)throw new Error(`货币配置加载失败（HTTP ${result.response.status}）`);
    const config=await result.response.json() as CurrencyConfig;
    productCurrencyCache.set(subject,{config,fetchedAt:Date.now()});
    return{config,token:result.token};
  }).finally(()=>productCurrencyFlights.delete(subject));
  productCurrencyFlights.set(subject,pending);
  return pending;
}
type NoteItem={id:string;body:string;userId:string|null;authorName:string;createdAt:string;updatedAt:string};
type ContactEmail={id?:string;label:string;email:string;isPrimary:boolean};
type ContactDate={month:number;day:number;year:number|null};
type ContactSpecialDate=ContactDate&{id?:string;kind:"anniversary"|"birthday"|"custom";label:string;leadDays:number|null};
type ContactProfile={id:string;accountId:string;accountName:string;alias:string;contactName:string;firstName:string;middleName:string;lastName:string;name:string;phone:string;avatarUrl:string|null;note:string;timezone:string|null;preferredLanguage:string|null;effectiveTimezone:string;timezoneSource:"custom"|"country"|"fallback";inferredCountry:string|null;birthday:ContactDate|null;specialDates:ContactSpecialDate[];emails:ContactEmail[];primaryEmail:string|null;methods:ContactMethod[];addresses:CustomerAddress[];conversationId:string|null;hasConversation:boolean;lastMessageAt:string|null;updatedAt:string};
type OrderProductItem={id:string;name:string;sku:string;quantity:number;unitAmount:number;weightAmount:number|null;weightUnit:WeightUnit|null;imageMediaId:string|null;imageName:string;productId:string|null};
type OrderFeeItem={id:string;name:string;amount:number};
type CustomerAddress={id:string;label:string;recipientName:string;phone:string;address:string;isDefault:boolean};
type PaymentRequest={id:string;invoiceId:string|null;url:string|null;status:string;amount:number;currency:string;environment:string;createdAt:string;lastSyncedAt:string|null};
type PaymentMethodType="paypal"|"bank_transfer"|"western_union"|"wise"|"moneygram"|"stripe_payment_link"|"custom";
type PaymentPublicField={label:string;value:string};
type PaymentProfile={id:string;profileId:string;name:string;profileName:string;methodId:string;methodType:PaymentMethodType;methodName:string;enabled:boolean;environment:"sandbox"|"live"|null;summary:string;publicFields:PaymentPublicField[];instructions:string;sandboxClientIdConfigured?:boolean;sandboxClientSecretConfigured?:boolean;liveClientIdConfigured?:boolean;liveClientSecretConfigured?:boolean;sandboxClientId?:string;sandboxClientSecret?:string;liveClientId?:string;liveClientSecret?:string;referenceTemplate?:string;noteTemplate?:string;itemNameTemplate?:string};
type PaymentMethod={id:string;type:PaymentMethodType;name:string;enabled:boolean;sortOrder:number;profiles:PaymentProfile[]};
type OrderBusinessStatus="quotation"|"pending_confirmation"|"pending_payment"|"paid"|"processing"|"shipped"|"completed"|"cancelled";
const ORDER_BUSINESS_STATUSES:Array<{value:OrderBusinessStatus;label:string}>=[
  {value:"quotation",label:"报价"},{value:"pending_confirmation",label:"待确认"},{value:"pending_payment",label:"待付款"},{value:"paid",label:"已付款"},
  {value:"processing",label:"处理中"},{value:"shipped",label:"已发货"},{value:"completed",label:"已完成"},{value:"cancelled",label:"已取消"},
];
function orderBusinessStatusText(value:string){return ORDER_BUSINESS_STATUSES.find(item=>item.value===value)?.label??"报价";}
type OrderItem={id:string;orderNumber:string;conversationId:string;accountId:string;accountName:string;customerName:string;customerPhone:string;amount:number;currency:string;weightUnit:WeightUnit;description:string;status:string;businessStatus:OrderBusinessStatus;sendFormat:string;translateOnSend:boolean;targetLanguage:string;createdAt:string;createdByName:string;messageStatus:string;items:OrderProductItem[];fees:OrderFeeItem[];addressId:string|null;address:CustomerAddress|null;paymentProfileId:string|null;paymentProfile:PaymentProfile|null;paymentRequest:PaymentRequest|null};
type OrderSendTarget={order:OrderItem};
type ContactTaskSummary={id:string;title:string;kind:"general"|"message";status:string;dueAt:string;sendAt:string|null;assignedUserName:string|null};
type ContactTaskDetail=ContactTaskSummary&{description:string;progress:number;startAt:string;sendMode:"approval"|"auto";accountName:string;source:string};
type ConversationDetails={customerStage:string;contact:ContactProfile|null;tags:TagItem[];notes:NoteItem[];orders:OrderItem[]};
type ConversationDetailsCacheEntry={details:ConversationDetails;catalog:TagItem[];contactTasks:ContactTaskSummary[]};
const CONVERSATION_DETAILS_CACHE_LIMIT=100;
const conversationDetailsCache=new Map<string,ConversationDetailsCacheEntry>();
function cacheConversationDetails(conversationId:string,entry:ConversationDetailsCacheEntry){
  conversationDetailsCache.delete(conversationId);
  conversationDetailsCache.set(conversationId,entry);
  if(conversationDetailsCache.size>CONVERSATION_DETAILS_CACHE_LIMIT){
    const oldest=conversationDetailsCache.keys().next().value as string|undefined;
    if(oldest)conversationDetailsCache.delete(oldest);
  }
}
function updateCachedConversationDetails(conversationId:string,update:(details:ConversationDetails)=>ConversationDetails){
  const cached=conversationDetailsCache.get(conversationId);
  if(cached)cacheConversationDetails(conversationId,{...cached,details:update(cached.details)});
}
const CONTACT_TASK_STATUS:Record<string,string>={planned:"计划中",in_progress:"进行中",waiting_approval:"待审批",scheduled:"待发送",completed:"已完成",overdue:"已逾期",failed:"失败",cancelled:"已取消"};
type ChatMessage = {
  id:string; direction:"in"|"out"; kind:string; text:string; time:string;occurredAt?:string;
  platform?:"whatsapp"|"messenger";providerMessageId?:string;pageId?:string;
  quoted?:{id:string;direction:"in"|"out";kind:string;text:string};
  translationSourceText?:string;
  translationTargetLanguage?:string;
  failureMessage?:string;
  queueDiagnostic?:{commandId:string;state:string;attempt:number;lastError:string;availableAt:string;claimedAt:string;createdAt:string;accountStatus:string;agentStatus:string;agentLastSeenAt:string};
  cachedTranslationText?:string;cachedTranslationLanguage?:string;cachedTranslationSourceLanguage?:string;cachedTranscriptionText?:string;
  status?:"received"|"queued"|"dispatching"|"sent"|"delivered"|"read"|"failed"|"uncertain";
  attachment?:{id:string;name:string;size:string;mime:string};
};
type EmailActivity={id:string;subject:string;recipients:Array<{email:string;label:string}>;contentType:string;status:"queued"|"sending"|"retrying"|"accepted"|"failed";attempt:number;lastError:string;createdAt:string;senderName:string;attachmentCount:number};
type User = {id:string;email:string;displayName:string;role:string};
type WorkspaceView = "inbox"|"contacts"|"tasks"|"statuses"|"orders"|"products"|"agents"|"settings"|"help";
const WORKSPACE_PATHS:Record<WorkspaceView,string>={
  inbox:"/inbox",
  contacts:"/contacts",
  tasks:"/tasks",
  statuses:"/statuses",
  orders:"/orders",
  products:"/products",
  agents:"/agents",
  settings:"/settings",
  help:"/help",
};
type ManagedAgent = {id:string;name:string;status:string;version?:string;protocol_version?:number;platform?:string;last_seen_at?:string;last_acked_cursor:number;created_at:string;accounts:Array<{id:string;display_name:string;phone_e164?:string;status:string;status_reason?:string;last_event_at?:string}>};
type MediaAsset = {id:string;fileName:string;mimeType:string;size:number;sha256:string;createdAt:string;usageCount:number};
type SavedQuickReply={id:string;sourceMessageId:string;title:string;text:string;tags:string;kind:string;createdAt:string;attachment?:MediaAsset};
type TtsProviderId="openai"|"elevenlabs"|"azure"|"openai_compatible";
type TtsProviderConfig={provider:TtsProviderId;enabled:boolean;keyConfigured:boolean;apiKey:string;baseUrl:string;model:string;voice:string;updatedAt:string|null};
type TranslationProviderId="openai"|"openai_compatible";
type TranslationProviderConfig={provider:TranslationProviderId;enabled:boolean;keyConfigured:boolean;apiKey:string;baseUrl:string;model:string;transcriptionModel:string;updatedAt:string|null};
type EmailProviderId="smtp"|"resend";
type EmailProviderConfig={provider:EmailProviderId;enabled:boolean;configured:boolean;fromName:string;fromEmail:string;replyTo:string;host:string;port:number;tls:"tls"|"starttls";username:string;secret:string;updatedAt:string|null};
type TranslationPreference={enabled:boolean;agentLanguage:string;customerLanguage:string;updatedAt:string|null};
type ConversationContextState={conversation:Conversation;x:number;y:number;section:"root"|"stage"|"tags"};
type ConversationCounts={all:number;mine:number;unassigned:number;favorite:number;closed:number;archived:number;reminders:number};
type CurrencyItem={code:string;name:string;rate:number};
type CurrencyConfig={baseCurrency:string;currencies:CurrencyItem[];rateSource?:string|null;rateDate?:string|null;rateUpdatedAt?:string|null};
type MessageTranslation={status:"idle"|"loading"|"translated"|"failed";text?:string;sourceText?:string;sourceLanguage?:string;targetLanguage?:string;message?:string};
type KnowledgeBaseItem={id:string;name:string;description:string;document_count?:number;faq_count?:number};
type AgentDraft={id:string;text_content:string;reply_zh:string|null;reason:string;citations:string[];created_at:string};
const DEFAULT_TRANSLATION_PREFERENCE:TranslationPreference={enabled:false,agentLanguage:"zh-CN",customerLanguage:"en",updatedAt:null};
const EMPTY_CONVERSATION_COUNTS:ConversationCounts={all:0,mine:0,unassigned:0,favorite:0,closed:0,archived:0,reminders:0};

function conversationFilterKey(label:string):ConversationListFilter{
  if(label==="分配给我")return"mine";
  if(label==="未分配")return"unassigned";
  if(label==="收藏")return"favorite";
  if(label==="已关闭")return"closed";
  if(label==="已归档")return"archived";
  if(label==="我的提醒")return"reminders";
  return"all";
}
const DEFAULT_CURRENCY_CONFIG:CurrencyConfig={baseCurrency:"USD",currencies:[{code:"USD",name:"美元",rate:1},{code:"CNY",name:"人民币",rate:7.2},{code:"EUR",name:"欧元",rate:.92},{code:"GBP",name:"英镑",rate:.78},{code:"JPY",name:"日元",rate:157},{code:"HKD",name:"港币",rate:7.8},{code:"SGD",name:"新加坡元",rate:1.35},{code:"AUD",name:"澳元",rate:1.5},{code:"CAD",name:"加元",rate:1.37},{code:"AED",name:"阿联酋迪拉姆",rate:3.6725}]};

function convertCurrency(amount:number,from:string,to:string,config:CurrencyConfig):number{if(from===to)return amount;const source=config.currencies.find(item=>item.code===from)?.rate,target=config.currencies.find(item=>item.code===to)?.rate;if(!source||!target)return amount;return amount/source*target;}

function mapOrder(item:Record<string,unknown>,defaults:Partial<OrderItem>={}):OrderItem{return{
  id:String(item.id),orderNumber:String(item.display_order_number??item.order_number??""),conversationId:String(item.conversation_id??defaults.conversationId??""),accountId:String(item.account_id??defaults.accountId??""),accountName:String(item.account_name??defaults.accountName??""),customerName:String(item.customer_name??defaults.customerName??""),customerPhone:String(item.customer_phone??defaults.customerPhone??""),amount:Number(item.amount),currency:String(item.currency),weightUnit:(item.weight_unit??defaults.weightUnit??"kg") as WeightUnit,description:String(item.description??""),status:String(item.status??"draft"),businessStatus:String(item.business_status??defaults.businessStatus??"quotation") as OrderBusinessStatus,sendFormat:String(item.send_format??""),translateOnSend:Boolean(item.translate_on_send),targetLanguage:String(item.target_language??""),createdAt:String(item.created_at),createdByName:String(item.created_by_name??"已离职坐席"),messageStatus:String(item.message_status??item.status??"draft"),items:Array.isArray(item.items)?(item.items as Array<Record<string,unknown>>).map(product=>({id:String(product.id),name:String(product.name),sku:String(product.sku??""),quantity:Number(product.quantity),unitAmount:Number(product.unitAmount),weightAmount:product.weightAmount===null||product.weightAmount===undefined?null:Number(product.weightAmount),weightUnit:product.weightUnit?String(product.weightUnit) as WeightUnit:null,imageMediaId:product.imageMediaId?String(product.imageMediaId):null,imageName:String(product.imageName??""),productId:product.productId?String(product.productId):null})):[],fees:Array.isArray(item.fees)?(item.fees as Array<Record<string,unknown>>).map(fee=>({id:String(fee.id),name:String(fee.name),amount:Number(fee.amount)})):[],addressId:item.address_id?String(item.address_id):null,address:item.shipping_address_snapshot?mapCustomerAddress(item.shipping_address_snapshot as Record<string,unknown>,item.address_id?String(item.address_id):""):null,paymentProfileId:item.payment_profile_id?String(item.payment_profile_id):null,paymentProfile:item.payment_profile_snapshot?mapPaymentProfile(item.payment_profile_snapshot as Record<string,unknown>):defaults.paymentProfile??null,paymentRequest:item.payment_request?mapPaymentRequest(item.payment_request as Record<string,unknown>):defaults.paymentRequest??null,
};}

function mapPaymentProfile(item:Record<string,unknown>):PaymentProfile{return{id:String(item.id??item.profileId),profileId:String(item.profileId??item.id),name:String(item.name??item.profileName),profileName:String(item.profileName??item.name),methodId:String(item.methodId),methodType:String(item.methodType) as PaymentMethodType,methodName:String(item.methodName),enabled:item.enabled===undefined?true:Boolean(item.enabled),environment:item.environment==="sandbox"||item.environment==="live"?item.environment:null,summary:String(item.summary??`${item.methodName} · ${item.profileName??item.name}`),publicFields:Array.isArray(item.publicFields)?item.publicFields.map(field=>({label:String((field as Record<string,unknown>).label),value:String((field as Record<string,unknown>).value)})):[],instructions:String(item.instructions??""),sandboxClientIdConfigured:Boolean(item.sandboxClientIdConfigured),sandboxClientSecretConfigured:Boolean(item.sandboxClientSecretConfigured),liveClientIdConfigured:Boolean(item.liveClientIdConfigured),liveClientSecretConfigured:Boolean(item.liveClientSecretConfigured),referenceTemplate:item.referenceTemplate?String(item.referenceTemplate):undefined,noteTemplate:item.noteTemplate?String(item.noteTemplate):undefined,itemNameTemplate:item.itemNameTemplate?String(item.itemNameTemplate):undefined};}

function mapPaymentRequest(item:Record<string,unknown>):PaymentRequest{return{id:String(item.id),invoiceId:item.invoiceId?String(item.invoiceId):null,url:item.url?String(item.url):null,status:String(item.status??"UNKNOWN"),amount:Number(item.amount),currency:String(item.currency),environment:String(item.environment??"sandbox"),createdAt:String(item.createdAt??""),lastSyncedAt:item.lastSyncedAt?String(item.lastSyncedAt):null};}

function mapCustomerAddress(item:Record<string,unknown>,id=String(item.id??"")):CustomerAddress{return{id,label:String(item.label??"地址"),recipientName:String(item.recipientName??item.recipient_name??""),phone:String(item.phone??""),address:String(item.address??""),isDefault:Boolean(item.isDefault??item.is_default)};}

export function WhatsAppInbox({initialView="inbox"}:{initialView?:WorkspaceView}) {
  const router=useRouter();
  const pathname=usePathname();
  const pathView=pathname.split("/")[1] as WorkspaceView;
  const routeView=pathView in WORKSPACE_PATHS?pathView:initialView;
  const [view,setWorkspaceView]=useState<WorkspaceView>(routeView);
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const [messages,setMessages]=useState<Record<string,ChatMessage[]>>({});
  const [messageCursors,setMessageCursors]=useState<Record<string,string|null>>({});
  const [loadingOlderConversationId,setLoadingOlderConversationId]=useState("");
  const [olderMessageErrors,setOlderMessageErrors]=useState<Record<string,string>>({});
  const [failedMessageCounts,setFailedMessageCounts]=useState<Record<string,number>>({});
  const [emailActivities,setEmailActivities]=useState<Record<string,EmailActivity[]>>({});
  const [activeId,setActiveId]=useState("");
  const [selectedAccount,setSelectedAccount]=useState("");
  const [filter,setFilter]=useState("全部会话");
  const [dateFilter,setDateFilter]=useState<ConversationDateFilter>("all");
  const [query,setQuery]=useState("");
  const [debouncedQuery,setDebouncedQuery]=useState("");
  const [selectedTag,setSelectedTag]=useState("");
  const [conversationCounts,setConversationCounts]=useState<ConversationCounts>(EMPTY_CONVERSATION_COUNTS);
  const [nextConversationCursor,setNextConversationCursor]=useState<string|null>(null);
  const [loadingMoreConversations,setLoadingMoreConversations]=useState(false);
  const [loadMoreError,setLoadMoreError]=useState("");
  const [draft,setDraft]=useState("");
  const [replyTo,setReplyTo]=useState<{conversationId:string;message:ChatMessage}|null>(null);
  const [detailsOpen,setDetailsOpen]=useState(true);
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [toast,setToast]=useState("");
  const [markingUnreadId,setMarkingUnreadId]=useState("");
  const [retryingMessageId,setRetryingMessageId]=useState("");
  const [clearingFailedMessages,setClearingFailedMessages]=useState(false);
  const [apiToken,setApiToken]=useState("");
  const [user,setUser]=useState<User|null>(null);
  const [authOpen,setAuthOpen]=useState(false);
  const [sessionReady,setSessionReady]=useState(false);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState("");
  const [newConversationOpen,setNewConversationOpen]=useState(false);
  const [mediaOpen,setMediaOpen]=useState(false);
  const [composerImageBusy,setComposerImageBusy]=useState(false);
  const [composerImageDragging,setComposerImageDragging]=useState(false);
  const [materialLibraryOpen,setMaterialLibraryOpen]=useState(false);
  const [productCardsOpen,setProductCardsOpen]=useState(false);
  const [ttsOpen,setTtsOpen]=useState(false);
  const [emojiOpen,setEmojiOpen]=useState(false);
  const [quickReplyOpen,setQuickReplyOpen]=useState(false);
  const [savedQuickReplies,setSavedQuickReplies]=useState<SavedQuickReply[]>([]);
  const [quickReplyEditor,setQuickReplyEditor]=useState<SavedQuickReply|null|undefined>(undefined);
  const [emojiCategory,setEmojiCategory]=useState("常用");
  const [translationPreferences,setTranslationPreferences]=useState<Record<string,TranslationPreference>>({});
  const [translationConfigured,setTranslationConfigured]=useState(false);
  const [translationReadyConversationId,setTranslationReadyConversationId]=useState("");
  const [translationMenuOpen,setTranslationMenuOpen]=useState(false);
  const [messageTranslations,setMessageTranslations]=useState<Record<string,MessageTranslation>>({});
  const [translationPreview,setTranslationPreview]=useState<{source:string;translated:string;targetLanguage:string}|null>(null);
  const [translatingDraft,setTranslatingDraft]=useState(false);
  const [translationError,setTranslationError]=useState("");
  const [replySuggestionBusy,setReplySuggestionBusy]=useState(false);
  const [conversationMenu,setConversationMenu]=useState<ConversationContextState|null>(null);
  const [contextTags,setContextTags]=useState<TagItem[]>([]);
  const [contextBusy,setContextBusy]=useState(false);
  const [contextContactId,setContextContactId]=useState("");
  const [contextNoteConversation,setContextNoteConversation]=useState<Conversation|null>(null);
  const [contextTaskConversation,setContextTaskConversation]=useState<Conversation|null>(null);
  const [clock,setClock]=useState(()=>Date.now());
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const composerDragDepth=useRef(0);
  const messagesRef=useRef<HTMLDivElement>(null);
  const conversationListRef=useRef<HTMLDivElement>(null);
  const conversationLoadSentinelRef=useRef<HTMLDivElement>(null);
  const conversationAbortRef=useRef<AbortController|null>(null);
  const conversationCursorRef=useRef<string|null>(null);
  const messageCursorsRef=useRef<Record<string,string|null>>({});
  const accountsLoadedForRef=useRef("");
  const conversationLoadKeyRef=useRef("");
  const messageInitialLoadKeyRef=useRef("");
  const messagePaginationDepthRef=useRef(new Map<string,number>());
  const messageStickToBottomRef=useRef(true);
  const translationLoadSequence=useRef(0);
  const previousTranslationTargetLanguageRef=useRef<string|null>(null);
  const workspaceLoadSequence=useRef(0);
  const dateFilterRef=useRef<ConversationDateFilter>("all");
  const notifiedReminders=useRef(new Set<string>());
  const notificationBaseline=useRef<Map<string,{lastMessageAt:string|null;unread:number}>>(new Map());
  const notificationBaselineReady=useRef(false);
  const notificationAudio=useRef<AudioContext|null>(null);
  const lastRealtimeCountsRefresh=useRef(0);

  const userId=user?.id??tokenSubject(apiToken);
  const counts=conversationCounts;
  const visible=conversations;
  const effectiveActiveId=visible.some(item=>item.id===activeId)?activeId:(visible[0]?.id??"");
  const active=visible.find(item=>item.id===effectiveActiveId)??null;
  const translationPreference=active?translationPreferences[active.id]??DEFAULT_TRANSLATION_PREFERENCE:DEFAULT_TRANSLATION_PREFERENCE;
  const translationReady=Boolean(active&&translationReadyConversationId===active.id);
  const currentMessages=useMemo(()=>active?messages[active.id]??[]:[],[active,messages]);
  const failedMessageCount=active?Math.max(failedMessageCounts[active.id]??0,currentMessages.filter(message=>message.direction==="out"&&(message.status==="failed"||message.status==="uncertain")).length):0;
  const selectedReply=replyTo?.conversationId===effectiveActiveId?replyTo.message:null;
  const currentEmailActivities=useMemo(()=>active?emailActivities[active.id]??[]:[],[active,emailActivities]);
  const latestMessageId=currentMessages.at(-1)?.id??"";
  const conversationVirtualizer=useVirtualizer({count:visible.length,getScrollElement:()=>conversationListRef.current,estimateSize:()=>91,overscan:6,getItemKey:index=>visible[index]?.id??index});
  const taskRequest=useCallback((path:string,init?:RequestInit)=>authorizedFetch(path,apiToken,init),[apiToken]);
  const scrollMessagesToEnd=useCallback(()=>{
    window.requestAnimationFrame(()=>{
      const container=messagesRef.current;
      if(container)container.scrollTo({top:container.scrollHeight,behavior:"smooth"});
    });
  },[]);
  const keepMessagesAtEnd=useCallback(()=>{
    if(messageStickToBottomRef.current)scrollMessagesToEnd();
  },[scrollMessagesToEnd]);
  const setMessageCursor=useCallback((conversationId:string,cursor:string|null)=>{
    messageCursorsRef.current={...messageCursorsRef.current,[conversationId]:cursor};
    setMessageCursors(messageCursorsRef.current);
  },[]);

  const playNotificationSound=useCallback(()=>{
    try{
      const AudioContextClass=window.AudioContext;
      const context=notificationAudio.current??new AudioContextClass();
      notificationAudio.current=context;
      if(context.state==="suspended")void context.resume();
      const start=context.currentTime+.01;
      for(const [offset,frequency] of [[0,660],[.13,880]] as const){
        const oscillator=context.createOscillator(),gain=context.createGain();
        oscillator.type="sine";oscillator.frequency.value=frequency;
        gain.gain.setValueAtTime(.0001,start+offset);
        gain.gain.exponentialRampToValueAtTime(.16,start+offset+.015);
        gain.gain.exponentialRampToValueAtTime(.0001,start+offset+.11);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start+offset);oscillator.stop(start+offset+.12);
      }
    }catch{/* Browsers may block sound until the first user interaction. */}
  },[]);

  const notifyIncomingConversation=useCallback((conversation:Conversation)=>{
    playNotificationSound();
    if(!("Notification" in window)||Notification.permission!=="granted")return;
    const notification=new Notification(`RelayDesk · ${conversation.name}`,{
      body:conversation.preview||"收到一条新消息",
      icon:"/favicon.svg",
      tag:`relaydesk-conversation-${conversation.id}`,
    });
    notification.onclick=()=>{
      window.focus();setActiveId(conversation.id);
      if(pathname!==WORKSPACE_PATHS.inbox)router.push(WORKSPACE_PATHS.inbox);
      notification.close();
    };
  },[pathname,playNotificationSound,router]);

  useLayoutEffect(()=>{
    if(!effectiveActiveId)return;
    const container=messagesRef.current;
    if(container){messageStickToBottomRef.current=true;container.scrollTop=container.scrollHeight;}
  },[effectiveActiveId]);

  useEffect(()=>{
    if(latestMessageId&&messageStickToBottomRef.current)scrollMessagesToEnd();
  },[latestMessageId,scrollMessagesToEnd]);

  useEffect(()=>{
    const enableNotifications=()=>{
      try{
        const AudioContextClass=window.AudioContext;
        const context=notificationAudio.current??new AudioContextClass();
        notificationAudio.current=context;
        if(context.state==="suspended")void context.resume();
      }catch{/* Audio notifications remain unavailable in this browser. */}
      if("Notification" in window&&Notification.permission==="default")void Notification.requestPermission();
    };
    window.addEventListener("pointerdown",enableNotifications,{once:true});
    window.addEventListener("keydown",enableNotifications,{once:true});
    return()=>{
      window.removeEventListener("pointerdown",enableNotifications);
      window.removeEventListener("keydown",enableNotifications);
      void notificationAudio.current?.close();
      notificationAudio.current=null;
    };
  },[]);

  useEffect(()=>{
    if(!conversationMenu)return;
    const close=()=>setConversationMenu(null);
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape")close();};
    window.addEventListener("click",close);
    window.addEventListener("resize",close);
    window.addEventListener("scroll",close,true);
    window.addEventListener("keydown",key);
    return()=>{window.removeEventListener("click",close);window.removeEventListener("resize",close);window.removeEventListener("scroll",close,true);window.removeEventListener("keydown",key);};
  },[conversationMenu]);

  const logout=useCallback(()=>{
    void fetch(`${API_URL}/api/v1/auth/logout`,{method:"POST",credentials:"include"}).catch(()=>undefined);
    clearStoredSession();
    conversationDetailsCache.clear();
    conversationAbortRef.current?.abort();conversationCursorRef.current=null;
    accountsLoadedForRef.current="";conversationLoadKeyRef.current="";messageInitialLoadKeyRef.current="";messageCursorsRef.current={};messagePaginationDepthRef.current.clear();messageStickToBottomRef.current=true;
    notificationBaseline.current.clear();notificationBaselineReady.current=false;
    dateFilterRef.current="all";setDateFilter("all");setApiToken("");setUser(null);setAccounts([]);setConversations([]);setConversationCounts(EMPTY_CONVERSATION_COUNTS);setNextConversationCursor(null);setMessages({});setMessageCursors({});setLoadingOlderConversationId("");setOlderMessageErrors({});setFailedMessageCounts({});setEmailActivities({});setMessageTranslations({});setTranslationPreferences({});setTranslationReadyConversationId("");setActiveId("");setSelectedTag("");setContextTags([]);setAuthOpen(false);setSessionReady(true);setLoading(false);
  },[]);

  const loadAccounts=useCallback(async(token:string)=>{
    const result=await authorizedFetch("/api/v1/accounts",token);
    if(result.token!==token)setApiToken(result.token);
    if(result.response.status===401){logout();return;}
    if(!result.response.ok)throw new Error(`账号 API 响应异常（${result.response.status}）`);
    const body=await result.response.json() as {data:Array<Record<string,unknown>>};
    setAccounts(body.data.map(item=>({id:String(item.id),name:String(item.display_name),phone:String(item.phone_e164??""),status:String(item.status),reason:String(item.status_reason??""),platform:item.platform==="messenger"?"messenger":"whatsapp",pageId:item.page_id?String(item.page_id):undefined,transport:String(item.transport??"web") as "web"|"cloud",webhookStatus:item.webhook_status?String(item.webhook_status):undefined,credentialsStatus:item.credentials_status?String(item.credentials_status):undefined,lastEvent:item.last_event_at?String(item.last_event_at):undefined})));
  },[logout]);

  const syncConversationTags=useCallback((tags:TagItem[])=>{
    setContextTags(tags);
    setSelectedTag(current=>current&&tags.every(tag=>tag.id!==current)?"":current);
  },[]);

  const loadConversationTags=useCallback(async(token:string)=>{
    const result=await authorizedFetch("/api/v1/tags",token);
    if(result.token!==token)setApiToken(result.token);
    if(result.response.status===401){logout();return;}
    if(!result.response.ok)return;
    const body=await result.response.json() as {data:Array<Record<string,unknown>>};
    syncConversationTags(body.data.map(mapTag));
  },[logout,syncConversationTags]);

  const loadConversationCounts=useCallback(async(token:string)=>{
    const result=await authorizedFetch(conversationCountsPath(dateFilter,new Date(),selectedAccount),token);
    if(result.token!==token)setApiToken(result.token);
    if(result.response.status===401){logout();return;}
    if(result.response.ok){
      const body=await result.response.json() as ConversationCounts&{dueReminders?:Array<{id:string;display_name:string;remind_at:string}>};
      setConversationCounts(body);
      const due=body.dueReminders?.find(item=>!notifiedReminders.current.has(item.id));
      if(due){notifiedReminders.current.add(due.id);setToast(`${due.display_name} 的任务已到期`);}
    }
  },[dateFilter,selectedAccount,logout]);

  const loadConversations=useCallback(async(token:string,options:{append?:boolean;quiet?:boolean;notify?:boolean}={})=>{
    const append=Boolean(options.append),quiet=Boolean(options.quiet);
    if(append&&!conversationCursorRef.current)return;
    const previousCursor=conversationCursorRef.current;
    const sequence=++workspaceLoadSequence.current;
    if(!append){conversationAbortRef.current?.abort();conversationAbortRef.current=new AbortController();}
    if(append){setLoadingMoreConversations(true);setLoadMoreError("");}else if(!quiet)setLoading(true);
    if(!append)setLoadError("");
    try{
      const path=conversationListPath(dateFilter,new Date(),{filter:conversationFilterKey(filter),accountId:selectedAccount,q:debouncedQuery,tagId:selectedTag,cursor:append?conversationCursorRef.current??undefined:undefined,limit:40});
      const conversationResult=await authorizedFetch(path,token,{signal:!append?conversationAbortRef.current?.signal:undefined});
      if(conversationResult.token!==token)setApiToken(conversationResult.token);
      if(conversationResult.response.status===401){logout();return;}
      if(!conversationResult.response.ok)throw new Error(`会话 API 响应异常（${conversationResult.response.status}）`);
      const conversationBody=await conversationResult.response.json() as {data:Array<Record<string,unknown>>;nextCursor:string|null;total:null};
      if(sequence!==workspaceLoadSequence.current)return;
      const mapped=conversationBody.data.map((item,index)=>mapConversation(item,index));
      if(options.notify&&notificationBaselineReady.current){
        for(const conversation of mapped){
          const previous=notificationBaseline.current.get(conversation.id);
          if(previous&&conversation.lastDirection==="in"&&conversation.lastMessageAt&&conversation.lastMessageAt!==previous.lastMessageAt){
            notifyIncomingConversation(conversation);
          }
        }
      }
      notificationBaseline.current=new Map(mapped.map(item=>[item.id,{lastMessageAt:item.lastMessageAt,unread:item.unread}]));
      notificationBaselineReady.current=true;
      if(!quiet||!previousCursor){conversationCursorRef.current=conversationBody.nextCursor;setNextConversationCursor(conversationBody.nextCursor);}
      setConversations(current=>{
        if(append){const ids=new Set(current.map(item=>item.id));return[...current,...mapped.filter(item=>!ids.has(item.id))];}
        if(!quiet)return mapped;
        const firstIds=new Set(mapped.map(item=>item.id)),merged=[...mapped,...current.filter(item=>!firstIds.has(item.id))];
        return merged.sort((a,b)=>conversationFilterKey(filter)==="reminders"?new Date(a.remindAt??8640000000000000).getTime()-new Date(b.remindAt??8640000000000000).getTime():(new Date(b.lastMessageAt??0).getTime()-new Date(a.lastMessageAt??0).getTime())||b.id.localeCompare(a.id));
      });
      setActiveId(previous=>previous||mapped[0]?.id||"");
    }catch(error){
      if((error as {name?:string}).name==="AbortError")return;
      if(sequence===workspaceLoadSequence.current){const message=error instanceof Error?error.message:"会话数据加载失败";if(append)setLoadMoreError(message);else setLoadError(message);}
    }finally{if(append)setLoadingMoreConversations(false);if(sequence===workspaceLoadSequence.current)setLoading(false);}
  },[dateFilter,filter,selectedAccount,debouncedQuery,selectedTag,logout,notifyIncomingConversation]);

  const loadWorkspace=useCallback(async(token:string,quiet=false)=>{
    if(!quiet)setLoading(true);
    await Promise.allSettled([loadAccounts(token),loadConversationTags(token),loadConversations(token,{quiet,notify:quiet}),loadConversationCounts(token)]);
  },[loadAccounts,loadConversationTags,loadConversations,loadConversationCounts]);

  const selectDateFilter=(next:ConversationDateFilter)=>{
    if(next===dateFilter)return;
    dateFilterRef.current=next;setDateFilter(next);
  };

  const handleDateFilterKeyDown=(event:React.KeyboardEvent<HTMLButtonElement>)=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const tabs=Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')??[]);
    const current=tabs.indexOf(event.currentTarget);
    const target=event.key==="Home"?0:event.key==="End"?tabs.length-1:(current+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
    tabs[target]?.focus();tabs[target]?.click();
  };

  const loadMessages=useCallback(async(token:string,conversationId:string,markRead=false,options:{older?:boolean}={})=>{
    const older=Boolean(options.older),cursor=messageCursorsRef.current[conversationId];
    if(older&&!cursor)return;
    const container=older&&conversationId===effectiveActiveId?messagesRef.current:null;
    const previousScrollHeight=container?.scrollHeight??0,previousScrollTop=container?.scrollTop??0;
    if(older){setLoadingOlderConversationId(conversationId);setOlderMessageErrors(all=>({...all,[conversationId]:""}));messageStickToBottomRef.current=false;}
    try{
      const params=new URLSearchParams({limit:String(MESSAGE_PAGE_SIZE)});
      if(older&&cursor)params.set("cursor",cursor);
      const messageRequest=authorizedFetch(`/api/v1/conversations/${conversationId}/messages?${params}`,token);
      const emailRequest=older?Promise.resolve(null):authorizedFetch(`/api/v1/conversations/${conversationId}/email-activities`,token);
      const [result,emailResult]=await Promise.all([messageRequest,emailRequest]);
      const response=result.response;if(result.token!==token)setApiToken(result.token);
      if(response.status===401){logout();return;}if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.json() as {data:Array<Record<string,unknown>>;nextCursor?:string|null;failedCount?:number};
      const loadedMessages=body.data.map(mapMessage);
      setMessages(all=>{
        const current=all[conversationId]??[];
        if(older){
          const existingIds=new Set(current.map(message=>message.id));
          return{...all,[conversationId]:[...loadedMessages.filter(message=>!existingIds.has(message.id)),...current]};
        }
        const oldestFresh=loadedMessages[0]?.occurredAt;
        const olderExisting=oldestFresh?current.filter(message=>message.occurredAt&&message.occurredAt<oldestFresh):[];
        const freshIds=new Set(loadedMessages.map(message=>message.id));
        return{...all,[conversationId]:[...olderExisting.filter(message=>!freshIds.has(message.id)),...loadedMessages]};
      });
      if(older)messagePaginationDepthRef.current.set(conversationId,(messagePaginationDepthRef.current.get(conversationId)??0)+1);
      if(older||(messagePaginationDepthRef.current.get(conversationId)??0)===0)setMessageCursor(conversationId,body.nextCursor??null);
      setFailedMessageCounts(all=>({...all,[conversationId]:Number(body.failedCount??0)}));
      const cachedTranslations=Object.fromEntries(loadedMessages.filter(message=>message.cachedTranslationText&&message.cachedTranslationSourceLanguage&&message.cachedTranslationLanguage).map(message=>[message.id,{status:"translated" as const,text:message.cachedTranslationText,sourceText:message.cachedTranscriptionText,sourceLanguage:message.cachedTranslationSourceLanguage,targetLanguage:message.cachedTranslationLanguage}]));
      if(Object.keys(cachedTranslations).length)setMessageTranslations(all=>({...cachedTranslations,...all}));
      if(emailResult?.response.ok){const emailBody=await emailResult.response.json() as {data:Array<Record<string,unknown>>};setEmailActivities(all=>({...all,[conversationId]:emailBody.data.map(mapEmailActivity)}));}
      if(markRead)await authorizedFetch(`/api/v1/conversations/${conversationId}`,result.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({read:true})});
      if(older&&container)window.requestAnimationFrame(()=>{container.scrollTop=previousScrollTop+(container.scrollHeight-previousScrollHeight);});
    }catch(reason){
      if(older)setOlderMessageErrors(all=>({...all,[conversationId]:reason instanceof Error?reason.message:"历史消息加载失败"}));
      else setToast("消息加载失败，正在等待下次同步");
    }finally{if(older)setLoadingOlderConversationId(current=>current===conversationId?"":current);}
  },[effectiveActiveId,logout,setMessageCursor]);

  const getConversationEventUrl=useCallback(async()=>{
    const result=await authorizedFetch("/api/v1/events/ticket",apiToken,{method:"POST"});
    if(result.token!==apiToken)setApiToken(result.token);
    if(result.response.status===401){logout();throw new Error("unauthorized");}
    if(!result.response.ok)throw new Error(`event ticket HTTP ${result.response.status}`);
    const body=await result.response.json() as {ticket:string;websocketPath:string};
    const url=new URL(`${API_URL}${body.websocketPath}`,window.location.origin);
    url.protocol=url.protocol==="https:"?"wss:":"ws:";
    url.searchParams.set("ticket",body.ticket);
    return url.toString();
  },[apiToken,logout]);

  const refreshRealtimeCounts=useCallback(async(token:string)=>{
    if(Date.now()-lastRealtimeCountsRefresh.current<5000)return;
    lastRealtimeCountsRefresh.current=Date.now();
    await loadConversationCounts(token);
  },[loadConversationCounts]);

  const applyConversationEvents=useCallback(async(ids:string[])=>{
    const updates=new Map<string,{data?:Record<string,unknown>;matches:boolean}>();
    for(let offset=0;offset<ids.length;offset+=6){
      const chunk=ids.slice(offset,offset+6);
      await Promise.all(chunk.map(async id=>{
        const path=conversationSummaryPath(id,dateFilter,new Date(),{filter:conversationFilterKey(filter),accountId:selectedAccount,q:debouncedQuery,tagId:selectedTag});
        const result=await authorizedFetch(path,apiToken);
        if(result.token!==apiToken)setApiToken(result.token);
        if(result.response.status===401){logout();return;}
        if(result.response.status===404){updates.set(id,{matches:false});return;}
        if(!result.response.ok)return;
        const body=await result.response.json() as {data:Record<string,unknown>;matches:boolean};
        updates.set(id,body);
      }));
    }
    setConversations(current=>{
      const byId=new Map(current.map(item=>[item.id,item]));
      for(const id of ids){
        const update=updates.get(id);
        if(!update)continue;
        if(!update.matches||!update.data){byId.delete(id);notificationBaseline.current.delete(id);continue;}
        const mapped=mapConversation(update.data,Math.max(0,current.findIndex(item=>item.id===id)));
        const baseline=notificationBaseline.current.get(id);
        if(baseline&&mapped.lastDirection==="in"&&mapped.lastMessageAt&&mapped.lastMessageAt!==baseline.lastMessageAt)notifyIncomingConversation(mapped);
        notificationBaseline.current.set(id,{lastMessageAt:mapped.lastMessageAt,unread:mapped.unread});
        byId.set(id,mapped);
      }
      return[...byId.values()].sort((a,b)=>conversationFilterKey(filter)==="reminders"
        ? new Date(a.remindAt??8640000000000000).getTime()-new Date(b.remindAt??8640000000000000).getTime()
        : (new Date(b.lastMessageAt??0).getTime()-new Date(a.lastMessageAt??0).getTime())||b.id.localeCompare(a.id));
    });
    if(ids.includes(effectiveActiveId))await loadMessages(apiToken,effectiveActiveId);
    await refreshRealtimeCounts(apiToken);
  },[apiToken,dateFilter,filter,selectedAccount,debouncedQuery,selectedTag,effectiveActiveId,loadMessages,logout,notifyIncomingConversation,refreshRealtimeCounts]);

  const reconcileConversationFeed=useCallback(async()=>{
    await Promise.all([loadConversations(apiToken,{quiet:true}),loadConversationCounts(apiToken),effectiveActiveId?loadMessages(apiToken,effectiveActiveId):Promise.resolve()]);
  },[apiToken,effectiveActiveId,loadConversations,loadConversationCounts,loadMessages]);

  useConversationFeed({
    enabled:view==="inbox"&&Boolean(apiToken),
    getWebSocketUrl:getConversationEventUrl,
    onConversationIds:applyConversationEvents,
    onReconcile:reconcileConversationFeed,
  });

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

  const loadIncomingTranslations=useCallback(async(token:string,messageIds:string[],targetLanguage:string,sourceLanguage:string,retry=false,generateAudio=false)=>{
    const ids=messageIds.filter(id=>retry||!messageTranslations[id]);if(!ids.length)return;
    setMessageTranslations(all=>({...all,...Object.fromEntries(ids.map(id=>[id,{status:"loading" as const,sourceLanguage,targetLanguage}]))}));
    let accessToken=token;
    for(let offset=0;offset<ids.length;offset+=50){const chunk=ids.slice(offset,offset+50);try{
      const result=await authorizedFetch("/api/v1/translations/messages",accessToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messageIds:chunk,targetLanguage,sourceLanguage,generateAudio})});accessToken=result.token;if(result.token!==token)setApiToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {data?:Array<{messageId:string;status:string;translatedText?:string;sourceText?:string;sourceLanguage?:string;message?:string}>;message?:string};
      if(!result.response.ok||!body.data){setMessageTranslations(all=>({...all,...Object.fromEntries(chunk.map(id=>[id,{status:"failed" as const,sourceLanguage,targetLanguage,message:body.message??"翻译服务暂时不可用"}]))}));continue;}
      setMessageTranslations(all=>({...all,...Object.fromEntries(body.data!.map(item=>[item.messageId,item.status==="translated"?{status:"translated" as const,text:item.translatedText??"",sourceText:item.sourceText,sourceLanguage:item.sourceLanguage??sourceLanguage,targetLanguage}:item.status==="skipped"?{status:"idle" as const,sourceLanguage,targetLanguage}:{status:"failed" as const,sourceLanguage,targetLanguage,message:item.message}]))}));
    }catch{setMessageTranslations(all=>({...all,...Object.fromEntries(chunk.map(id=>[id,{status:"failed" as const,sourceLanguage,targetLanguage}]))}));}}
  },[messageTranslations]);

  useEffect(()=>{
    const timer=window.setTimeout(()=>{
      const persistent=localStorage.getItem(REMEMBER_LOGIN_KEY)==="true";
      const storage=persistent?localStorage:sessionStorage;
      const token=storage.getItem("relayAccessToken")??"";
      const storedUser=storage.getItem("relayUser");
      if(!token){setLoading(false);setSessionReady(true);return;}
      setApiToken(token);if(storedUser)try{setUser(JSON.parse(storedUser) as User);}catch{}
      setAuthOpen(false);setSessionReady(true);
    },0);
    return()=>window.clearTimeout(timer);
  },[]);
  useEffect(()=>{const timer=window.setTimeout(()=>setDebouncedQuery(query.trim()),300);return()=>window.clearTimeout(timer);},[query]);
  useEffect(()=>{
    if(!apiToken)return;
    const subject=tokenSubject(apiToken);
    if(!subject||accountsLoadedForRef.current===subject)return;
    accountsLoadedForRef.current=subject;
    void loadAccounts(apiToken);
  },[apiToken,loadAccounts]);
  useEffect(()=>{
    if(view!=="inbox"||!apiToken)return;
    const key=[tokenSubject(apiToken),view,dateFilter,filter,selectedAccount,debouncedQuery,selectedTag].join("|");
    if(conversationLoadKeyRef.current===key)return;
    conversationLoadKeyRef.current=key;
    conversationCursorRef.current=null;setNextConversationCursor(null);conversationListRef.current?.scrollTo({top:0});
    void Promise.all([loadConversations(apiToken),loadConversationCounts(apiToken)]);
  },[view,apiToken,dateFilter,filter,selectedAccount,debouncedQuery,selectedTag,loadConversations,loadConversationCounts]);
  useEffect(()=>{const timer=window.setTimeout(()=>{if(window.matchMedia("(max-width: 1280px)").matches)setDetailsOpen(false);},0);return()=>window.clearTimeout(timer);},[]);

  useEffect(()=>{
    const root=conversationListRef.current,target=conversationLoadSentinelRef.current;
    if(!root||!target||!nextConversationCursor||loadingMoreConversations)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))void loadConversations(apiToken,{append:true});},{root,rootMargin:"240px"});
    observer.observe(target);return()=>observer.disconnect();
  },[apiToken,nextConversationCursor,loadingMoreConversations,loadConversations]);
  useEffect(()=>{
    if(view!=="inbox"||!apiToken||!effectiveActiveId)return;
    const key=`${tokenSubject(apiToken)}|${effectiveActiveId}`;
    if(messageInitialLoadKeyRef.current===key)return;
    messageInitialLoadKeyRef.current=key;
    const initial=window.setTimeout(()=>void loadMessages(apiToken,effectiveActiveId,true),0);
    return()=>window.clearTimeout(initial);
  },[view,apiToken,effectiveActiveId,loadMessages]);
  useEffect(()=>{if(view!=="inbox"||!apiToken||!effectiveActiveId)return;const timer=window.setTimeout(()=>void loadTranslationSettings(apiToken,effectiveActiveId),0);return()=>window.clearTimeout(timer);},[view,apiToken,effectiveActiveId,loadTranslationSettings]);
  useEffect(()=>{
    if(previousTranslationTargetLanguageRef.current===null){previousTranslationTargetLanguageRef.current=translationPreference.agentLanguage;return;}
    previousTranslationTargetLanguageRef.current=translationPreference.agentLanguage;
    const timer=window.setTimeout(()=>setMessageTranslations(all=>Object.fromEntries(Object.entries(all).filter(([,value])=>value.targetLanguage===translationPreference.agentLanguage))),0);
    return()=>window.clearTimeout(timer);
  },[translationPreference.agentLanguage]);
  useEffect(()=>{
    const accountId=active?.accountId;
    const timer=window.setTimeout(()=>{
      if(!accountId||!userId){setSavedQuickReplies([]);return;}
      try{
        const key=quickReplyStorageKey(userId,accountId),stored=localStorage.getItem(key),items=loadQuickReplyStore(stored);
        setSavedQuickReplies(items);if(!stored||stored.trim().startsWith("["))localStorage.setItem(key,JSON.stringify({version:2,items}));
      }catch{setSavedQuickReplies([]);}
    },0);
    return()=>window.clearTimeout(timer);
  },[active?.accountId,userId]);
  useEffect(()=>{if(!apiToken||!translationPreference.enabled||!translationConfigured)return;const ids=currentMessages.filter(message=>message.direction==="in"&&((message.kind==="text"&&message.text.trim())||(message.kind==="audio"&&message.attachment))&&!messageTranslations[message.id]).map(message=>message.id);if(!ids.length)return;const timer=window.setTimeout(()=>void loadIncomingTranslations(apiToken,ids,translationPreference.agentLanguage,translationPreference.customerLanguage),0);return()=>window.clearTimeout(timer);},[apiToken,currentMessages,translationPreference.enabled,translationPreference.agentLanguage,translationPreference.customerLanguage,translationConfigured,messageTranslations,loadIncomingTranslations]);
  useEffect(()=>{if(!toast)return;const timer=window.setTimeout(()=>setToast(""),3200);return()=>window.clearTimeout(timer);},[toast]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),30_000);return()=>window.clearInterval(timer);},[]);
  async function updateConversation(change:Record<string,unknown>,conversationId=active?.id){
    if(!conversationId||!apiToken)return false;
    const result=await authorizedFetch(`/api/v1/conversations/${conversationId}`,apiToken,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(change)});const response=result.response;if(result.token!==apiToken)setApiToken(result.token);
    if(!response.ok){setToast(`操作失败（HTTP ${response.status}）`);return false;}await Promise.all([loadConversations(result.token),loadConversationCounts(result.token)]);return true;
  }

  function openConversationMenu(event:React.MouseEvent,item:Conversation){
    event.preventDefault();event.stopPropagation();setActiveId(item.id);
    const width=244,height=390,padding=10;
    setConversationMenu({conversation:item,x:Math.max(padding,Math.min(event.clientX,window.innerWidth-width-padding)),y:Math.max(padding,Math.min(event.clientY,window.innerHeight-height-padding)),section:"root"});
  }

  async function openContextTags(){
    if(!conversationMenu)return;
    setConversationMenu(value=>value?{...value,section:"tags"}:value);
    if(contextTags.length)return;
    setContextBusy(true);
    try{
      const result=await authorizedFetch("/api/v1/tags",apiToken);if(result.token!==apiToken)setApiToken(result.token);
      if(!result.response.ok)throw new Error();
      const body=await result.response.json() as {data:Array<Record<string,unknown>>};setContextTags(body.data.map(mapTag));
    }catch{setToast("标签加载失败，请重试");}
    finally{setContextBusy(false);}
  }

  async function setContextStage(customerStage:string){
    if(!conversationMenu||contextBusy)return;setContextBusy(true);
    const item=conversationMenu.conversation,ok=await updateConversation({customerStage},item.id);
    if(ok){setToast(`已将 ${item.name} 的客户阶段改为“${stageName(customerStage)}”`);setConversationMenu(null);}
    setContextBusy(false);
  }

  async function toggleContextTag(tag:TagItem){
    if(!conversationMenu||contextBusy)return;
    const item=conversationMenu.conversation,hasTag=item.tags.some(value=>value.id===tag.id);
    const tagIds=hasTag?item.tags.filter(value=>value.id!==tag.id).map(value=>value.id):[...item.tags.map(value=>value.id),tag.id];
    setContextBusy(true);
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${item.id}/tags`,apiToken,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({tagIds})});if(result.token!==apiToken)setApiToken(result.token);
      if(!result.response.ok)throw new Error();
      const body=await result.response.json() as {data:Array<Record<string,unknown>>},tags=body.data.map(mapTag);
      setConversations(all=>all.map(value=>value.id===item.id?{...value,tags}:value));
      setConversationMenu(value=>value?{...value,conversation:{...value.conversation,tags}}:value);
      setToast(hasTag?`已移除标签“${tag.name}”`:`已添加标签“${tag.name}”`);
    }catch{setToast("标签修改失败，请重试");}
    finally{setContextBusy(false);}
  }

  async function setContextConversationStatus(){
    if(!conversationMenu||contextBusy)return;
    const item=conversationMenu.conversation,next=item.conversationStatus==="closed"?"open":"closed";
    if(next==="closed"&&!await confirmAction(`关闭与“${item.name}”的会话？之后仍可从“已关闭”中重新打开。`,{title:"关闭会话",confirmLabel:"关闭会话",tone:"warning"}))return;
    setContextBusy(true);
    const ok=await updateConversation({status:next},item.id);
    if(ok){setToast(next==="closed"?"会话已关闭":"会话已重新打开");setConversationMenu(null);}
    setContextBusy(false);
  }

  async function markConversationUnread(conversationId:string){
    if(!apiToken||markingUnreadId)return;
    setMarkingUnreadId(conversationId);
    setConversations(all=>all.map(item=>item.id===conversationId?{...item,unread:Math.max(item.unread,1)}:item));
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${conversationId}`,apiToken,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({unread:true})});
      if(result.token!==apiToken)setApiToken(result.token);
      if(!result.response.ok)throw new Error(`HTTP ${result.response.status}`);
      const updated=await result.response.json() as {unread_count?:number};
      setConversations(all=>all.map(item=>item.id===conversationId?{...item,unread:Number(updated.unread_count??1)}:item));
      setToast("已标记为未读");
    }catch{
      setConversations(all=>all.map(item=>item.id===conversationId?{...item,unread:0}:item));
      setToast("标记未读失败，请重试");
    }finally{setMarkingUnreadId("");}
  }

  async function saveTranslationPreference(next:TranslationPreference){
    if(!apiToken||!active)return;if(next.enabled&&!translationConfigured){setToast("管理员尚未启用 AI 翻译 Provider");return;}
    const conversationId=active.id,previous=translationPreferences[conversationId]??DEFAULT_TRANSLATION_PREFERENCE;setTranslationPreferences(all=>({...all,[conversationId]:next}));
    const result=await authorizedFetch("/api/v1/me/translation-preferences",apiToken,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({conversationId,enabled:next.enabled,agentLanguage:next.agentLanguage,customerLanguage:next.customerLanguage})});if(result.token!==apiToken)setApiToken(result.token);
    if(!result.response.ok){setTranslationPreferences(all=>({...all,[conversationId]:previous}));const body=await result.response.json().catch(()=>({})) as {message?:string};setToast(body.message??"该会话的翻译偏好保存失败");return;}
    const body=await result.response.json() as TranslationPreference;setTranslationPreferences(all=>({...all,[conversationId]:body}));
  }

  async function generateReplySuggestion(){
    if(!active||!apiToken||replySuggestionBusy)return;
    setReplySuggestionBusy(true);
    setTranslationPreview(null);
    setTranslationError("");
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${active.id}/reply-suggestion`,apiToken,{method:"POST"});
      if(result.token!==apiToken)setApiToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {reply?:string;sources?:Array<{id:string;source:string}>;error?:string};
      if(!result.response.ok||!body.reply)throw new Error(body.error??"回复建议生成失败");
      setDraft(body.reply);
      setQuickReplyOpen(false);
      setTranslationMenuOpen(false);
      setToast(body.sources?.length?`回复建议已生成，参考了 ${body.sources.length} 条知识库内容`:"回复建议已根据聊天记录生成");
      requestAnimationFrame(()=>textareaRef.current?.focus());
    }catch(reason){
      const message=reason instanceof Error?reason.message:"回复建议生成失败";
      setToast(message==="agent_provider_not_configured"?"请先在系统设置中配置 AI Provider":message==="conversation_has_no_messages"?"当前会话还没有可分析的聊天记录":"回复建议生成失败，请稍后重试");
    }finally{setReplySuggestionBusy(false);}
  }

  async function sendMessage(){
    if(!active||!apiToken||!draft.trim()||translatingDraft||composerImageBusy)return;
    const source=draft.trim();
    if(translationPreference.enabled){
      if(!translationConfigured){setToast("AI 翻译暂不可用，请联系管理员配置 Provider");return;}
      setTranslatingDraft(true);setTranslationError("");
      try{const targetLanguage=translationPreference.customerLanguage,result=await authorizedFetch("/api/v1/translations/preview",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:source,targetLanguage})});if(result.token!==apiToken)setApiToken(result.token);const body=await result.response.json().catch(()=>({})) as {translatedText?:string;message?:string};if(!result.response.ok||!body.translatedText)throw new Error(body.message??"翻译失败");setTranslationPreview({source,translated:body.translatedText,targetLanguage});}catch(reason){setTranslationError(reason instanceof Error?reason.message:"翻译失败");setToast("AI 翻译失败，原文未发送");}finally{setTranslatingDraft(false);}return;
    }
    await queueTextMessage(source);
  }

  async function queueTextMessage(
    text: string,
    translationSourceText?: string,
    translationTargetLanguage?: string,
  ) {
    if (!active || !apiToken || !text.trim()) return;
    const clientMessageId = crypto.randomUUID(),
      quoted = selectedReply ? messageQuote(selectedReply) : undefined;
    setDraft("");
    setReplyTo(null);
    setTranslationPreview(null);
    setTranslationError("");
    setMessages((all) => ({
      ...all,
      [active.id]: [
        ...(all[active.id] ?? []),
        {
          id: clientMessageId,
          direction: "out",
          kind: "text",
          text,
          translationSourceText,
          translationTargetLanguage,
          quoted,
          time: formatTime(new Date()),
          status: "queued",
        },
      ],
    }));
    const result = await authorizedFetch("/api/v1/messages", apiToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: active.accountId,
        conversationId: active.id,
        clientMessageId,
        type: "text",
        text,
        ...(translationSourceText ? { translationSourceText } : {}),
        ...(translationTargetLanguage ? { translationTargetLanguage } : {}),
        ...(quoted ? { quotedMessageId: quoted.id } : {}),
      }),
    });
    const response = result.response;
    if (result.token !== apiToken) setApiToken(result.token);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setToast(
        body.error === "agent_upgrade_required"
          ? "请先升级 Windows Agent 后再使用指定回复"
          : `消息入队失败（HTTP ${response.status}）`,
      );
      setMessages((all) => ({
        ...all,
        [active.id]: (all[active.id] ?? []).map((item) =>
          item.id === clientMessageId ? { ...item, status: "failed" } : item,
        ),
      }));
      return;
    }
    setToast(
      active.accountStatus === "online"
        ? "消息已进入发送队列"
        : "账号离线，消息已持久化排队",
    );
    void loadMessages(apiToken, active.id);
  }

  async function retryMessage(message: ChatMessage) {
    if (!active || !apiToken || retryingMessageId) return;
    if (
      message.status === "uncertain" &&
      !(await confirmAction(
        "这条消息可能已经送达。重新发送可能让客户收到重复消息。",
        {
          title: "仍要重新发送吗？",
          confirmLabel: "重新发送",
          tone: "warning",
        },
      ))
    )
      return;
    setRetryingMessageId(message.id);
    try {
      const clientMessageId = crypto.randomUUID();
      let result = await authorizedFetch(
        `/api/v1/messages/${message.id}/retry`,
        apiToken,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId }),
        },
      );
      if (result.token !== apiToken) setApiToken(result.token);
      let body = (await result.response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (result.response.status === 404 && message.kind !== "template") {
        result = await authorizedFetch("/api/v1/messages", result.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: active.accountId,
            conversationId: active.id,
            clientMessageId,
            type: message.kind,
            text: message.text || undefined,
            translationSourceText: message.translationSourceText,
            translationTargetLanguage: message.translationTargetLanguage,
            mediaId: message.attachment?.id,
            quotedMessageId: message.quoted?.id,
          }),
        });
        if (result.token !== apiToken) setApiToken(result.token);
        body = (await result.response.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
      }
      if (!result.response.ok)
        throw new Error(
          body.message ??
            (
              {
                message_not_retryable: "消息状态已更新，当前不能重新发送",
                original_command_not_found: "找不到原发送记录",
              } as Record<string, string>
            )[body.error ?? ""] ??
            `重新发送失败（HTTP ${result.response.status}）`,
        );
      setToast("消息已重新进入发送队列");
      await loadMessages(result.token, active.id);
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "重新发送失败");
    } finally {
      setRetryingMessageId("");
    }
  }

  async function clearFailedMessages() {
    if (!active || !apiToken || !failedMessageCount || clearingFailedMessages)
      return;
    if (
      !(await confirmAction(
        `将清除与“${active.name}”会话中的 ${failedMessageCount} 条发送失败或待确认消息。\n\n这只会删除失败记录，不会撤回可能已经送达的 WhatsApp 消息。`,
        { title: "清除失败消息？", confirmLabel: "清除记录" },
      ))
    )
      return;
    setClearingFailedMessages(true);
    try {
      const conversationId = active.id;
      const result = await authorizedFetch(
        `/api/v1/conversations/${conversationId}/messages/failed`,
        apiToken,
        { method: "DELETE" },
      );
      if (result.token !== apiToken) setApiToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as {
        deletedCount?: number;
        message?: string;
      };
      if (!result.response.ok)
        throw new Error(
          body.message ?? `清除失败（HTTP ${result.response.status}）`,
        );
      setMessages((all) => ({
        ...all,
        [conversationId]: (all[conversationId] ?? []).filter(
          (message) =>
            message.direction !== "out" ||
            (message.status !== "failed" && message.status !== "uncertain"),
        ),
      }));
      setFailedMessageCounts((all) => ({ ...all, [conversationId]: 0 }));
      setToast(
        `已清除 ${Math.max(Number(body.deletedCount ?? 0), failedMessageCount)} 条失败消息`,
      );
      await Promise.all([
        loadMessages(result.token, conversationId),
        loadWorkspace(result.token, true),
      ]);
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "清除失败消息失败");
    } finally {
      setClearingFailedMessages(false);
    }
  }

  async function sendMediaAsset(asset:MediaAsset,caption:string,throwOnFailure=false,includeReply=true){
    if(!active||!apiToken)return;
    if(active.platform==="messenger"&&caption.trim()){const message="Messenger 媒体首版不支持 caption，请先单独发送文字";setToast(message);if(throwOnFailure)throw new Error(message);return;}
    const kind=mediaKind(asset.mimeType),clientMessageId=crypto.randomUUID(),quoted=includeReply&&selectedReply?messageQuote(selectedReply):undefined;setDraft("");setReplyTo(null);
    setMessages(all=>({...all,[active.id]:[...(all[active.id]??[]),{id:clientMessageId,direction:"out",kind,text:caption,quoted,platform:active.platform,pageId:active.pageId??undefined,time:formatTime(new Date()),status:"queued",attachment:{id:asset.id,name:asset.fileName,mime:asset.mimeType,size:formatBytes(asset.size)}}]}));
    const queued=await authorizedFetch("/api/v1/messages",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:active.accountId,conversationId:active.id,clientMessageId,type:kind,text:caption||undefined,mediaId:asset.id,...(quoted?{quotedMessageId:quoted.id}:{})})});if(queued.token!==apiToken)setApiToken(queued.token);
    if(!queued.response.ok){const body=await queued.response.json().catch(()=>({})) as {error?:string};const message=body.error==="agent_upgrade_required"?"请先升级 Windows Agent 后再使用指定回复":`附件消息入队失败（HTTP ${queued.response.status}）`;setToast(message);setMessages(all=>({...all,[active.id]:(all[active.id]??[]).map(item=>item.id===clientMessageId?{...item,status:"failed"}:item)}));if(throwOnFailure)throw new Error(message);return;}
    setMediaOpen(false);setMaterialLibraryOpen(false);setToast(active.accountStatus==="online"?"附件已进入发送队列":"账号离线，附件已持久化排队");void loadMessages(queued.token,active.id);
  }

  async function uploadComposerImages(files:FileList|File[]){
    if(!active||!apiToken||composerImageBusy)return;
    const images=Array.from(files).filter(file=>file.type.startsWith("image/"));
    if(!images.length){setToast("消息框仅支持粘贴或拖拽图片");return;}
    const unsupported=images.find(file=>!["image/jpeg","image/png","image/webp"].includes(file.type));
    if(unsupported){setToast(`${unsupported.name} 格式不受支持，请使用 JPG、PNG 或 WebP`);return;}
    const oversized=images.find(file=>file.size>64*1024*1024);
    if(oversized){setToast(`${oversized.name} 超过 64 MB，无法发送`);return;}
    const caption=draft.trim();
    setComposerImageBusy(true);setComposerImageDragging(false);
    try{
      for(const [index,file] of images.entries()){
        const form=new FormData();form.append("file",file);
        const result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(active.accountId)}`,apiToken,{method:"POST",body:form});
        if(result.token!==apiToken)setApiToken(result.token);
        const body=await result.response.json().catch(()=>({})) as {mediaId?:string;fileName?:string;mimeType?:string;size?:number;sha256?:string;message?:string};
        if(!result.response.ok||!body.mediaId)throw new Error(body.message??`${file.name} 上传失败（HTTP ${result.response.status}）`);
        await sendMediaAsset({id:body.mediaId,fileName:body.fileName??file.name,mimeType:body.mimeType??file.type,size:body.size??file.size,sha256:body.sha256??"",createdAt:new Date().toISOString(),usageCount:0},index===0?caption:"",true,index===0);
      }
      setToast(images.length>1?`${images.length} 张图片已进入发送队列`:"图片已进入发送队列");
    }catch(reason){setToast(reason instanceof Error?reason.message:"图片上传失败");}
    finally{setComposerImageBusy(false);}
  }

  function handleComposerDragEnter(event:DragEvent<HTMLDivElement>){
    if(!Array.from(event.dataTransfer.items).some(item=>item.kind==="file"))return;
    event.preventDefault();composerDragDepth.current+=1;setComposerImageDragging(true);
  }

  function handleComposerDragLeave(event:DragEvent<HTMLDivElement>){
    event.preventDefault();composerDragDepth.current=Math.max(0,composerDragDepth.current-1);
    if(composerDragDepth.current===0)setComposerImageDragging(false);
  }

  function handleComposerDrop(event:DragEvent<HTMLDivElement>){
    event.preventDefault();composerDragDepth.current=0;setComposerImageDragging(false);
    void uploadComposerImages(event.dataTransfer.files);
  }

  async function sendQuickReplyMedia(asset:MediaAsset,captionOverride?:string){
    let caption=asset.mimeType.startsWith("audio/")?"":(captionOverride??draft).trim();
    if(caption&&translationPreference.enabled){
      if(!translationConfigured){setToast("AI 翻译暂不可用，请联系管理员配置 Provider");return;}
      setTranslatingDraft(true);setTranslationError("");
      try{
        const result=await authorizedFetch("/api/v1/translations/preview",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:caption,targetLanguage:translationPreference.customerLanguage})});
        if(result.token!==apiToken)setApiToken(result.token);
        const body=await result.response.json().catch(()=>({})) as {translatedText?:string;message?:string};
        if(!result.response.ok||!body.translatedText)throw new Error(body.message??"翻译失败");
        caption=body.translatedText;
      }catch(reason){setTranslationError(reason instanceof Error?reason.message:"翻译失败");setToast("AI 翻译失败，快捷回复未发送");return;}
      finally{setTranslatingDraft(false);}
    }
    setQuickReplyOpen(false);await sendMediaAsset(asset,caption);
  }

  function addMessageToQuickReplies(message:ChatMessage){
    if(!active||!userId)return;
    const text=message.text.trim(),attachment=message.attachment?{id:message.attachment.id,fileName:message.attachment.name,mimeType:message.attachment.mime,size:parseFormattedBytes(message.attachment.size),sha256:"",createdAt:message.occurredAt??new Date().toISOString(),usageCount:1}:undefined;
    const reply:SavedQuickReply={id:crypto.randomUUID(),sourceMessageId:message.id,title:(text||attachment?.fileName||kindText(message.kind)).slice(0,40),text,tags:`${kindText(message.kind)} ${active.name}`,kind:message.kind,createdAt:new Date().toISOString(),attachment};
    const next=[reply,...savedQuickReplies.filter(item=>item.sourceMessageId!==message.id)];persistQuickReplies(next);
    setToast("已加入快捷回复，可在输入区搜索使用");
  }

  function persistQuickReplies(next:SavedQuickReply[]){
    if(!active||!userId)return;localStorage.setItem(quickReplyStorageKey(userId,active.accountId),JSON.stringify({version:2,items:next}));setSavedQuickReplies(next);
  }

  function saveQuickReply(item:SavedQuickReply){
    const next=savedQuickReplies.some(value=>value.id===item.id)?savedQuickReplies.map(value=>value.id===item.id?item:value):[item,...savedQuickReplies];
    persistQuickReplies(next);setQuickReplyEditor(undefined);setToast(savedQuickReplies.some(value=>value.id===item.id)?"快捷回复已更新":"快捷回复已新增");
  }

  async function deleteQuickReply(item:SavedQuickReply){
    if(!await confirmAction(`快捷回复“${item.title}”将从当前设备中删除。`,{title:"删除快捷回复？",confirmLabel:"删除"}))return;persistQuickReplies(savedQuickReplies.filter(value=>value.id!==item.id));setToast("快捷回复已删除");
  }

  async function retryEmail(emailId:string){if(!active)return;const result=await authorizedFetch(`/api/v1/email-sends/${emailId}/retry`,apiToken,{method:"POST"});if(result.token!==apiToken)setApiToken(result.token);setToast(result.response.ok?"失败邮件已重新进入队列":`邮件重试失败（HTTP ${result.response.status}）`);if(result.response.ok)await loadMessages(result.token,active.id);}

  function insertEmoji(emoji:string){const input=textareaRef.current,start=input?.selectionStart??draft.length,end=input?.selectionEnd??start;setDraft(`${draft.slice(0,start)}${emoji}${draft.slice(end)}`);requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(start+emoji.length,start+emoji.length);});}
  const handleQuickReplyOpen=useCallback((value:boolean)=>{setQuickReplyOpen(value);if(value){setEmojiOpen(false);setTranslationMenuOpen(false);}},[]);

  const onlineCount=accounts.filter(item=>item.status==="online").length;
  const cloudWindowClosed=Boolean(active?.transport==="cloud"&&(!active.replyWindowExpiresAt||new Date(active.replyWindowExpiresAt).getTime()<=clock));
  const profileText=(user?.displayName||user?.email||"坐席").slice(0,1).toUpperCase();
  const userRole=user?.role||tokenRole(apiToken);
  useEffect(()=>{setWorkspaceView(routeView);},[routeView]);
  const navigate=(nextView:WorkspaceView)=>{
    if(nextView===view)return;
    setWorkspaceView(nextView);
    router.push(WORKSPACE_PATHS[nextView]);
  };
  const openInbox=(nextFilter="全部会话")=>{navigate("inbox");setFilter(nextFilter);};
  const completeLogin=(token:string,nextUser:User,rememberMe:boolean)=>{conversationDetailsCache.clear();accountsLoadedForRef.current="";conversationLoadKeyRef.current="";messageInitialLoadKeyRef.current="";storeSession(token,nextUser,rememberMe);setApiToken(token);setUser(nextUser);setAuthOpen(false);setSessionReady(true);};

  if(!sessionReady)return <AccessPortal loading onLogin={()=>{}}/>;
  if(!apiToken)return <><AccessPortal loading={false} onLogin={()=>setAuthOpen(true)}/>{authOpen&&<LoginDialog connected={false} token="" canClose onClose={()=>setAuthOpen(false)} onLogin={completeLogin} onLogout={logout}/>}</>;

  return (
    <main className="relay-shell">
      <ConfirmationHost />
      <PromptHost />
      {toast && (
        <div className="toast">
          <Check size={15} />
          {toast}
        </div>
      )}
      <nav className="rail" aria-label="全局导航">
        <button
          className="brand-mark"
          onClick={() => openInbox()}
          aria-label="RelayDesk 消息中心"
        >
          <Sparkles size={19} />
        </button>
        <div className="rail-nav">
          <button
            className={
              view === "inbox" && filter === "全部会话"
                ? "rail-button active"
                : "rail-button"
            }
            onClick={() => openInbox()}
            aria-label="消息中心"
            title="消息中心"
          >
            <MessageCircle size={18} />
          </button>
          <button
            className={
              view === "contacts" ? "rail-button active" : "rail-button"
            }
            onClick={() => navigate("contacts")}
            aria-label="联系人管理"
            title="联系人管理"
          >
            <Users size={18} />
          </button>
          <button
            className={view === "tasks" ? "rail-button active" : "rail-button"}
            onClick={() => navigate("tasks")}
            aria-label="任务中心"
            title="任务中心"
          >
            <ClipboardList size={18} />
          </button>
          <button
            className={view === "statuses" ? "rail-button active" : "rail-button"}
            onClick={() => navigate("statuses")}
            aria-label="动态发布"
            title="动态发布"
          >
            <Eye size={18} />
          </button>
          <button
            className={view === "orders" ? "rail-button active" : "rail-button"}
            onClick={() => navigate("orders")}
            aria-label="订单管理"
            title="订单管理"
          >
            <ReceiptText size={18} />
          </button>
          <button
            className={
              view === "products" ? "rail-button active" : "rail-button"
            }
            onClick={() => navigate("products")}
            aria-label="产品库"
            title="产品库"
          >
            <ShoppingBag size={18} />
          </button>
          <button
            className={view === "agents" ? "rail-button active" : "rail-button"}
            onClick={() => navigate("agents")}
            aria-label="Agent 管理"
            title="Agent 管理"
          >
            <MonitorSmartphone size={18} />
          </button>
          <button
            className="rail-button"
            onClick={() => {
              openInbox();
              window.setTimeout(() => {
                const composer =
                  document.querySelector<HTMLTextAreaElement>(
                    ".composer textarea",
                  );
                if (composer) composer.focus();
                else setToast("请先选择一个真实会话");
              }, 0);
            }}
            aria-label="发送消息"
            title="发送消息"
          >
            <Send size={18} />
          </button>
          <button
            className={
              view === "inbox" && filter === "收藏"
                ? "rail-button active"
                : "rail-button"
            }
            onClick={() => openInbox("收藏")}
            aria-label="收藏会话"
            title="收藏会话"
          >
            <Star size={18} />
          </button>
          <button
            className={
              view === "inbox" && filter === "已关闭"
                ? "rail-button active"
                : "rail-button"
            }
            onClick={() => openInbox("已关闭")}
            aria-label="已关闭会话"
            title="已关闭会话"
          >
            <Clock3 size={18} />
          </button>
          <button
            className={
              view === "inbox" && filter === "已归档"
                ? "rail-button active"
                : "rail-button"
            }
            onClick={() => openInbox("已归档")}
            aria-label="已归档会话"
            title="已归档会话"
          >
            <Archive size={18} />
          </button>
        </div>
        <div className="rail-bottom">
          <button
            className={view === "help" ? "rail-button active" : "rail-button"}
            onClick={() => navigate("help")}
            aria-label="帮助"
            title="帮助"
          >
            <CircleHelp size={18} />
          </button>
          <button
            className={
              view === "settings" ? "rail-button active" : "rail-button"
            }
            onClick={() => navigate("settings")}
            aria-label="系统设置"
            title="系统设置"
          >
            <Settings size={18} />
          </button>
          <button
            className="profile-button"
            onClick={() => setAuthOpen(true)}
            aria-label="账户"
          >
            <span className="avatar small coral">{profileText}</span>
          </button>
        </div>
      </nav>

      {view === "inbox" ? (
        <>
          <aside className={`filters ${sidebarOpen ? "mobile-open" : ""}`}>
            <div className="mobile-filter-head">
              <b>收件箱</b>
              <button
                onClick={() => setSidebarOpen(false)}
                aria-label="关闭筛选"
              >
                <X size={18} />
              </button>
            </div>
            <div className="workspace-title">
              <div>
                <span className="eyebrow">工作空间</span>
                <h1>消息中心</h1>
              </div>
              <button
                onClick={() => setNewConversationOpen(true)}
                aria-label="新建会话"
                title="新建会话"
              >
                <Plus size={16} />
              </button>
            </div>
            <label className="account-switcher">
              <span className="wa-dot">
                <Phone size={13} />
              </span>
              <span>
                <b>渠道账号</b>
                <small>
                  {onlineCount} 在线 · {accounts.length - onlineCount} 离线
                </small>
              </span>
              <ChevronDown size={15} />
              <select
                aria-label="筛选渠道账号"
                value={selectedAccount}
                onChange={(event) => setSelectedAccount(event.target.value)}
              >
                <option value="">全部账号</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.platform==="messenger"?"Facebook":"WhatsApp"} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <section>
              <p className="section-label">收件箱</p>
              {[
                { label: "全部会话", icon: Inbox, count: counts.all },
                { label: "分配给我", icon: Users, count: counts.mine },
                { label: "未分配", icon: UserPlus, count: counts.unassigned },
                { label: "我的提醒", icon: Bell, count: counts.reminders },
                { label: "收藏", icon: Star, count: counts.favorite },
                { label: "已关闭", icon: Check, count: counts.closed },
                { label: "已归档", icon: Archive, count: counts.archived },
              ].map(({ label, icon: Icon, count }) => (
                <button
                  key={label}
                  onClick={() => {
                    setFilter(label);
                    setSidebarOpen(false);
                  }}
                  className={
                    filter === label ? "filter-row selected" : "filter-row"
                  }
                >
                  <span>
                    <Icon size={15} />
                    {label}
                  </span>
                  <em>{count}</em>
                </button>
              ))}
            </section>
            <section className="accounts-block">
              <p className="section-label">账号连接</p>
              {accounts.length ? (
                accounts.map((account, index) => (
                  <AccountStatus
                    key={account.id}
                    initials={account.name.slice(0, 2).toUpperCase()}
                    color={["green", "blue", "gray"][index % 3]}
                    name={`${account.name} · ${account.transport === "cloud" ? "Cloud API" : "Web"}`}
                    detail={
                      account.status === "online"
                        ? "已连接"
                        : account.reason || statusText(account.status)
                    }
                    online={account.status === "online"}
                  />
                ))
              ) : (
                <p className="empty-note">暂无已绑定账号</p>
              )}
            </section>
          </aside>

          <ConversationPanel filter={filter} subtitle={debouncedQuery||selectedTag?`已加载 ${visible.length} 条结果`:`${counts[conversationFilterKey(filter)]} 个真实会话`} query={query} onQuery={setQuery} tags={contextTags} tagId={selectedTag} onTagId={setSelectedTag} onTagOpen={()=>void loadConversationTags(apiToken)} onOpenSidebar={()=>setSidebarOpen(true)} onRefresh={()=>void loadWorkspace(apiToken)} dateFilter={dateFilter} onDateFilter={selectDateFilter} onDateKeyDown={handleDateFilterKeyDown} listRef={conversationListRef} sentinelRef={conversationLoadSentinelRef} items={visible} rows={conversationVirtualizer.getVirtualItems()} totalSize={conversationVirtualizer.getTotalSize()} measure={conversationVirtualizer.measureElement} effectiveActiveId={effectiveActiveId} clock={clock} markingUnreadId={markingUnreadId} onSelect={setActiveId} onMenu={openConversationMenu} onMarkUnread={id=>void markConversationUnread(id)} loading={loading} loadError={loadError} hasAccounts={Boolean(accounts.length)} loadingMore={loadingMoreConversations} loadMoreError={loadMoreError} hasMore={Boolean(nextConversationCursor)} onLoadMore={()=>void loadConversations(apiToken,{append:true})}/>

          <section className="chat-panel">
            {active ? (
              <>
                <header className="chat-head">
                  <div className="chat-person">
                    <span
                      className="avatar"
                      style={{ background: active.color }}
                    >
                      {active.initials}
                    </span>
                    <span>
                      <b>{active.name}</b>
                      <small>
                        <i
                          className={`status-dot ${active.accountStatus === "online" ? "online" : ""}`}
                        />
                        <span className={`channel-badge ${active.platform}`}>{active.platform==="messenger"?<Facebook size={10}/>:<MessageCircle size={10}/>} {active.platform==="messenger"?"Facebook":"WhatsApp"}</span>{" · "}
                        {active.account} ·{" "}
                        {active.platform==="messenger"?"Page":active.transport === "cloud" ? "Cloud API" : "Web"} ·{" "}
                        {statusText(active.accountStatus)}
                      </small>
                    </span>
                  </div>
                  <div className="chat-actions">
                    {failedMessageCount > 0 && (
                      <button
                        onClick={() => void clearFailedMessages()}
                        className="clear-failed-messages-button"
                        disabled={
                          clearingFailedMessages || Boolean(retryingMessageId)
                        }
                        title="清除当前会话中的失败和待确认消息"
                      >
                        <Trash2 size={14} />
                        <span>
                          {clearingFailedMessages
                            ? "清除中…"
                            : `清除失败消息 (${failedMessageCount})`}
                        </span>
                      </button>
                    )}
                    <button
                      onClick={() =>
                        void updateConversation({
                          assignedToMe: active.assignedUserId !== userId,
                        })
                      }
                      className="assign-button"
                    >
                      <UserPlus size={15} />
                      {active.assignedUserId === userId
                        ? "取消认领"
                        : active.assignedUserId
                          ? "转为我负责"
                          : "认领"}
                    </button>
                    <button
                      onClick={() =>
                        void updateConversation({ favorite: !active.favorite })
                      }
                      className="icon-button"
                      aria-label="收藏"
                    >
                      <Bookmark
                        size={17}
                        fill={active.favorite ? "currentColor" : "none"}
                      />
                    </button>
                    <button
                      onClick={() => setDetailsOpen(!detailsOpen)}
                      className="icon-button"
                      aria-label="联系人详情"
                    >
                      <Info size={17} />
                    </button>
                  </div>
                </header>
                <AgentConversationBar
                  conversationId={active.id}
                  token={apiToken}
                  refreshKey={latestMessageId}
                  onToken={setApiToken}
                  onToast={setToast}
                  onUseDraft={setDraft}
                  onSent={() => void loadMessages(apiToken, active.id)}
                />
                {active.accountStatus !== "online" && (
                  <div className="offline-banner">
                    <WifiOff size={15} />
                    <span>该账号当前离线；发送请求仍会进入持久队列。</span>
                  </div>
                )}
                {currentEmailActivities.length > 0 && (
                  <div className="email-activity-stream" aria-label="邮件活动">
                    {currentEmailActivities.map((item) => (
                      <article key={item.id} className="email-activity-card">
                        <header>
                          <span>
                            <Mail size={14} />
                            <b>{item.subject}</b>
                          </span>
                          <em className={item.status}>
                            {emailStatusText(item.status)}
                          </em>
                        </header>
                        <p>
                          {item.recipients
                            .map((recipient) => recipient.email)
                            .join(", ")}
                        </p>
                        <footer>
                          <span>
                            {emailContentTypeText(item.contentType)} ·{" "}
                            {item.attachmentCount} 个附件 ·{" "}
                            {item.senderName || "已离职坐席"}
                          </span>
                          <time>{formatDateTime(item.createdAt)}</time>
                        </footer>
                        {item.lastError && <small>{item.lastError}</small>}
                        {item.status === "failed" && (
                          <button onClick={() => void retryEmail(item.id)}>
                            <RefreshCw size={11} />
                            重新发送
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
                <div
                  ref={messagesRef}
                  className="messages"
                  aria-live="polite"
                  onScroll={(event)=>{
                    const element=event.currentTarget;
                    messageStickToBottomRef.current=element.scrollHeight-element.scrollTop-element.clientHeight<120;
                  }}
                >
                  {messageCursors[active.id]&&(
                    <div className="message-history-loader">
                      <button
                        type="button"
                        disabled={loadingOlderConversationId===active.id}
                        onClick={()=>void loadMessages(apiToken,active.id,false,{older:true})}
                      >
                        <RefreshCw className={loadingOlderConversationId===active.id?"spin":""} size={13}/>
                        {loadingOlderConversationId===active.id?"正在加载更早消息…":"加载更早消息"}
                      </button>
                      {olderMessageErrors[active.id]&&<small>{olderMessageErrors[active.id]}</small>}
                    </div>
                  )}
                  <div className="day-separator">
                    <span>真实消息记录</span>
                  </div>
                  {currentMessages.length ? (
                    currentMessages.map((message) => (
                      <article
                        key={message.id}
                        className={`message-row ${message.direction}`}
                      >
                        {message.direction === "in" && (
                          <span
                            className="avatar message-avatar"
                            style={{ background: active.color }}
                          >
                            {active.initials}
                          </span>
                        )}
                        <div
                          className={`message-bubble ${message.attachment?.name.startsWith("sticker-") ? "sticker-bubble" : ""}`}
                        >
                          <div className="message-actions">
                            <button
                              className="message-reply-action"
                              disabled={cloudWindowClosed}
                              onClick={() => {
                                setReplyTo({
                                  conversationId: active.id,
                                  message,
                                });
                                requestAnimationFrame(() =>
                                  textareaRef.current?.focus(),
                                );
                              }}
                              aria-label="回复这条消息"
                              title="回复"
                            >
                              <Reply size={14} />
                            </button>
                            <button
                              className="message-save-quick-reply"
                              onClick={() => addMessageToQuickReplies(message)}
                              aria-label="加入快捷回复"
                              title="加入快捷回复"
                            >
                              <Bookmark size={14} />
                              <Plus size={9} />
                            </button>
                          </div>
                          {message.quoted && (
                            <QuotedMessage
                              quote={message.quoted}
                              customerName={active.name}
                            />
                          )}{" "}
                          {message.text && <p>{message.text}</p>}
                          {message.failureMessage && (
                            <small className="message-failure">
                              <Info size={11} />
                              {message.failureMessage}
                            </small>
                          )}
                          {message.direction === "out" &&
                            (message.status === "queued" ||
                              message.status === "dispatching") && (
                              <QueueDiagnostic message={message} />
                            )}{" "}
                          {message.direction === "out" &&
                            message.translationSourceText && (
                              <div className="outgoing-translation-source">
                                <span>
                                  <Languages size={12} />
                                  原文（仅坐席可见）→{" "}
                                  {detectedLanguageName(
                                    message.translationTargetLanguage ??
                                      translationPreference.customerLanguage,
                                  )}
                                </span>
                                <p>{message.translationSourceText}</p>
                              </div>
                            )}
                          {translationPreference.enabled &&
                            message.direction === "in" &&
                            message.kind === "text" &&
                            message.text && (
                              <IncomingTranslation
                                value={messageTranslations[message.id]}
                                language={translationPreference.agentLanguage}
                                defaultSourceLanguage={translationPreference.customerLanguage}
                                onTranslate={sourceLanguage =>
                                  void loadIncomingTranslations(
                                    apiToken,
                                    [message.id],
                                    translationPreference.agentLanguage,
                                    sourceLanguage,
                                    true,
                                  )
                                }
                              />
                            )}{" "}
                          {message.attachment && (
                            <MessageMedia
                              attachment={message.attachment}
                              token={apiToken}
                              onToken={setApiToken}
                              onReady={keepMessagesAtEnd}
                            />
                          )}{" "}
                          {translationPreference.enabled &&
                            message.direction === "in" &&
                            message.kind === "audio" && (
                              <VoiceTranslation
                                value={messageTranslations[message.id]}
                                language={translationPreference.agentLanguage}
                                defaultSourceLanguage={translationPreference.customerLanguage}
                                configured={translationConfigured}
                                onTranslate={sourceLanguage =>
                                  void loadIncomingTranslations(
                                    apiToken,
                                    [message.id],
                                    translationPreference.agentLanguage,
                                    sourceLanguage,
                                    true,
                                    true,
                                  )
                                }
                              />
                            )}
                          <footer>
                            <span className={`channel-badge message-channel ${active.platform}`}>{active.platform==="messenger"?<Facebook size={9}/>:<MessageCircle size={9}/>} {active.platform==="messenger"?`Facebook · ${active.account}`:`WhatsApp · ${active.account}`}</span>
                            <time dateTime={message.occurredAt} title={message.occurredAt?formatMessageTimeTitle(message.occurredAt):undefined}>{message.time}</time>
                            {message.direction === "out" && (
                              <MessageStatus status={message.status} />
                            )}
                          </footer>
                          {message.direction === "out" &&
                            (message.status === "failed" ||
                              message.status === "uncertain") && (
                              <div className="message-retry-row">
                                <button
                                  className="message-retry-action"
                                  disabled={Boolean(retryingMessageId)}
                                  onClick={() => void retryMessage(message)}
                                  aria-label="重新发送这条消息"
                                  title={
                                    message.status === "uncertain"
                                      ? "重新发送（消息可能已经送达）"
                                      : "重新发送"
                                  }
                                >
                                  <RefreshCw
                                    className={
                                      retryingMessageId === message.id
                                        ? "spin"
                                        : ""
                                    }
                                    size={13}
                                  />
                                  <span>
                                    {retryingMessageId === message.id
                                      ? "重新发送中…"
                                      : "重新发送"}
                                  </span>
                                </button>
                              </div>
                            )}
                        </div>
                      </article>
                    ))
                  ) : (
                    <EmptyState
                      title="暂无消息"
                      text="收到或发送的消息将显示在这里"
                    />
                  )}
                </div>
                <div className="composer-wrap">
                  <div className="composer-tools">
                    <div className="composer-tool-actions">
                      <QuickReplyDropdown
                        open={quickReplyOpen}
                        disabled={cloudWindowClosed || translatingDraft}
                        translationEnabled={translationPreference.enabled}
                        savedReplies={savedQuickReplies}
                        onOpenChange={handleQuickReplyOpen}
                        onAdd={() => {
                          setQuickReplyOpen(false);
                          setQuickReplyEditor(null);
                        }}
                        onEdit={(item) => {
                          setQuickReplyOpen(false);
                          setQuickReplyEditor(item);
                        }}
                        onDelete={deleteQuickReply}
                        onText={(text) => {
                          setDraft(text);
                          setQuickReplyOpen(false);
                          requestAnimationFrame(() =>
                            textareaRef.current?.focus(),
                          );
                        }}
                        onMedia={(asset, caption) =>
                          void sendQuickReplyMedia(asset, caption)
                        }
                      />
                      <button
                        className="reply-suggestion-trigger"
                        disabled={replySuggestionBusy||translatingDraft}
                        onClick={()=>void generateReplySuggestion()}
                        aria-label="生成推进成交的回复建议"
                        title="结合知识库和聊天记录生成回复建议"
                      >
                        <Sparkles className={replySuggestionBusy?"spin":""} size={15}/>
                        <span>{replySuggestionBusy?"生成中…":"回复建议 Agent"}</span>
                      </button>
                      <button
                        onClick={() => setMediaOpen(true)}
                        aria-label="打开媒体与附件"
                        title="媒体与附件"
                      >
                        <Paperclip size={17} />
                      </button>
                      <button
                        className="material-library-trigger"
                        onClick={() => setMaterialLibraryOpen(true)}
                        aria-label="打开素材库"
                        title="从素材库发送图片"
                      >
                        <LayoutGrid size={15} />
                        <span>素材库</span>
                      </button>
                      <button
                        onClick={() => setProductCardsOpen(true)}
                        aria-label="发送产品卡片"
                        title="发送产品卡片"
                      >
                        <ShoppingBag size={17} />
                      </button>
                      <button
                        className={`translation-trigger ${translationPreference.enabled ? "active" : ""}`}
                        onClick={() => {
                          setQuickReplyOpen(false);
                          setTranslationMenuOpen((value) => !value);
                        }}
                        aria-expanded={translationMenuOpen}
                        aria-label="AI 翻译设置"
                      >
                        <Languages size={15} />
                        <span>
                          {translationPreference.enabled
                            ? `${languageName(translationPreference.agentLanguage)} → ${languageName(translationPreference.customerLanguage)}`
                            : "AI 翻译"}
                        </span>
                      </button>
                    </div>
                    <span>回复给 {active.name}</span>
                  </div>
                  {translationMenuOpen && (
                    <TranslationMenu
                      preference={translationPreference}
                      configured={translationConfigured}
                      ready={translationReady}
                      onChange={(next) => void saveTranslationPreference(next)}
                      onClose={() => setTranslationMenuOpen(false)}
                    />
                  )}
                  {emojiOpen && (
                    <EmojiPicker
                      category={emojiCategory}
                      onCategory={setEmojiCategory}
                      onSelect={insertEmoji}
                      onClose={() => setEmojiOpen(false)}
                    />
                  )}
                  {selectedReply && !cloudWindowClosed && (
                    <div className="composer-reply-preview">
                      <Reply size={14} />
                      <QuotedMessage
                        quote={messageQuote(selectedReply)}
                        customerName={active.name}
                      />
                      <button
                        onClick={() => setReplyTo(null)}
                        aria-label="取消回复"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {cloudWindowClosed&&active.platform==="whatsapp" ? (
                    <TemplateComposer
                      accountId={active.accountId}
                      conversationId={active.id}
                      token={apiToken}
                      onToken={setApiToken}
                      onSent={() => {
                        setToast("模板消息已进入发送队列");
                        void loadMessages(apiToken, active.id);
                      }}
                    />
                  ) : cloudWindowClosed ? (
                    <div className="messenger-window-closed"><Clock3 size={15}/><span>Facebook Messenger 24 小时回复窗口已关闭</span></div>
                  ) : (
                    <div
                      className={`composer ${composerImageDragging ? "image-dragging" : ""} ${composerImageBusy ? "image-uploading" : ""}`}
                      onDragEnter={handleComposerDragEnter}
                      onDragOver={(event) => {
                        if (
                          Array.from(event.dataTransfer.items).some(
                            (item) => item.kind === "file",
                          )
                        )
                          event.preventDefault();
                      }}
                      onDragLeave={handleComposerDragLeave}
                      onDrop={handleComposerDrop}
                    >
                      {(composerImageDragging || composerImageBusy) && (
                        <div className="composer-image-drop-hint">
                          <UploadCloud size={18} />
                          <span>
                            {composerImageBusy
                              ? "正在上传并发送图片…"
                              : "松开即可发送图片"}
                          </span>
                        </div>
                      )}
                      <textarea
                        ref={textareaRef}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onPaste={(event) => {
                          const hasImage = Array.from(
                            event.clipboardData.items,
                          ).some(
                            (item) =>
                              item.kind === "file" &&
                              item.type.startsWith("image/"),
                          );
                          if (!hasImage) return;
                          event.preventDefault();
                          void clipboardFiles(event.nativeEvent, {
                            imagesOnly: true,
                          }).then((files) => uploadComposerImages(files));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void sendMessage();
                          }
                          if (event.key === "Escape") {
                            if (selectedReply) setReplyTo(null);
                            else {
                              setEmojiOpen(false);
                              setTranslationMenuOpen(false);
                            }
                          }
                        }}
                        placeholder="输入消息；可粘贴或拖入图片发送"
                      />
                      <div className="composer-icons">
                        <button
                          className={emojiOpen ? "active" : ""}
                          onClick={() => setEmojiOpen((value) => !value)}
                          aria-label="选择表情"
                          title="选择表情"
                        >
                          <Smile size={18} />
                        </button>
                        <button
                          onClick={() => setTtsOpen(true)}
                          aria-label="AI 文字转语音"
                          title="AI 文字转语音"
                        >
                          <Mic size={18} />
                        </button>
                        <button
                          onClick={() => void sendMessage()}
                          className="send-button"
                          aria-label={
                            translationPreference.enabled
                              ? "翻译并预览"
                              : "发送"
                          }
                          disabled={translatingDraft || composerImageBusy}
                        >
                          {translatingDraft || composerImageBusy ? (
                            <RefreshCw className="spin" size={18} />
                          ) : (
                            <Send size={18} />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                  {translationError && (
                    <p className="composer-error">{translationError}</p>
                  )}
                  <p className="delivery-hint">
                    {cloudWindowClosed ? (
                      <>
                        <Clock3 size={13} />
                        {active.platform==="messenger"?"Messenger 回复窗口已关闭":"已超出 24 小时窗口，只能发送已审核模板"}
                      </>
                    ) : active.accountStatus === "online" ? (
                      <>
                        <Wifi size={13} />
                        {active.platform==="messenger"
                          ? "Facebook Page 在线"
                          : active.transport === "cloud"
                            ? "Cloud API 在线"
                          : "Agent 在线"}
                      </>
                    ) : (
                      <>
                        <Clock3 size={13} />
                        离线队列已启用
                      </>
                    )}
                  </p>
                </div>
              </>
            ) : (
              <div className="chat-empty">
                <MessageCircle size={31} />
                <h2>选择一个真实会话</h2>
                <p>这里不会再显示演示联系人或模拟消息。</p>
              </div>
            )}
          </section>

          {detailsOpen && active && (
            <CrmDetailsPanel
              key={active.id}
              active={active}
              token={apiToken}
              user={user}
              role={userRole}
              translationPreference={translationPreference}
              onToken={setApiToken}
              onClose={() => setDetailsOpen(false)}
              onToast={setToast}
              onTagCatalogChange={syncConversationTags}
              onConversationChange={async (change) => {
                await updateConversation(change);
              }}
              onChanged={async () => {
                await Promise.all([
                  loadWorkspace(apiToken, true),
                  loadMessages(apiToken, active.id),
                ]);
              }}
              onDeleted={async () => {
                setDetailsOpen(false);
                setActiveId("");
                setMessages((all) => {
                  const next = { ...all };
                  delete next[active.id];
                  return next;
                });
                await loadWorkspace(apiToken, true);
              }}
            />
          )}
        </>
      ) : view === "contacts" ? (
        <ContactManagement
          token={apiToken}
          role={userRole}
          accounts={accounts}
          onToken={setApiToken}
          onToast={setToast}
          onConversation={(conversationId) => {
            const found = conversations.find(
              (item) => item.id === conversationId,
            );
            if (!found) {
              setToast("该会话不在当前列表，请在消息中心搜索联系人");
              openInbox();
              return;
            }
            setActiveId(conversationId);
            setDetailsOpen(true);
            openInbox();
          }}
        />
      ) : view === "tasks" ? (
        <TaskCenter
          token={apiToken}
          accounts={accounts}
          request={taskRequest}
          onToken={setApiToken}
          onToast={setToast}
        />
      ) : view === "statuses" ? (
        <StatusCenter
          accounts={accounts.filter(account=>account.platform==="whatsapp")}
          role={userRole}
          request={taskRequest}
          onToken={setApiToken}
          onToast={setToast}
        />
      ) : view === "orders" ? (
        <OrderManagement
          token={apiToken}
          accounts={accounts}
          onToken={setApiToken}
          onToast={setToast}
          onConversation={(conversationId) => {
            const found = conversations.find(
              (item) => item.id === conversationId,
            );
            if (!found) {
              setToast("该会话不在当前列表，请在消息中心搜索客户");
              openInbox();
              return;
            }
            setActiveId(conversationId);
            setDetailsOpen(true);
            openInbox();
          }}
        />
      ) : view === "products" ? (
        <ProductWorkspace
          token={apiToken}
          role={userRole}
          onToken={setApiToken}
          onToast={setToast}
          products={() => (
            <ProductManagement
              token={apiToken}
              role={userRole}
              onToken={setApiToken}
              onToast={setToast}
            />
          )}
        />
      ) : view === "agents" ? (
        <AgentManagement
          token={apiToken}
          role={userRole}
          onToken={setApiToken}
          onToast={setToast}
        />
      ) : view === "settings" ? (
        <SettingsPanel
          token={apiToken}
          role={userRole}
          accounts={accounts}
          onToken={setApiToken}
          onToast={setToast}
        />
      ) : (
        <HelpPanel
          onInbox={() => openInbox()}
          onAgents={() => navigate("agents")}
        />
      )}

      {authOpen && (
        <LoginDialog
          connected={Boolean(apiToken)}
          token={apiToken}
          canClose={Boolean(apiToken)}
          onClose={() => setAuthOpen(false)}
          onLogin={completeLogin}
          onLogout={logout}
        />
      )}
      {newConversationOpen && (
        <NewConversationDialog
          accounts={accounts.filter(account=>account.platform==="whatsapp")}
          token={apiToken}
          onToken={setApiToken}
          onClose={() => setNewConversationOpen(false)}
          onCreated={async (conversationId, accountId, accessToken) => {
            setNewConversationOpen(false);
            navigate("inbox");
            setFilter("全部会话");
            dateFilterRef.current = "all";
            setDateFilter("all");
            setSelectedAccount(accountId);
            await loadWorkspace(accessToken, true);
            setActiveId(conversationId);
            setToast("新会话已创建，首条消息已进入发送队列");
          }}
        />
      )}
      {mediaOpen && active && (
        <MediaDialog
          accountId={active.accountId}
          token={apiToken}
          initialCaption={draft}
          onToken={setApiToken}
          onToast={setToast}
          onClose={() => setMediaOpen(false)}
          onSend={sendMediaAsset}
        />
      )}
      {materialLibraryOpen && active && (
        <MaterialLibrarySendDialog
          accountId={active.accountId}
          conversationId={active.id}
          customerName={active.name}
          initialCaption={draft}
          translationEnabled={translationPreference.enabled}
          translationConfigured={translationConfigured}
          targetLanguage={translationPreference.customerLanguage}
          targetLanguageName={languageName(
            translationPreference.customerLanguage,
          )}
          request={taskRequest}
          onToken={setApiToken}
          onClose={() => setMaterialLibraryOpen(false)}
          onSent={(message) => {
            setDraft("");
            setToast(message);
            void loadMessages(apiToken, active.id);
          }}
        />
      )}
      {productCardsOpen && active && (
        <ProductCardSendDialog
          accountId={active.accountId}
          conversationId={active.id}
          contactId={active.contactId}
          translationEnabled={translationPreference.enabled}
          translationConfigured={translationConfigured}
          targetLanguage={translationPreference.customerLanguage}
          targetLanguageName={languageName(
            translationPreference.customerLanguage,
          )}
          request={(path, init) => authorizedFetch(path, apiToken, init)}
          onToken={setApiToken}
          onClose={() => setProductCardsOpen(false)}
          onSent={(text) => {
            setToast(text);
            void loadMessages(apiToken, active.id);
          }}
        />
      )}
      {ttsOpen && active && (
        <TextToSpeechDialog
          accountId={active.accountId}
          token={apiToken}
          initialText={draft}
          translationEnabled={translationPreference.enabled}
          translationConfigured={translationConfigured}
          targetLanguage={translationPreference.customerLanguage}
          onToken={setApiToken}
          onClose={() => setTtsOpen(false)}
          onSend={async (asset) => {
            setTtsOpen(false);
            await sendMediaAsset(asset, "");
          }}
        />
      )}
      {quickReplyEditor !== undefined && active && (
        <QuickReplyEditorDialog
          accountId={active.accountId}
          token={apiToken}
          item={quickReplyEditor}
          onToken={setApiToken}
          onClose={() => setQuickReplyEditor(undefined)}
          onSave={saveQuickReply}
        />
      )}
      {translationPreview && (
        <TranslationPreviewDialog
          source={translationPreview.source}
          translated={translationPreview.translated}
          targetLanguage={translationPreview.targetLanguage}
          onClose={() => setTranslationPreview(null)}
          onConfirm={(text) =>
            void queueTextMessage(
              text,
              translationPreview.source,
              translationPreview.targetLanguage,
            )
          }
        />
      )}
      {conversationMenu && (
        <ConversationContextMenu
          state={conversationMenu}
          tags={contextTags}
          busy={contextBusy}
          onSection={(section) =>
            setConversationMenu((value) =>
              value ? { ...value, section } : value,
            )
          }
          onTags={() => void openContextTags()}
          onStage={(value) => void setContextStage(value)}
          onToggleTag={(tag) => void toggleContextTag(tag)}
          onNote={() => {
            setContextNoteConversation(conversationMenu.conversation);
            setConversationMenu(null);
          }}
          onStatus={() => void setContextConversationStatus()}
          onEdit={() => {
            setContextContactId(conversationMenu.conversation.contactId);
            setConversationMenu(null);
          }}
          onTask={() => {
            setContextTaskConversation(conversationMenu.conversation);
            setConversationMenu(null);
          }}
        />
      )}
      {contextContactId && (
        <ContactEditDialog
          contactId={contextContactId}
          token={apiToken}
          onToken={setApiToken}
          onClose={() => setContextContactId("")}
          onSaved={async () => {
            setContextContactId("");
            setToast("联系人资料已更新");
            await loadWorkspace(apiToken, true);
          }}
        />
      )}
      {contextNoteConversation && (
        <ConversationNoteDialog
          conversation={contextNoteConversation}
          token={apiToken}
          onToken={setApiToken}
          onClose={() => setContextNoteConversation(null)}
          onSaved={async () => {
            setContextNoteConversation(null);
            setToast("共享备注已添加");
            await loadWorkspace(apiToken, true);
          }}
        />
      )}
      {contextTaskConversation && (
        <ConversationQuickTaskDialog
          conversation={contextTaskConversation}
          token={apiToken}
          assignedUserId={user?.id ?? null}
          onToken={setApiToken}
          onClose={() => setContextTaskConversation(null)}
          onSaved={() => {
            setContextTaskConversation(null);
            setToast("任务已创建并关联到该客户");
          }}
        />
      )}
    </main>
  );
}

const CUSTOMER_STAGES=[
  ["new","新线索"],["considering","待考量"],["qualified","合格"],["won","已成交"],["lost","已流失"],
] as const;

function stageName(value:string){return CUSTOMER_STAGES.find(item=>item[0]===value)?.[1]??"新线索";}

function ConversationContextMenu({state,tags,busy,onSection,onTags,onStage,onToggleTag,onNote,onStatus,onEdit,onTask}:{state:ConversationContextState;tags:TagItem[];busy:boolean;onSection:(section:ConversationContextState["section"])=>void;onTags:()=>void;onStage:(value:string)=>void;onToggleTag:(tag:TagItem)=>void;onNote:()=>void;onStatus:()=>void;onEdit:()=>void;onTask:()=>void}){
  const item=state.conversation;
  return <div className="conversation-context-menu" style={{left:state.x,top:state.y}} role="menu" aria-label={`${item.name} 的快捷操作`} onClick={event=>event.stopPropagation()}>
    <header><span className="avatar small" style={{background:item.color}}>{item.initials}</span><span><b>{item.name}</b><small>{item.phone||item.account}</small></span></header>
    {state.section==="root"?<div className="conversation-context-actions">
      <button role="menuitem" onClick={()=>onSection("stage")}><Zap size={15}/><span><b>修改客户阶段</b><small>{stageName(item.customerStage)}</small></span><em>›</em></button>
      <button role="menuitem" onClick={onTags}><Tag size={15}/><span><b>修改标签</b><small>{item.tags.length?item.tags.map(tag=>tag.name).join("、"):"暂无标签"}</small></span><em>›</em></button>
      <button role="menuitem" onClick={onNote}><FileText size={15}/><span><b>添加备注</b><small>团队共享备注</small></span></button>
      <button role="menuitem" onClick={onEdit}><Pencil size={15}/><span><b>编辑资料</b><small>名称、邮箱及联系方式</small></span></button>
      <button role="menuitem" onClick={onTask}><ClipboardList size={15}/><span><b>添加任务</b><small>关联当前客户和会话</small></span></button>
      <i/>
      <button role="menuitem" className={item.conversationStatus==="closed"?"reopen":""} disabled={busy} onClick={onStatus}><CheckCheck size={15}/><span><b>{item.conversationStatus==="closed"?"重新打开会话":"关闭会话"}</b><small>{item.conversationStatus==="closed"?"恢复到全部会话":"移入已关闭会话"}</small></span></button>
    </div>:state.section==="stage"?<div className="conversation-context-submenu"><button className="context-back" onClick={()=>onSection("root")}>‹ 返回快捷操作</button><h4>客户阶段</h4>{CUSTOMER_STAGES.map(([value,label])=><button key={value} disabled={busy} className={item.customerStage===value?"selected":""} onClick={()=>onStage(value)}><span>{label}</span>{item.customerStage===value&&<Check size={14}/>}</button>)}</div>:<div className="conversation-context-submenu tags"><button className="context-back" onClick={()=>onSection("root")}>‹ 返回快捷操作</button><h4>标签 <small>{item.tags.length}/20</small></h4>{busy&&!tags.length?<p>正在读取标签…</p>:tags.length?tags.map(tag=><button key={tag.id} disabled={busy||!item.tags.some(value=>value.id===tag.id)&&item.tags.length>=20} className={item.tags.some(value=>value.id===tag.id)?"selected":""} onClick={()=>onToggleTag(tag)}><i style={{background:tag.color}}/><span>{tag.name}</span>{item.tags.some(value=>value.id===tag.id)&&<Check size={14}/>}</button>):<p>暂时没有可用标签</p>}</div>}
  </div>;
}

function ConversationNoteDialog({conversation,token,onToken,onClose,onSaved}:{conversation:Conversation;token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [body,setBody]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function save(){if(!body.trim()||busy)return;setBusy(true);setError("");const result=await authorizedFetch(`/api/v1/conversations/${conversation.id}/notes`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:body.trim()})});if(result.token!==token)onToken(result.token);if(!result.response.ok){setError(`备注保存失败（HTTP ${result.response.status}）`);setBusy(false);return;}await onSaved();}
  return <div className="modal-backdrop context-action-backdrop" role="presentation"><section className="login-dialog context-action-dialog" role="dialog" aria-modal="true" aria-labelledby="context-note-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><FileText size={19}/></span><h2 id="context-note-title">给 {conversation.name} 添加备注</h2><p>备注将对团队成员共享，并显示在联系人详情中。</p><label>备注内容<textarea autoFocus value={body} onChange={event=>setBody(event.target.value)} maxLength={5000} placeholder="记录客户需求、跟进情况或注意事项"/><small>{body.length}/5000</small></label>{error&&<span className="login-error">{error}</span>}<footer><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={busy||!body.trim()}>{busy?"正在保存…":"添加备注"}</button></footer></section></div>;
}

function ConversationQuickTaskDialog({conversation,token,assignedUserId,onToken,onClose,onSaved}:{conversation:Conversation;token:string;assignedUserId:string|null;onToken:(token:string)=>void;onClose:()=>void;onSaved:()=>void}){
  const [title,setTitle]=useState(""),[kind,setKind]=useState<"general"|"message">("general"),[dueAt,setDueAt]=useState(()=>toDateTimeLocal(new Date(Date.now()+86400000).toISOString())),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function save(){const due=new Date(dueAt),now=new Date();if(!title.trim()||Number.isNaN(due.getTime())||due<=now){setError("请填写任务标题，并选择未来的截止时间");return;}setBusy(true);setError("");const result=await authorizedFetch("/api/v1/tasks",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:conversation.accountId,contactId:conversation.contactId,conversationId:conversation.id,assignedUserId,kind,title:title.trim(),description:"",status:"planned",progress:0,startAt:now.toISOString(),dueAt:due.toISOString(),sendAt:kind==="message"?due.toISOString():null,sendMode:"approval",recurrence:null,personaOverride:null,toolOverrides:null,dependencyIds:[]})});if(result.token!==token)onToken(result.token);if(!result.response.ok){const response=await result.response.json().catch(()=>({})) as {message?:string};setError(response.message??`任务创建失败（HTTP ${result.response.status}）`);setBusy(false);return;}onSaved();}
  return <div className="modal-backdrop context-action-backdrop" role="presentation"><section className="login-dialog context-action-dialog" role="dialog" aria-modal="true" aria-labelledby="context-task-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><ClipboardList size={19}/></span><h2 id="context-task-title">给 {conversation.name} 添加任务</h2><p>任务会自动关联当前客户与会话，并默认分配给你。</p><label>任务标题<input autoFocus value={title} onChange={event=>setTitle(event.target.value)} maxLength={200} placeholder="例如：跟进报价反馈"/></label><div className="context-task-grid"><label>任务类型<select value={kind} onChange={event=>setKind(event.target.value as "general"|"message")}><option value="general">普通待办</option><option value="message">定时消息</option></select></label><label>{kind==="message"?"计划发送时间":"截止时间"}<input type="datetime-local" value={dueAt} min={toDateTimeLocal(new Date().toISOString())} onChange={event=>setDueAt(event.target.value)}/></label></div>{kind==="message"&&<small className="context-task-hint">定时消息将进入审批模式，可在任务中心补充内容并生成草稿。</small>}{error&&<span className="login-error">{error}</span>}<footer><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={busy||!title.trim()}>{busy?"正在创建…":"创建任务"}</button></footer></section></div>;
}

function ContactTaskDialog({task,token,onToken,onClose,onSaved}:{task:ContactTaskSummary;token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:(message:string)=>void}){
  const [detail,setDetail]=useState<ContactTaskDetail|null>(null),[title,setTitle]=useState(task.title),[description,setDescription]=useState(""),[status,setStatus]=useState(task.status),[progress,setProgress]=useState(0),[startAt,setStartAt]=useState(""),[dueAt,setDueAt]=useState(toDateTimeLocal(task.dueAt)),[sendAt,setSendAt]=useState(task.sendAt?toDateTimeLocal(task.sendAt):""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{
    let cancelled=false;
    void authorizedFetch(`/api/v1/tasks/${task.id}`,token).then(async result=>{
      if(result.token!==token)onToken(result.token);
      if(!result.response.ok)throw new Error(`任务加载失败（HTTP ${result.response.status}）`);
      const item=await result.response.json() as Record<string,unknown>;
      if(cancelled)return;
      const next:ContactTaskDetail={id:String(item.id),title:String(item.title??""),description:String(item.description??""),kind:item.kind==="message"?"message":"general",status:String(item.status??"planned"),progress:Number(item.progress??0),startAt:String(item.start_at),dueAt:String(item.due_at),sendAt:item.send_at?String(item.send_at):null,sendMode:item.send_mode==="auto"?"auto":"approval",assignedUserName:item.assigned_user_name?String(item.assigned_user_name):null,accountName:String(item.account_name??""),source:String(item.source??"manual")};
      setDetail(next);setTitle(next.title);setDescription(next.description);setStatus(next.status);setProgress(next.progress);setStartAt(toDateTimeLocal(next.startAt));setDueAt(toDateTimeLocal(next.dueAt));setSendAt(next.sendAt?toDateTimeLocal(next.sendAt):"");
    }).catch(reason=>{if(!cancelled)setError(reason instanceof Error?reason.message:"任务加载失败");}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[task.id,token,onToken]);
  async function save(){
    const start=new Date(startAt),due=new Date(dueAt),send=sendAt?new Date(sendAt):null;
    if(!title.trim()){setError("请输入任务标题");return;}
    if(Number.isNaN(start.getTime())||Number.isNaN(due.getTime())||due<start){setError("截止时间不能早于开始时间");return;}
    if(detail?.kind==="message"&&(!send||Number.isNaN(send.getTime()))){setError("请选择计划发送时间");return;}
    setBusy(true);setError("");
    try{
      const result=await authorizedFetch(`/api/v1/tasks/${task.id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({title:title.trim(),description:description.trim(),status,progress,startAt:start.toISOString(),dueAt:due.toISOString(),sendAt:detail?.kind==="message"?send!.toISOString():null})});
      if(result.token!==token)onToken(result.token);
      if(!result.response.ok){const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};throw new Error(body.message??body.error??`任务保存失败（HTTP ${result.response.status}）`);}
      onSaved("任务已更新");
    }catch(reason){setError(reason instanceof Error?reason.message:"任务保存失败");setBusy(false);}
  }
  async function remove(){
    if(!await confirmAction(`删除任务“${task.title}”？删除后将不再出现在联系人任务和“我的提醒”中。`,{title:"删除任务？",confirmLabel:"删除"}))return;
    setBusy(true);setError("");
    try{
      const result=await authorizedFetch(`/api/v1/tasks/${task.id}`,token,{method:"DELETE"});
      if(result.token!==token)onToken(result.token);
      if(!result.response.ok){const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};throw new Error(body.message??body.error??`任务删除失败（HTTP ${result.response.status}）`);}
      onSaved("任务已删除");
    }catch(reason){setError(reason instanceof Error?reason.message:"任务删除失败");setBusy(false);}
  }
  return <div className="modal-backdrop contact-task-modal-backdrop" role="presentation">
    <section className="contact-task-modal" role="dialog" aria-modal="true" aria-labelledby="contact-task-modal-title">
      <header><div><span className={`contact-task-icon ${task.kind}`} aria-hidden="true">{task.kind==="message"?<Send size={15}/>:<ClipboardList size={15}/>}</span><span><small>{task.kind==="message"?"定时消息任务":"普通任务"}</small><h2 id="contact-task-modal-title">查看与编辑任务</h2></span></div><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button></header>
      {loading?<div className="contact-task-modal-loading"><RefreshCw className="spin" size={18}/>正在加载任务…</div>:<div className="contact-task-modal-body">
        {detail&&<div className="contact-task-meta"><span>账号：{detail.accountName||"—"}</span><span>负责人：{detail.assignedUserName||"未分配"}</span><span>来源：{{manual:"手工",birthday:"生日",special_date:"特殊日期",holiday:"节日",agent:"Agent",recurring:"周期"}[detail.source]??detail.source}</span></div>}
        <label>任务标题<input autoFocus value={title} onChange={event=>setTitle(event.target.value)} maxLength={200}/></label>
        <label>任务描述<textarea value={description} onChange={event=>setDescription(event.target.value)} maxLength={10000} placeholder="补充任务目标、背景或执行说明"/></label>
        <div className="contact-task-modal-grid"><label>状态<select value={status} onChange={event=>{const next=event.target.value;setStatus(next);if(next==="completed")setProgress(100);}}>{Object.entries(CONTACT_TASK_STATUS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>完成进度<span className="contact-task-progress-input"><input type="range" min="0" max="100" step="5" value={progress} onChange={event=>setProgress(Number(event.target.value))}/><b>{progress}%</b></span></label></div>
        <div className="contact-task-modal-grid"><label>开始时间<input type="datetime-local" value={startAt} onChange={event=>setStartAt(event.target.value)}/></label><label>截止时间<input type="datetime-local" value={dueAt} onChange={event=>setDueAt(event.target.value)}/></label></div>
        {detail?.kind==="message"&&<label>计划发送时间<input type="datetime-local" value={sendAt} onChange={event=>setSendAt(event.target.value)}/><small>发送模式：{detail.sendMode==="auto"?"自动发送":"审批后发送"}</small></label>}
        {error&&<p className="task-error">{error}</p>}
      </div>}
      <footer><button className="danger-text contact-task-delete" onClick={()=>void remove()} disabled={loading||busy}><Trash2 size={14}/>删除任务</button><span/><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={loading||busy||!detail||!title.trim()}>{busy?"正在处理…":"保存更改"}</button></footer>
    </section>
  </div>;
}

function CrmDetailsPanel({
  active,
  token,
  user,
  role,
  translationPreference,
  onToken,
  onClose,
  onToast,
  onTagCatalogChange,
  onConversationChange,
  onChanged,
  onDeleted,
}: {
  active: Conversation;
  token: string;
  user: User | null;
  role: string;
  translationPreference: TranslationPreference;
  onToken: (token: string) => void;
  onClose: () => void;
  onToast: (text: string) => void;
  onTagCatalogChange: (tags: TagItem[]) => void;
  onConversationChange: (change: Record<string, unknown>) => Promise<void>;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const cachedDetails=conversationDetailsCache.get(active.id);
  const [details, setDetails] = useState<ConversationDetails | null>(()=>cachedDetails?.details??null),
    [catalog, setCatalog] = useState<TagItem[]>(()=>cachedDetails?.catalog??[]),
    [loading, setLoading] = useState(()=>!cachedDetails),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tagQuery, setTagQuery] = useState(""),
    [tagMenuOpen, setTagMenuOpen] = useState(false),
    [noteDraft, setNoteDraft] = useState(""),
    [contactTasks, setContactTasks] = useState<ContactTaskSummary[]>(()=>cachedDetails?.contactTasks??[]),
    [taskTitle, setTaskTitle] = useState(""),
    [taskKind, setTaskKind] = useState<"general"|"message">("general"),
    [taskDueAt, setTaskDueAt] = useState(()=>toDateTimeLocal(new Date(Date.now()+86400000).toISOString())),
    [taskMinAt] = useState(()=>Date.now()),
    [taskEditing, setTaskEditing] = useState<ContactTaskSummary | null>(null),
    [orderOpen, setOrderOpen] = useState(false),
    [editOrderTarget, setEditOrderTarget] = useState<OrderItem | null>(null),
    [sendOrderTarget, setSendOrderTarget] = useState<OrderSendTarget | null>(null),
    [paymentOrderTarget, setPaymentOrderTarget] = useState<OrderItem | null>(null),
    [statusOrderId,setStatusOrderId]=useState(""),
    [contactEditing, setContactEditing] = useState(false),
    [addressEditing, setAddressEditing] = useState(false),
    [aliasEditing, setAliasEditing] = useState(false),
    [aliasDraft, setAliasDraft] = useState(active.alias),
    [aliasBusy, setAliasBusy] = useState(false);
  const canManageTags = ["admin", "supervisor"].includes(role);
  const load = useCallback(async (signal?:AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const [detailResult, tagResult, taskResult] = await Promise.all([
        authorizedFetch(`/api/v1/conversations/${active.id}/details`, token,{signal}),
        authorizedFetch("/api/v1/tags", token,{signal}),
        authorizedFetch(`/api/v1/tasks?contactId=${encodeURIComponent(active.contactId)}&limit=20`,token,{signal}),
      ]);
      const nextToken =
        detailResult.token !== token ? detailResult.token : tagResult.token !== token ? tagResult.token : taskResult.token;
      if (nextToken !== token) onToken(nextToken);
      if (!detailResult.response.ok || !tagResult.response.ok || !taskResult.response.ok)
        throw new Error("联系人业务资料加载失败");
      const body = (await detailResult.response.json()) as Record<
          string,
          unknown
        >,
        tagBody = (await tagResult.response.json()) as {
          data: Array<Record<string, unknown>>;
        },
        taskBody=(await taskResult.response.json()) as {data?:Array<Record<string,unknown>>};
      const nextDetails:ConversationDetails={
        customerStage: String(body.customerStage ?? active.customerStage),
        contact:body.contact&&typeof body.contact==="object"?mapContactProfile(body.contact as Record<string,unknown>):null,
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
        orders: Array.isArray(body.orders)
          ? (body.orders as Array<Record<string, unknown>>).map(item=>mapOrder(item,{conversationId:active.id,accountId:active.accountId,accountName:active.account,customerName:active.name,customerPhone:active.phone}))
          : [],
      };
      const nextCatalog=tagBody.data.map(mapTag);
      const nextContactTasks:ContactTaskSummary[]=(taskBody.data??[]).map(item=>({id:String(item.id),title:String(item.title??""),kind:item.kind==="message"?"message":"general",status:String(item.status??"planned"),dueAt:String(item.due_at),sendAt:item.send_at?String(item.send_at):null,assignedUserName:item.assigned_user_name?String(item.assigned_user_name):null}));
      setDetails(nextDetails);
      setCatalog(nextCatalog);
      onTagCatalogChange(nextCatalog);
      setContactTasks(nextContactTasks);
      cacheConversationDetails(active.id,{details:nextDetails,catalog:nextCatalog,contactTasks:nextContactTasks});
    } catch (reason) {
      if(!signal?.aborted)setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      if(!signal?.aborted)setLoading(false);
    }
  }, [active.id, active.contactId, active.customerStage, active.accountId, active.account, active.name, active.phone, token, onToken, onTagCatalogChange]);
  useEffect(() => {
    if(conversationDetailsCache.has(active.id))return;
    const controller=new AbortController(),timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {window.clearTimeout(timer);controller.abort();};
  }, [active.id,load]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (paymentOrderTarget) setPaymentOrderTarget(null);
      else if (sendOrderTarget) setSendOrderTarget(null);
      else if (taskEditing) setTaskEditing(null);
      else if (!orderOpen && !editOrderTarget) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, orderOpen, editOrderTarget, sendOrderTarget, paymentOrderTarget, taskEditing]);
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
      await load();
      setAliasEditing(false);
      onToast(aliasDraft.trim()?"联系人别名已保存":"联系人别名已清除");
    }catch(reason){setError(reason instanceof Error?reason.message:"别名保存失败");}
    finally{setAliasBusy(false);}
  }
  async function deleteConversation() {
    if(!await confirmAction(`会话“${active.name}”的消息记录、备注、提醒、订单和 AI 记录将一并删除，且无法恢复。`,{title:"永久删除此会话？",confirmLabel:"永久删除"}))return;
    setBusy(true);setError("");
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${active.id}`,token,{method:"DELETE"});
      if(result.token!==token)onToken(result.token);
      if(!result.response.ok){const body=await result.response.json().catch(()=>({})) as {message?:string};throw new Error(body.message??`删除失败（HTTP ${result.response.status}）`);}
      conversationDetailsCache.delete(active.id);
      onToast("会话已永久删除");
      await onDeleted();
    }catch(reason){setError(reason instanceof Error?reason.message:"会话删除失败");}
    finally{setBusy(false);}
  }
  async function setStage(customerStage: string) {
    await onConversationChange({ customerStage });
    setDetails((value) => (value ? { ...value, customerStage } : value));
    updateCachedConversationDetails(active.id,details=>({...details,customerStage}));
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
  async function createAndAddTag() {
    const name=tagQuery.trim();
    if(!name||!details||!canManageTags)return;
    setBusy(true);
    setError("");
    try{
      const createResult=await authorizedFetch("/api/v1/tags",token,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({name,color:"#DFF5E8"}),
      });
      if(createResult.token!==token)onToken(createResult.token);
      const createdBody=await createResult.response.json().catch(()=>({})) as Record<string,unknown>;
      if(!createResult.response.ok)throw new Error(createdBody.error==="tag_name_exists"?"标签名称已存在":`创建标签失败（HTTP ${createResult.response.status}）`);
      const created=mapTag(createdBody);
      const tagIds=[...details.tags.map(tag=>tag.id),created.id];
      const addResult=await authorizedFetch(`/api/v1/conversations/${active.id}/tags`,createResult.token,{
        method:"PUT",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({tagIds}),
      });
      if(addResult.token!==createResult.token)onToken(addResult.token);
      if(!addResult.response.ok)throw new Error(`添加标签失败（HTTP ${addResult.response.status}）`);
      setTagQuery("");
      setTagMenuOpen(false);
      await load();
      await onChanged();
      onToast(`已创建并添加标签“${name}”`);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"创建标签失败");
    }finally{
      setBusy(false);
    }
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
    const body = (await promptAction({
      title: "编辑备注",
      label: "备注内容",
      defaultValue: note.body,
      description: "修改后团队成员会看到更新后的内容。",
      placeholder: "输入备注内容",
      confirmLabel: "保存备注",
      multiline: true,
      maxLength: 4000,
    }))?.trim();
    if (!body || body === note.body) return;
    await request(`/api/v1/conversations/${active.id}/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }
  async function deleteNote(note: NoteItem) {
    if (await confirmAction("这条备注将被永久删除。",{title:"删除备注？",confirmLabel:"删除"}))
      await request(`/api/v1/conversations/${active.id}/notes/${note.id}`, {
        method: "DELETE",
      });
  }
  async function createQuickTask() {
    const dueAt=new Date(taskDueAt);
    if(!taskTitle.trim()||Number.isNaN(dueAt.getTime())||dueAt.getTime()<=Date.now())return;
    const ok=await request("/api/v1/tasks",{
      method:"POST",
      headers: { "content-type": "application/json" },
      body:JSON.stringify({accountId:active.accountId,contactId:active.contactId,conversationId:active.id,assignedUserId:user?.id??null,kind:taskKind,title:taskTitle.trim(),description:"",status:"planned",progress:0,startAt:new Date().toISOString(),dueAt:dueAt.toISOString(),sendAt:taskKind==="message"?dueAt.toISOString():null,sendMode:"approval",recurrence:null,personaOverride:null,toolOverrides:null,dependencyIds:[]}),
    });
    if(ok){setTaskTitle("");setTaskDueAt(toDateTimeLocal(new Date(Date.now()+86400000).toISOString()));onToast(taskKind==="message"?"定时消息任务已创建":"任务已创建");}
  }
  async function changeOrderStatus(order:OrderItem,businessStatus:OrderBusinessStatus){
    if(order.businessStatus===businessStatus)return;
    setStatusOrderId(order.id);setError("");
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${active.id}/orders/${order.id}/status`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({businessStatus})});
      if(result.token!==token)onToken(result.token);
      if(!result.response.ok)throw new Error(`订单状态更新失败（HTTP ${result.response.status}）`);
      setDetails(value=>value?{...value,orders:value.orders.map(item=>item.id===order.id?{...item,businessStatus}:item)}:value);
      updateCachedConversationDetails(active.id,value=>({...value,orders:value.orders.map(item=>item.id===order.id?{...item,businessStatus}:item)}));
      onToast(`订单 #${order.orderNumber} 已切换为${orderBusinessStatusText(businessStatus)}`);
    }catch(reason){setError(reason instanceof Error?reason.message:"订单状态更新失败");}
    finally{setStatusOrderId("");}
  }
  async function sendOrder(order: OrderItem, format: "text" | "image" | "pdf", translate: boolean, targetLanguage?: string, email?:{recipientEmailIds:string[];subject:string;messageBody:string}) {
    setBusy(true);
    setError("");
    try {
      const result = await authorizedFetch(
        email?`/api/v1/conversations/${active.id}/email-sends`:`/api/v1/conversations/${active.id}/orders/${order.id}/send`,
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(email?{clientSendId:crypto.randomUUID(),recipientEmailIds:email.recipientEmailIds,subject:email.subject,messageBody:email.messageBody,content:{type:"order",orderId:order.id,format,translate,...(translate&&targetLanguage?{targetLanguage}:{})}}:{ format, clientSendId: crypto.randomUUID(), translate, ...(translate&&targetLanguage?{targetLanguage}:{}) }),
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
        `订单 #${order.orderNumber} 已${order.status === "draft" ? "按" : "重新按"}${translate?languageName(targetLanguage??order.targetLanguage):"英文"}${format === "image" ? "完整图片版" : format==="pdf" ? "PDF 版" : "文字版"}进入${email?"邮件":"WhatsApp"}发送队列`,
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
      !await confirmAction(
        sent
          ? `删除订单 #${order.orderNumber}？这只会从联系人资料中移除，不会撤回已发送的 WhatsApp 消息。`
          : `删除草稿订单 #${order.orderNumber}？`,
        {title:"删除订单？",confirmLabel:"删除"},
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
  const normalizedTagQuery=tagQuery.trim().toLocaleLowerCase();
  const visibleTags=catalog
    .filter(tag=>!details?.tags.some(item=>item.id===tag.id))
    .filter(tag=>tag.name.toLocaleLowerCase().includes(normalizedTagQuery))
    .slice(0,8);
  const tagNameExists=Boolean(normalizedTagQuery&&catalog.some(tag=>tag.name.trim().toLocaleLowerCase()===normalizedTagQuery));
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
          <p>{active.platform==="messenger"?`Messenger 用户 · ${active.providerUserId}`:(active.phone || "号码待同步")}</p>
          <span className="contact-online">
            <i
              className={`status-dot ${active.accountStatus === "online" ? "online" : ""}`}
            />
            {statusText(active.accountStatus)}
          </span>
          {details?.contact&&<ContactLocalTime contact={details.contact}/>}
          {details?.contact?.preferredLanguage&&<div className="contact-preferred-language" title={`偏好语言：${languageName(details.contact.preferredLanguage)}`}><span aria-hidden="true">{languageFlag(details.contact.preferredLanguage)}</span><b>{languageShortCode(details.contact.preferredLanguage)}</b></div>}
          {details?.contact?.primaryEmail&&<p className="contact-primary-email"><Mail size={12}/>{details.contact.primaryEmail}</p>}
          {details?.contact?.methods.filter(method=>!isSocialContactMethod(method.type)).slice(0,2).map((method,index)=><p className="contact-method-summary" key={`${method.type}-${index}`}>{method.label||contactMethodName(method.type)}：{method.value}</p>)}
          {details?.contact&&<ContactSocialLinks methods={details.contact.methods}/>}
          <div className="contact-profile-actions"><button className="contact-profile-edit" onClick={()=>setContactEditing(true)}><Pencil size={13}/>编辑资料</button><button className="contact-profile-edit" onClick={()=>setAddressEditing(true)}><MapPin size={13}/>收货地址{details?.contact?.addresses.length?` (${details.contact.addresses.length})`:""}</button></div>
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
                      <button className="order-summary-open" onClick={()=>setPaymentOrderTarget(order)} aria-label={`查看订单 #${order.orderNumber} 详情`}>
                        <span className="order-summary-heading">
                          <b>#{order.orderNumber}</b>
                          <em>{order.items.length} 件商品</em>
                        </span>
                        <strong>{order.currency} {order.amount.toFixed(2)}</strong>
                        <span className="order-summary-meta">
                          <small>{formatDateTime(order.createdAt)}</small>
                          {order.sendFormat && (
                            <small>
                              {order.sendFormat === "image"
                                ? "完整图片版"
                                : order.sendFormat === "pdf"
                                  ? "PDF 版"
                                : "文字版"}
                            </small>
                          )}
                        </span>
                        {order.paymentRequest&&<small className={`payment-state ${order.paymentRequest.status.toLowerCase()}`}><CreditCard size={11}/>{paymentStatusText(order.paymentRequest.status)}</small>}
                      </button>
                      <div className="order-card-actions">
                        <label className={`order-business-status ${order.businessStatus}`}>
                          <span className="sr-only">订单 #{order.orderNumber} 状态</span>
                          <select value={order.businessStatus} disabled={busy||statusOrderId===order.id} onChange={event=>void changeOrderStatus(order,event.target.value as OrderBusinessStatus)} aria-label={`切换订单 #${order.orderNumber} 状态`}>
                            {ORDER_BUSINESS_STATUSES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </label>
                        {order.status !== "draft" && (
                          <em
                            className={`delivery-state ${order.messageStatus}`}
                          >
                            {deliveryText(order.messageStatus)}
                          </em>
                        )}
                        <button
                          className="order-payment"
                          disabled={busy}
                          onClick={() => setPaymentOrderTarget(order)}
                          aria-label={`查看订单 #${order.orderNumber} 的付款方式`}
                        >
                          <CreditCard size={12} />
                          {order.paymentRequest?"付款详情":order.paymentProfile?"付款说明":"选择收款"}
                        </button>
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
              <div className="crm-tag-search" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setTagMenuOpen(false);}}>
                <label className="crm-search">
                  <Search size={13} />
                  <input
                    role="combobox"
                    aria-expanded={tagMenuOpen}
                    aria-controls="contact-tag-options"
                    aria-autocomplete="list"
                    value={tagQuery}
                    onFocus={()=>setTagMenuOpen(true)}
                    onChange={(event) => {setTagQuery(event.target.value);setTagMenuOpen(true);}}
                    onKeyDown={event=>{
                      if(event.key==="Escape"){event.stopPropagation();setTagMenuOpen(false);}
                      else if(event.key==="Enter"){
                        event.preventDefault();
                        const exact=visibleTags.find(tag=>tag.name.trim().toLocaleLowerCase()===normalizedTagQuery);
                        if(exact)void toggleTag(exact.id);
                        else if(normalizedTagQuery&&!tagNameExists&&canManageTags)void createAndAddTag();
                      }
                    }}
                    maxLength={40}
                    placeholder="搜索并添加标签"
                  />
                </label>
                {tagMenuOpen&&(visibleTags.length>0||Boolean(normalizedTagQuery))&&<div id="contact-tag-options" className="tag-options" role="listbox">
                  {visibleTags.map(tag=>(
                    <button type="button" role="option" aria-selected="false" key={tag.id} onMouseDown={event=>event.preventDefault()} onClick={()=>{void toggleTag(tag.id);setTagQuery("");setTagMenuOpen(false);}}>
                      <i style={{background:tag.color}}/>
                      <span><b>{tag.name}</b><small>添加标签</small></span>
                    </button>
                  ))}
                  {normalizedTagQuery&&!tagNameExists&&canManageTags&&<button type="button" role="option" aria-selected={visibleTags.length===0} className="create" disabled={busy} onMouseDown={event=>event.preventDefault()} onClick={()=>void createAndAddTag()}>
                    <Plus size={13}/>
                    <span><b>创建“{tagQuery.trim()}”</b><small>创建后添加到此联系人</small></span>
                  </button>}
                  {!visibleTags.length&&(!canManageTags||tagNameExists)&&<p>没有可添加的匹配标签</p>}
                </div>}
              </div>
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
              <h4 className="detail-title"><span>任务</span><Link href="/tasks">查看全部</Link></h4>
              <div className="contact-task-list">
                {contactTasks.length?contactTasks.slice(0,6).map(task=><article key={task.id} role="button" tabIndex={0} aria-label={`查看并编辑任务：${task.title}`} onClick={()=>setTaskEditing(task)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setTaskEditing(task);}}}>
                  <span className={`contact-task-icon ${task.kind}`} aria-hidden="true">{task.kind==="message"?<Send size={12}/>:<ClipboardList size={12}/>}</span>
                  <span><b>{task.title}</b><small><CalendarDays size={10}/>{formatDateTime(task.sendAt??task.dueAt)}{task.assignedUserName?` · ${task.assignedUserName}`:""}</small></span>
                  <em className={task.status}>{CONTACT_TASK_STATUS[task.status]??task.status}</em>
                </article>):<p className="crm-empty">该联系人暂无任务</p>}
              </div>
              <div className="contact-quick-task">
                <div>
                  <select className="crm-select" value={taskKind} onChange={event=>setTaskKind(event.target.value as "general"|"message")} aria-label="任务类型">
                    <option value="general">普通任务</option>
                    <option value="message">定时消息</option>
                  </select>
                  <input className="crm-select" value={taskTitle} onChange={event=>setTaskTitle(event.target.value)} placeholder={taskKind==="message"?"例如：发送报价跟进":"例如：电话回访"} maxLength={200}/>
                </div>
                <input className="crm-select" type="datetime-local" value={taskDueAt} min={toDateTimeLocal(new Date(taskMinAt).toISOString())} onChange={event=>setTaskDueAt(event.target.value)}/>
                <button className="crm-primary" disabled={busy||!taskTitle.trim()||!taskDueAt||new Date(taskDueAt).getTime()<=taskMinAt} onClick={()=>void createQuickTask()}>
                  <Plus size={12}/>快捷添加{taskKind==="message"?"定时消息":"任务"}
                </button>
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
                disabled={busy}
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
              {["admin", "supervisor"].includes(role) && (
                <button className="conversation-delete-button" disabled={busy} onClick={() => void deleteConversation()}>
                  <Trash2 size={14} />永久删除会话
                </button>
              )}
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
      {contactEditing&&<ContactEditDialog contactId={active.contactId} token={token} onToken={onToken} onClose={()=>setContactEditing(false)} onSaved={async profile=>{setContactEditing(false);setDetails(value=>value?{...value,contact:profile}:value);onToast("联系人资料已更新");await onChanged();await load();}}/>}
      {addressEditing&&<ContactAddressDialog contactId={active.contactId} token={token} onToken={onToken} onClose={()=>setAddressEditing(false)} onSaved={async profile=>{setAddressEditing(false);setDetails(value=>value?{...value,contact:profile}:value);onToast("联系人地址已更新，创建订单时可直接选择");await load();}}/>}
      {taskEditing&&<ContactTaskDialog task={taskEditing} token={token} onToken={onToken} onClose={()=>setTaskEditing(null)} onSaved={async message=>{setTaskEditing(null);onToast(message);await load();await onChanged();}}/>}
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
          emails={(details?.contact?.emails??[]).filter(item=>Boolean(item.id)) as Array<ContactEmail&{id:string}>}
          defaultTargetLanguage={translationPreference.customerLanguage}
          busy={busy}
          onClose={() => setSendOrderTarget(null)}
          onSend={(format,translate,targetLanguage,email) => void sendOrder(sendOrderTarget.order,format,translate,targetLanguage,email)}
        />
      )}
      {paymentOrderTarget && (
        <OrderDetailsDialog
          order={paymentOrderTarget}
          token={token}
          onToken={onToken}
          onToast={onToast}
          onPaymentChange={paymentRequest=>{
            setPaymentOrderTarget(order=>order?{...order,paymentRequest}:order);
            setDetails(value=>value?{...value,orders:value.orders.map(order=>order.id===paymentOrderTarget.id?{...order,paymentRequest}:order)}:value);
            updateCachedConversationDetails(active.id,details=>({...details,orders:details.orders.map(order=>order.id===paymentOrderTarget.id?{...order,paymentRequest}:order)}));
          }}
          onClose={()=>setPaymentOrderTarget(null)}
          onEdit={()=>{setEditOrderTarget(paymentOrderTarget);setPaymentOrderTarget(null);}}
          onConversation={()=>setPaymentOrderTarget(null)}
        />
      )}
    </>
  );
}

function OrderSendDialog({order,emails,defaultTargetLanguage,busy,onClose,onSend}:{order:OrderItem;emails:Array<ContactEmail&{id:string}>;defaultTargetLanguage:string;busy:boolean;onClose:()=>void;onSend:(format:"text"|"image"|"pdf",translate:boolean,targetLanguage?:string,email?:{recipientEmailIds:string[];subject:string;messageBody:string})=>void}){
  const initialTargetLanguage=defaultTargetLanguage||"en";
  const [format,setFormat]=useState<"text"|"image"|"pdf">("text"),[translate,setTranslate]=useState(!isEnglishLanguage(initialTargetLanguage)),[targetLanguage,setTargetLanguage]=useState(initialTargetLanguage),[channel,setChannel]=useState<"whatsapp"|"email">("whatsapp"),[recipientIds,setRecipientIds]=useState(emails.filter(item=>item.isPrimary).map(item=>item.id)),[subject,setSubject]=useState(`Order #${order.orderNumber}`),[messageBody,setMessageBody]=useState("Hi,\n\nPlease find your order details below.\n\nBest regards,");
  const emailReady=channel!=="email"||(recipientIds.length>0&&Boolean(subject.trim()));
  return <div className="modal-backdrop order-backdrop" role="presentation"><section className="login-dialog order-send-dialog" role="dialog" aria-modal="true" aria-labelledby="order-send-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Send size={19}/></span><h2 id="order-send-title">发送订单 #{order.orderNumber}</h2><p>选择发送渠道、语言和订单格式。</p><div className="email-channel-picker"><button className={channel==="whatsapp"?"active":""} onClick={()=>setChannel("whatsapp")}><MessageCircle size={13}/>WhatsApp</button><button className={channel==="email"?"active":""} onClick={()=>setChannel("email")}><Mail size={13}/>Email</button></div>{channel==="email"&&<div className="email-compose-fields"><fieldset><legend>收件人</legend>{emails.length?emails.map(item=><label key={item.id}><input type="checkbox" checked={recipientIds.includes(item.id)} onChange={()=>setRecipientIds(ids=>ids.includes(item.id)?ids.filter(id=>id!==item.id):[...ids,item.id])}/><span>{item.label||"邮箱"} · {item.email}{item.isPrimary?" · Primary":""}</span></label>):<p>联系人尚未保存邮箱，请先编辑联系人资料。</p>}</fieldset><label>邮件主题<input value={subject} maxLength={200} onChange={event=>setSubject(event.target.value)}/></label><label>正文说明<textarea value={messageBody} maxLength={5000} onChange={event=>setMessageBody(event.target.value)}/></label></div>}<div className="order-send-mode"><label className={!translate?"selected":""}><input type="radio" name="order-language-mode" checked={!translate} onChange={()=>setTranslate(false)}/><span><FileText size={14}/><b>英文原文</b></span></label><label className={translate?"selected":""}><input type="radio" name="order-language-mode" checked={translate} onChange={()=>setTranslate(true)}/><span><Languages size={14}/><b>AI 翻译</b></span></label></div>{translate&&<label className="order-send-language"><span>目标翻译语言</span><LanguagePicker value={targetLanguage} onChange={setTargetLanguage}/></label>}<div className="order-send-options"><label className={format==="text"?"selected":""}><input type="radio" name="order-format" checked={format==="text"} onChange={()=>setFormat("text")}/><span><b><FileText size={16}/>文字版详情</b><small>发送完整订单文字，不包含产品图片</small></span></label><label className={format==="image"?"selected":""}><input type="radio" name="order-format" checked={format==="image"} onChange={()=>setFormat("image")}/><span><b><ShoppingBag size={16}/>图片版完整详情</b><small>生成一张包含全部订单内容和所有产品图片的长图</small></span></label><label className={format==="pdf"?"selected":""}><input type="radio" name="order-format" checked={format==="pdf"} onChange={()=>setFormat("pdf")}/><span><b><FileDown size={16}/>PDF 订单</b><small>生成包含完整订单内容和所有产品图片的 PDF 文件</small></span></label></div>{translate?<p className="order-send-translation"><Languages size={13}/>点击发送后才会将订单详情翻译为 {languageName(targetLanguage)}</p>:<p className="order-send-translation english"><FileText size={13}/>订单将以英文原文发送，不调用 AI 翻译</p>}<button className="login-submit" disabled={busy||!emailReady} onClick={()=>onSend(format,translate,translate?targetLanguage:undefined,channel==="email"?{recipientEmailIds:recipientIds,subject,messageBody}:undefined)}>{busy?format==="image"?"正在生成订单图片…":format==="pdf"?"正在生成订单 PDF…":"正在加入队列…":`通过 ${channel==="email"?"Email":"WhatsApp"} 发送${format==="image"?"图片版":format==="pdf"?"PDF 版":"文字版"}`}</button></section></div>;
}

type DraftProduct={id:string;mode:"library"|"new"|"legacy";productId:string|null;clientProductId:string|null;sku:string;name:string;quantity:string;unitAmount:string;weightAmount:string;weightUnit:WeightUnit;priceLocked:boolean;imageMediaId:string|null;imageName:string};
type DraftFee={id:string;name:string;amount:string};
const newDraftProduct=():DraftProduct=>({id:crypto.randomUUID(),mode:"new",productId:null,clientProductId:crypto.randomUUID(),sku:"",name:"",quantity:"1",unitAmount:"",weightAmount:"",weightUnit:"kg",priceLocked:false,imageMediaId:null,imageName:""});
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
            sku: item.sku,
            name: item.name,
            quantity: String(item.quantity),
            unitAmount: item.unitAmount.toFixed(2),
            weightAmount: item.weightAmount?.toString()??"",
            weightUnit: item.weightUnit??order.weightUnit,
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
    [businessStatus,setBusinessStatus]=useState<OrderBusinessStatus>(order?.businessStatus??"quotation"),
    [weightUnit,setWeightUnit]=useState<WeightUnit>(order?.weightUnit??"kg"),
    [paymentProfiles,setPaymentProfiles]=useState<PaymentProfile[]>(()=>order?.paymentProfile?[order.paymentProfile]:[]),
    [paymentProfileId,setPaymentProfileId]=useState(order?.paymentProfileId??""),
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
  const totalWeight=useMemo(()=>products.reduce((sum,item)=>sum+(item.weightAmount
    ? (Number(item.quantity)||0)*convertWeight(Number(item.weightAmount)||0,item.weightUnit,weightUnit)
    : 0),0),[products,weightUnit]);
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
          const [result,currencyResult,paymentResult] = await Promise.all([authorizedFetch(
            "/api/v1/products?limit=100",token),authorizedFetch("/api/v1/currencies",token),authorizedFetch("/api/v1/payment-profiles",token)]);
          if (result.token !== token) onToken(result.token);else if(currencyResult.token!==token)onToken(currencyResult.token);else if(paymentResult.token!==token)onToken(paymentResult.token);
          if (result.response.ok) {
            const body = (await result.response.json()) as {
              data: Array<Record<string, unknown>>;
            };
            setCatalog(body.data.map(mapProduct));
          }
          if(currencyResult.response.ok){const body=await currencyResult.response.json() as CurrencyConfig;setCurrencyConfig(body);if(!order)setCurrency(current=>current||body.baseCurrency);}
          if(paymentResult.response.ok){const body=await paymentResult.response.json() as {data:Array<Record<string,unknown>>};const enabled=body.data.map(mapPaymentProfile);setPaymentProfiles(order?.paymentProfile&&!enabled.some(item=>item.id===order.paymentProfileId)?[order.paymentProfile,...enabled]:enabled);}
        })(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [token, onToken, order]);
  useEffect(()=>{let cancelled=false;void (async()=>{const result=await authorizedFetch(`/api/v1/conversations/${active.id}/addresses`,token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:Array<Record<string,unknown>>};if(!cancelled){const next=body.data.map(item=>mapCustomerAddress(item));setAddresses(next);if(!order)setAddressId(next.find(item=>item.isDefault)?.id??"");}}})();return()=>{cancelled=true;};},[active.id,token,onToken,order]);
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
      weightAmount:selected.weightAmount?.toString()??"",
      weightUnit:selected.weightUnit??weightUnit,
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
      weightAmount: "",
      weightUnit,
      priceLocked: false,
      imageMediaId: null,
      imageName: "",
    });
  }
  async function submit() {
    const money = /^\d+(?:\.\d{1,2})?$/,positiveNumber=/^\d+(?:\.\d+)?$/;
    if(!currency){setError("请先在设置中配置基准货币");return;}
    if(paymentProfiles.length&&!paymentProfileId){setError("请选择付款方式与 Profile");return;}
    if (
      products.some(
        (item) =>
          !item.name.trim() ||
          (item.mode === "new" && !item.sku.trim()) ||
          !/^\d+$/.test(item.quantity) ||
          Number(item.quantity) < 1 ||
          !money.test(item.unitAmount) ||
          (item.weightAmount!==""&&(!positiveNumber.test(item.weightAmount)||Number(item.weightAmount)<=0)),
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
          ...(product.weightAmount?{weightAmount:Number(product.weightAmount),weightUnit:product.weightUnit}:{}),
          ...(product.imageMediaId ? { imageMediaId: product.imageMediaId } : {}),
          ...(product.productId ? { productId: product.productId } : {}),
          ...(product.clientProductId
            ? { clientProductId: product.clientProductId }
            : {}),
        }));
      const payload = {
        currency,
        businessStatus,
        weightUnit,
        paymentProfileId:paymentProfileId||null,
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
        orderId?: string;
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
      const savedOrderId=order?.id??body.orderId;
      if(savedOrderId){
        const statusSaved=await authorizedFetch(`/api/v1/conversations/${active.id}/orders/${savedOrderId}/status`,saved.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({businessStatus})});
        if(statusSaved.token!==saved.token)onToken(statusSaved.token);
        if(!statusSaved.response.ok)throw new Error("订单已保存，但订单状态更新失败，请重试");
      }
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
            订单状态
            <select value={businessStatus} onChange={event=>setBusinessStatus(event.target.value as OrderBusinessStatus)}>
              {ORDER_BUSINESS_STATUSES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
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
          <label>
            重量单位
            <select value={weightUnit} onChange={(event)=>setWeightUnit(event.target.value as WeightUnit)}>
              {WEIGHT_UNITS.map(unit=><option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          <label>
            付款方式
            <select value={paymentProfileId} onChange={event=>setPaymentProfileId(event.target.value)} required={paymentProfiles.length>0}>
              <option value="">{paymentProfiles.length?"请选择付款 Profile":"尚未配置付款方式"}</option>
              {paymentProfiles.map(profile=><option key={profile.id} value={profile.id}>{profile.summary}{profile.environment?` · ${profile.environment==="live"?"Live":"Sandbox"}`:""}</option>)}
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
                <label>
                  单件重量
                  <input
                    value={product.weightAmount}
                    onChange={(event)=>updateProduct(product.id,{weightAmount:event.target.value})}
                    inputMode="decimal"
                    placeholder="可选"
                  />
                </label>
                <label>
                  重量单位
                  <select value={product.weightUnit} disabled={!product.weightAmount} onChange={(event)=>updateProduct(product.id,{weightUnit:event.target.value as WeightUnit})}>
                    {WEIGHT_UNITS.map(unit=><option key={unit} value={unit}>{unit}</option>)}
                  </select>
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
        <div className="order-weight-total">
          <span>订单总重量</span>
          <strong>{formatWeight(totalWeight,weightUnit)}</strong>
          <small>按商品数量自动求和并换算为订单重量单位</small>
        </div>
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
            {addresses.map(item=><button key={item.id} className={!addingAddress&&addressId===item.id?"selected":""} onClick={()=>{setAddingAddress(false);setAddressId(item.id);}}><MapPin size={15}/><span><b>{item.label}{item.isDefault?" · 默认":""}</b><small>{[item.recipientName,item.phone].filter(Boolean).join(" · ")}</small><em>{item.address}</em></span></button>)}
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

const DETECTED_LANGUAGE_NAMES:Record<string,string>={zh:"中文",en:"英语",es:"西班牙语",fr:"法语",de:"德语",it:"意大利语",pt:"葡萄牙语",ru:"俄语",ar:"阿拉伯语",hi:"印地语",tr:"土耳其语",nl:"荷兰语",pl:"波兰语",ms:"马来语",id:"印度尼西亚语",th:"泰语",vi:"越南语",ja:"日语",ko:"韩语"};
function detectedLanguageName(code?:string){if(!code)return"未知语种";if(/^zh-CN$/i.test(code))return"简体中文";if(/^zh-(?:TW|HK|Hant)$/i.test(code))return"繁体中文";return DETECTED_LANGUAGE_NAMES[code.split("-")[0].toLowerCase()]??languageName(code);}
function isEnglishLanguage(code:string){return /^en(?:-|$)/i.test(code);}

function TranslationMenu({preference,configured,ready,onChange,onClose}:{preference:TranslationPreference;configured:boolean;ready:boolean;onChange:(value:TranslationPreference)=>void;onClose:()=>void}){
  return <section className="translation-menu" role="dialog" aria-label="AI 翻译设置"><header><span><Languages size={16}/><b>当前会话 · AI 双向翻译</b></span><button onClick={onClose} aria-label="关闭翻译设置"><X size={15}/></button></header><label className="translation-toggle"><span><b>为当前会话启用</b><small>{!ready?"正在读取会话配置…":configured?"此会话偏好会跨浏览器同步":"管理员尚未配置翻译 Provider"}</small></span><input type="checkbox" checked={preference.enabled} disabled={!ready||(!configured&&!preference.enabled)} onChange={event=>onChange({...preference,enabled:event.target.checked})}/></label><div className="translation-language-grid"><label><span>收到消息译为</span><LanguagePicker value={preference.agentLanguage} onChange={agentLanguage=>onChange({...preference,agentLanguage})}/></label><label><span>客户语种（含语音识别）</span><LanguagePicker value={preference.customerLanguage} onChange={customerLanguage=>onChange({...preference,customerLanguage})}/></label></div><p><Info size={13}/>客户语种会用于语音转写和双向翻译；发送前会显示可编辑预览。</p></section>;
}

const FALLBACK_TIMEZONES=["UTC","Asia/Shanghai","Asia/Hong_Kong","Asia/Tokyo","Asia/Singapore","Asia/Dubai","Europe/London","Europe/Paris","America/New_York","America/Chicago","America/Denver","America/Los_Angeles","Australia/Sydney"];
function TimezoneSearchDropdown({value,onChange,label="搜索并选择时区"}:{value:string;onChange:(value:string)=>void;label?:string}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState("");
  const zones=useMemo(()=>{try{return (Intl as typeof Intl&{supportedValuesOf?:(key:"timeZone")=>string[]}).supportedValuesOf?.("timeZone")??FALLBACK_TIMEZONES;}catch{return FALLBACK_TIMEZONES;}},[]);
  const visible=useMemo(()=>{const term=query.trim().toLowerCase();return (term?zones.filter(zone=>zone.toLowerCase().includes(term)):zones).slice(0,100);},[query,zones]);
  return <div className="timezone-picker"><div className="timezone-search-field"><Search size={14}/><input type="search" value={open?query:value} onFocus={()=>{setOpen(true);setQuery("");}} onChange={event=>{setOpen(true);setQuery(event.target.value);}} onBlur={()=>window.setTimeout(()=>setOpen(false),120)} aria-label={label} role="combobox" aria-controls="timezone-search-options" aria-expanded={open} aria-autocomplete="list" autoComplete="off"/><ChevronDown size={14}/></div>{open&&<div id="timezone-search-options" className="timezone-options" role="listbox">{visible.length?visible.map(zone=><button type="button" role="option" aria-selected={zone===value} className={zone===value?"selected":""} key={zone} onMouseDown={event=>event.preventDefault()} onClick={()=>{onChange(zone);setOpen(false);setQuery("");}}>{zone}</button>):<span className="timezone-empty">没有匹配时区</span>}</div>}</div>;
}

function MessageSourceLanguageControl({language,busy=false,actionLabel,onApply}:{language:string;busy?:boolean;actionLabel:string;onApply:(language:string)=>void}){
  const [editing,setEditing]=useState(false),[selected,setSelected]=useState(language);
  if(!editing)return <button type="button" className="message-source-language" disabled={busy} onClick={()=>{setSelected(language);setEditing(true);}} title="仅修改这条消息的原语言"><Pencil size={11}/>原语言：{languageName(language)}</button>;
  return <div className="message-language-override"><span>指定这条消息的原语言</span><LanguagePicker value={selected} onChange={setSelected} label="搜索并指定这条消息的原语言"/><div><button type="button" onClick={()=>setEditing(false)}>取消</button><button type="button" className="apply" disabled={busy} onClick={()=>{setEditing(false);onApply(selected);}}>{actionLabel}</button></div></div>;
}

function IncomingTranslation({value,language,defaultSourceLanguage,onTranslate}:{value?:MessageTranslation;language:string;defaultSourceLanguage:string;onTranslate:(sourceLanguage:string)=>void}){
  const sourceLanguage=value?.sourceLanguage??defaultSourceLanguage;
  if(value?.status==="idle")return null;
  if(!value||value.status==="loading")return <div className="incoming-translation loading"><RefreshCw className="spin" size={12}/>正在翻译为 {languageName(language)}…</div>;
  if(value.status==="failed")return <div className="incoming-translation"><div className="translation-failure-row"><span>{value.message??"译文加载失败"}</span><button onClick={()=>onTranslate(sourceLanguage)}>重试</button></div><MessageSourceLanguageControl language={sourceLanguage} actionLabel="按此语种重新翻译" onApply={onTranslate}/></div>;
  return <div className="incoming-translation"><span><Languages size={12}/>{detectedLanguageName(value.sourceLanguage)} → {languageName(language)}</span><p>{value.text}</p><MessageSourceLanguageControl language={sourceLanguage} actionLabel="按此语种重新翻译" onApply={onTranslate}/></div>;
}

function VoiceTranslation({value,language,defaultSourceLanguage,configured,onTranslate}:{value?:MessageTranslation;language:string;defaultSourceLanguage:string;configured:boolean;onTranslate:(sourceLanguage:string)=>void}){
  const sourceLanguage=value?.sourceLanguage??defaultSourceLanguage;
  if(!value||value.status==="idle")return <div className="voice-translation-actions"><MessageSourceLanguageControl language={sourceLanguage} busy={!configured} actionLabel="按此语种转写并翻译" onApply={onTranslate}/><button className="voice-translate-action" disabled={!configured} onClick={()=>onTranslate(sourceLanguage)}><Languages size={12}/>{configured?`AI 翻译语音为 ${languageName(language)}`:"管理员尚未配置翻译 Provider"}</button></div>;
  if(value.status==="loading")return <div className="incoming-translation loading"><RefreshCw className="spin" size={12}/>正在转写并翻译语音…</div>;
  if(value.status==="failed")return <div className="incoming-translation"><div className="translation-failure-row"><span>{value.message??"语音翻译失败"}</span><button onClick={()=>onTranslate(sourceLanguage)}>重试</button></div><MessageSourceLanguageControl language={sourceLanguage} busy={!configured} actionLabel="按此语种转写并翻译" onApply={onTranslate}/></div>;
  return <div className="incoming-translation voice-translation">{value.sourceText&&<><span><Mic size={12}/>语音原文</span><p>{value.sourceText}</p></>}<span><Languages size={12}/>{detectedLanguageName(value.sourceLanguage)} → {languageName(language)}</span><p>{value.text}</p><MessageSourceLanguageControl language={sourceLanguage} busy={!configured} actionLabel="按此语种转写并翻译" onApply={onTranslate}/></div>;
}

const QUICK_REPLY_TEXTS=[
  {id:"welcome",title:"欢迎与问候",text:"您好，感谢您的消息！请问有什么可以帮您？",tags:"问候 欢迎 hello"},
  {id:"checking",title:"正在为您查询",text:"收到，我正在为您查询，请稍等片刻。",tags:"查询 稍等 进度"},
  {id:"details",title:"请补充信息",text:"为了更快帮您处理，请提供订单号或相关图片，谢谢。",tags:"订单号 图片 信息"},
  {id:"follow-up",title:"稍后跟进",text:"感谢您的耐心等待，我们确认后会尽快回复您。",tags:"跟进 回复 等待"},
] as const;

function defaultQuickReplies():SavedQuickReply[]{return QUICK_REPLY_TEXTS.map(item=>({id:`preset-${item.id}`,sourceMessageId:`preset:${item.id}`,title:item.title,text:item.text,tags:item.tags,kind:"text",createdAt:new Date().toISOString()}));}
function loadQuickReplyStore(raw:string|null):SavedQuickReply[]{
  if(!raw)return defaultQuickReplies();
  const parsed=JSON.parse(raw) as SavedQuickReply[]|{items?:SavedQuickReply[]};
  if(!Array.isArray(parsed))return Array.isArray(parsed.items)?parsed.items:defaultQuickReplies();
  const existingSources=new Set(parsed.map(item=>item.sourceMessageId));return[...defaultQuickReplies().filter(item=>!existingSources.has(item.sourceMessageId)),...parsed];
}

function QuickReplyDropdown({open,disabled,translationEnabled,savedReplies,onOpenChange,onAdd,onEdit,onDelete,onText,onMedia}:{open:boolean;disabled:boolean;translationEnabled:boolean;savedReplies:SavedQuickReply[];onOpenChange:(open:boolean)=>void;onAdd:()=>void;onEdit:(item:SavedQuickReply)=>void;onDelete:(item:SavedQuickReply)=>void;onText:(text:string)=>void;onMedia:(asset:MediaAsset,caption?:string)=>void}){
  const [query,setQuery]=useState(""),[filter,setFilter]=useState("all");
  const rootRef=useRef<HTMLDivElement>(null),inputRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    if(!open)return;
    const timer=window.setTimeout(()=>inputRef.current?.focus(),0);
    const close=(event:MouseEvent)=>{if(!rootRef.current?.contains(event.target as Node))onOpenChange(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")onOpenChange(false);};
    document.addEventListener("mousedown",close);document.addEventListener("keydown",escape);
    return()=>{window.clearTimeout(timer);document.removeEventListener("mousedown",close);document.removeEventListener("keydown",escape);};
  },[open,onOpenChange]);
  const normalized=query.trim().toLocaleLowerCase();
  const visible=savedReplies.filter(item=>{const kind=item.attachment?mediaKind(item.attachment.mimeType):"text";return(filter==="all"||filter===kind)&&`${item.title} ${item.text} ${item.tags} ${item.attachment?.fileName??""}`.toLocaleLowerCase().includes(normalized);});
  return <div className="quick-reply" ref={rootRef}><button type="button" className={`quick-reply-trigger ${open?"active":""}`} disabled={disabled} onClick={()=>onOpenChange(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label="快捷回复"><Zap size={15}/><span>快捷回复</span>{savedReplies.length>0&&<i>{savedReplies.length}</i>}<ChevronDown size={12}/></button>{open&&<section className="quick-reply-menu" aria-label="搜索快捷回复"><header><label><Search size={14}/><input ref={inputRef} role="combobox" aria-expanded="true" aria-controls="quick-reply-options" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索标题、内容或标签"/></label><button type="button" className="quick-reply-add" onClick={onAdd} aria-label="新增快捷回复"><Plus size={14}/><span>新增</span></button><button type="button" onClick={()=>onOpenChange(false)} aria-label="关闭快捷回复"><X size={14}/></button></header><div className="quick-reply-filters" role="tablist">{[["all","全部"],["text","文本"],["image","图文"],["audio","语音"],["video","视频"],["document","文件"]].map(([value,label])=><button type="button" key={value} role="tab" aria-selected={filter===value} className={filter===value?"active":""} onClick={()=>setFilter(value)}>{label}</button>)}</div><div className="quick-reply-options" id="quick-reply-options" role="listbox">{visible.map(item=>{const asset=item.attachment,kind=asset?mediaKind(asset.mimeType):"text";return <article className="quick-reply-option" role="option" aria-selected="false" key={item.id}><button type="button" className="quick-reply-use" onClick={()=>asset?onMedia(asset,item.text):onText(item.text)}><span className={`quick-reply-kind ${kind} ${asset?"":"saved"}`}>{kind==="audio"?<Mic size={14}/>:kind==="image"?<LayoutGrid size={14}/>:kind==="text"?<MessageCircle size={14}/>:<FileText size={14}/>}</span><span><b>{item.title}</b><small>{asset?`${kindText(kind)}${item.text?` · ${item.text}`:""}`:item.text}</small></span>{translationEnabled&&<em><Languages size={10}/>自动翻译</em>}</button><span className="quick-reply-item-actions"><button type="button" onClick={()=>onEdit(item)} aria-label={`编辑 ${item.title}`} title="编辑"><Pencil size={13}/></button><button type="button" onClick={()=>onDelete(item)} aria-label={`删除 ${item.title}`} title="删除"><Trash2 size={13}/></button></span></article>})}{!visible.length&&<p className="quick-reply-state">没有匹配的快捷回复</p>}</div><footer><span>{savedReplies.length} 条快捷回复</span><span>支持新增、编辑与删除</span></footer></section>}</div>;
}

function QuickReplyEditorDialog({accountId,token,item,onToken,onClose,onSave}:{accountId:string;token:string;item:SavedQuickReply|null;onToken:(token:string)=>void;onClose:()=>void;onSave:(item:SavedQuickReply)=>void}){
  const initialKind=item?.attachment?mediaKind(item.attachment.mimeType):"text";
  const [title,setTitle]=useState(item?.title??""),[text,setText]=useState(item?.text??""),[tags,setTags]=useState(item?.tags??""),[kind,setKind]=useState(initialKind),[mediaId,setMediaId]=useState(item?.attachment?.id??""),[assets,setAssets]=useState<MediaAsset[]>(item?.attachment?[item.attachment]:[]),[loading,setLoading]=useState(false),[error,setError]=useState("");
  useEffect(()=>{const controller=new AbortController();void (async()=>{setLoading(true);try{const result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}&limit=100`,token,{signal:controller.signal});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({data:[]})) as {data?:Array<Record<string,unknown>>};if(!result.response.ok)throw new Error(`HTTP ${result.response.status}`);setAssets((body.data??[]).map(mapMediaAsset));}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"媒体库加载失败");}finally{if(!controller.signal.aborted)setLoading(false);}})();return()=>controller.abort();},[accountId,token,onToken]);
  const mediaOptions=assets.filter(asset=>mediaKind(asset.mimeType)===kind),selected=assets.find(asset=>asset.id===mediaId)??item?.attachment;
  function submit(){if(!title.trim()||(kind==="text"&&!text.trim())||(kind!=="text"&&!selected))return;onSave({id:item?.id??crypto.randomUUID(),sourceMessageId:item?.sourceMessageId??`manual:${crypto.randomUUID()}`,title:title.trim(),text:text.trim(),tags:tags.trim(),kind,createdAt:item?.createdAt??new Date().toISOString(),attachment:kind==="text"?undefined:selected});}
  return <div className="modal-backdrop quick-reply-editor-backdrop" role="presentation"><section className="login-dialog quick-reply-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-reply-editor-title"><button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Zap size={20}/></span><h2 id="quick-reply-editor-title">{item?"编辑快捷回复":"新增快捷回复"}</h2><p>快捷回复按当前坐席和 WhatsApp 账号保存。</p><label>标题<input value={title} onChange={event=>setTitle(event.target.value)} maxLength={40} autoFocus placeholder="例如：报价后跟进"/></label><label>消息类型<select value={kind} onChange={event=>{setKind(event.target.value);setMediaId("");}}>{[["text","文本"],["image","图片"],["audio","语音"],["video","视频"],["document","文件"]].map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>{kind!=="text"&&<label>媒体文件<select value={mediaId} onChange={event=>setMediaId(event.target.value)} disabled={loading}><option value="">{loading?"正在读取媒体库…":"请选择媒体文件"}</option>{mediaOptions.map(asset=><option value={asset.id} key={asset.id}>{asset.fileName} · {formatBytes(asset.size)}</option>)}</select><small>如需新文件，请先通过“媒体与附件”上传。</small></label>}<label>{kind==="text"?"回复内容":"附件说明（可选）"}<textarea value={text} onChange={event=>setText(event.target.value)} maxLength={65536} placeholder={kind==="text"?"输入快捷回复内容":"随媒体发送的文字说明"}/></label><label>搜索标签（可选）<input value={tags} onChange={event=>setTags(event.target.value)} maxLength={200} placeholder="例如：报价 售后 英文"/></label>{error&&<span className="login-error">{error}</span>}<div className="quick-reply-editor-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" onClick={submit} disabled={!title.trim()||(kind==="text"&&!text.trim())||(kind!=="text"&&!selected)}><Check size={14}/>{item?"保存修改":"新增快捷回复"}</button></div></section></div>;
}

function TranslationPreviewDialog({source,translated,targetLanguage,onClose,onConfirm}:{source:string;translated:string;targetLanguage:string;onClose:()=>void;onConfirm:(text:string)=>void}){
  const [text,setText]=useState(translated);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[onClose]);
  return <div className="modal-backdrop" role="presentation"><section className="login-dialog translation-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="translation-preview-title"><button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Languages size={21}/></span><h2 id="translation-preview-title">确认翻译后发送</h2><p>目标语言：{languageName(targetLanguage)}。译文可以在发送前继续修改。</p><label>原文<textarea value={source} readOnly/></label><label>将发送的译文 <span className="tts-count">{text.length}/65536</span><textarea value={text} onChange={event=>setText(event.target.value)} maxLength={65536} autoFocus/></label><div className="translation-preview-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" disabled={!text.trim()} onClick={()=>onConfirm(text.trim())}><Send size={14}/>确认并发送</button></div></section></div>;
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

function TextToSpeechDialog({accountId,token,initialText,translationEnabled,translationConfigured,targetLanguage,onToken,onClose,onSend}:{accountId:string;token:string;initialText:string;translationEnabled:boolean;translationConfigured:boolean;targetLanguage:string;onToken:(token:string)=>void;onClose:()=>void;onSend:(asset:MediaAsset)=>Promise<void>}){
  const [text,setText]=useState(initialText),[translatedText,setTranslatedText]=useState(""),[translationSource,setTranslationSource]=useState(""),[speed,setSpeed]=useState(1),[instructions,setInstructions]=useState("用自然、友好、适合客户沟通的语气朗读"),[busy,setBusy]=useState<"translating"|"generating"|null>(null),[error,setError]=useState(""),[provider,setProvider]=useState<string|null>(null),[configured,setConfigured]=useState<boolean|null>(null);
  useEffect(()=>{void (async()=>{const result=await authorizedFetch("/api/v1/tts/status",token);if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {configured?:boolean;provider?:string};setConfigured(Boolean(body.configured));setProvider(body.provider??null);})().catch(()=>setConfigured(false));},[token,onToken]);
  const translationPreviewReady=translationEnabled&&Boolean(translationSource)&&translationSource===text.trim();
  async function previewTranslation(){
    const source=text.trim();
    if(!source||busy)return;
    if(!translationConfigured){setError("AI 翻译暂不可用，请联系管理员配置 Provider");return;}
    setBusy("translating");setError("");
    try{
      const result=await authorizedFetch("/api/v1/translations/preview",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:source,targetLanguage})});if(result.token!==token)onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {translatedText?:string;message?:string};
      if(!result.response.ok||!body.translatedText)throw new Error(body.message??"翻译失败");
      const translated=body.translatedText.trim();
      if(translated.length>4096)throw new Error("译文超过 4096 个字符，请缩短原文后重试");
      setTranslationSource(source);setTranslatedText(translated);
    }catch(reason){setError(reason instanceof Error?reason.message:"AI 翻译失败，尚未生成语音");}
    finally{setBusy(null);}
  }
  async function generate(){
    const speechText=translationEnabled?translatedText.trim():text.trim();
    if(!speechText||busy||(translationEnabled&&!translationPreviewReady))return;setBusy("generating");setError("");
    try{
      const result=await authorizedFetch("/api/v1/text-to-speech",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,text:speechText,speed,instructions:instructions.trim()||undefined})});if(result.token!==token)onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;
      if(!result.response.ok)throw new Error(String(body.message??(body.error==="tts_not_configured"?"管理员尚未启用语音 Provider":`生成失败（HTTP ${result.response.status}）`)));
      await onSend({id:String(body.mediaId),fileName:String(body.fileName),mimeType:String(body.mimeType),size:Number(body.size),sha256:String(body.sha256),createdAt:new Date().toISOString(),usageCount:0});
    }catch(reason){setError(reason instanceof Error?reason.message:"AI 语音生成失败，请稍后重试");setBusy(null);}
  }
  return <div className="modal-backdrop media-backdrop" role="presentation"><section className="login-dialog tts-dialog" role="dialog" aria-modal="true" aria-labelledby="tts-title"><button className="login-close" onClick={onClose} disabled={Boolean(busy)} aria-label="关闭"><X size={17}/></button><div className="login-logo"><Sparkles size={20}/></div><h2 id="tts-title">AI 文字转语音</h2><p>{translationEnabled?`此会话已开启 AI 翻译。请先预览并确认 ${languageName(targetLanguage)} 译文，再生成语音并发送。`:"输入要发送的内容，生成后会作为 WhatsApp 语音消息直接排队发送。"}</p><label>{translationEnabled?"原文":"朗读文字"} <span className="tts-count">{text.length}/4096</span><textarea value={text} onChange={event=>{setText(event.target.value);setTranslationSource("");setTranslatedText("");setError("");}} maxLength={4096} readOnly={Boolean(busy)} autoFocus placeholder="输入需要朗读并发送的文字"/></label>{translationEnabled&&translationPreviewReady&&<label className="tts-translation-preview">将朗读的译文 <span className="tts-count">{translatedText.length}/4096</span><textarea value={translatedText} onChange={event=>setTranslatedText(event.target.value)} maxLength={4096} disabled={Boolean(busy)} autoFocus/><small><Languages size={12}/>目标语言：{languageName(targetLanguage)} · 发送前可修改译文</small></label>}<label>语速 <span className="tts-speed">{speed.toFixed(2)}×</span><input type="range" min="0.75" max="1.5" step="0.05" value={speed} disabled={Boolean(busy)} onChange={event=>setSpeed(Number(event.target.value))}/></label><label>语气要求（部分 Provider 支持）<input value={instructions} onChange={event=>setInstructions(event.target.value)} disabled={Boolean(busy)} maxLength={500} placeholder="例如：专业、亲切，稍微放慢语速"/></label>{translationEnabled&&<div className={`tts-disclosure ${translationConfigured?"":"warning"}`}><Languages size={14}/><span>{translationConfigured?`AI 会先将原文翻译为 ${languageName(targetLanguage)}；确认译文前不会生成或发送语音。`:"管理员尚未启用 AI 翻译 Provider。"}</span></div>}<div className={`tts-disclosure ${configured===false?"warning":""}`}><Info size={14}/><span>{configured===null?"正在读取 Provider 配置…":configured?`文字会发送给 ${providerName(provider)} 生成 AI 音频。`:`管理员尚未在系统设置中启用语音 Provider。`}</span></div>{error&&<span className="login-error">{error}</span>}<button className="login-submit" onClick={()=>void (translationEnabled&&!translationPreviewReady?previewTranslation():generate())} disabled={Boolean(busy)||!text.trim()||configured!==true||(translationEnabled&&!translationConfigured)||(translationPreviewReady&&!translatedText.trim())}>{busy==="translating"?<><RefreshCw className="spin" size={15}/>正在翻译…</>:busy==="generating"?<><RefreshCw className="spin" size={15}/>正在生成并发送…</>:translationEnabled&&!translationPreviewReady?<><Languages size={15}/>预览翻译</>:<><Mic size={15}/>{translationEnabled?"确认译文并生成发送":"生成并发送语音"}</>}</button></section></div>;
}

const MEDIA_PAGE_SIZE=24;

function MediaDialog({accountId,token,initialCaption,onToken,onToast,onClose,onSend}:{accountId:string;token:string;initialCaption:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onClose:()=>void;onSend:(asset:MediaAsset,caption:string)=>Promise<void>}){
  const [assets,setAssets]=useState<MediaAsset[]>([]),[selectedId,setSelectedId]=useState(""),[query,setQuery]=useState(""),[debouncedQuery,setDebouncedQuery]=useState(""),[filter,setFilter]=useState("all"),[caption,setCaption]=useState(initialCaption),[busy,setBusy]=useState(false),[dragging,setDragging]=useState(false),[loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false),[total,setTotal]=useState(0),[error,setError]=useState("");
  const inputRef=useRef<HTMLInputElement>(null),gridRef=useRef<HTMLDivElement>(null),sentinelRef=useRef<HTMLDivElement>(null),tokenRef=useRef(token),onTokenRef=useRef(onToken),loadVersionRef=useRef(0),loadingMoreRef=useRef(false);
  useEffect(()=>{tokenRef.current=token;onTokenRef.current=onToken;},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>setDebouncedQuery(query.trim()),250);return()=>window.clearTimeout(timer);},[query]);
  const loadPage=useCallback(async(offset:number,replace:boolean,version:number,signal?:AbortSignal)=>{
    if(!replace&&loadingMoreRef.current)return;
    if(replace){loadingMoreRef.current=false;setLoadingMore(false);setLoading(true);setAssets([]);setTotal(0);}else{loadingMoreRef.current=true;setLoadingMore(true);}
    setError("");
    try{
      const params=new URLSearchParams({accountId,limit:String(MEDIA_PAGE_SIZE),offset:String(offset),kind:filter});if(debouncedQuery)params.set("q",debouncedQuery);
      const currentToken=tokenRef.current,result=await authorizedFetch(`/api/v1/media?${params}`,currentToken,{signal});
      if(result.token!==currentToken)onTokenRef.current(result.token);
      const body=await result.response.json().catch(()=>({})) as {data?:Array<Record<string,unknown>>;total?:number};
      if(!result.response.ok||!body.data)throw new Error(`媒体库加载失败（HTTP ${result.response.status}）`);
      if(version!==loadVersionRef.current)return;
      const next=body.data.map(mapMediaAsset);
      setAssets(current=>replace?next:[...current,...next.filter(item=>!current.some(existing=>existing.id===item.id))]);
      setTotal(Number(body.total??next.length));
    }catch(reason){if(!signal?.aborted&&version===loadVersionRef.current)setError(reason instanceof Error?reason.message:"媒体库加载失败");}
    finally{if(version===loadVersionRef.current){if(replace)setLoading(false);else{loadingMoreRef.current=false;setLoadingMore(false);}}}
  },[accountId,debouncedQuery,filter]);
  const refresh=useCallback(async()=>{const version=++loadVersionRef.current;await loadPage(0,true,version);},[loadPage]);
  useEffect(()=>{const controller=new AbortController(),version=++loadVersionRef.current;void loadPage(0,true,version,controller.signal);return()=>controller.abort();},[loadPage]);
  const hasMore=assets.length<total;
  useEffect(()=>{const root=gridRef.current,sentinel=sentinelRef.current;if(!root||!sentinel||!hasMore||loading||loadingMore)return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))void loadPage(assets.length,false,loadVersionRef.current);},{root,rootMargin:"180px"});observer.observe(sentinel);return()=>observer.disconnect();},[assets.length,hasMore,loadPage,loading,loadingMore]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy)onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[busy,onClose]);
  useEffect(()=>{const paste=(event:ClipboardEvent)=>{if(busy)return;void (async()=>{const files=await clipboardFiles(event);if(!files.length)return;event.preventDefault();await upload(files);})();};window.addEventListener("paste",paste);return()=>window.removeEventListener("paste",paste);});
  const selected=assets.find(item=>item.id===selectedId)??null;
  async function upload(files:FileList|File[]){const list=Array.from(files);if(!list.length)return;setBusy(true);setError("");try{let last:MediaAsset|null=null;for(const file of list){if(file.size>64*1024*1024)throw new Error(`${file.name} 超过 64 MB`);const form=new FormData();form.append("file",file);const currentToken=tokenRef.current,result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}`,currentToken,{method:"POST",body:form});if(result.token!==currentToken)onTokenRef.current(result.token);if(!result.response.ok)throw new Error(`${file.name} 上传失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {mediaId:string;fileName:string;mimeType:string;size:number;sha256:string};last={id:body.mediaId,fileName:body.fileName,mimeType:body.mimeType,size:body.size,sha256:body.sha256,createdAt:new Date().toISOString(),usageCount:0};}await refresh();if(last)setSelectedId(last.id);onToast(list.length>1?`${list.length} 个文件已加入媒体库`:"文件已加入媒体库");}catch(reason){setError(reason instanceof Error?reason.message:"上传失败");}finally{setBusy(false);setDragging(false);}}
  async function remove(asset:MediaAsset){if(asset.usageCount>0){setError("该文件已被消息使用，不能删除");return;}if(!await confirmAction(`文件“${asset.fileName}”将从媒体库中永久删除。`,{title:"删除媒体文件？",confirmLabel:"删除"}))return;setBusy(true);const currentToken=tokenRef.current,result=await authorizedFetch(`/api/v1/media/${asset.id}`,currentToken,{method:"DELETE"});if(result.token!==currentToken)onTokenRef.current(result.token);setBusy(false);if(!result.response.ok){setError(result.response.status===409?"该文件已被消息使用，不能删除":`删除失败（HTTP ${result.response.status}）`);return;}if(selectedId===asset.id)setSelectedId("");setAssets(current=>current.filter(item=>item.id!==asset.id));setTotal(current=>Math.max(0,current-1));onToast("文件已从媒体库删除");}
  return <div className="modal-backdrop media-backdrop" role="presentation"><section className="media-dialog" role="dialog" aria-modal="true" aria-labelledby="media-dialog-title"><header><div><span className="login-logo"><Paperclip size={21}/></span><span><h2 id="media-dialog-title">媒体与附件</h2><p>上传一次，之后可在该 WhatsApp 账号的会话中复用。</p></span></div><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button></header><div className={`media-dropzone ${dragging?"dragging":""}`} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();void upload(event.dataTransfer.files)}} onClick={()=>inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")inputRef.current?.click();}}><UploadCloud size={30}/><b>{busy?"正在上传…":"拖拽文件到这里、直接粘贴，或点击选择"}</b><span>图片、MP4、OGG、MP3、PDF、ZIP；单文件最大 64 MB</span><input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,audio/ogg,audio/mpeg,application/pdf,application/zip" onChange={event=>{if(event.target.files)void upload(event.target.files);event.currentTarget.value="";}}/></div><div className="media-library-head"><div><b>媒体库</b><span>{loading?"正在加载…":`已加载 ${assets.length} / 共 ${total} 个文件`}</span></div><label><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索全部文件名"/></label></div><div className="media-filters">{[["all","全部"],["image","图片"],["video","视频"],["audio","音频"],["document","文档"]].map(([value,label])=><button key={value} className={filter===value?"active":""} onClick={()=>setFilter(value)}>{label}</button>)}</div><div ref={gridRef} className="media-grid">{loading&&!assets.length?<div className="media-load-more"><RefreshCw className="spin" size={18}/>正在加载第一批文件…</div>:assets.length?assets.map(asset=>{const kind=mediaKind(asset.mimeType);return <div key={asset.id} role="button" tabIndex={0} className={`media-item ${kind==="image"?"with-image-preview":""} ${selectedId===asset.id?"selected":""}`} onClick={()=>setSelectedId(asset.id)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")setSelectedId(asset.id);}}>{kind==="image"?<ProductImage mediaId={asset.id} token={token} onToken={onToken} alt={asset.fileName} className="media-library-preview" preview/>:<span className={`media-kind ${kind}`}><FileText size={22}/></span>}<span><b title={asset.fileName}>{asset.fileName}</b><small>{formatBytes(asset.size)} · {asset.usageCount?`已使用 ${asset.usageCount} 次`:"未使用"}</small></span><button type="button" className="media-delete-button" aria-label={`删除 ${asset.fileName}`} title={asset.usageCount?"该文件正在使用，不能删除":"删除此文件"} disabled={busy||asset.usageCount>0} onClick={event=>{event.stopPropagation();void remove(asset)}}><Trash2 size={14}/><span>删除</span></button></div>}):<div className="media-empty"><FileText size={28}/><b>媒体库中暂无匹配文件</b><span>{debouncedQuery?"搜索已覆盖全部媒体与附件":"可从上方拖拽或粘贴上传"}</span></div>}{assets.length>0&&hasMore&&<div ref={sentinelRef} className="media-load-more">{loadingMore?<><RefreshCw className="spin" size={16}/>正在加载更多…</>:<span>继续滚动加载更多</span>}</div>}</div>{error&&<span className="login-error media-error">{error}</span>}<footer><label>附件说明（可选）<input value={caption} onChange={event=>setCaption(event.target.value)} maxLength={65536} placeholder="随附件一起发送的文字"/></label><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" disabled={!selected||busy} onClick={()=>selected&&void onSend(selected,caption.trim())}>发送所选附件</button></footer></section></div>;
}

function mapMediaAsset(item:Record<string,unknown>):MediaAsset{return{id:String(item.id),fileName:String(item.file_name??"未命名文件"),mimeType:String(item.mime_type??"application/octet-stream"),size:Number(item.byte_size??0),sha256:String(item.sha256??""),createdAt:String(item.created_at??""),usageCount:Number(item.usage_count??0)};}
function mediaKind(mime:string){return mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":"document";}

function mapConversation(item:Record<string,unknown>,index:number):Conversation {const name=String(item.display_name??item.phone_e164??item.provider_user_id??"未知联系人"),methods=Array.isArray(item.contact_methods)?item.contact_methods.map(mapContactMethod):[],lastDirection=item.last_message_direction==="in"||item.last_message_direction==="out"?item.last_message_direction:null,lastMessageStatus:Conversation["lastMessageStatus"]=["received","queued","dispatching","sent","delivered","read","failed","uncertain"].includes(String(item.last_message_status))?item.last_message_status as NonNullable<Conversation["lastMessageStatus"]>:null,lastMessageAt=item.last_message_at?String(item.last_message_at):null,windowExpiresAt=(item.reply_window_expires_at??item.service_window_expires_at)?String(item.reply_window_expires_at??item.service_window_expires_at):null;return{id:String(item.id),name,initials:name.slice(0,2).toUpperCase(),color:COLORS[index%COLORS.length],account:String(item.account_name??"未知账号"),accountId:String(item.account_id),phone:String(item.phone_e164??""),providerUserId:String(item.provider_user_id??""),contactId:String(item.contact_id??""),alias:String(item.alias??""),contactName:String(item.contact_name??item.phone_e164??item.provider_user_id??""),primaryEmail:String(item.primary_email??""),contactMethods:methods,preview:String(item.last_message??kindText(String(item.last_message_kind??""))),lastDirection,lastMessageStatus,lastMessageAt,time:lastMessageAt?formatTime(new Date(lastMessageAt)):"",unread:Number(item.unread_count??0),accountStatus:String(item.account_status??"offline"),assignedUserId:item.assigned_user_id?String(item.assigned_user_id):null,favorite:Boolean(item.favorite),conversationStatus:String(item.status??"open"),customerStage:String(item.customer_stage??"new"),tags:Array.isArray(item.tags)?item.tags.map(mapTag):[],remindAt:item.remind_at?String(item.remind_at):null,platform:item.platform==="messenger"?"messenger":"whatsapp",pageId:item.page_id?String(item.page_id):null,transport:String(item.transport??"web") as "web"|"cloud",serviceWindowExpiresAt:windowExpiresAt,replyWindowExpiresAt:windowExpiresAt};}
function mapContactMethod(item:Record<string,unknown>):ContactMethod{return{id:item.id?String(item.id):undefined,type:String(item.type??"other") as ContactMethodType,label:String(item.label??""),value:String(item.value??"")};}
function mapContactProfile(item:Record<string,unknown>):ContactProfile{const emails=Array.isArray(item.emails)?item.emails.map(email=>{const value=email as Record<string,unknown>;return{id:value.id?String(value.id):undefined,label:String(value.label??""),email:String(value.email??""),isPrimary:Boolean(value.isPrimary??value.is_primary)};}):[],methods=Array.isArray(item.methods)?item.methods.map(method=>mapContactMethod(method as Record<string,unknown>)):[],addresses=Array.isArray(item.addresses)?item.addresses.map(address=>mapCustomerAddress(address as Record<string,unknown>)):[],birthday=item.birthday&&typeof item.birthday==="object"?item.birthday as ContactDate:null,specialDates=Array.isArray(item.specialDates)?item.specialDates as ContactSpecialDate[]:[],conversationId=item.conversationId?String(item.conversationId):item.conversation_id?String(item.conversation_id):null;return{id:String(item.id),accountId:String(item.accountId??item.account_id??""),accountName:String(item.accountName??item.account_name??""),alias:String(item.alias??""),contactName:String(item.contactName??item.contact_name??""),firstName:String(item.firstName??item.first_name??""),middleName:String(item.middleName??item.middle_name??""),lastName:String(item.lastName??item.last_name??""),name:String(item.name??item.alias??item.contactName??item.phone??"未知联系人"),phone:String(item.phone??item.phone_e164??""),avatarUrl:item.avatarUrl?String(item.avatarUrl):item.avatar_url?String(item.avatar_url):null,note:String(item.note??""),timezone:item.timezone?String(item.timezone):null,preferredLanguage:item.preferredLanguage?String(item.preferredLanguage):item.preferred_language?String(item.preferred_language):null,effectiveTimezone:String(item.effectiveTimezone??item.effective_timezone??"UTC"),timezoneSource:(item.timezoneSource??item.timezone_source??"fallback") as ContactProfile["timezoneSource"],inferredCountry:item.inferredCountry?String(item.inferredCountry):item.inferred_country?String(item.inferred_country):null,birthday,specialDates,emails,primaryEmail:item.primaryEmail?String(item.primaryEmail):emails.find(email=>email.isPrimary)?.email??null,methods,addresses,conversationId,hasConversation:Boolean(item.hasConversation??conversationId),lastMessageAt:item.lastMessageAt?String(item.lastMessageAt):item.last_message_at?String(item.last_message_at):null,updatedAt:String(item.updatedAt??item.updated_at??"")};}

function ContactLocalTime({contact}:{contact:ContactProfile}){
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(new Date()),30_000);return()=>window.clearInterval(timer);},[]);
  let value="时间不可用";try{value=new Intl.DateTimeFormat("zh-CN",{timeZone:contact.effectiveTimezone,weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(now);}catch{}
  const source=contact.timezoneSource==="custom"?"已设置时区":contact.timezoneSource==="country"?`${contact.inferredCountry??"号码国家/地区"}推算`:"未识别国家/地区，使用 UTC";
  return <div className="contact-local-time" title={`${contact.effectiveTimezone} · ${source}`}><Clock3 size={14}/><span><b>{value}</b><small>对方当前时间 · {source}</small></span></div>;
}
function contactMethodName(type:ContactMethodType){return({phone:"电话",wechat:"微信",telegram:"Telegram",line:"Line",website:"网站",facebook:"Facebook",x:"X",linkedin:"LinkedIn",instagram:"Instagram",other:"其他"} as Record<ContactMethodType,string>)[type];}
function isSocialContactMethod(type:ContactMethodType):type is "facebook"|"x"|"linkedin"|"instagram"{return ["facebook","x","linkedin","instagram"].includes(type);}
function socialContactUrl(method:ContactMethod){
  const value=method.value.trim();
  if(/^https?:\/\//i.test(value))return value;
  const handle=value.replace(/^@/,"").replace(/^\/+/,"");
  const domains={facebook:"facebook.com",x:"x.com",linkedin:"linkedin.com",instagram:"instagram.com"} as const;
  const domain=domains[method.type as keyof typeof domains];
  if(!domain)return "";
  const knownDomain=method.type==="x"?"(?:x\\.com|twitter\\.com)":domain.replace(".","\\.");
  if(new RegExp(`^(?:www\\.)?${knownDomain}/`,"i").test(handle))return `https://${handle}`;
  return method.type==="linkedin"?`https://${domain}/in/${handle}`:`https://${domain}/${handle}`;
}
function ContactSocialLinks({methods}:{methods:ContactMethod[]}){
  const socialMethods=methods.filter(method=>isSocialContactMethod(method.type));
  if(!socialMethods.length)return null;
  return <div className="contact-social-links" aria-label="社交媒体链接">{socialMethods.map((method,index)=>{
    const label=method.label||contactMethodName(method.type);
    const icon=method.type==="facebook"?<Facebook size={17}/>:method.type==="linkedin"?<Linkedin size={17}/>:method.type==="instagram"?<Instagram size={17}/>:<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.24l-4.89-6.39L6.48 22H3.36l7.26-8.3L2.97 2h6.4l4.42 5.84L18.9 2Zm-1.1 17.84h1.73L8.43 4.05H6.58L17.8 19.84Z" fill="currentColor"/></svg>;
    return <a key={`${method.type}-${method.id??index}`} href={socialContactUrl(method)} target="_blank" rel="noopener noreferrer" aria-label={`打开 ${label}`} title={`${label} · ${method.value}`}>{icon}</a>;
  })}</div>;
}
function mapTag(item:Record<string,unknown>):TagItem{return{id:String(item.id),name:String(item.name??"标签"),color:String(item.color??"#DFF5E8")};}
function mapMessage(item:Record<string,unknown>):ChatMessage {const kind=String(item.kind??"text"),mediaId=String(item.media_id??""),occurredAt=String(item.occurred_at),quotedId=String(item.quoted_message_id??""),commandId=String(item.command_id??"");return{id:String(item.id),direction:item.direction as "in"|"out",kind,text:String(item.text_content??(mediaId?"":kindText(kind))),platform:item.platform==="messenger"?"messenger":"whatsapp",providerMessageId:item.provider_message_id?String(item.provider_message_id):undefined,pageId:item.page_id?String(item.page_id):undefined,quoted:quotedId?{id:quotedId,direction:item.quoted_direction as "in"|"out",kind:String(item.quoted_kind??"text"),text:String(item.quoted_text_content??item.quoted_file_name??kindText(String(item.quoted_kind??"text")))}:undefined,translationSourceText:item.translation_source_text?String(item.translation_source_text):undefined,translationTargetLanguage:item.translation_target_language?String(item.translation_target_language):undefined,failureMessage:item.failure_message?String(item.failure_message):undefined,queueDiagnostic:item.direction==="out"?{commandId,state:String(item.command_state??""),attempt:Number(item.command_attempt??0),lastError:String(item.command_last_error??""),availableAt:String(item.command_available_at??""),claimedAt:String(item.command_claimed_at??""),createdAt:String(item.command_created_at??""),accountStatus:String(item.account_status??""),agentStatus:String(item.agent_status??""),agentLastSeenAt:String(item.agent_last_seen_at??"")}:undefined,cachedTranslationText:item.cached_translation_text?String(item.cached_translation_text):undefined,cachedTranslationLanguage:item.cached_translation_language?String(item.cached_translation_language):undefined,cachedTranslationSourceLanguage:item.cached_translation_source_language?String(item.cached_translation_source_language):undefined,cachedTranscriptionText:item.cached_transcription_text?String(item.cached_transcription_text):undefined,time:formatMessageTime(occurredAt),occurredAt,status:item.status as ChatMessage["status"],attachment:item.file_name&&mediaId?{id:mediaId,name:String(item.file_name),mime:String(item.mime_type??"文件"),size:formatBytes(Number(item.byte_size??0))}:undefined};}

function messageQuote(message:ChatMessage):NonNullable<ChatMessage["quoted"]>{return{id:message.id,direction:message.direction,kind:message.kind,text:message.text||message.attachment?.name||kindText(message.kind)};}
function mapEmailActivity(item:Record<string,unknown>):EmailActivity{return{id:String(item.id),subject:String(item.subject),recipients:Array.isArray(item.recipients)?item.recipients.map(value=>{const recipient=value as Record<string,unknown>;return{email:String(recipient.email),label:String(recipient.label??"")};}):[],contentType:String(item.content_type),status:String(item.status) as EmailActivity["status"],attempt:Number(item.attempt??0),lastError:String(item.last_error??""),createdAt:String(item.created_at),senderName:String(item.sender_name??""),attachmentCount:Number(item.attachment_count??0)};}
function emailStatusText(status:EmailActivity["status"]){return({queued:"已排队",sending:"发送中",retrying:"等待重试",accepted:"服务商已接受",failed:"发送失败"})[status];}
function emailContentTypeText(type:string){return type==="order_text"?"文字订单":type==="order_image"?"图片订单":"产品卡";}
function kindText(kind:string){return({audio:"[语音消息]",image:"[图片]",video:"[视频]",document:"[文档]",location:"[位置]",contact:"[联系人名片]"} as Record<string,string>)[kind]??"暂无消息";}
function statusText(status:string){return({online:"在线",pairing:"等待配对",offline:"离线",logged_out:"已退出",error:"异常"} as Record<string,string>)[status]??status;}
function formatTime(date:Date){return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});}
function formatBytes(size:number){if(size<1024)return`${size} B`;if(size<1048576)return`${(size/1024).toFixed(1)} KB`;return`${(size/1048576).toFixed(1)} MB`;}
function parseFormattedBytes(value:string){const amount=Number.parseFloat(value)||0;if(/MB$/i.test(value))return Math.round(amount*1048576);if(/KB$/i.test(value))return Math.round(amount*1024);return Math.round(amount);}
function quickReplyStorageKey(userId:string,accountId:string){return`relayQuickReplies:${userId}:${accountId}`;}
function tokenSubject(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).sub??"");}catch{return"";}}
function tokenRole(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role??"");}catch{return"";}}
function storeSession(token:string,user:User,rememberMe:boolean){
  clearStoredSession();
  const storage=rememberMe?localStorage:sessionStorage;
  storage.setItem("relayAccessToken",token);storage.setItem("relayUser",JSON.stringify(user));
  if(rememberMe)localStorage.setItem(REMEMBER_LOGIN_KEY,"true");
}
function storeRefreshedToken(token:string){
  const storage=localStorage.getItem(REMEMBER_LOGIN_KEY)==="true"?localStorage:sessionStorage;
  storage.setItem("relayAccessToken",token);
}
function clearStoredSession(){
  for(const storage of [localStorage,sessionStorage]){storage.removeItem("relayAccessToken");storage.removeItem("relayUser");}
  localStorage.removeItem(REMEMBER_LOGIN_KEY);
}
async function authorizedFetch(path:string,token:string,init:RequestInit={}):Promise<{response:Response;token:string}>{
  const send=(accessToken:string)=>fetch(`${API_URL}${path}`,{...init,credentials:"include",headers:{...init.headers,authorization:`Bearer ${accessToken}`}});
  let response=await send(token);if(response.status!==401)return{response,token};
  refreshPromise??=refreshAccessToken();
  let refreshedToken="";try{refreshedToken=await refreshPromise;}finally{refreshPromise=null;}
  if(!refreshedToken)return{response,token};
  storeRefreshedToken(refreshedToken);response=await send(refreshedToken);return{response,token:refreshedToken};
}
async function refreshAccessToken(){const response=await fetch(`${API_URL}/api/v1/auth/refresh`,{method:"POST",credentials:"include"});if(!response.ok)return"";const body=await response.json() as {accessToken?:string};return body.accessToken??"";}

function EmptyState({title,text}:{title:string;text:string}){return <div className="empty-state"><b>{title}</b><span>{text}</span></div>;}

function SecretField({label,value,onChange,placeholder,hint}:{label:string;value:string;onChange:(value:string)=>void;placeholder?:string;hint?:string}){
  const [visible,setVisible]=useState(false),[copied,setCopied]=useState(false);
  async function copy(){if(!value)return;let copiedValue=false;if(navigator.clipboard?.writeText)try{await navigator.clipboard.writeText(value);copiedValue=true;}catch{}if(!copiedValue){const input=document.createElement("textarea");input.value=value;input.style.position="fixed";input.style.opacity="0";document.body.appendChild(input);input.select();copiedValue=document.execCommand("copy");input.remove();}setCopied(copiedValue);if(copiedValue)window.setTimeout(()=>setCopied(false),1600);}
  return <label>{label}<div className="secret-input"><input type={visible?"text":"password"} autoComplete="new-password" value={value} onChange={event=>onChange(event.target.value)} placeholder={placeholder}/><button type="button" onClick={()=>setVisible(value=>!value)} aria-label={visible?`隐藏${label}`:`显示${label}`} title={visible?"隐藏":"显示"}>{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button><button type="button" onClick={()=>void copy()} disabled={!value} aria-label={`复制${label}`} title={copied?"已复制":"复制"}>{copied?<Check size={16}/>:<Copy size={16}/>}</button></div>{hint&&<small>{hint}</small>}</label>;
}
function AccountStatus({initials,color,name,detail,online=false}:{initials:string;color:string;name:string;detail:string;online?:boolean}){return <div className={`account-status ${online?"":"muted"}`}><span className={`avatar tiny ${color}`}>{initials}</span><span><b>{name}</b><small><i className={`status-dot ${online?"online":""}`}/>{detail}</small></span></div>;}
function MessageStatus({status}:{status?:ChatMessage["status"]}){if(status==="queued"||status==="dispatching")return <span className="message-state queued"><Clock3 size={12}/>{status==="queued"?"排队中":"发送中"}</span>;if(status==="failed"||status==="uncertain")return <span className="message-state failed"><X size={12}/>{status==="failed"?"失败":"待确认"}</span>;if(status==="read")return <span className="message-state read"><CheckCheck size={13}/>已读</span>;if(status==="delivered")return <span className="message-state"><CheckCheck size={13}/>已送达</span>;return <span className="message-state"><Check size={13}/>已发送</span>;}
function QueueDiagnostic({message}:{message:ChatMessage}){const diagnostic=message.queueDiagnostic;if(!diagnostic?.commandId)return <small className="message-queue-diagnostic warning"><Info size={11}/>未找到发送命令，请刷新页面后重试</small>;const agentOnline=diagnostic.agentStatus==="online",accountOnline=diagnostic.accountStatus==="online",label=message.status==="dispatching"?"Agent 已接收，正在执行":!agentOnline?"等待 Agent 上线":!accountOnline?"等待 WhatsApp 账号上线":diagnostic.lastError?"等待自动重试":"等待 Agent 接收";const detail=[`命令 ${diagnostic.commandId.slice(0,8)}`,`尝试 ${diagnostic.attempt}`,diagnostic.lastError||"",diagnostic.agentLastSeenAt?`Agent 最近运行 ${formatDateTime(diagnostic.agentLastSeenAt)}`:""].filter(Boolean).join(" · ");return <small className={`message-queue-diagnostic ${agentOnline&&accountOnline?"":"warning"}`}><Info size={11}/><span><b>{label}</b><em>{detail}</em></span></small>;}

function QuotedMessage({quote,customerName}:{quote:NonNullable<ChatMessage["quoted"]>;customerName:string}){return <div className="quoted-message"><b>{quote.direction==="in"?customerName:"我方"}</b><span>{quote.text||kindText(quote.kind)}</span></div>;}

function MessageMedia({attachment,token,onToken,onReady}:{attachment:{id:string;name:string;size:string;mime:string};token:string;onToken:(token:string)=>void;onReady:()=>void}){
  const [url,setUrl]=useState("");const [error,setError]=useState("");
  const hostRef=useRef<HTMLDivElement>(null),tokenRef=useRef(token),onTokenRef=useRef(onToken),onReadyRef=useRef(onReady);
  useEffect(()=>{tokenRef.current=token;},[token]);
  useEffect(()=>{onTokenRef.current=onToken;},[onToken]);
  useEffect(()=>{onReadyRef.current=onReady;},[onReady]);
  useEffect(()=>{
    let cancelled=false,acquired=false;
    let observer:IntersectionObserver|undefined;
    const start=()=>{
      if(acquired)return;
      acquired=true;observer?.disconnect();
      void acquireMedia(attachment.id,async()=>{
        const currentToken=tokenRef.current;
        const result=await authorizedFetch(`/api/v1/media/${attachment.id}`,currentToken);
        if(result.token!==currentToken)onTokenRef.current(result.token);
        if(!result.response.ok)throw new Error(`HTTP ${result.response.status}`);
        return result.response.blob();
      }).then(value=>{if(!cancelled){setUrl(value);setError("");}}).catch(reason=>{if(!cancelled)setError(reason instanceof Error?reason.message:"媒体加载失败");});
    };
    const element=hostRef.current;
    if(!element||typeof IntersectionObserver==="undefined")start();
    else{
      observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))start();},{root:element.closest(".messages"),rootMargin:"600px 0px"});
      observer.observe(element);
    }
    return()=>{cancelled=true;observer?.disconnect();if(acquired)releaseMedia(attachment.id);};
  },[attachment.id]);
  if(error)return <div ref={hostRef} className="message-media message-media-error">媒体加载失败 · {error}</div>;if(!url)return <div ref={hostRef} className="message-media message-media-loading">正在加载媒体…</div>;
  if(attachment.mime.startsWith("image/"))return <div ref={hostRef} className="message-media"><button className="message-media-preview" onClick={()=>window.open(url,"_blank","noopener,noreferrer")} aria-label={`查看图片 ${attachment.name}`}><Image src={url} alt={attachment.name} width={440} height={440} unoptimized onLoad={()=>onReadyRef.current()}/></button></div>;
  if(attachment.mime.startsWith("video/"))return <div ref={hostRef} className="message-media"><video src={url} controls preload="metadata" aria-label={attachment.name} onLoadedMetadata={()=>onReadyRef.current()}/></div>;
  if(attachment.mime.startsWith("audio/"))return <div ref={hostRef} className="message-media"><audio src={url} controls preload="metadata" aria-label={attachment.name} onLoadedMetadata={()=>onReadyRef.current()}/></div>;
  return <div ref={hostRef} className="message-media"><button className="attachment-card" onClick={()=>{const link=document.createElement("a");link.href=url;link.download=attachment.name;link.click();}}><span><FileText size={20}/></span><span><b>{attachment.name}</b><small>{attachment.mime} · {attachment.size}</small></span></button></div>;
}

function AgentConversationBar({conversationId,token,refreshKey,onToken,onToast,onUseDraft,onSent}:{conversationId:string;token:string;refreshKey:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onUseDraft:(text:string)=>void;onSent:()=>void}){
  const [state,setState]=useState<{mode:string;account_enabled:boolean;draft:AgentDraft|null}|null>(null),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{try{const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/agent`,token);if(result.token!==token)onToken(result.token);if(result.response.ok)setState(await result.response.json());}catch{}},[conversationId,token,onToken]);
  useEffect(()=>{const first=window.setTimeout(()=>void load(),0),poll=window.setInterval(()=>void load(),8000);return()=>{window.clearTimeout(first);window.clearInterval(poll);};},[load,refreshKey]);
  async function setMode(mode:"cautious"|"full"|"human_paused"){setBusy(true);const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/agent`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({mode})});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){onToast(mode==="cautious"?"已启用谨慎接管，证据不足时将等待人工确认":mode==="full"?"已启用完全接管，Agent 回复无需人工确认":"已切换人工接管，待跟进任务已取消");await load();}}
  async function resolveDraft(action:"send"|"dismiss"){if(!state?.draft)return;setBusy(true);const result=await authorizedFetch(`/api/v1/ai-drafts/${state.draft.id}/${action}`,token,{method:"POST",headers:{"content-type":"application/json"},body:action==="send"?JSON.stringify({text:state.draft.text_content}):undefined});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){onToast(action==="send"?"AI 草稿已进入发送队列，Agent 已转为人工接管":"AI 草稿已忽略");await load();onSent();}}
  if(!state)return null;const paused=state.mode==="human_paused",full=state.mode==="full",enabled=state.account_enabled;
  return <div className={`agent-conversation-bar ${paused?"paused":full?"full":""} ${enabled?"":"disabled"}`}><span><Bot size={15}/><b>{enabled?(paused?"人工接管":full?"完全接管":"谨慎接管"):"AI 自动回复未配置"}</b><small>{enabled?(paused?"当前会话不会自动回复或跟进":full?"当前会话完全由 Agent 回复，无需人工确认":"可靠回复自动发送，证据不足时等待人工确认"):"请先在系统设置中启用该账号的 AI 能力"}</small></span><div className="takeover-switch" role="group" aria-label="会话接管方式"><button className={!paused&&!full&&enabled?"active cautious":""} disabled={busy||!enabled} onClick={()=>void setMode("cautious")} aria-pressed={!paused&&!full&&enabled}><ShieldCheck size={15}/>谨慎接管</button><button className={full&&enabled?"active full":""} disabled={busy||!enabled} onClick={()=>void setMode("full")} aria-pressed={full&&enabled}><Bot size={15}/>完全接管</button><button className={paused&&enabled?"active human":""} disabled={busy||!enabled} onClick={()=>void setMode("human_paused")} aria-pressed={paused&&enabled}><Users size={15}/>人工接管</button></div>{state.draft&&<div className="agent-draft"><span><Sparkles size={14}/><b>AI 建议回复</b><small>{state.draft.reason}</small></span><div className="agent-draft-copy"><section><b>发送内容</b><p>{state.draft.text_content}</p></section><section className="zh"><b>中文参考</b><p>{state.draft.reply_zh||"历史建议未生成中文参考"}</p></section></div><div><button onClick={()=>onUseDraft(state.draft!.text_content)}>放入输入框</button><button onClick={()=>void resolveDraft("dismiss")}>忽略</button><button className="primary" onClick={()=>void resolveDraft("send")}>确认发送</button></div></div>}</div>;
}

function AgentMemoryPanel({conversationId,token,onToken,onToast}:{conversationId:string;token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  type MemoryResponse={summary:string;updatedAt:string|null;facts:Array<{id:string;fact_key:string;fact_value:string;confidence:number;source_text?:string}>;rebuild?:{id:string;state:"pending"|"processing"|"completed"|"failed"|"cancelled";last_error?:string|null}|null};
  const [memory,setMemory]=useState<MemoryResponse|null>(null),[busy,setBusy]=useState(false);
  const rebuildAbortRef=useRef<AbortController|null>(null);
  const load=useCallback(async(signal?:AbortSignal)=>{const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory`,token,{signal});if(result.token!==token)onToken(result.token);if(result.response.ok)setMemory(await result.response.json());},[conversationId,token,onToken]);
  useEffect(()=>{const controller=new AbortController(),timer=window.setTimeout(()=>void load(controller.signal).catch(()=>undefined),0);return()=>{window.clearTimeout(timer);controller.abort();};},[load]);
  useEffect(()=>()=>rebuildAbortRef.current?.abort(),[conversationId]);
  async function remove(id:string){const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/facts/${id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(result.response.ok)await load();}
  async function edit(fact:{id:string;fact_key:string;fact_value:string}){const key=await promptAction({title:"编辑 AI 记忆",label:"记忆字段",defaultValue:fact.fact_key,placeholder:"例如：采购偏好",confirmLabel:"下一步",maxLength:120});if(!key?.trim())return;const value=await promptAction({title:"编辑 AI 记忆",label:"记忆内容",defaultValue:fact.fact_value,description:`字段：${key.trim()}`,placeholder:"输入需要记住的内容",confirmLabel:"保存记忆",multiline:true,maxLength:4000});if(!value?.trim())return;const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/facts/${fact.id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({key:key.trim(),value:value.trim()})});if(result.token!==token)onToken(result.token);if(result.response.ok)await load();}
  async function rebuild(){
    rebuildAbortRef.current?.abort();
    const controller=new AbortController();
    rebuildAbortRef.current=controller;
    setBusy(true);
    try{
      const started=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/rebuild`,token,{method:"POST",signal:controller.signal});
      let currentToken=started.token;
      if(currentToken!==token)onToken(currentToken);
      if(!started.response.ok){onToast("记忆更新失败");return;}
      const job=await started.response.json() as {id:string};
      onToast("正在后台整理聊天记忆，您可以继续查看其他客户");
      for(let attempt=0;attempt<24;attempt+=1){
        await new Promise(resolve=>window.setTimeout(resolve,attempt===0?1200:5000));
        if(controller.signal.aborted)return;
        const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/memory/rebuild/${job.id}`,currentToken,{signal:controller.signal});
        if(result.token!==currentToken)onToken(result.token);
        currentToken=result.token;
        if(!result.response.ok)continue;
        const status=await result.response.json() as NonNullable<MemoryResponse["rebuild"]>;
        setMemory(value=>value?{...value,rebuild:status}:value);
        if(status.state==="completed"){await load(controller.signal);onToast("聊天记忆已更新");return;}
        if(status.state==="failed"||status.state==="cancelled"){onToast(status.last_error?`记忆更新失败：${status.last_error}`:"记忆更新失败");return;}
      }
      onToast("记忆整理仍在后台进行，请稍后查看");
    }catch(reason){
      if(!controller.signal.aborted)onToast(reason instanceof Error?`记忆更新失败：${reason.message}`:"记忆更新失败");
    }finally{
      if(!controller.signal.aborted)setBusy(false);
      if(rebuildAbortRef.current===controller)rebuildAbortRef.current=null;
    }
  }
  const rebuildState=memory?.rebuild?.state;
  const factLabels:Record<string,string>={
    expected_delivery_date:"预计送达",
    expected_delivery:"预计送达",
    item_quantities:"商品数量",
    items_ordered:"订购商品",
    shipping_address:"收货地址",
    order_currency:"订单币种",
    order_amount:"订单金额",
    order_status:"订单状态",
    order_number:"订单编号",
  };
  const factLabel=(key:string)=>factLabels[key.toLowerCase()]||key.replaceAll("_"," ");
  return <div className="detail-section agent-memory">
    <div className="detail-title">
      <h4><Brain size={15}/>聊天记忆</h4>
      <button disabled={busy} onClick={()=>void rebuild()}><RefreshCw className={busy?"spin":undefined} size={12}/>{busy?"整理中…":"重新整理"}</button>
    </div>
    <p className="memory-summary">{memory?.summary||"Agent 尚未生成会话摘要。"}</p>
    {!busy&&rebuildState==="failed"&&<p className="memory-rebuild-error">最近一次整理失败：{memory?.rebuild?.last_error||"未知错误"}</p>}
    {!busy&&rebuildState==="cancelled"&&<p className="memory-rebuild-error">最近一次整理已取消：{memory?.rebuild?.last_error||"未知原因"}</p>}
    {!busy&&(rebuildState==="pending"||rebuildState==="processing")&&<p className="memory-rebuild-pending"><RefreshCw className="spin" size={11}/>记忆仍在后台整理中</p>}
    {memory?.facts.length?<div className="memory-facts">{memory.facts.map(fact=><article key={fact.id} title={fact.source_text||"来源消息已删除"}>
      <div><b>{factLabel(fact.fact_key)}</b><em>{fact.fact_value}</em></div>
      <i><button onClick={()=>void edit(fact)} aria-label={`编辑记忆 ${fact.fact_key}`} title="编辑"><Pencil size={12}/></button><button onClick={()=>void remove(fact.id)} aria-label={`删除记忆 ${fact.fact_key}`} title="删除"><X size={12}/></button></i>
    </article>)}</div>:<p className="memory-empty">暂无结构化记忆，重新整理后会自动提取。</p>}
  </div>;
}

type CloudTemplate={name:string;language:string;category?:string;components:Array<{type:string;text?:string;format?:string}>};
function cloudTemplateVariableCount(template:CloudTemplate|undefined){const text=template?.components.find(item=>item.type.toUpperCase()==="BODY")?.text??"";return Math.max(0,...Array.from(text.matchAll(/\{\{(\d+)\}\}/g),match=>Number(match[1])));}
function cloudTemplateHeaderType(template:CloudTemplate|undefined){const format=template?.components.find(item=>item.type.toUpperCase()==="HEADER")?.format?.toLowerCase();return format&&["image","video","document"].includes(format)?format:"";}
function TemplateComposer({accountId,conversationId,token,onToken,onSent}:{accountId:string;conversationId:string;token:string;onToken:(token:string)=>void;onSent:()=>void}){
  const [templates,setTemplates]=useState<CloudTemplate[]>([]),[assets,setAssets]=useState<MediaAsset[]>([]),[selected,setSelected]=useState(""),[headerMediaId,setHeaderMediaId]=useState(""),[values,setValues]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{let active=true;void authorizedFetch(`/api/v1/accounts/${accountId}/templates`,token).then(async result=>{if(result.token!==token)onToken(result.token);if(!result.response.ok)return;const body=await result.response.json() as {data:CloudTemplate[]};if(active){const first=body.data[0];setTemplates(body.data);setSelected(first?`${first.name}:${first.language}`:"");setValues(Array.from({length:cloudTemplateVariableCount(first)},()=>("")));}});return()=>{active=false};},[accountId,token,onToken]);
  useEffect(()=>{let active=true;void authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}`,token).then(async result=>{if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:Array<Record<string,unknown>>};if(active)setAssets(body.data.map(mapMediaAsset));}});return()=>{active=false};},[accountId,token,onToken]);
  const template=templates.find(item=>`${item.name}:${item.language}`===selected),bodyText=template?.components.find(item=>item.type.toUpperCase()==="BODY")?.text??"",headerType=cloudTemplateHeaderType(template),headerAssets=assets.filter(asset=>mediaKind(asset.mimeType)===headerType);
  async function send(){if(!template||values.some(value=>!value.trim())||(headerType&&!headerMediaId))return;setBusy(true);setError("");const components:Record<string,unknown>[]=[];if(headerType)components.push({type:"header",parameters:[{type:headerType,mediaId:headerMediaId}]});if(values.length)components.push({type:"body",parameters:values.map(text=>({type:"text",text:text.trim()}))});const result=await authorizedFetch("/api/v1/messages",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,conversationId,clientMessageId:crypto.randomUUID(),type:"template",template:{name:template.name,language:template.language,components}})});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};setError(body.message??body.error??`HTTP ${result.response.status}`);return;}onSent();}
  return <div className="cloud-template-composer"><div><ShieldCheck size={16}/><span><b>发送已审核模板</b><small>Cloud API 客户服务窗口已关闭</small></span></div><label>模板<select value={selected} onChange={event=>{const next=templates.find(item=>`${item.name}:${item.language}`===event.target.value);setSelected(event.target.value);setHeaderMediaId("");setValues(Array.from({length:cloudTemplateVariableCount(next)},()=>("")));}}>{templates.map(item=><option key={`${item.name}:${item.language}`} value={`${item.name}:${item.language}`}>{item.name} · {item.language}</option>)}</select></label>{headerType&&<label>{headerType} 头部<select value={headerMediaId} onChange={event=>setHeaderMediaId(event.target.value)}><option value="">选择媒体</option>{headerAssets.map(asset=><option value={asset.id} key={asset.id}>{asset.fileName}</option>)}</select></label>}{bodyText&&<p>{bodyText}</p>}{values.map((value,index)=><label key={index}>变量 {index+1}<input value={value} onChange={event=>setValues(all=>all.map((item,i)=>i===index?event.target.value:item))} placeholder={`填写 {{${index+1}}}`}/></label>)}{error&&<span className="composer-error">{error}</span>}<button className="send-button" disabled={busy||!template||Boolean(headerType&&!headerMediaId)||values.some(value=>!value.trim())} onClick={()=>void send()}><Send size={16}/>{busy?"发送中…":"发送模板"}</button></div>;
}

function SettingsPanel({token,role,accounts,onToken,onToast}:{token:string;role:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [tab,setTab]=useState<"cloud"|"messenger"|"apiKeys"|"agent"|"tasks"|"knowledge"|"translation"|"speech"|"email"|"currency"|"orders">("cloud");
  if(role!=="admin")return <section className="management-panel"><EmptyState title="需要管理员权限" text="只有管理员可以查看或修改 AI Provider 与密钥配置。"/></section>;
  return <section className="management-panel settings-panel"><header className="management-head"><div><span className="eyebrow">系统设置</span><h1>工作区配置</h1><p>集中管理 WhatsApp、Facebook Messenger、自动回复、知识库、Provider 和业务规则。</p></div></header><nav className="settings-tabs" aria-label="系统设置"><button className={tab==="cloud"?"active":""} onClick={()=>setTab("cloud")}><Phone size={15}/>WhatsApp API</button><button className={tab==="messenger"?"active":""} onClick={()=>setTab("messenger")}><Facebook size={15}/>Messenger Pages</button><button className={tab==="apiKeys"?"active":""} onClick={()=>setTab("apiKeys")}><ShieldCheck size={15}/>API 密钥</button><button className={tab==="agent"?"active":""} onClick={()=>setTab("agent")}><Bot size={15}/>AI Agent</button><button className={tab==="tasks"?"active":""} onClick={()=>setTab("tasks")}><Clock3 size={15}/>任务 Agent</button><button className={tab==="knowledge"?"active":""} onClick={()=>setTab("knowledge")}><BookOpen size={15}/>知识库</button><button className={tab==="translation"?"active":""} onClick={()=>setTab("translation")}><Languages size={15}/>AI 翻译</button><button className={tab==="speech"?"active":""} onClick={()=>setTab("speech")}><Mic size={15}/>AI 语音</button><button className={tab==="email"?"active":""} onClick={()=>setTab("email")}><Mail size={15}/>邮件发送</button><button className={tab==="currency"?"active":""} onClick={()=>setTab("currency")}><CreditCard size={15}/>货币管理</button><button className={tab==="orders"?"active":""} onClick={()=>setTab("orders")}><ClipboardList size={15}/>订单设置</button></nav>{tab==="cloud"?<CloudApiSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="messenger"?<MessengerSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="apiKeys"?<ApiKeySettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="agent"?<AiAgentSettingsPanel token={token} accounts={accounts} onToken={onToken} onToast={onToast}/>:tab==="tasks"?<TaskAgentSettingsPanel token={token} accounts={accounts} onToken={onToken} onToast={onToast}/>:tab==="knowledge"?<KnowledgeBaseSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="translation"?<TranslationSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="speech"?<TtsSettingsPanel token={token} role={role} onToken={onToken} onToast={onToast}/>:tab==="email"?<EmailSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:tab==="currency"?<CurrencySettingsPanel token={token} role={role} onToken={onToken} onToast={onToast}/>:<OrderSettingsPanel token={token} onToken={onToken} onToast={onToast}/>}</section>;
}

type ApiKeyScope="products:read"|"products:write"|"messages:read"|"messages:send";
type ManagedApiKey={id:string;name:string;keyPrefix:string;scopes:ApiKeyScope[];lastUsedAt:string|null;expiresAt:string|null;revokedAt:string|null;createdAt:string;expired:boolean};
const API_KEY_SCOPE_LABELS:Record<ApiKeyScope,string>={"products:read":"读取产品","products:write":"更新产品","messages:read":"读取消息","messages:send":"发送消息"};

function ApiKeySettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [keys,setKeys]=useState<ManagedApiKey[]>([]),[name,setName]=useState("产品资料自动完善"),[scopes,setScopes]=useState<ApiKeyScope[]>(["products:read","products:write"]),[expiresInDays,setExpiresInDays]=useState<"30"|"90"|"365"|"never">("90"),[createdSecret,setCreatedSecret]=useState(""),[copied,setCopied]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{const result=await authorizedFetch("/api/v1/api-keys",token);if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {data?:ManagedApiKey[];error?:string};if(!result.response.ok||!body.data){setError(body.error??`读取失败（HTTP ${result.response.status}）`);return;}setKeys(body.data);setError("");},[token,onToken]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  function toggleScope(scope:ApiKeyScope){setScopes(current=>current.includes(scope)?current.filter(item=>item!==scope):[...current,scope]);}
  async function create(){if(!name.trim()||!scopes.length||busy)return;setBusy(true);setError("");setCreatedSecret("");try{const result=await authorizedFetch("/api/v1/api-keys",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:name.trim(),scopes,expiresInDays:expiresInDays==="never"?null:Number(expiresInDays)})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {secret?:string;error?:string;message?:string};if(!result.response.ok||!body.secret)throw new Error(body.message??body.error??`创建失败（HTTP ${result.response.status}）`);setCreatedSecret(body.secret);setCopied(false);onToast("API 密钥已创建，请立即复制保存");await load();}catch(reason){setError(reason instanceof Error?reason.message:"创建失败");}finally{setBusy(false);}}
  async function copySecret(){if(!createdSecret)return;await navigator.clipboard.writeText(createdSecret);setCopied(true);onToast("API 密钥已复制");}
  async function revoke(key:ManagedApiKey){if(!await confirmAction(`吊销“${key.name}”后，使用该密钥的自动化将立即停止。`,{title:"吊销 API 密钥？",confirmLabel:"立即吊销"}))return;setBusy(true);setError("");try{const result=await authorizedFetch(`/api/v1/api-keys/${key.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`吊销失败（HTTP ${result.response.status}）`);onToast("API 密钥已吊销");await load();}catch(reason){setError(reason instanceof Error?reason.message:"吊销失败");}finally{setBusy(false);}}
  return <div className="api-key-settings"><section className="provider-form agent-card api-key-create"><header><div><h2>创建 API 密钥</h2><p>密钥仅在创建后显示一次。请只授予自动化实际需要的权限。</p></div></header><label>密钥名称<input value={name} onChange={event=>setName(event.target.value)} maxLength={120} placeholder="例如：产品资料自动完善"/></label><fieldset><legend>访问权限</legend>{(Object.keys(API_KEY_SCOPE_LABELS) as ApiKeyScope[]).map(scope=><label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={()=>toggleScope(scope)}/><span><b>{API_KEY_SCOPE_LABELS[scope]}</b><small>{scope}</small></span></label>)}</fieldset><label>有效期<select value={expiresInDays} onChange={event=>setExpiresInDays(event.target.value as typeof expiresInDays)}><option value="30">30 天</option><option value="90">90 天</option><option value="365">1 年</option><option value="never">永不过期</option></select></label>{error&&<span className="login-error">{error}</span>}<button className="primary-action" disabled={busy||!name.trim()||!scopes.length} onClick={()=>void create()}><Plus size={14}/>{busy?"正在处理…":"创建密钥"}</button>{createdSecret&&<div className="api-key-secret"><span><ShieldCheck size={16}/><b>请立即复制，关闭或离开后无法再次查看</b></span><code>{createdSecret}</code><button onClick={()=>void copySecret()}><Copy size={14}/>{copied?"已复制":"复制密钥"}</button></div>}</section><section className="provider-form agent-card api-key-list"><header><div><h2>现有 API 密钥</h2><p>这里只显示密钥前缀、权限与使用状态，不会返回完整密钥。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={14}/>刷新</button></header>{keys.length?<div className="api-key-table">{keys.map(key=>{const inactive=Boolean(key.revokedAt)||key.expired;return <article key={key.id} className={inactive?"inactive":""}><div><span><b>{key.name}</b><code>{key.keyPrefix}…</code></span><small>权限：{key.scopes.map(scope=>API_KEY_SCOPE_LABELS[scope]??scope).join("、")}</small><small>创建：{formatDateTime(key.createdAt)} · 最近使用：{key.lastUsedAt?formatDateTime(key.lastUsedAt):"从未使用"}</small><small>有效期：{key.expiresAt?formatDateTime(key.expiresAt):"永不过期"}</small></div><span className={`api-key-status ${inactive?"inactive":""}`}>{key.revokedAt?"已吊销":key.expired?"已过期":"有效"}</span>{!inactive&&<button className="danger-text" disabled={busy} onClick={()=>void revoke(key)}><Trash2 size={13}/>吊销</button>}</article>;})}</div>:<p className="empty-note">尚未创建 API 密钥</p>}</section></div>;
}

type CloudAccountAdmin={id:string;display_name:string;phone_e164?:string;status:string;waba_id:string;phone_number_id:string;enabled:boolean;credentialsStatus:string;webhookStatus:string;last_template_sync_at?:string;last_webhook_at?:string};
function CloudApiSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [accounts,setAccounts]=useState<CloudAccountAdmin[]>([]),[form,setForm]=useState({displayName:"",wabaId:"",phoneNumberId:"",accessToken:"",appSecret:""}),[busy,setBusy]=useState(false),[error,setError]=useState(""),[verifyToken,setVerifyToken]=useState("");
  const load=useCallback(async()=>{const result=await authorizedFetch("/api/v1/admin/whatsapp-cloud/accounts",token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:CloudAccountAdmin[]};setAccounts(body.data);}},[token,onToken]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  async function create(){setBusy(true);setError("");const result=await authorizedFetch("/api/v1/admin/whatsapp-cloud/accounts",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...form,enabled:true})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {verifyToken?:string;message?:string};setBusy(false);if(!result.response.ok){setError(body.message??`HTTP ${result.response.status}`);return;}setVerifyToken(body.verifyToken??"");setForm({displayName:"",wabaId:"",phoneNumberId:"",accessToken:"",appSecret:""});await load();onToast("Cloud API 账号已创建并完成凭据验证");}
  async function action(account:CloudAccountAdmin,kind:"test"|"sync"|"toggle"|"reset"){setBusy(true);setError("");const path=kind==="test"?`/api/v1/admin/whatsapp-cloud/accounts/${account.id}/test`:kind==="sync"?`/api/v1/admin/whatsapp-cloud/accounts/${account.id}/templates/sync`:kind==="reset"?`/api/v1/admin/whatsapp-cloud/accounts/${account.id}/verify-token/reset`:`/api/v1/admin/whatsapp-cloud/accounts/${account.id}`,result=await authorizedFetch(path,token,{method:kind==="toggle"?"PATCH":"POST",...(kind==="toggle"?{headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!account.enabled})}:{})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {verifyToken?:string;message?:string;count?:number};setBusy(false);if(!result.response.ok){setError(body.message??`HTTP ${result.response.status}`);return;}if(body.verifyToken)setVerifyToken(body.verifyToken);onToast(kind==="sync"?`已同步 ${body.count??0} 个模板`:kind==="test"?"Cloud API 凭据有效":kind==="reset"?"Verify Token 已重置":"账号状态已更新");await load();}
  return <div className="agent-settings-grid cloud-api-settings"><section className="provider-form agent-card"><header><div><h2>添加 Meta Cloud API 账号</h2><p>凭据会加密保存，保存后不会再次返回明文。</p></div></header><label>账号显示名称<input value={form.displayName} onChange={event=>setForm(value=>({...value,displayName:event.target.value}))} placeholder="例如：新加坡销售"/></label><div className="provider-form-grid"><label>WABA ID<input value={form.wabaId} onChange={event=>setForm(value=>({...value,wabaId:event.target.value}))}/></label><label>Phone Number ID<input value={form.phoneNumberId} onChange={event=>setForm(value=>({...value,phoneNumberId:event.target.value}))}/></label></div><label>长期 Access Token<input type="password" value={form.accessToken} onChange={event=>setForm(value=>({...value,accessToken:event.target.value}))} autoComplete="off"/></label><label>Meta App Secret<input type="password" value={form.appSecret} onChange={event=>setForm(value=>({...value,appSecret:event.target.value}))} autoComplete="off"/></label>{error&&<span className="login-error">{error}</span>}<button className="primary-action" disabled={busy||Object.values(form).some(value=>!value.trim())} onClick={()=>void create()}><Plus size={14}/>{busy?"正在验证…":"验证并添加账号"}</button>{verifyToken&&<div className="enrollment-result"><span>Webhook Verify Token（仅显示一次）</span><code>{verifyToken}</code><button onClick={()=>void navigator.clipboard.writeText(verifyToken)}><Copy size={13}/>复制</button><small>Callback URL：{`${API_URL}/api/v1/meta/whatsapp/webhook`}</small></div>}</section><section className="provider-form agent-card"><header><div><h2>Cloud API 账号</h2><p>检查 Webhook、凭据与模板同步状态。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={14}/>刷新</button></header>{accounts.length?accounts.map(account=><article className="cloud-account-row" key={account.id}><div><b>{account.display_name}</b><small>{account.phone_e164||account.phone_number_id} · {account.enabled?"已启用":"已停用"}</small><small>凭据：{account.credentialsStatus} · Webhook：{account.webhookStatus}</small><small>模板同步：{account.last_template_sync_at?formatDateTime(account.last_template_sync_at):"尚未同步"}</small></div><div><button onClick={()=>void action(account,"test")}>测试</button><button onClick={()=>void action(account,"sync")}>同步模板</button><button onClick={()=>void action(account,"reset")}>重置 Verify Token</button><button onClick={()=>void action(account,"toggle")}>{account.enabled?"停用":"启用"}</button></div></article>):<p className="empty-note">尚未添加 Cloud API 账号</p>}</section></div>;
}

type MessengerPageAdmin={id:string;display_name:string;status:string;page_id:string;enabled:boolean;credentialsStatus:string;webhookStatus:string;last_webhook_at?:string};
function MessengerSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [pages,setPages]=useState<MessengerPageAdmin[]>([]),[form,setForm]=useState({displayName:"",pageId:"",pageAccessToken:"",appSecret:""}),[busy,setBusy]=useState(false),[error,setError]=useState(""),[verifyToken,setVerifyToken]=useState("");
  const load=useCallback(async()=>{const result=await authorizedFetch("/api/v1/admin/messenger/pages",token);if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {data?:MessengerPageAdmin[];message?:string};if(!result.response.ok||!body.data){setError(body.message??`HTTP ${result.response.status}`);return;}setPages(body.data);setError("");},[token,onToken]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  async function create(){setBusy(true);setError("");const result=await authorizedFetch("/api/v1/admin/messenger/pages",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...form,enabled:true})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {verifyToken?:string;message?:string;error?:string};setBusy(false);if(!result.response.ok){setError(body.message??body.error??`HTTP ${result.response.status}`);return;}setVerifyToken(body.verifyToken??"");setForm({displayName:"",pageId:"",pageAccessToken:"",appSecret:""});await load();onToast("Messenger Page 已验证并添加");}
  async function action(page:MessengerPageAdmin,kind:"test"|"toggle"|"reset"){setBusy(true);setError("");const path=kind==="test"?`/api/v1/admin/messenger/pages/${page.id}/test`:kind==="reset"?`/api/v1/admin/messenger/pages/${page.id}/verify-token/reset`:`/api/v1/admin/messenger/pages/${page.id}`,result=await authorizedFetch(path,token,{method:kind==="toggle"?"PATCH":"POST",...(kind==="toggle"?{headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!page.enabled})}:{})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {verifyToken?:string;message?:string;error?:string};setBusy(false);if(!result.response.ok){setError(body.message??body.error??`HTTP ${result.response.status}`);return;}if(body.verifyToken)setVerifyToken(body.verifyToken);onToast(kind==="test"?"Messenger Page 凭据有效":kind==="reset"?"Verify Token 已重置":"Page 状态已更新");await load();}
  return <div className="agent-settings-grid cloud-api-settings"><section className="provider-form agent-card"><header><div><h2>添加 Facebook Messenger Page</h2><p>Page Access Token 与 App Secret 会加密保存。</p></div></header><label>渠道显示名称<input value={form.displayName} onChange={event=>setForm(value=>({...value,displayName:event.target.value}))} placeholder="例如：Facebook 新加坡主页"/></label><label>Page ID<input value={form.pageId} onChange={event=>setForm(value=>({...value,pageId:event.target.value}))}/></label><label>Page Access Token<input type="password" value={form.pageAccessToken} onChange={event=>setForm(value=>({...value,pageAccessToken:event.target.value}))} autoComplete="off"/></label><label>Meta App Secret<input type="password" value={form.appSecret} onChange={event=>setForm(value=>({...value,appSecret:event.target.value}))} autoComplete="off"/></label>{error&&<span className="login-error">{error}</span>}<button className="primary-action" disabled={busy||Object.values(form).some(value=>!value.trim())} onClick={()=>void create()}><Facebook size={14}/>{busy?"正在验证…":"验证并添加 Page"}</button>{verifyToken&&<div className="enrollment-result"><span>Webhook Verify Token（仅显示一次）</span><code>{verifyToken}</code><button onClick={()=>void navigator.clipboard.writeText(verifyToken)}><Copy size={13}/>复制</button><small>Callback URL：{`${API_URL}/api/v1/meta/messenger/webhook`}</small></div>}</section><section className="provider-form agent-card"><header><div><h2>Messenger Pages</h2><p>每个 Page 独立进入统一收件箱并使用独立权限。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={14}/>刷新</button></header>{pages.length?pages.map(page=><article className="cloud-account-row" key={page.id}><div><b>{page.display_name}</b><small>Page ID：{page.page_id} · {page.enabled?"已启用":"已停用"}</small><small>凭据：{page.credentialsStatus} · Webhook：{page.webhookStatus}</small><small>最近事件：{page.last_webhook_at?formatDateTime(page.last_webhook_at):"尚未收到"}</small></div><div><button onClick={()=>void action(page,"test")}>测试</button><button onClick={()=>void action(page,"reset")}>重置 Verify Token</button><button onClick={()=>void action(page,"toggle")}>{page.enabled?"停用":"启用"}</button></div></article>):<p className="empty-note">尚未添加 Messenger Page</p>}</section></div>;
}

function TaskAgentSettingsPanel({
  token,
  accounts,
  onToken,
  onToast,
}: {
  token: string;
  accounts: Account[];
  onToken: (token: string) => void;
  onToast: (text: string) => void;
}) {
  const tools = [
      "knowledge_search",
      "contact_profile_read",
      "conversation_memory_read",
      "recent_messages_read",
      "order_summary_read",
      "create_task",
      "generate_draft",
      "queue_message",
    ],
    names: Record<string, string> = {
      knowledge_search: "知识库检索",
      contact_profile_read: "联系人资料",
      conversation_memory_read: "聊天记忆",
      recent_messages_read: "近期消息",
      order_summary_read: "订单摘要",
      create_task: "创建任务",
      generate_draft: "生成草稿",
      queue_message: "加入发送队列",
    };
  type Holiday = { id: string; name: string; month: number; day: number };
  const defaults = useMemo<Holiday[]>(
    () => [
      { id: "new_year", name: "新年", month: 1, day: 1 },
      { id: "valentines", name: "情人节", month: 2, day: 14 },
      { id: "halloween", name: "万圣节", month: 10, day: 31 },
      { id: "christmas", name: "圣诞节", month: 12, day: 25 },
    ],
    [],
  );
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? ""),
    [settings, setSettings] = useState({
      timezone: "UTC",
      holidayRegions: ["global"],
      holidays: defaults,
      defaultLeadDays: 14,
      draftLeadHours: 72,
      defaultSendMode: "approval",
      leapDayPolicy: "feb28",
      defaultTools: tools.filter((tool) => tool !== "queue_message"),
    }),
    [newHoliday, setNewHoliday] = useState({ name: "", month: 1, day: 1 }),
    [loading, setLoading] = useState(false),
    [arranging, setArranging] = useState(false);
  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const result = await authorizedFetch(
      `/api/v1/accounts/${accountId}/task-settings`,
      token,
    );
    if (result.token !== token) onToken(result.token);
    if (result.response.ok) {
      const body = (await result.response.json()) as Record<string, unknown>;
      setSettings({
        timezone: String(body.timezone ?? "UTC"),
        holidayRegions: (body.holiday_regions as string[]) ?? ["global"],
        holidays: (body.holiday_definitions as Holiday[]) ?? defaults,
        defaultLeadDays: Number(body.default_lead_days ?? 14),
        draftLeadHours: Number(body.draft_lead_hours ?? 72),
        defaultSendMode: String(body.default_send_mode ?? "approval"),
        leapDayPolicy: String(body.leap_day_policy ?? "feb28"),
        defaultTools: (body.default_tools as string[]) ?? [],
      });
    }
    setLoading(false);
  }, [accountId, token, onToken, defaults]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  async function save(quiet = false) {
    setLoading(true);
    const result = await authorizedFetch(
      `/api/v1/accounts/${accountId}/task-settings`,
      token,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      },
    );
    if (result.token !== token) onToken(result.token);
    setLoading(false);
    const body = (await result.response.json().catch(() => ({}))) as {
      message?: string;
    };
    if (!quiet || !result.response.ok)
      onToast(
        result.response.ok
          ? "任务 Agent 规则已保存"
          : (body.message ?? "任务 Agent 规则保存失败"),
      );
    return result.response.ok;
  }
  async function arrangeHolidays() {
    setArranging(true);
    try {
      if (!(await save(true))) return;
      const result = await authorizedFetch(
        `/api/v1/accounts/${accountId}/task-settings/arrange-holidays`,
        token,
        { method: "POST" },
      );
      if (result.token !== token) onToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as {
        contactCount?: number;
        holidayCount?: number;
        ruleCount?: number;
        taskCount?: number;
        message?: string;
      };
      if (!result.response.ok) {
        onToast(body.message ?? "AI Agent 安排失败");
        return;
      }
      onToast(
        `AI Agent 已为 ${body.contactCount ?? 0} 位联系人安排 ${body.ruleCount ?? 0} 个节日计划${body.taskCount ? `，${body.taskCount} 个任务已进入执行窗口` : ""}`,
      );
    } finally {
      setArranging(false);
    }
  }
  function patchHoliday(id: string, patch: Partial<Holiday>) {
    setSettings((value) => ({
      ...value,
      holidays: value.holidays.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  }
  function addHoliday() {
    const name = newHoliday.name.trim();
    if (!name) return;
    setSettings((value) => ({
      ...value,
      holidays: [
        ...value.holidays,
        {
          id: `custom_${Date.now().toString(36)}`,
          name,
          month: newHoliday.month,
          day: newHoliday.day,
        },
      ],
    }));
    setNewHoliday({ name: "", month: 1, day: 1 });
  }
  return (
    <div className="agent-settings-grid">
      <section className="provider-form agent-card task-date-settings">
        <header>
          <div>
            <h2>节日与日期任务</h2>
            <p>系统提前创建任务，临近发送时再读取最新资料生成草稿。</p>
          </div>
        </header>
        <label>
          WhatsApp 账号
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          任务时区
          <TimezoneSearchDropdown
            value={settings.timezone}
            onChange={(timezone) =>
              setSettings((value) => ({ ...value, timezone }))
            }
            label="搜索并选择任务时区"
          />
          <small>生日、特殊日期和节日任务都按此时区计算日期与发送时间。</small>
        </label>
        <div className="provider-form-grid">
          <label>
            默认提前天数
            <input
              type="number"
              min="0"
              max="365"
              value={settings.defaultLeadDays}
              onChange={(event) =>
                setSettings((value) => ({
                  ...value,
                  defaultLeadDays: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            草稿提前小时
            <input
              type="number"
              min="0"
              max="8760"
              value={settings.draftLeadHours}
              onChange={(event) =>
                setSettings((value) => ({
                  ...value,
                  draftLeadHours: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            默认发送策略
            <select
              value={settings.defaultSendMode}
              onChange={(event) =>
                setSettings((value) => ({
                  ...value,
                  defaultSendMode: event.target.value,
                }))
              }
            >
              <option value="approval">审批后发送</option>
              <option value="auto">自动发送</option>
            </select>
          </label>
          <label>
            2 月 29 日策略
            <select
              value={settings.leapDayPolicy}
              onChange={(event) =>
                setSettings((value) => ({
                  ...value,
                  leapDayPolicy: event.target.value,
                }))
              }
            >
              <option value="feb28">非闰年于 2 月 28 日</option>
              <option value="mar1">非闰年于 3 月 1 日</option>
              <option value="leap_year_only">仅闰年创建</option>
            </select>
          </label>
        </div>
        <div className="holiday-editor">
          <div className="holiday-editor-head">
            <span>
              <b>节日</b>
              <small>保存当前设置，并为账号内所有联系人建立节日计划。</small>
            </span>
            <div className="holiday-editor-actions">
              <em>{settings.holidays.length} 个</em>
              <button
                type="button"
                disabled={
                  arranging ||
                  loading ||
                  !accountId ||
                  !settings.defaultTools.includes("create_task") ||
                  settings.holidays.length === 0 ||
                  settings.holidays.some((item) => !item.name.trim())
                }
                onClick={() => void arrangeHolidays()}
                title={
                  settings.defaultTools.includes("create_task")
                    ? "为全部联系人建立节日问候计划"
                    : "请先开启“创建任务”工具权限"
                }
              >
                <Sparkles size={13} />
                {arranging ? "正在安排…" : "AI Agent 一键安排"}
              </button>
            </div>
          </div>
          <div className="holiday-list">
            {settings.holidays.map((item) => (
              <div className="holiday-row" key={item.id}>
                <input
                  value={item.name}
                  maxLength={80}
                  aria-label="节日名称"
                  onChange={(event) =>
                    patchHoliday(item.id, { name: event.target.value })
                  }
                />
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={item.month}
                  aria-label={`${item.name}月份`}
                  onChange={(event) =>
                    patchHoliday(item.id, { month: Number(event.target.value) })
                  }
                />
                <span>月</span>
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={item.day}
                  aria-label={`${item.name}日期`}
                  onChange={(event) =>
                    patchHoliday(item.id, { day: Number(event.target.value) })
                  }
                />
                <span>日</span>
                <button
                  type="button"
                  aria-label={`删除${item.name}`}
                  onClick={() =>
                    setSettings((value) => ({
                      ...value,
                      holidays: value.holidays.filter(
                        (holiday) => holiday.id !== item.id,
                      ),
                    }))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="holiday-add">
            <input
              value={newHoliday.name}
              maxLength={80}
              placeholder="节日名称"
              aria-label="新节日名称"
              onChange={(event) =>
                setNewHoliday((value) => ({
                  ...value,
                  name: event.target.value,
                }))
              }
            />
            <input
              type="number"
              min="1"
              max="12"
              value={newHoliday.month}
              aria-label="新节日月份"
              onChange={(event) =>
                setNewHoliday((value) => ({
                  ...value,
                  month: Number(event.target.value),
                }))
              }
            />
            <span>月</span>
            <input
              type="number"
              min="1"
              max="31"
              value={newHoliday.day}
              aria-label="新节日日期"
              onChange={(event) =>
                setNewHoliday((value) => ({
                  ...value,
                  day: Number(event.target.value),
                }))
              }
            />
            <span>日</span>
            <button
              type="button"
              disabled={!newHoliday.name.trim()}
              onClick={addHoliday}
            >
              <Plus size={14} />
              添加
            </button>
          </div>
        </div>
      </section>
      <section className="provider-form agent-card">
        <header>
          <div>
            <h2>工具权限</h2>
            <p>任务可继承这些账号默认权限；高风险发送工具需明确开启。</p>
          </div>
        </header>
        <fieldset className="task-tools">
          {tools.map((tool) => (
            <label
              key={tool}
              className={tool === "queue_message" ? "risk" : ""}
            >
              <input
                type="checkbox"
                checked={settings.defaultTools.includes(tool)}
                onChange={(event) =>
                  setSettings((value) => ({
                    ...value,
                    defaultTools: event.target.checked
                      ? [...value.defaultTools, tool]
                      : value.defaultTools.filter((item) => item !== tool),
                  }))
                }
              />
              <span>
                <b>{names[tool]}</b>
                {tool === "queue_message" && (
                  <small>允许自动任务进入 WhatsApp 队列</small>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        <button
          className="primary-action"
          disabled={
            loading ||
            !accountId ||
            settings.holidays.some((item) => !item.name.trim())
          }
          onClick={() => void save()}
        >
          <Check size={14} />
          {loading ? "正在保存…" : "保存任务 Agent 规则"}
        </button>
      </section>
    </div>
  );
}

function EmailSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<EmailProviderConfig[]>([]),[selected,setSelected]=useState<EmailProviderId>("smtp"),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[testing,setTesting]=useState(false),[testEmail,setTestEmail]=useState(""),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/email-providers",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {data?:Array<Omit<EmailProviderConfig,"secret">>;message?:string};if(!result.response.ok||!body.data)throw new Error(body.message??`HTTP ${result.response.status}`);const next=body.data.map(item=>({...item,secret:""}));setProviders(next);setSelected(value=>next.some(item=>item.provider===value)?value:(next.find(item=>item.enabled)?.provider??"smtp"));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"邮件 Provider 加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);const current=providers.find(item=>item.provider===selected);const change=(patch:Partial<EmailProviderConfig>)=>setProviders(items=>items.map(item=>item.provider===selected?{...item,...patch}:item));
  async function save(){if(!current)return;setSaving(true);setError("");try{const result=await authorizedFetch(`/api/v1/admin/email-providers/${selected}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:current.enabled,fromName:current.fromName,fromEmail:current.fromEmail,replyTo:current.replyTo,...(selected==="smtp"?{host:current.host,port:current.port,tls:current.tls,username:current.username}:{}),secret:current.secret||undefined})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};if(!result.response.ok)throw new Error(body.message??body.error??`HTTP ${result.response.status}`);onToast(`${selected==="smtp"?"SMTP":"Resend"} 配置已保存${current.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setSaving(false);}}
  async function test(){if(!testEmail.trim())return;setTesting(true);setError("");try{const result=await authorizedFetch(`/api/v1/admin/email-providers/${selected}/test`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({recipientEmail:testEmail})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};if(!result.response.ok)throw new Error(body.message??body.error??`HTTP ${result.response.status}`);onToast(`测试邮件已被 ${selected==="smtp"?"SMTP":"Resend"} 接受`);}catch(reason){setError(reason instanceof Error?reason.message:"测试失败");}finally{setTesting(false);}}
  return <div className="settings-provider-section"><div className="settings-section-head"><div><h2>邮件发送 Provider</h2><p>配置 SMTP 或 Resend；同一时间只启用一个服务。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>{loading?<EmptyState title="正在读取邮件 Provider" text="请稍候…"/>:<div className="provider-settings-layout"><nav className="provider-list">{providers.map(item=><button key={item.provider} className={selected===item.provider?"active":""} onClick={()=>setSelected(item.provider)}><span><b>{item.provider==="smtp"?"标准 SMTP":"Resend API"}</b><small>{item.provider==="smtp"?"企业邮箱及通用邮件服务":"域名邮件 API 与幂等发送"}</small></span><em className={item.enabled?"enabled":item.configured?"configured":""}>{item.enabled?"使用中":item.configured?"已配置":"未配置"}</em></button>)}</nav>{current&&<div className="provider-form"><header><div><h2>{selected==="smtp"?"标准 SMTP":"Resend API"}</h2><p>密钥会加密保存，界面不会回显。</p></div><label className="provider-toggle"><input type="checkbox" checked={current.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>设为当前 Provider</span></label></header><div className="provider-form-grid"><label>发件人名称<input value={current.fromName} onChange={event=>change({fromName:event.target.value})}/></label><label>发件人邮箱<input type="email" value={current.fromEmail} onChange={event=>change({fromEmail:event.target.value})}/></label></div><label>Reply-To<input type="email" value={current.replyTo} onChange={event=>change({replyTo:event.target.value})} placeholder="可留空"/></label>{selected==="smtp"&&<><div className="provider-form-grid"><label>SMTP Host<input value={current.host} onChange={event=>change({host:event.target.value})}/></label><label>端口<input type="number" value={current.port} onChange={event=>change({port:Number(event.target.value)})}/></label></div><div className="provider-form-grid"><label>TLS 模式<select value={current.tls} onChange={event=>change({tls:event.target.value as "tls"|"starttls"})}><option value="starttls">STARTTLS（通常 587）</option><option value="tls">直接 TLS（通常 465）</option></select></label><label>用户名<input value={current.username} onChange={event=>change({username:event.target.value})}/></label></div></>}<SecretField label={selected==="smtp"?"SMTP 密码 / 应用密码":"Resend API Key"} value={current.secret} onChange={value=>change({secret:value})} placeholder={current.configured?"已配置；留空保持不变":"请输入密钥"} hint="密钥使用工作区加密密钥保存。"/><div className="email-provider-actions"><button className="primary-action" disabled={saving||!current.fromName.trim()||!current.fromEmail.trim()||(!current.configured&&!current.secret.trim())} onClick={()=>void save()}>{saving?"正在保存…":"保存配置"}</button><label>测试收件邮箱<input type="email" value={testEmail} onChange={event=>setTestEmail(event.target.value)} placeholder="you@example.com"/></label><button className="secondary-action" disabled={testing||!testEmail.trim()||!current.configured} onClick={()=>void test()}>{testing?"正在发送…":"发送测试邮件"}</button></div>{error&&<span className="login-error">{error}</span>}</div>}</div>}</div>;
}

type DefaultConversationMode="cautious"|"full"|"human_paused";
function AiAgentSettingsPanel({token,accounts,onToken,onToast}:{token:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<Array<{provider:string;enabled:boolean;key_configured:boolean;api_key:string;base_url:string;model:string;embedding_model:string}>>([]);
  const [providerId,setProviderId]=useState("openai"),[accountId,setAccountId]=useState(accounts[0]?.id??""),[kbs,setKbs]=useState<KnowledgeBaseItem[]>([]);
  const [settings,setSettings]=useState({enabled:false,defaultConversationMode:"human_paused" as DefaultConversationMode,persona:"You are a helpful, concise customer service agent.",replyLanguage:"auto",timezone:"Asia/Shanghai",businessStart:"09:00",businessEnd:"18:00",confidenceThreshold:.8,followupEnabled:true,followupDelaysHours:[24,72],knowledgeBaseIds:[] as string[]}),[saving,setSaving]=useState(false);
  const loadProvider=useCallback(async()=>{const result=await authorizedFetch("/api/v1/admin/agent-provider",token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:typeof providers};setProviders(body.data);setProviderId(value=>body.data.find(item=>item.enabled)?.provider??(body.data.some(item=>item.provider===value)?value:"openai"));}},[token,onToken]);
  const loadAccount=useCallback(async()=>{if(!accountId)return;const [result,kbResult]=await Promise.all([authorizedFetch(`/api/v1/accounts/${accountId}/agent-settings`,token),authorizedFetch("/api/v1/knowledge-bases",token)]);if(result.token!==token)onToken(result.token);if(kbResult.token!==token)onToken(kbResult.token);if(kbResult.response.ok)setKbs((await kbResult.response.json()).data);if(result.response.ok){const body=await result.response.json() as Record<string,unknown>;setSettings({enabled:Boolean(body.enabled),defaultConversationMode:String(body.default_conversation_mode??"human_paused") as DefaultConversationMode,persona:String(body.persona??""),replyLanguage:String(body.reply_language??"auto"),timezone:String(body.timezone??"UTC"),businessStart:String(body.business_start??"09:00").slice(0,5),businessEnd:String(body.business_end??"18:00").slice(0,5),confidenceThreshold:Number(body.confidence_threshold??.8),followupEnabled:body.followup_enabled!==false,followupDelaysHours:(body.followup_delays_hours as number[])??[24,72],knowledgeBaseIds:(body.knowledgeBaseIds as string[])??[]});}},[accountId,token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void loadProvider(),0);return()=>window.clearTimeout(timer);},[loadProvider]);
  useEffect(()=>{if(!accountId&&accounts[0]){const timer=window.setTimeout(()=>setAccountId(accounts[0].id),0);return()=>window.clearTimeout(timer);}},[accountId,accounts]);
  useEffect(()=>{const timer=window.setTimeout(()=>void loadAccount(),0);return()=>window.clearTimeout(timer);},[loadAccount]);
  const provider=providers.find(item=>item.provider===providerId);
  async function saveProvider(){if(!provider)return;setSaving(true);const result=await authorizedFetch(`/api/v1/admin/agent-provider/${providerId}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:provider.enabled,apiKey:provider.api_key.trim()||undefined,baseUrl:provider.base_url,model:provider.model,embeddingModel:provider.embedding_model})});if(result.token!==token)onToken(result.token);setSaving(false);onToast(result.response.ok?"Agent Provider 已保存":"Provider 保存失败");if(result.response.ok)await loadProvider();}
  async function saveAccount(){if(!accountId)return;setSaving(true);const result=await authorizedFetch(`/api/v1/accounts/${accountId}/agent-settings`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({...settings,businessDays:[1,2,3,4,5]})});if(result.token!==token)onToken(result.token);setSaving(false);onToast(result.response.ok?"账号 Agent 规则已保存":"账号 Agent 规则保存失败");}
  const patchProvider=(change:Record<string,unknown>)=>setProviders(items=>items.map(item=>item.provider===providerId?{...item,...change}:item));
  const modeOptions:Array<{mode:DefaultConversationMode;title:string;description:string;icon:React.ReactNode}>=[
    {mode:"cautious",title:"谨慎接管",description:"可靠回复自动发送，证据不足时等待人工确认",icon:<ShieldCheck size={15}/>},
    {mode:"full",title:"完全接管",description:"Agent 可直接回复，无需人工确认",icon:<Bot size={15}/>},
    {mode:"human_paused",title:"人工接管",description:"新会话默认不自动回复或跟进",icon:<Users size={15}/>},
  ];
  return <div className="agent-settings-grid">
    <section className="provider-form agent-card">
      <header><div><h2>Agent Provider</h2><p>用于回复决策、记忆整理和知识检索。</p></div></header>
      <label>Provider<select value={providerId} onChange={event=>setProviderId(event.target.value)}><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option><option value="siliconflow">SiliconFlow</option><option value="openai_compatible">OpenAI Compatible</option></select></label>
      {provider&&<><label className="provider-toggle"><input type="checkbox" checked={provider.enabled} onChange={event=>patchProvider({enabled:event.target.checked})}/><span>启用此 Provider</span></label><SecretField label="API Key" value={provider.api_key} onChange={value=>patchProvider({api_key:value})} placeholder="请输入 API Key" hint="密钥已加密保存；仅管理员可在此显示或复制。"/><label>Endpoint<input value={provider.base_url} onChange={event=>patchProvider({base_url:event.target.value})}/></label><label>生成模型<input value={provider.model} onChange={event=>patchProvider({model:event.target.value})}/></label><label>嵌入模型<input value={provider.embedding_model} onChange={event=>patchProvider({embedding_model:event.target.value})}/><small>必须返回 1536 维向量。</small></label><button className="primary-action" disabled={saving||!provider.api_key.trim()} onClick={()=>void saveProvider()}><Check size={14}/>保存 Provider</button></>}
    </section>
    <section className="provider-form agent-card">
      <header><div><h2>账号自动化</h2><p>配置账号级 AI 能力和新会话默认接管方式；会话中仍可随时手动切换。</p></div></header>
      <label>WhatsApp 账号<select value={accountId} onChange={event=>setAccountId(event.target.value)}>{accounts.map(account=><option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
      <label className="provider-toggle"><input type="checkbox" checked={settings.enabled} onChange={event=>setSettings(value=>({...value,enabled:event.target.checked}))}/><span>启用该账号的 AI 接管能力</span></label>
      <fieldset className="default-takeover-mode">
        <legend>新会话默认接管模式</legend>
        <p>仅影响保存后新创建的会话；人工发送消息后仍会切换为人工接管。</p>
        <div>{modeOptions.map(item=><label className={settings.defaultConversationMode===item.mode?"selected":""} key={item.mode}><input type="radio" name={`default-takeover-${accountId}`} checked={settings.defaultConversationMode===item.mode} onChange={()=>setSettings(value=>({...value,defaultConversationMode:item.mode}))}/><span>{item.icon}<b>{item.title}</b><small>{item.description}</small></span></label>)}</div>
      </fieldset>
      <label>Agent 人设<textarea value={settings.persona} onChange={event=>setSettings(value=>({...value,persona:event.target.value}))}/></label>
      <div className="provider-form-grid"><label>时区<TimezoneSearchDropdown value={settings.timezone} onChange={timezone=>setSettings(value=>({...value,timezone}))}/></label><label>回复语言<input value={settings.replyLanguage} onChange={event=>setSettings(value=>({...value,replyLanguage:event.target.value}))}/></label><label>营业开始<input type="time" value={settings.businessStart} onChange={event=>setSettings(value=>({...value,businessStart:event.target.value}))}/></label><label>营业结束<input type="time" value={settings.businessEnd} onChange={event=>setSettings(value=>({...value,businessEnd:event.target.value}))}/></label></div>
      <label>自动发送置信度：{settings.confidenceThreshold.toFixed(2)}<input type="range" min="0.6" max="0.95" step="0.01" value={settings.confidenceThreshold} onChange={event=>setSettings(value=>({...value,confidenceThreshold:Number(event.target.value)}))}/></label>
      <label className="provider-toggle"><input type="checkbox" checked={settings.followupEnabled} onChange={event=>setSettings(value=>({...value,followupEnabled:event.target.checked}))}/><span>24 小时与 72 小时主动跟进</span></label>
      <fieldset className="kb-assignment"><legend>分配知识库</legend>{kbs.map(kb=><label key={kb.id}><input type="checkbox" checked={settings.knowledgeBaseIds.includes(kb.id)} onChange={event=>setSettings(value=>({...value,knowledgeBaseIds:event.target.checked?[...value.knowledgeBaseIds,kb.id]:value.knowledgeBaseIds.filter(id=>id!==kb.id)}))}/>{kb.name}</label>)}</fieldset>
      <button className="primary-action" disabled={saving||!accountId} onClick={()=>void saveAccount()}><Check size={14}/>保存账号规则</button>
    </section>
  </div>;
}

function KnowledgeBaseSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [items,setItems]=useState<KnowledgeBaseItem[]>([]),[selected,setSelected]=useState(""),[detail,setDetail]=useState<{documents:Array<{id:string;file_name:string;status:string;error?:string}>;faqs:Array<{id:string;question:string;answer:string}>}|null>(null),[name,setName]=useState(""),[editingId,setEditingId]=useState(""),[editName,setEditName]=useState(""),[question,setQuestion]=useState(""),[answer,setAnswer]=useState(""),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const result=await authorizedFetch("/api/v1/knowledge-bases",token);if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:KnowledgeBaseItem[]};setItems(body.data);setSelected(value=>body.data.some(item=>item.id===value)?value:(body.data[0]?.id??""));}},[token,onToken]);const loadDetail=useCallback(async()=>{if(!selected){setDetail(null);return;}const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}`,token);if(result.token!==token)onToken(result.token);if(result.response.ok)setDetail(await result.response.json());},[selected,token,onToken]);useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);useEffect(()=>{const first=window.setTimeout(()=>void loadDetail(),0),poll=window.setInterval(()=>void loadDetail(),5000);return()=>{window.clearTimeout(first);window.clearInterval(poll);};},[loadDetail]);
  async function create(){if(!name.trim())return;setBusy(true);const result=await authorizedFetch("/api/v1/knowledge-bases",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){const created=await result.response.json() as {id:string};setName("");await load();setSelected(created.id);}}
  function startEdit(item:KnowledgeBaseItem){setEditingId(item.id);setEditName(item.name);}
  async function saveEdit(id:string){const nextName=editName.trim();if(!nextName)return;setBusy(true);const result=await authorizedFetch(`/api/v1/knowledge-bases/${id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:nextName})});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){onToast("知识库名称修改失败");return;}setEditingId("");setEditName("");await load();onToast("知识库名称已更新");}
  async function removeKnowledgeBase(item:KnowledgeBaseItem){if(!await confirmAction(`知识库“${item.name}”及其中的文档和问答将全部删除，此操作无法撤销。`,{title:"永久删除知识库？",confirmLabel:"永久删除"}))return;setBusy(true);const result=await authorizedFetch(`/api/v1/knowledge-bases/${item.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){onToast("知识库删除失败");return;}if(selected===item.id){setSelected("");setDetail(null);}if(editingId===item.id){setEditingId("");setEditName("");}await load();onToast("知识库已删除");}
  async function upload(file:File){setBusy(true);const form=new FormData();form.append("file",file);const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/documents`,token,{method:"POST",body:form});if(result.token!==token)onToken(result.token);setBusy(false);onToast(result.response.ok?"文档已上传，正在建立索引":"文档上传失败");await loadDetail();}
  async function addFaq(){if(!question.trim()||!answer.trim())return;setBusy(true);const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/faqs`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question,answer})});if(result.token!==token)onToken(result.token);setBusy(false);if(result.response.ok){setQuestion("");setAnswer("");await loadDetail();}}
  async function removeDocument(id:string){if(!await confirmAction("该文档及其全部检索内容将被永久删除。",{title:"删除知识库文档？",confirmLabel:"删除"}))return;const result=await authorizedFetch(`/api/v1/knowledge-documents/${id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(result.response.ok)await loadDetail();}
  async function editFaq(faq:{id:string;question:string;answer:string}){const nextQuestion=await promptAction({title:"编辑知识库问答",label:"问题",defaultValue:faq.question,placeholder:"输入客户可能提出的问题",confirmLabel:"下一步",multiline:true,maxLength:1000});if(!nextQuestion?.trim())return;const nextAnswer=await promptAction({title:"编辑知识库问答",label:"答案",defaultValue:faq.answer,description:`问题：${nextQuestion.trim()}`,placeholder:"输入标准答案",confirmLabel:"保存问答",multiline:true,maxLength:8000});if(!nextAnswer?.trim())return;const result=await authorizedFetch(`/api/v1/knowledge-bases/${selected}/faqs/${faq.id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({question:nextQuestion.trim(),answer:nextAnswer.trim()})});if(result.token!==token)onToken(result.token);if(result.response.ok)await loadDetail();}
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
  const [section,setSection]=useState<"number"|"payments"|"product-card"|TemplateFormat>("number"),[dirty,setDirty]=useState(false);
  const request=useCallback((path:string,init?:RequestInit)=>authorizedFetch(path,token,init),[token]);
  async function select(next:"number"|"payments"|"product-card"|TemplateFormat){if(next===section)return;if(dirty&&!await confirmAction("当前模板的未保存修改将会丢失。",{title:"放弃未保存的修改？",confirmLabel:"放弃并离开",tone:"warning"}))return;setDirty(false);setSection(next);}
  return <div className="order-settings-shell"><nav className="order-settings-tabs" aria-label="订单设置"><button className={section==="number"?"active":""} onClick={()=>select("number")}>编号规则</button><button className={section==="text"?"active":""} onClick={()=>select("text")}>文字模板</button><button className={section==="image"?"active":""} onClick={()=>select("image")}>图片模板</button><button className={section==="pdf"?"active":""} onClick={()=>select("pdf")}>PDF 模板</button><button className={section==="product-card"?"active":""} onClick={()=>select("product-card")}>产品卡片模板</button><button className={section==="payments"?"active":""} onClick={()=>select("payments")}><CreditCard size={13}/>付款方式</button></nav>{section==="number"?<OrderNumberSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:section==="payments"?<PaymentMethodsSettingsPanel token={token} onToken={onToken} onToast={onToast}/>:section==="product-card"?<ProductCardTemplateEditor request={request} onToken={onToken} onToast={onToast} onDirtyChange={setDirty}/>:<OrderTemplateEditor format={section} request={request} onToken={onToken} onToast={onToast} onDirtyChange={setDirty}/>}</div>;
}

function OrderNumberSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [template,setTemplate]=useState("{YYYY}{MM}{DD}-{SEQ:3}"),[timezone,setTimezone]=useState("Asia/Shanghai"),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/order-settings",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {numberTemplate?:string;timezone?:string;message?:string};if(!result.response.ok)throw new Error(body.message??`HTTP ${result.response.status}`);setTemplate(body.numberTemplate??"{YYYY}{MM}{DD}-{SEQ:3}");setTimezone(body.timezone??"Asia/Shanghai");setError("");}catch(reason){setError(reason instanceof Error?reason.message:"订单设置加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  async function save(){setSaving(true);setError("");try{const result=await authorizedFetch("/api/v1/admin/order-settings",token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({numberTemplate:template,timezone})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};if(!result.response.ok)throw new Error(body.message??body.error??`HTTP ${result.response.status}`);onToast("订单编号规则已保存，仅影响此后创建的订单");await load();}catch(reason){setError(reason instanceof Error?reason.message:"订单设置保存失败");}finally{setSaving(false);}}
  if(loading)return <EmptyState title="正在读取订单设置" text="请稍候…"/>;
  return <div className="settings-provider-section order-settings"><div className="settings-section-head"><div><h2>订单编号规则</h2><p>订单号在创建时固化；修改规则不会改变任何历史订单。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div><div className="order-settings-form"><label>编号模板<input value={template} onChange={event=>setTemplate(event.target.value)} maxLength={80}/><small>必须包含年份、月份、日期和当日序号各一次。</small></label><div className="order-variable-buttons">{["{YYYY}","{YY}","{MM}","{DD}","{SEQ:3}"].map(variable=><button key={variable} onClick={()=>setTemplate(value=>value+variable)}>{variable}</button>)}</div><label>业务时区<input value={timezone} onChange={event=>setTimezone(event.target.value)} list="order-timezones" placeholder="Asia/Shanghai"/><datalist id="order-timezones"><option value="Asia/Shanghai"/><option value="Asia/Hong_Kong"/><option value="Asia/Singapore"/><option value="Europe/London"/><option value="America/New_York"/><option value="America/Los_Angeles"/></datalist><small>使用 IANA 时区计算日期和每日序号重置边界。</small></label><div className="order-number-preview"><span>下一个订单号示例</span><b>#{previewOrderNumber(template,timezone)}</b></div>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||!template.trim()||!timezone.trim()} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在保存</>:<><Check size={14}/>保存订单设置</>}</button></div></div>;
}

const PAYMENT_METHOD_PRESETS:Array<{type:PaymentMethodType;name:string}>=[
  {type:"paypal",name:"PayPal"},{type:"bank_transfer",name:"Bank Transfer"},{type:"western_union",name:"Western Union"},
  {type:"wise",name:"Wise"},{type:"moneygram",name:"MoneyGram"},{type:"stripe_payment_link",name:"Stripe Payment Link"},{type:"custom",name:"Custom"},
];
function mapPaymentMethod(item:Record<string,unknown>):PaymentMethod{return{id:String(item.id),type:String(item.type) as PaymentMethodType,name:String(item.name),enabled:Boolean(item.enabled),sortOrder:Number(item.sortOrder??item.sort_order??0),profiles:Array.isArray(item.profiles)?item.profiles.map(profile=>mapPaymentProfile(profile as Record<string,unknown>)):[]};}

function PaymentMethodsSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [methods,setMethods]=useState<PaymentMethod[]>([]),[selectedId,setSelectedId]=useState(""),[selectedProfileId,setSelectedProfileId]=useState(""),[newType,setNewType]=useState<PaymentMethodType>("bank_transfer"),[newName,setNewName]=useState("Bank Transfer"),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/payment-methods",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {data?:Array<Record<string,unknown>>;message?:string;error?:string};if(!result.response.ok||!body.data)throw new Error(body.message??body.error??`HTTP ${result.response.status}`);const next=body.data.map(mapPaymentMethod);setMethods(next);setSelectedId(current=>next.some(item=>item.id===current)?current:(next[0]?.id??""));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"付款方式加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  const method=methods.find(item=>item.id===selectedId),profile=method?.profiles.find(item=>item.id===selectedProfileId)??method?.profiles[0];
  async function call(path:string,init:RequestInit,success:string){setBusy(true);setError("");try{const result=await authorizedFetch(path,token,init);if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));onToast(success);await load();return body;}catch(reason){setError(reason instanceof Error?reason.message:"操作失败");return null;}finally{setBusy(false);}}
  async function createMethod(){if(!newName.trim())return;const body=await call("/api/v1/admin/payment-methods",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:newType,name:newName.trim(),enabled:true,sortOrder:methods.length})},"付款方式已新增");if(body?.id)setSelectedId(String(body.id));}
  async function saveMethod(change:Partial<PaymentMethod>={}){if(!method)return;await call(`/api/v1/admin/payment-methods/${method.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:change.name??method.name,enabled:change.enabled??method.enabled,sortOrder:change.sortOrder??method.sortOrder})},"付款方式已保存");}
  async function addProfile(){if(!method)return;const name=await promptAction({title:"新增付款 Profile",label:"Profile 名称",placeholder:"例如 US Sales / HSBC USD",maxLength:80});if(!name)return;const body=await call(`/api/v1/admin/payment-methods/${method.id}/profiles`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,enabled:false,publicFields:[],instructions:"",environment:method.type==="paypal"?"sandbox":undefined})},"付款 Profile 已新增");if(body?.id)setSelectedProfileId(String(body.id));}
  async function copyProfile(){if(!method||!profile)return;const body=await call(`/api/v1/admin/payment-methods/${method.id}/profiles`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:`${profile.name} Copy`,enabled:false,publicFields:profile.publicFields,instructions:profile.instructions,environment:profile.environment??undefined,referenceTemplate:profile.referenceTemplate,noteTemplate:profile.noteTemplate,itemNameTemplate:profile.itemNameTemplate})},"付款 Profile 已复制");if(body?.id)setSelectedProfileId(String(body.id));}
  async function removeMethod(){if(!method||!await confirmAction(`删除“${method.name}”及其全部 Profiles？历史订单快照不会受到影响。`,{title:"删除付款方式？",confirmLabel:"删除"}))return;await call(`/api/v1/admin/payment-methods/${method.id}`,{method:"DELETE"},"付款方式已删除");}
  async function removeProfile(){if(!method||!profile||!await confirmAction(`删除 Profile“${profile.name}”？历史订单快照不会受到影响。`,{title:"删除付款 Profile？",confirmLabel:"删除"}))return;await call(`/api/v1/admin/payment-methods/${method.id}/profiles/${profile.id}`,{method:"DELETE"},"付款 Profile 已删除");}
  function updateProfile(change:Partial<PaymentProfile>){if(!method||!profile)return;setMethods(items=>items.map(item=>item.id===method.id?{...item,profiles:item.profiles.map(value=>value.id===profile.id?{...value,...change}:value)}:item));}
  async function saveProfile(){if(!method||!profile)return;await call(`/api/v1/admin/payment-methods/${method.id}/profiles/${profile.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:profile.name,enabled:profile.enabled,publicFields:profile.publicFields.filter(field=>field.label.trim()&&field.value.trim()),instructions:profile.instructions,environment:profile.environment??undefined,referenceTemplate:profile.referenceTemplate,noteTemplate:profile.noteTemplate,itemNameTemplate:profile.itemNameTemplate,sandboxClientId:profile.sandboxClientId||undefined,sandboxClientSecret:profile.sandboxClientSecret||undefined,liveClientId:profile.liveClientId||undefined,liveClientSecret:profile.liveClientSecret||undefined})},method.type==="paypal"?`付款 Profile 已保存，PayPal ${profile.environment==="live"?"Live":"Sandbox"} 环境已启用`:"付款 Profile 已保存");}
  const activePayPalEnvironment=profile?.environment==="live"?"live":"sandbox",activePayPalName=activePayPalEnvironment==="live"?"Live":"Sandbox",activePayPalConfigured=activePayPalEnvironment==="live"?Boolean((profile?.liveClientIdConfigured||profile?.liveClientId?.trim())&&(profile?.liveClientSecretConfigured||profile?.liveClientSecret?.trim())):Boolean((profile?.sandboxClientIdConfigured||profile?.sandboxClientId?.trim())&&(profile?.sandboxClientSecretConfigured||profile?.sandboxClientSecret?.trim()));
  if(loading)return <EmptyState title="正在读取付款方式" text="请稍候…"/>;
  return <div className="settings-provider-section payment-method-settings"><div className="settings-section-head"><div><h2>付款方式与 Profiles</h2><p>订单选择具体 Profile；历史订单保存公开资料快照。PayPal 凭据按 Profile 和环境独立加密。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>
    <div className="provider-form payment-method-create"><label><span>方式类型</span><select value={newType} onChange={event=>{const type=event.target.value as PaymentMethodType;setNewType(type);setNewName(PAYMENT_METHOD_PRESETS.find(item=>item.type===type)?.name??"");}}>{PAYMENT_METHOD_PRESETS.map(item=><option key={item.type} value={item.type}>{item.name}</option>)}</select></label><label><span>显示名称</span><input value={newName} maxLength={80} onChange={event=>setNewName(event.target.value)} placeholder="付款方式显示名称"/></label><button className="primary-action" disabled={busy||!newName.trim()} onClick={()=>void createMethod()}><Plus size={14}/>新增付款方式</button></div>
    {error&&<span className="login-error">{error}</span>}
    {methods.length?<div className="provider-settings-layout"><nav className="provider-list">{methods.map(item=><button key={item.id} className={item.id===selectedId?"active":""} onClick={()=>{setSelectedId(item.id);setSelectedProfileId(item.profiles[0]?.id??"");}}><span><b>{item.name}</b><small>{PAYMENT_METHOD_PRESETS.find(value=>value.type===item.type)?.name} · {item.profiles.length} Profiles</small></span><em className={item.enabled?"enabled":""}>{item.enabled?"已启用":"已停用"}</em></button>)}</nav>{method&&<div className="provider-form"><header><div><input value={method.name} onChange={event=>setMethods(items=>items.map(item=>item.id===method.id?{...item,name:event.target.value}:item))}/><small>{method.type}</small></div><label className="provider-toggle"><input type="checkbox" checked={method.enabled} onChange={event=>setMethods(items=>items.map(item=>item.id===method.id?{...item,enabled:event.target.checked}:item))}/><span>启用方式</span></label></header><div className="payment-method-toolbar"><label>排序<input type="number" value={method.sortOrder} onChange={event=>setMethods(items=>items.map(item=>item.id===method.id?{...item,sortOrder:Number(event.target.value)}:item))}/></label><div className="payment-request-actions"><button className="secondary-action" disabled={busy} onClick={()=>void saveMethod()}><Check size={14}/>保存方式</button><button className="danger-text" disabled={busy} onClick={()=>void removeMethod()}><Trash2 size={14}/>删除方式</button><button className="primary-action" disabled={busy} onClick={()=>void addProfile()}><Plus size={14}/>新增 Profile</button></div></div>
      {method.profiles.length>0&&<><nav className="order-settings-tabs payment-profile-tabs">{method.profiles.map(item=><button key={item.id} className={profile?.id===item.id?"active":""} onClick={()=>setSelectedProfileId(item.id)}>{item.name}{!item.enabled?" · 停用":""}</button>)}</nav>{profile&&<div className="paypal-template-settings"><header><div><h3>{profile.name}</h3><p>{profile.summary}</p></div><label className="provider-toggle"><input type="checkbox" checked={profile.enabled} onChange={event=>updateProfile({enabled:event.target.checked})}/><span>允许新订单选择</span></label></header><label>Profile 名称<input value={profile.name} maxLength={80} onChange={event=>updateProfile({name:event.target.value,profileName:event.target.value,summary:`${method.name} · ${event.target.value}`})}/></label>
        {method.type==="paypal"?<><section className={`paypal-environment-panel ${activePayPalEnvironment}`}><header><div><b>PayPal 运行环境</b><small>选择后点击底部“保存 Profile”才会正式切换。</small></div><em className={activePayPalConfigured?"configured":""}>{activePayPalConfigured?"凭据已配置":"需要配置凭据"}</em></header><div className="paypal-environment-switch" role="group" aria-label="PayPal 运行环境"><button type="button" className={activePayPalEnvironment==="sandbox"?"active":""} aria-pressed={activePayPalEnvironment==="sandbox"} onClick={()=>updateProfile({environment:"sandbox"})}><span>Sandbox</span><small>测试付款</small></button><button type="button" className={activePayPalEnvironment==="live"?"active":""} aria-pressed={activePayPalEnvironment==="live"} onClick={()=>updateProfile({environment:"live"})}><span>Live</span><small>真实付款</small></button></div><p>保存后，新创建或重新生成的付款链接将使用 <strong>{activePayPalName}</strong>。已有付款链接会保留原环境，需在订单中重新生成。</p></section><div className="provider-form-grid paypal-active-credentials"><SecretField label={`${activePayPalName} Client ID${activePayPalConfigured?"（已配置）":""}`} value={activePayPalEnvironment==="live"?profile.liveClientId??"":profile.sandboxClientId??""} onChange={value=>updateProfile(activePayPalEnvironment==="live"?{liveClientId:value}:{sandboxClientId:value})} placeholder="留空保持原值"/><SecretField label={`${activePayPalName} Client Secret${activePayPalConfigured?"（已配置）":""}`} value={activePayPalEnvironment==="live"?profile.liveClientSecret??"":profile.sandboxClientSecret??""} onChange={value=>updateProfile(activePayPalEnvironment==="live"?{liveClientSecret:value}:{sandboxClientSecret:value})} placeholder="留空保持原值"/></div><label>Reference 模板<input value={profile.referenceTemplate??"Order #{{orderNumber}}"} onChange={event=>updateProfile({referenceTemplate:event.target.value})}/></label><label>Note 模板<textarea value={profile.noteTemplate??"{{orderNotes}}"} onChange={event=>updateProfile({noteTemplate:event.target.value})}/></label><label>Items · Name 模板<input value={profile.itemNameTemplate??"{{productName}}"} onChange={event=>updateProfile({itemNameTemplate:event.target.value})}/></label></>:<><div><h3>公开收款字段</h3><p>这些内容会进入订单快照和付款说明。</p></div>{profile.publicFields.map((field,index)=><div className="provider-form-grid" key={index}><input value={field.label} placeholder="字段名，例如 IBAN" onChange={event=>updateProfile({publicFields:profile.publicFields.map((item,i)=>i===index?{...item,label:event.target.value}:item)})}/><span><input value={field.value} placeholder="字段值" onChange={event=>updateProfile({publicFields:profile.publicFields.map((item,i)=>i===index?{...item,value:event.target.value}:item)})}/><button onClick={()=>updateProfile({publicFields:profile.publicFields.filter((_,i)=>i!==index)})}><Trash2 size={13}/></button></span></div>)}<button className="secondary-action" onClick={()=>updateProfile({publicFields:[...profile.publicFields,{label:"",value:""}]})}><Plus size={13}/>添加字段</button><label>完整付款说明<textarea value={profile.instructions} maxLength={8000} onChange={event=>updateProfile({instructions:event.target.value})} placeholder="支持 {{orderNumber}}、{{amount}}、{{currency}}"/></label></>}
        <div className="payment-request-actions"><button className="primary-action" disabled={busy||!profile.name.trim()} onClick={()=>void saveProfile()}><Check size={14}/>保存 Profile</button><button className="secondary-action" disabled={busy} onClick={()=>void copyProfile()}><Copy size={14}/>复制</button><button className="danger-text" disabled={busy} onClick={()=>void removeProfile()}><Trash2 size={14}/>删除</button></div></div>}</>}</div>}</div>:<EmptyState title="尚未配置付款方式" text="从上方选择预置类型或 Custom 新增。"/>}
  </div>;
}

function PayPalSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [setting,setSetting]=useState({enabled:false,environment:"sandbox" as "sandbox"|"live",referenceTemplate:"Order #{{orderNumber}}",noteTemplate:"{{orderNotes}}",itemNameTemplate:"{{productName}}"}),[credentials,setCredentials]=useState({sandbox:{clientId:"",clientSecret:""},live:{clientId:"",clientSecret:""}}),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError("");try{const result=await authorizedFetch("/api/v1/admin/paypal-settings",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));setSetting({enabled:Boolean(body.enabled),environment:body.environment==="live"?"live":"sandbox",referenceTemplate:String(body.referenceTemplate??"Order #{{orderNumber}}"),noteTemplate:String(body.noteTemplate??"{{orderNotes}}"),itemNameTemplate:String(body.itemNameTemplate??"{{productName}}")});setCredentials({sandbox:{clientId:String(body.sandboxClientId??""),clientSecret:String(body.sandboxClientSecret??"")},live:{clientId:String(body.liveClientId??""),clientSecret:String(body.liveClientSecret??"")}});}catch(reason){setError(reason instanceof Error?reason.message:"PayPal 配置加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  async function save(){setSaving(true);setError("");try{const result=await authorizedFetch("/api/v1/admin/paypal-settings",token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:setting.enabled,environment:setting.environment,sandboxClientId:credentials.sandbox.clientId.trim()||undefined,sandboxClientSecret:credentials.sandbox.clientSecret.trim()||undefined,liveClientId:credentials.live.clientId.trim()||undefined,liveClientSecret:credentials.live.clientSecret.trim()||undefined,referenceTemplate:setting.referenceTemplate,noteTemplate:setting.noteTemplate,itemNameTemplate:setting.itemNameTemplate})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));onToast(`PayPal ${setting.environment==="live"?"Live":"Sandbox"} 配置已保存${setting.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"PayPal 配置保存失败");}finally{setSaving(false);}}
  if(loading)return <EmptyState title="正在读取 PayPal 配置" text="请稍候…"/>;
  const currentCredentials=credentials[setting.environment],credentialsReady=Boolean(currentCredentials.clientId.trim()&&currentCredentials.clientSecret.trim()),environmentName=setting.environment==="live"?"Live":"Sandbox",updateCredential=(field:"clientId"|"clientSecret",value:string)=>setCredentials(all=>({...all,[setting.environment]:{...all[setting.environment],[field]:value}}));
  return <div className="settings-provider-section paypal-settings"><div className="settings-section-head"><div><h2>PayPal 收款</h2><p>Sandbox 与 Live 凭据分别加密保存；仅管理员可显示或复制。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div><div className="provider-form paypal-settings-form"><header><div><h2>Payment Request Provider</h2><p>先在 Sandbox 完成测试，再切换到 Live 接收真实付款。</p></div><label className="provider-toggle"><input type="checkbox" checked={setting.enabled} onChange={event=>setSetting(value=>({...value,enabled:event.target.checked}))}/><span>启用 PayPal 收款</span></label></header><label>当前收款环境<select value={setting.environment} onChange={event=>setSetting(value=>({...value,environment:event.target.value as "sandbox"|"live"}))}><option value="sandbox">Sandbox（测试）</option><option value="live">Live（真实付款）</option></select><small>{setting.environment==="live"?"当前使用 Live 独立凭据生成真实付款请求。":"当前使用 Sandbox 独立凭据生成测试付款请求。"}</small></label><div className="paypal-credential-environment"><b>{environmentName} API Credentials</b><small>切换环境不会覆盖另一套 Client ID 和 Client Secret。</small></div><SecretField label={`${environmentName} Client ID`} value={currentCredentials.clientId} onChange={value=>updateCredential("clientId",value)} placeholder={`输入 PayPal ${environmentName} REST App Client ID`}/><SecretField label={`${environmentName} Client Secret`} value={currentCredentials.clientSecret} onChange={value=>updateCredential("clientSecret",value)} placeholder={`输入 PayPal ${environmentName} REST App Client Secret`} hint={`启用时只验证当前 ${environmentName} 凭据；验证失败不会保存。`}/><section className="paypal-template-settings"><div><h3>Payment Request 内容模板</h3><p>可输入固定文本，并点击变量插入 <code>{"{{variable}}"}</code>。创建付款请求时会使用订单当时的数据渲染。</p></div><PayPalTemplateField label="Reference" value={setting.referenceTemplate} onChange={referenceTemplate=>setSetting(value=>({...value,referenceTemplate}))} variables={PAYPAL_GLOBAL_VARIABLES}/><PayPalTemplateField label="Note" value={setting.noteTemplate} onChange={noteTemplate=>setSetting(value=>({...value,noteTemplate}))} variables={PAYPAL_GLOBAL_VARIABLES} multiline/><PayPalTemplateField label="Items · Name" value={setting.itemNameTemplate} onChange={itemNameTemplate=>setSetting(value=>({...value,itemNameTemplate}))} variables={PAYPAL_ITEM_VARIABLES}/><small>商品名称模板会分别应用到每个产品和附加费用；产品变量代表当前行。Reference、Note 和 Name 最终会按 PayPal 字段长度限制截取。</small></section>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||(setting.enabled&&!credentialsReady)||!setting.referenceTemplate.trim()||!setting.itemNameTemplate.trim()} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在验证并保存</>:<><Check size={14}/>保存 PayPal 配置</>}</button></div></div>;
}

const PAYPAL_VARIABLE_LABELS:Record<string,string>={orderNumber:"订单号",currentDate:"当前日期",recipientName:"收件人",address:"地址",phone:"电话",orderNotes:"订单备注",orderTotal:"订单总金额",currency:"币种",customerName:"客户名",customerPhone:"客户电话",productNames:"全部产品名",productQuantity:"产品数量",productName:"当前产品名",sku:"SKU",unitAmount:"当前单价",lineTotal:"当前小计"};
const PAYPAL_GLOBAL_VARIABLES=["orderNumber","currentDate","recipientName","address","phone","orderNotes","orderTotal","currency","customerName","customerPhone","productNames","productQuantity"];
const PAYPAL_ITEM_VARIABLES=[...PAYPAL_GLOBAL_VARIABLES,"productName","sku","unitAmount","lineTotal"];
function PayPalTemplateField({label,value,onChange,variables,multiline=false}:{label:string;value:string;onChange:(value:string)=>void;variables:string[];multiline?:boolean}){
  const field=multiline?<textarea value={value} onChange={event=>onChange(event.target.value)} maxLength={4000}/>:<input value={value} onChange={event=>onChange(event.target.value)} maxLength={500}/>;
  return <label className="paypal-template-field"><span>{label}</span>{field}<div className="paypal-variable-buttons">{variables.map(variable=><button type="button" key={variable} title={`插入 {{${variable}}}`} onClick={()=>onChange(`${value}{{${variable}}}`)}>{PAYPAL_VARIABLE_LABELS[variable]}</button>)}</div></label>;
}

const TRANSLATION_PROVIDER_META:Record<TranslationProviderId,{name:string;description:string;keyLabel:string;endpointHint:string;modelHint:string;transcriptionModelHint:string}>={
  openai:{name:"OpenAI",description:"OpenAI 官方 Chat Completions 与 Audio Transcriptions API",keyLabel:"OpenAI API Key",endpointHint:"https://api.openai.com/v1",modelHint:"gpt-5.6-luna",transcriptionModelHint:"gpt-4o-mini-transcribe"},
  openai_compatible:{name:"Custom Provider",description:"兼容 /chat/completions 与 /audio/transcriptions 的服务",keyLabel:"API Key",endpointHint:"https://provider.example.com/v1",modelHint:"Provider 的翻译模型 ID",transcriptionModelHint:"Provider 的语音转写模型 ID"},
};

function TranslationSettingsPanel({token,onToken,onToast}:{token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<TranslationProviderConfig[]>([]),[selected,setSelected]=useState<TranslationProviderId>("openai"),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/translation-providers",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {data?:TranslationProviderConfig[];error?:string};if(!result.response.ok||!body.data)throw new Error(body.error??`HTTP ${result.response.status}`);setProviders(body.data);setSelected(previous=>body.data?.some(item=>item.provider===previous)?previous:(body.data?.find(item=>item.enabled)?.provider??"openai"));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"翻译 Provider 配置加载失败");}finally{setLoading(false);}},[token,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(initial);},[load]);
  const current=providers.find(item=>item.provider===selected);const meta=TRANSLATION_PROVIDER_META[selected];
  function change(values:Partial<TranslationProviderConfig>){setProviders(items=>items.map(item=>item.provider===selected?{...item,...values}:item));}
  async function save(){if(!current||saving)return;setSaving(true);setError("");try{const result=await authorizedFetch(`/api/v1/admin/translation-providers/${selected}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:current.enabled,apiKey:current.apiKey.trim()||undefined,baseUrl:current.baseUrl,model:current.model,transcriptionModel:current.transcriptionModel})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));onToast(`${meta.name} 翻译配置已保存${current.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setSaving(false);}}
  return <div className="settings-provider-section"><div className="settings-section-head"><div><h2>AI 翻译 Provider</h2><p>用于文字翻译与语音转写；转写原文和译文都会缓存。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>{loading?<EmptyState title="正在读取翻译 Provider" text="请稍候…"/>:<div className="provider-settings-layout"><nav className="provider-list" aria-label="翻译 Provider">{providers.map(item=><button key={item.provider} className={selected===item.provider?"active":""} onClick={()=>setSelected(item.provider)}><span><b>{TRANSLATION_PROVIDER_META[item.provider].name}</b><small>{TRANSLATION_PROVIDER_META[item.provider].description}</small></span><em className={item.enabled?"enabled":item.keyConfigured?"configured":""}>{item.enabled?"使用中":item.keyConfigured?"已配置":"未配置"}</em></button>)}</nav>{current&&<div className="provider-form"><header><div><h2>{meta.name}</h2><p>{meta.description}</p></div><label className="provider-toggle"><input type="checkbox" checked={current.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>设为当前 Provider</span></label></header><SecretField label={meta.keyLabel} value={current.apiKey} onChange={value=>change({apiKey:value})} placeholder="请输入 API Key" hint="密钥已加密保存；仅管理员可在此显示或复制。"/><label>API Endpoint<input type="url" value={current.baseUrl} onChange={event=>change({baseUrl:event.target.value})} placeholder={meta.endpointHint}/></label><label>文字翻译模型 ID<input value={current.model} onChange={event=>change({model:event.target.value})} placeholder={meta.modelHint}/></label><label>语音转写模型 ID<input value={current.transcriptionModel} onChange={event=>change({transcriptionModel:event.target.value})} placeholder={meta.transcriptionModelHint}/><small>OpenAI 默认使用 gpt-4o-mini-transcribe。</small></label>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||!current.baseUrl.trim()||!current.model.trim()||!current.transcriptionModel.trim()||!current.apiKey.trim()} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在保存</>:<><Check size={14}/>保存配置</>}</button></div>}</div>}</div>;
}

const TTS_PROVIDER_META:Record<TtsProviderId,{name:string;description:string;keyLabel:string;endpointHint:string;modelHint:string;voiceHint:string}>={
  openai:{name:"OpenAI",description:"OpenAI 官方 Audio Speech API",keyLabel:"OpenAI API Key",endpointHint:"https://api.openai.com/v1",modelHint:"gpt-4o-mini-tts",voiceHint:"coral"},
  elevenlabs:{name:"ElevenLabs",description:"多语言语音与自定义 Voice ID",keyLabel:"ElevenLabs API Key",endpointHint:"https://api.elevenlabs.io/v1",modelHint:"eleven_multilingual_v2",voiceHint:"Voice ID"},
  azure:{name:"Azure Speech",description:"Microsoft Azure AI Speech REST API",keyLabel:"Speech Resource Key",endpointHint:"https://资源名.cognitiveservices.azure.com",modelHint:"Azure 不需要填写模型",voiceHint:"zh-CN-XiaoxiaoNeural"},
  openai_compatible:{name:"OpenAI 兼容接口",description:"自托管或第三方兼容 /audio/speech 的服务",keyLabel:"API Key",endpointHint:"https://provider.example.com/v1",modelHint:"Provider 的模型 ID",voiceHint:"Provider 的音色 ID"},
};
function providerName(provider:string|null){return provider&&provider in TTS_PROVIDER_META?TTS_PROVIDER_META[provider as TtsProviderId].name:(provider??"已配置的 Provider");}

function TtsSettingsPanel({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [providers,setProviders]=useState<TtsProviderConfig[]>([]),[selected,setSelected]=useState<TtsProviderId>("openai"),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const load=useCallback(async()=>{if(role!=="admin"){setLoading(false);return;}setLoading(true);try{const result=await authorizedFetch("/api/v1/admin/tts-providers",token);if(result.token!==token)onToken(result.token);const body=await result.response.json() as {data?:TtsProviderConfig[];error?:string};if(!result.response.ok||!body.data)throw new Error(body.error??`HTTP ${result.response.status}`);setProviders(body.data);setSelected(previous=>body.data?.some(item=>item.provider===previous)?previous:(body.data?.find(item=>item.enabled)?.provider??"openai"));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"Provider 配置加载失败");}finally{setLoading(false);}},[token,role,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(initial);},[load]);
  const current=providers.find(item=>item.provider===selected);const meta=TTS_PROVIDER_META[selected];
  function change(values:Partial<TtsProviderConfig>){setProviders(items=>items.map(item=>item.provider===selected?{...item,...values}:item));}
  async function save(){if(!current||saving)return;setSaving(true);setError("");try{const result=await authorizedFetch(`/api/v1/admin/tts-providers/${selected}`,token,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:current.enabled,apiKey:current.apiKey.trim()||undefined,baseUrl:current.baseUrl,model:current.model,voice:current.voice})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));onToast(`${meta.name} 配置已保存${current.enabled?"并启用":""}`);await load();}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setSaving(false);}}
  if(role!=="admin")return <EmptyState title="需要管理员权限" text="只有管理员可以查看或修改语音 Provider 与密钥配置。"/>;
  return <div className="settings-provider-section"><div className="settings-section-head"><div><h2>AI 语音 Provider</h2><p>管理文字转语音服务、模型与默认音色。</p></div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>{loading?<EmptyState title="正在读取语音 Provider" text="请稍候…"/>:<div className="provider-settings-layout"><nav className="provider-list" aria-label="语音 Provider">{providers.map(item=><button key={item.provider} className={selected===item.provider?"active":""} onClick={()=>setSelected(item.provider)}><span><b>{TTS_PROVIDER_META[item.provider].name}</b><small>{TTS_PROVIDER_META[item.provider].description}</small></span><em className={item.enabled?"enabled":item.keyConfigured?"configured":""}>{item.enabled?"使用中":item.keyConfigured?"已配置":"未配置"}</em></button>)}</nav>{current&&<div className="provider-form"><header><div><h2>{meta.name}</h2><p>{meta.description}</p></div><label className="provider-toggle"><input type="checkbox" checked={current.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>设为当前 Provider</span></label></header><SecretField label={meta.keyLabel} value={current.apiKey} onChange={value=>change({apiKey:value})} placeholder="请输入 API Key" hint="密钥已加密保存；仅管理员可在此显示或复制。"/><label>API Endpoint<input type="url" value={current.baseUrl} onChange={event=>change({baseUrl:event.target.value})} placeholder={meta.endpointHint}/></label><div className="provider-form-grid"><label>模型 ID<input value={current.model} onChange={event=>change({model:event.target.value})} placeholder={meta.modelHint}/></label><label>默认音色 / Voice ID<input value={current.voice} onChange={event=>change({voice:event.target.value})} placeholder={meta.voiceHint}/></label></div>{error&&<span className="login-error">{error}</span>}<button className="primary-action provider-save" disabled={saving||!current.baseUrl.trim()||!current.voice.trim()||(selected!=="azure"&&!current.model.trim())||!current.apiKey.trim()} onClick={()=>void save()}>{saving?<><RefreshCw className="spin" size={14}/>正在保存</>:<><Check size={14}/>保存配置</>}</button></div>}</div>}</div>;
}

function ContactAvatar({contact,token,onToken,size="medium"}:{contact:Pick<ContactProfile,"id"|"name"|"avatarUrl">;token:string;onToken:(token:string)=>void;size?:"medium"|"large"}){
  const avatarKey=`${contact.id}:${contact.avatarUrl??""}`;
  const [loadedAvatar,setLoadedAvatar]=useState({key:"",url:""});
  useEffect(()=>{if(!contact.avatarUrl)return;const controller=new AbortController();let objectUrl="";void(async()=>{try{const result=await authorizedFetch(`/api/v1/contacts/${contact.id}/avatar`,token,{signal:controller.signal});if(result.token!==token)onToken(result.token);if(!result.response.ok)return;objectUrl=URL.createObjectURL(await result.response.blob());setLoadedAvatar({key:avatarKey,url:objectUrl});}catch{} })();return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[avatarKey,contact.id,contact.avatarUrl,token,onToken]);
  const url=loadedAvatar.key===avatarKey?loadedAvatar.url:"";
  return <span className={`contact-avatar ${size}`}>{url?<img src={url} alt=""/>:<span>{contact.name.slice(0,2).toUpperCase()}</span>}</span>;
}

function ContactManagement({token,role,accounts,onToken,onToast,onConversation}:{token:string;role:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void;onConversation:(conversationId:string)=>void}){
  const [contacts,setContacts]=useState<ContactProfile[]>([]),[query,setQuery]=useState(""),[accountId,setAccountId]=useState(""),[offset,setOffset]=useState(0),[total,setTotal]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(""),[creating,setCreating]=useState(false),[importing,setImporting]=useState(false),[exporting,setExporting]=useState(false),[editingId,setEditingId]=useState<string|null>(null),[addressEditingId,setAddressEditingId]=useState<string|null>(null);const pageSize=30;
  const load=useCallback(async()=>{setLoading(true);try{const params=new URLSearchParams({limit:String(pageSize),offset:String(offset)});if(query.trim())params.set("q",query.trim());if(accountId)params.set("accountId",accountId);const result=await authorizedFetch(`/api/v1/contacts?${params}`,token);if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {data?:Array<Record<string,unknown>>;total?:number;message?:string};if(!result.response.ok)throw new Error(body.message??`联系人加载失败（HTTP ${result.response.status}）`);setContacts((body.data??[]).map(mapContactProfile));setTotal(Number(body.total??0));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"联系人加载失败");}finally{setLoading(false);}},[token,onToken,query,accountId,offset]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),query?250:0);return()=>window.clearTimeout(timer);},[load,query]);
  async function remove(contact:ContactProfile){const warning=contact.hasConversation?`“${contact.name}”及其关联会话、消息和订单将被永久删除。`:`联系人“${contact.name}”将被永久删除。`;if(!await confirmAction(warning,{title:"删除联系人？",confirmLabel:"永久删除"}))return;const result=await authorizedFetch(`/api/v1/contacts/${contact.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {message?:string};if(!result.response.ok){onToast(body.message??`联系人删除失败（HTTP ${result.response.status}）`);return;}onToast("联系人已删除");if(contacts.length===1&&offset>0)setOffset(value=>Math.max(0,value-pageSize));else await load();}
  async function exportContacts(){setExporting(true);try{const exported:ContactProfile[]=[];let nextOffset=0;while(true){const params=new URLSearchParams({limit:"100",offset:String(nextOffset)});if(query.trim())params.set("q",query.trim());if(accountId)params.set("accountId",accountId);const result=await authorizedFetch(`/api/v1/contacts?${params}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`联系人导出失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {data:Array<Record<string,unknown>>;hasMore:boolean;nextOffset:number};exported.push(...body.data.map(mapContactProfile));if(!body.hasMore)break;nextOffset=body.nextOffset;}downloadCsv(`contacts-${dateFileSuffix()}.csv`,["account","phone","first_name","middle_name","last_name","alias","email","note","conversation_id"],exported.map(contact=>[contact.accountName,contact.phone,contact.firstName,contact.middleName,contact.lastName,contact.alias,contact.primaryEmail??"",contact.note,contact.conversationId??""]));onToast(`已导出 ${exported.length} 位联系人`);}catch(reason){onToast(reason instanceof Error?reason.message:"联系人导出失败");}finally{setExporting(false);}}
  const page=Math.floor(offset/pageSize)+1,pages=Math.max(1,Math.ceil(total/pageSize));
  return <section className="management-panel contact-management"><header className="management-head"><div><span className="eyebrow">团队联系人目录</span><h1>联系人管理</h1><p>新建联系人并维护头像、WhatsApp 号码、邮箱、其他联系方式和业务备注。</p></div><div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button><button className="secondary-action" onClick={()=>setImporting(true)}><UploadCloud size={15}/>一键导入</button><button className="secondary-action" disabled={exporting} onClick={()=>void exportContacts()}><FileDown size={15}/>{exporting?"导出中…":"一键导出"}</button><button className="primary-action" onClick={()=>setCreating(true)} disabled={!accounts.length}><UserPlus size={15}/>新建联系人</button></div></header>
    <div className="contact-filters"><label><Search size={15}/><input value={query} onChange={event=>{setQuery(event.target.value);setOffset(0);}} placeholder="搜索姓名、号码、邮箱或其他联系方式"/></label><select value={accountId} onChange={event=>{setAccountId(event.target.value);setOffset(0);}} aria-label="按 WhatsApp 账号筛选"><option value="">全部 WhatsApp 账号</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select><span>共 {total} 位联系人</span></div>
    {loading?<EmptyState title="正在读取联系人" text="请稍候…"/>:error?<EmptyState title="联系人加载失败" text={error}/>:contacts.length?<><div className="order-table-wrap contact-table-wrap"><table className="order-table contact-table"><thead><tr><th>联系人</th><th>Primary Email</th><th>联系方式 / 地址</th><th>WhatsApp 账号</th><th>最近会话</th><th aria-label="操作"/></tr></thead><tbody>{contacts.map(contact=><tr key={contact.id}><td><span className="contact-table-person"><ContactAvatar contact={contact} token={token} onToken={onToken}/><span><b>{contact.name}</b><small>{contact.phone||"暂无 WhatsApp 号码"}</small></span></span></td><td>{contact.primaryEmail?<><b>{contact.primaryEmail}</b><small>{contact.emails.find(item=>item.isPrimary)?.label||"主要邮箱"}</small></>:<span className="contact-empty-value">未设置</span>}</td><td>{contact.methods.length?<b>{contactMethodName(contact.methods[0].type)} · {contact.methods[0].value}</b>:<span className="contact-empty-value">暂无其他联系方式</span>}<small>{contact.addresses.length?`${contact.addresses.length} 个收货地址`:"暂无收货地址"}</small></td><td><b>{contact.accountName}</b><small>账号内独立联系人</small></td><td>{contact.lastMessageAt?formatDateTime(contact.lastMessageAt):"暂无"}</td><td><span className="contact-row-actions"><button onClick={()=>setEditingId(contact.id)}><Pencil size={13}/>资料</button><button onClick={()=>setAddressEditingId(contact.id)}><MapPin size={13}/>地址</button>{contact.conversationId&&<button onClick={()=>onConversation(contact.conversationId!)}><ExternalLink size={13}/>会话</button>}{["admin","supervisor"].includes(role)&&<button className="danger" onClick={()=>void remove(contact)}><Trash2 size={13}/>删除</button>}</span></td></tr>)}</tbody></table></div><div className="contact-pagination"><button disabled={offset===0} onClick={()=>setOffset(value=>Math.max(0,value-pageSize))}>上一页</button><span>第 {page} / {pages} 页</span><button disabled={offset+pageSize>=total} onClick={()=>setOffset(value=>value+pageSize)}>下一页</button></div></>:<EmptyState title="暂无匹配联系人" text="点击“新建联系人”添加，或等待 WhatsApp 会话同步后自动出现。"/>}
    {creating&&<ContactCreateDialog accounts={accounts.filter(account=>account.platform==="whatsapp")} token={token} onToken={onToken} onClose={()=>setCreating(false)} onSaved={async()=>{setCreating(false);setOffset(0);onToast("联系人已创建");await load();}}/>}
    {importing&&<DataImportDialog kind="contacts" accounts={accounts.filter(account=>account.platform==="whatsapp").map(account=>({id:account.id,name:account.name}))} request={(path,init)=>authorizedFetch(path,token,init)} onToken={onToken} onClose={()=>setImporting(false)} onImported={async count=>{setImporting(false);setOffset(0);onToast(`已导入 ${count} 位联系人`);await load();}}/>}
    {editingId&&<ContactEditDialog contactId={editingId} token={token} onToken={onToken} onClose={()=>setEditingId(null)} onSaved={async()=>{setEditingId(null);onToast("联系人资料已更新");await load();}}/>}
    {addressEditingId&&<ContactAddressDialog contactId={addressEditingId} token={token} onToken={onToken} onClose={()=>setAddressEditingId(null)} onSaved={async()=>{setAddressEditingId(null);onToast("联系人地址已更新");await load();}}/>}
  </section>;
}

function ContactCreateDialog({accounts,token,onToken,onClose,onSaved}:{accounts:Account[];token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [accountId,setAccountId]=useState(accounts[0]?.id??""),[firstName,setFirstName]=useState(""),[middleName,setMiddleName]=useState(""),[lastName,setLastName]=useState(""),[phone,setPhone]=useState(""),[avatar,setAvatar]=useState<File|null>(null),[avatarPickerOpen,setAvatarPickerOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const name=[firstName,middleName,lastName].map(value=>value.trim()).filter(Boolean).join(" ");
  const preview=useMemo(()=>avatar?URL.createObjectURL(avatar):"",[avatar]);useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview);},[preview]);
  const request=useCallback((path:string,init?:RequestInit)=>authorizedFetch(path,token,init),[token]);
  async function selectAvatar(asset:ProductImageAsset){setError("");try{const result=await request(`/api/v1/media/${asset.id}`);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`头像读取失败（HTTP ${result.response.status}）`);const blob=await result.response.blob();setAvatar(new File([blob],asset.fileName,{type:asset.mimeType}));setAvatarPickerOpen(false);}catch(reason){setError(reason instanceof Error?reason.message:"头像读取失败");}}
  async function save(){if(!accountId||!name||!phone.trim())return;if(avatar&&avatar.size>5*1024*1024){setError("头像文件不能超过 5 MB");return;}setBusy(true);setError("");try{let accessToken=token;const result=await authorizedFetch("/api/v1/contacts",accessToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,firstName,middleName,lastName,phone})});accessToken=result.token;if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>&{id?:string;message?:string;details?:{fieldErrors?:Record<string,string[]>}};if(!result.response.ok||!body.id){const detail=body.details?.fieldErrors?Object.values(body.details.fieldErrors).flat()[0]:undefined;throw new Error(detail??body.message??`创建失败（HTTP ${result.response.status}）`);}if(avatar){const form=new FormData();form.append("file",avatar);const uploaded=await authorizedFetch(`/api/v1/contacts/${body.id}/avatar`,accessToken,{method:"POST",body:form});if(uploaded.token!==accessToken)onToken(uploaded.token);if(!uploaded.response.ok)throw new Error("联系人已创建，但头像上传失败；可在联系人资料中重新设置");}await onSaved();}catch(reason){setError(reason instanceof Error?reason.message:"联系人创建失败");setBusy(false);}}
  return <><div className="modal-backdrop contact-dialog-backdrop" role="presentation"><section className="login-dialog contact-create-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-create-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><header className="contact-dialog-heading"><span className="login-logo"><UserPlus size={20}/></span><div><h2 id="contact-create-title">新建联系人</h2><p>联系人归属于一个 WhatsApp 账号，之后可继续补充邮箱和地址。</p></div></header><div className="contact-avatar-editor"><button type="button" className="contact-avatar-picker" onClick={()=>setAvatarPickerOpen(true)} disabled={busy||!accountId}><span className="contact-avatar large">{preview?<img src={preview} alt="头像预览"/>:<span>{name.slice(0,2).toUpperCase()||"头像"}</span>}</span><span><b>{avatar?"更换头像":"设置头像"}</b><small>从媒体与附件选择，支持 JPG、PNG 或 WebP，最大 5 MB</small></span></button>{avatar&&<button type="button" onClick={()=>setAvatar(null)}>移除</button>}</div><label>WhatsApp 账号<select value={accountId} onChange={event=>setAccountId(event.target.value)} disabled={busy}>{accounts.map(account=><option value={account.id} key={account.id}>{account.name}</option>)}</select></label><div className="contact-create-grid"><label>First name<input value={firstName} maxLength={80} onChange={event=>setFirstName(event.target.value)} placeholder="例如：Alice" autoFocus/></label><label>Middle name<input value={middleName} maxLength={80} onChange={event=>setMiddleName(event.target.value)} placeholder="可选"/></label><label>Last name<input value={lastName} maxLength={80} onChange={event=>setLastName(event.target.value)} placeholder="例如：Smith"/></label><label>WhatsApp 号码<input value={phone} onChange={event=>setPhone(event.target.value)} inputMode="tel" placeholder="例如：+8613800138000"/><small>必须包含国家或地区代码</small></label></div>{error&&<span className="login-error">{error}</span>}<footer className="contact-dialog-actions"><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={busy||!accountId||!name||!phone.trim()}>{busy?"正在创建…":"创建联系人"}</button></footer></section></div>{avatarPickerOpen&&<ProductImageMediaDialog request={request} onToken={onToken} onClose={()=>setAvatarPickerOpen(false)} onSelect={asset=>void selectAvatar(asset)} libraryPath={`/api/v1/media?accountId=${encodeURIComponent(accountId)}&limit=100`} uploadPath={`/api/v1/media?accountId=${encodeURIComponent(accountId)}`} title="选择联系人头像" description="复用该 WhatsApp 账号媒体与附件中的图片，或上传新图片。" actionLabel="使用所选头像" acceptedMimeTypes={["image/jpeg","image/png","image/webp"]} maxFileSize={5*1024*1024}/>}</>;
}

function ContactAddressDialog({contactId,token,onToken,onClose,onSaved}:{contactId:string;token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:(profile:ContactProfile)=>Promise<void>}){
  const [profile,setProfile]=useState<ContactProfile|null>(null);
  const [addresses,setAddresses]=useState<CustomerAddress[]>([]);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{let cancelled=false;void(async()=>{try{const result=await authorizedFetch(`/api/v1/contacts/${contactId}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`地址加载失败（HTTP ${result.response.status}）`);const next=mapContactProfile(await result.response.json() as Record<string,unknown>);if(!cancelled){setProfile(next);setAddresses(next.addresses);}}catch(reason){if(!cancelled)setError(reason instanceof Error?reason.message:"地址加载失败");}finally{if(!cancelled)setLoading(false);}})();return()=>{cancelled=true;};},[contactId,token,onToken]);
  function addAddress(){setAddresses(items=>[...items,{id:"",label:"收货地址",recipientName:profile?.name??"",phone:profile?.phone??"",address:"",isDefault:items.length===0}]);}
  function changeAddress(index:number,change:Partial<CustomerAddress>){setAddresses(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,...change}:item));}
  function removeAddress(index:number){setAddresses(items=>{const removed=items[index],next=items.filter((_,itemIndex)=>itemIndex!==index);if(removed?.isDefault&&next.length)next[0]={...next[0],isDefault:true};return next;});}
  function setDefaultAddress(index:number){setAddresses(items=>items.map((item,itemIndex)=>({...item,isDefault:itemIndex===index})));}
  async function save(){if(!profile)return;if(addresses.some(item=>!item.label.trim()||!item.address.trim())){setError("请填写地址名称和详细地址，或移除未完成的地址");return;}setBusy(true);setError("");try{const result=await authorizedFetch(`/api/v1/contacts/${contactId}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({alias:profile.alias,firstName:profile.firstName,middleName:profile.middleName,lastName:profile.lastName,note:profile.note,emails:profile.emails.map(({label,email,isPrimary})=>({label,email,isPrimary})),methods:profile.methods.map(({type,label,value})=>({type,label,value})),addresses:addresses.map(item=>({...(item.id?{id:item.id}:{}),label:item.label,recipientName:item.recipientName,phone:item.phone,address:item.address,isDefault:item.isDefault}))})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>&{error?:string};if(!result.response.ok)throw new Error(body.error??`地址保存失败（HTTP ${result.response.status}）`);await onSaved(mapContactProfile(body));}catch(reason){setError(reason instanceof Error?reason.message:"地址保存失败");setBusy(false);}}
  return <div className="modal-backdrop contact-dialog-backdrop" role="presentation">
    <section className="login-dialog address-dialog" role="dialog" aria-modal="true" aria-labelledby="address-dialog-title">
      <button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button>
      <header className="contact-dialog-heading"><span className="login-logo"><MapPin size={20}/></span><div><h2 id="address-dialog-title">联系人收货地址</h2><p>{profile?`${profile.name} · ${profile.accountName}`:"地址会绑定到当前联系人"}</p></div></header>
      {loading?<div className="contact-dialog-loading"><RefreshCw className="spin" size={17}/>正在读取地址…</div>:<>
        <div className="address-dialog-toolbar"><span>已保存 {addresses.length} 个地址</span><button type="button" onClick={addAddress}><Plus size={14}/>新增地址</button></div>
        <div className="contact-address-list">{addresses.map((item,index)=><article key={item.id||`new-${index}`}>
          <header><MapPin size={15}/><b>地址 {index+1}</b><label><input type="radio" name="default-address" checked={item.isDefault} onChange={()=>setDefaultAddress(index)}/><span>{item.isDefault?"默认收货地址":"设为默认"}</span></label><button type="button" onClick={()=>removeAddress(index)} aria-label="移除地址"><Trash2 size={14}/></button></header>
          <div className="contact-address-grid"><label>地址名称<input value={item.label} maxLength={40} onChange={event=>changeAddress(index,{label:event.target.value})} placeholder="例如：公司、家"/></label><label>收件人<input value={item.recipientName} maxLength={80} onChange={event=>changeAddress(index,{recipientName:event.target.value})} placeholder="收件人姓名"/></label><label>联系电话<input value={item.phone} maxLength={40} onChange={event=>changeAddress(index,{phone:event.target.value})} placeholder="联系电话"/></label><label className="contact-address-detail">详细地址<textarea value={item.address} maxLength={1000} onChange={event=>changeAddress(index,{address:event.target.value})} placeholder="国家/地区、省市、街道及门牌号"/></label></div>
        </article>)}</div>
        {!addresses.length&&<div className="contact-address-empty"><MapPin size={22}/><b>尚未保存收货地址</b><span>新增后，创建订单时可直接选择。</span></div>}
        {error&&<span className="login-error">{error}</span>}
        <footer className="contact-dialog-actions"><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={busy}>{busy?"正在保存…":"保存地址"}</button></footer>
      </>}
    </section>
  </div>;
}

function ContactEditDialog({contactId,token,onToken,onClose,onSaved}:{contactId:string;token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:(profile:ContactProfile)=>Promise<void>}){
  const [profile,setProfile]=useState<ContactProfile|null>(null),[alias,setAlias]=useState(""),[firstName,setFirstName]=useState(""),[middleName,setMiddleName]=useState(""),[lastName,setLastName]=useState(""),[phone,setPhone]=useState(""),[note,setNote]=useState(""),[timezone,setTimezone]=useState(""),[preferredLanguage,setPreferredLanguage]=useState(""),[birthday,setBirthday]=useState<ContactDate|null>(null),[specialDates,setSpecialDates]=useState<ContactSpecialDate[]>([]),[emails,setEmails]=useState<ContactEmail[]>([]),[methods,setMethods]=useState<ContactMethod[]>([]),[avatarFile,setAvatarFile]=useState<File|null>(null),[avatarPickerOpen,setAvatarPickerOpen]=useState(false),[removeAvatar,setRemoveAvatar]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const avatarPreview=useMemo(()=>avatarFile?URL.createObjectURL(avatarFile):"",[avatarFile]);useEffect(()=>()=>{if(avatarPreview)URL.revokeObjectURL(avatarPreview);},[avatarPreview]);
  const request=useCallback((path:string,init?:RequestInit)=>authorizedFetch(path,token,init),[token]);
  async function selectAvatar(asset:ProductImageAsset){setError("");try{const result=await request(`/api/v1/media/${asset.id}`);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`头像读取失败（HTTP ${result.response.status}）`);const blob=await result.response.blob();setAvatarFile(new File([blob],asset.fileName,{type:asset.mimeType}));setRemoveAvatar(false);setAvatarPickerOpen(false);}catch(reason){setError(reason instanceof Error?reason.message:"头像读取失败");}}
  useEffect(()=>{let cancelled=false;void (async()=>{try{const result=await authorizedFetch(`/api/v1/contacts/${contactId}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`联系人加载失败（HTTP ${result.response.status}）`);const next=mapContactProfile(await result.response.json() as Record<string,unknown>);if(cancelled)return;setProfile(next);setAlias(next.alias);setFirstName(next.firstName);setMiddleName(next.middleName);setLastName(next.lastName);setPhone(next.phone);setNote(next.note);setTimezone(next.timezone??"");setPreferredLanguage(next.preferredLanguage??"");setBirthday(next.birthday);setSpecialDates(next.specialDates);setEmails(next.emails);setMethods(next.methods);}catch(reason){if(!cancelled)setError(reason instanceof Error?reason.message:"联系人加载失败");}finally{if(!cancelled)setLoading(false);}})();return()=>{cancelled=true;};},[contactId,token,onToken]);
  useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy)onClose();};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[busy,onClose]);
  function addEmail(){setEmails(items=>[...items,{id:crypto.randomUUID(),label:"",email:"",isPrimary:items.length===0}]);}
  function removeEmail(index:number){setEmails(items=>{const next=items.filter((_,itemIndex)=>itemIndex!==index);if(next.length&&!next.some(item=>item.isPrimary))next[0]={...next[0],isPrimary:true};return next;});}
  function setPrimary(index:number){setEmails(items=>items.map((item,itemIndex)=>({...item,isPrimary:itemIndex===index})));}
  function addMethod(){setMethods(items=>[...items,{id:crypto.randomUUID(),type:"phone",label:"",value:""}]);}
  async function save(){if(emails.some(item=>!item.email.trim())){setError("请填写完整邮箱地址，或移除空白邮箱行");return;}if(methods.some(item=>!item.value.trim())){setError("请填写完整联系方式，或移除空白联系方式行");return;}if(specialDates.some(item=>!item.label.trim())){setError("请填写特殊日期名称，或移除空白项目");return;}if(avatarFile&&avatarFile.size>5*1024*1024){setError("头像文件不能超过 5 MB");return;}if(!profile)return;setBusy(true);setError("");try{let accessToken=token;const result=await authorizedFetch(`/api/v1/contacts/${contactId}`,accessToken,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({alias,firstName,middleName,lastName,phone,note,timezone:timezone||null,preferredLanguage:preferredLanguage||null,birthday,specialDates,emails:emails.map(item=>({label:item.label,email:item.email,isPrimary:item.isPrimary})),methods:methods.map(item=>({type:item.type,label:item.label,value:item.value})),addresses:profile.addresses})});accessToken=result.token;if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>&{error?:string;message?:string;details?:{fieldErrors?:Record<string,string[]>}};if(!result.response.ok){const detail=body.details?.fieldErrors?Object.values(body.details.fieldErrors).flat()[0]:undefined;throw new Error(detail??body.message??body.error??`保存失败（HTTP ${result.response.status}）`);}if(avatarFile){const form=new FormData();form.append("file",avatarFile);const uploaded=await authorizedFetch(`/api/v1/contacts/${contactId}/avatar`,accessToken,{method:"POST",body:form});accessToken=uploaded.token;if(accessToken!==token)onToken(accessToken);const avatarBody=await uploaded.response.json().catch(()=>({})) as {message?:string};if(!uploaded.response.ok)throw new Error(avatarBody.message??"头像上传失败");}else if(removeAvatar&&profile.avatarUrl){const removed=await authorizedFetch(`/api/v1/contacts/${contactId}/avatar`,accessToken,{method:"DELETE"});if(removed.token!==token)onToken(removed.token);if(!removed.response.ok)throw new Error("头像移除失败");}const refreshed=await authorizedFetch(`/api/v1/contacts/${contactId}`,accessToken);if(refreshed.token!==token)onToken(refreshed.token);await onSaved(mapContactProfile(await refreshed.response.json() as Record<string,unknown>));}catch(reason){setError(reason instanceof Error?reason.message:"联系人保存失败");setBusy(false);}}
  return <><div className="modal-backdrop contact-dialog-backdrop" role="presentation"><section className="login-dialog contact-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title">
    <button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Users size={20}/></span><h2 id="contact-dialog-title">编辑联系人</h2>
    {loading?<div className="contact-dialog-loading"><RefreshCw className="spin" size={17}/>正在读取联系人资料…</div>:profile?<>
      <p>{profile.contactName||profile.phone} · {profile.accountName}</p>
      <div className="contact-avatar-editor"><button type="button" className="contact-avatar-picker" onClick={()=>setAvatarPickerOpen(true)} disabled={busy}>{avatarPreview?<span className="contact-avatar large"><img src={avatarPreview} alt="头像预览"/></span>:removeAvatar?<span className="contact-avatar large"><span>{profile.name.slice(0,2).toUpperCase()}</span></span>:<ContactAvatar contact={profile} token={token} onToken={onToken} size="large"/>}<span><b>{profile.avatarUrl&&!removeAvatar?"更换头像":"设置头像"}</b><small>从媒体与附件选择，支持 JPG、PNG 或 WebP，最大 5 MB</small></span></button>{(profile.avatarUrl||avatarFile)&&!removeAvatar&&<button type="button" onClick={()=>{setAvatarFile(null);setRemoveAvatar(true);}}>移除</button>}</div>
      <div className="contact-create-grid"><label>联系人名称<input value={alias} onChange={event=>setAlias(event.target.value)} maxLength={80} placeholder={profile.contactName||profile.phone}/><small>团队维护的显示名称不会被 WhatsApp 同步覆盖。</small></label><label>WhatsApp 号码<input value={phone} onChange={event=>setPhone(event.target.value)} inputMode="tel" disabled={profile.hasConversation&&Boolean(profile.phone)}/><small>{profile.hasConversation&&profile.phone?"该联系人已有对应会话，号码不可修改。":"必须包含国家或地区代码。"}</small></label><label>First name<input value={firstName} onChange={event=>setFirstName(event.target.value)} maxLength={80} placeholder="名字"/></label><label>Middle name<input value={middleName} onChange={event=>setMiddleName(event.target.value)} maxLength={80} placeholder="中间名（可选）"/></label><label>Last name<input value={lastName} onChange={event=>setLastName(event.target.value)} maxLength={80} placeholder="姓氏"/></label></div>
      <section className="contact-field-section contact-language-field"><header><span><Languages size={15}/><b>偏好语言</b><small>联系人更常用或希望收到消息的语言</small></span>{preferredLanguage&&<button type="button" onClick={()=>setPreferredLanguage("")}>清除设置</button>}</header><LanguagePicker value={preferredLanguage} onChange={setPreferredLanguage} label="搜索联系人偏好语言" allowEmpty/><p>{preferredLanguage?<><span aria-hidden="true">{languageFlag(preferredLanguage)}</span> 已设置为 {languageName(preferredLanguage)}（{languageShortCode(preferredLanguage)}）</>:"尚未设置偏好语言"}</p></section>
      <section className="contact-field-section contact-timezone-field"><header><span><Clock3 size={15}/><b>联系人时区</b><small>用于详情页显示对方当前时间</small></span>{timezone&&<button type="button" onClick={()=>setTimezone("")}>按国家自动推算</button>}</header><TimezoneSearchDropdown value={timezone} onChange={setTimezone} label="搜索联系人 IANA 时区"/><p>{timezone?`已指定 ${timezone}`:`未指定时区，将根据号码国家/地区自动使用 ${profile.effectiveTimezone}${profile.inferredCountry?`（${profile.inferredCountry}）`:""}`}</p></section>
      <section className="contact-field-section"><header><span><Mail size={15}/><b>邮箱</b><small>邮件功能将默认使用 Primary Email</small></span><button type="button" onClick={addEmail}><Plus size={13}/>添加邮箱</button></header>{emails.length?<div className="contact-repeat-list">{emails.map((email,index)=><div className="contact-email-row" key={email.id??index}><input value={email.label} maxLength={40} onChange={event=>setEmails(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,label:event.target.value}:item))} placeholder="标签，如工作"/><input type="email" value={email.email} maxLength={254} onChange={event=>setEmails(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,email:event.target.value}:item))} placeholder="name@example.com"/><label className="primary-email-radio"><input type="radio" name="primary-email" checked={email.isPrimary} onChange={()=>setPrimary(index)}/>Primary</label><button type="button" className="danger-text" onClick={()=>removeEmail(index)} aria-label="移除邮箱"><Trash2 size={14}/></button></div>)}</div>:<p className="contact-field-empty">尚未添加邮箱</p>}</section>
      <section className="contact-field-section"><header><span><Phone size={15}/><b>其他联系方式</b><small>支持社媒账号或完整链接</small></span><button type="button" onClick={addMethod}><Plus size={13}/>添加方式</button></header>{methods.length?<div className="contact-repeat-list">{methods.map((method,index)=><div className="contact-method-row" key={method.id??index}><select value={method.type} onChange={event=>setMethods(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,type:event.target.value as ContactMethodType}:item))}>{(["phone","wechat","telegram","line","website","facebook","x","linkedin","instagram","other"] as ContactMethodType[]).map(type=><option value={type} key={type}>{contactMethodName(type)}</option>)}</select><input value={method.label} maxLength={40} onChange={event=>setMethods(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,label:event.target.value}:item))} placeholder="自定义标签"/><input value={method.value} maxLength={500} onChange={event=>setMethods(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,value:event.target.value}:item))} placeholder={isSocialContactMethod(method.type)?"账号名或完整链接":"号码、账号或网址"}/><button type="button" className="danger-text" onClick={()=>setMethods(items=>items.filter((_,itemIndex)=>itemIndex!==index))} aria-label="移除联系方式"><Trash2 size={14}/></button></div>)}</div>:<p className="contact-field-empty">尚未添加其他联系方式</p>}</section>
      <label>联系人备注<textarea value={note} onChange={event=>setNote(event.target.value)} maxLength={5000} placeholder="记录联系人级业务信息；不会替代会话共享备注。"/><small>{note.length}/5000</small></label>{error&&<span className="login-error">{error}</span>}<footer className="contact-dialog-actions"><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={busy}>{busy?"正在保存…":"保存联系人"}</button></footer>
    </>:error?<span className="login-error">{error}</span>:null}</section></div>{avatarPickerOpen&&profile&&<ProductImageMediaDialog request={request} onToken={onToken} onClose={()=>setAvatarPickerOpen(false)} onSelect={asset=>void selectAvatar(asset)} libraryPath={`/api/v1/media?accountId=${encodeURIComponent(profile.accountId)}&limit=100`} uploadPath={`/api/v1/media?accountId=${encodeURIComponent(profile.accountId)}`} title="选择联系人头像" description="复用该 WhatsApp 账号媒体与附件中的图片，或上传新图片。" actionLabel="使用所选头像" acceptedMimeTypes={["image/jpeg","image/png","image/webp"]} maxFileSize={5*1024*1024}/>}</>;
}

function OrderManagement({token,accounts,onToken,onToast,onConversation}:{token:string;accounts:Account[];onToken:(token:string)=>void;onToast:(text:string)=>void;onConversation:(conversationId:string)=>void}){
  const [orders,setOrders]=useState<OrderItem[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState(""),[accountId,setAccountId]=useState(""),[status,setStatus]=useState(""),[dateFrom,setDateFrom]=useState(""),[dateTo,setDateTo]=useState(""),[total,setTotal]=useState(0),[nextCursor,setNextCursor]=useState<string|null>(null),[viewing,setViewing]=useState<OrderItem|null>(null),[editing,setEditing]=useState<OrderItem|null>(null),[importing,setImporting]=useState(false),[exporting,setExporting]=useState(false);
  const cursorRef=useRef<string|null>(null);
  const load=useCallback(async(reset=true)=>{if(reset)setLoading(true);try{const params=new URLSearchParams({limit:"30"});if(query.trim())params.set("q",query.trim());if(accountId)params.set("accountId",accountId);if(status)params.set("status",status);if(dateFrom)params.set("dateFrom",dateFrom);if(dateTo)params.set("dateTo",dateTo);if(!reset&&cursorRef.current)params.set("cursor",cursorRef.current);const result=await authorizedFetch(`/api/v1/orders?${params}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`订单加载失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {data:Array<Record<string,unknown>>;nextCursor:string|null;total:number};const mapped=body.data.map(item=>mapOrder(item));setOrders(all=>reset?mapped:[...all,...mapped]);cursorRef.current=body.nextCursor;setNextCursor(body.nextCursor);if(reset)setTotal(Number(body.total??mapped.length));setError("");}catch(reason){setError(reason instanceof Error?reason.message:"订单加载失败");}finally{setLoading(false);}},[token,onToken,query,accountId,status,dateFrom,dateTo]);
  useEffect(()=>{cursorRef.current=null;const timer=window.setTimeout(()=>void load(true),query?250:0);return()=>window.clearTimeout(timer);},[load,query]);
  async function remove(order:OrderItem){const sent=order.status!=="draft";if(!await confirmAction(sent?`订单 #${order.orderNumber} 将被删除，但不会撤回已经发送的 WhatsApp 消息。`:`草稿订单 #${order.orderNumber} 将被删除。`,{title:"删除订单？",confirmLabel:"删除"}))return;const result=await authorizedFetch(`/api/v1/conversations/${order.conversationId}/orders/${order.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`订单删除失败（HTTP ${result.response.status}）`);return;}onToast(`订单 #${order.orderNumber} 已删除${sent?"，历史消息保持不变":""}`);cursorRef.current=null;await load(true);}
  async function exportOrders(){setExporting(true);try{const exported:OrderItem[]=[];let cursor="";while(true){const params=new URLSearchParams({limit:"100"});if(query.trim())params.set("q",query.trim());if(accountId)params.set("accountId",accountId);if(status)params.set("status",status);if(dateFrom)params.set("dateFrom",dateFrom);if(dateTo)params.set("dateTo",dateTo);if(cursor)params.set("cursor",cursor);const result=await authorizedFetch(`/api/v1/orders?${params}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`订单导出失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {data:Array<Record<string,unknown>>;nextCursor:string|null};exported.push(...body.data.map(item=>mapOrder(item)));if(!body.nextCursor)break;cursor=body.nextCursor;}const clean=(value:string)=>value.replace(/[|;]/g," ");downloadCsv(`orders-${dateFileSuffix()}.csv`,["conversation_id","account","customer_phone","currency","business_status","description","items","fees","order_number","created_at"],exported.map(order=>[order.conversationId,order.accountName,order.customerPhone,order.currency,order.businessStatus,order.description,order.items.map(item=>[clean(item.sku),clean(item.name),item.quantity,item.unitAmount.toFixed(2)].join("|")).join(";"),order.fees.map(fee=>[clean(fee.name),fee.amount.toFixed(2)].join("|")).join(";"),order.orderNumber,order.createdAt]));onToast(`已导出 ${exported.length} 张订单`);}catch(reason){onToast(reason instanceof Error?reason.message:"订单导出失败");}finally{setExporting(false);}}
  const draftCount=orders.filter(order=>order.status==="draft").length,queuedCount=orders.filter(order=>order.status!=="draft").length;
  return <section className="management-panel order-management"><header className="management-head"><div><span className="eyebrow">会话订单中心</span><h1>订单管理</h1><p>集中查看、编辑和删除从客户会话中创建的订单。</p></div><div><button className="secondary-action" onClick={()=>void load(true)}><RefreshCw size={15}/>刷新</button><button className="secondary-action" onClick={()=>setImporting(true)}><UploadCloud size={15}/>一键导入</button><button className="secondary-action" disabled={exporting} onClick={()=>void exportOrders()}><FileDown size={15}/>{exporting?"导出中…":"一键导出"}</button></div></header>
    <div className="management-summary"><SummaryCard label="匹配订单" value={total}/><SummaryCard label="当前页草稿" value={draftCount}/><SummaryCard label="当前页已发送" value={queuedCount}/></div>
    <div className="order-management-filters"><label><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索订单号、客户名称或手机号"/></label><select value={accountId} onChange={event=>setAccountId(event.target.value)} aria-label="按账号筛选"><option value="">全部账号</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select><select value={status} onChange={event=>setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option><option value="draft">草稿</option><option value="queued">已发送</option></select><input type="date" value={dateFrom} onChange={event=>setDateFrom(event.target.value)} aria-label="开始日期"/><input type="date" value={dateTo} min={dateFrom||undefined} onChange={event=>setDateTo(event.target.value)} aria-label="结束日期"/></div>
    {loading?<EmptyState title="正在读取订单" text="请稍候…"/>:error?<EmptyState title="订单加载失败" text={error}/>:orders.length?<><div className="order-table-wrap"><table className="order-table"><thead><tr><th>订单号</th><th>客户 / 账号</th><th>商品</th><th>金额</th><th>状态</th><th>创建时间</th><th aria-label="操作"/></tr></thead><tbody>{orders.map(order=><tr key={order.id} onClick={()=>setViewing(order)}><td><b>#{order.orderNumber}</b><small>{order.createdByName}</small></td><td><b>{order.customerName||order.customerPhone||"未知客户"}</b><small>{order.accountName}{order.customerPhone?` · ${order.customerPhone}`:""}</small></td><td>{order.items.length} 件<small>{order.items.slice(0,2).map(item=>item.name).join("、")}{order.items.length>2?"…":""}</small></td><td><b>{order.currency} {order.amount.toFixed(2)}</b></td><td><em className={`delivery-state ${order.messageStatus}`}>{order.status==="draft"?"草稿":deliveryText(order.messageStatus)}</em>{order.paymentRequest&&<small className={`payment-state ${order.paymentRequest.status.toLowerCase()}`}>{paymentStatusText(order.paymentRequest.status)}</small>}</td><td>{formatDateTime(order.createdAt)}</td><td><span className="order-row-actions"><button onClick={event=>{event.stopPropagation();setEditing(order);}} aria-label={`编辑订单 ${order.orderNumber}`}><Pencil size={13}/></button><button className="danger" onClick={event=>{event.stopPropagation();void remove(order);}} aria-label={`删除订单 ${order.orderNumber}`}><Trash2 size={13}/></button></span></td></tr>)}</tbody></table></div>{nextCursor&&<button className="order-load-more" onClick={()=>void load(false)}>加载更多订单</button>}</>:<EmptyState title="暂无匹配订单" text="订单需先在客户会话中创建，或调整当前筛选条件"/>}
    {viewing&&<OrderDetailsDialog order={viewing} token={token} onToken={onToken} onToast={onToast} onPaymentChange={paymentRequest=>{setViewing(current=>current?{...current,paymentRequest}:current);setOrders(items=>items.map(item=>item.id===viewing.id?{...item,paymentRequest}:item));}} onClose={()=>setViewing(null)} onEdit={()=>{setViewing(null);setEditing(viewing);}} onConversation={()=>onConversation(viewing.conversationId)}/>}
    {editing&&<OrderDialog order={editing} active={{id:editing.conversationId,name:editing.customerName,initials:"",color:"#477a62",account:editing.accountName,accountId:editing.accountId,phone:editing.customerPhone,contactId:"",alias:"",contactName:editing.customerName,primaryEmail:"",contactMethods:[],preview:"",lastDirection:null,lastMessageStatus:null,lastMessageAt:null,time:"",unread:0,accountStatus:"online",assignedUserId:null,favorite:false,conversationStatus:"open",customerStage:"new",tags:[],remindAt:null,transport:"web",serviceWindowExpiresAt:null}} token={token} onToken={onToken} onClose={()=>setEditing(null)} onCreated={async orderNumber=>{setEditing(null);onToast(`订单 #${orderNumber} 已更新`);cursorRef.current=null;await load(true);}}/>}
    {importing&&<DataImportDialog kind="orders" accounts={accounts.map(account=>({id:account.id,name:account.name}))} request={(path,init)=>authorizedFetch(path,token,init)} onToken={onToken} onClose={()=>setImporting(false)} onImported={async count=>{setImporting(false);cursorRef.current=null;onToast(`已导入 ${count} 张草稿订单`);await load(true);}}/>}
  </section>;
}

function OrderDetailsDialog({order,token,onToken,onToast,onPaymentChange,onClose,onEdit,onConversation}:{order:OrderItem;token:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onPaymentChange:(paymentRequest:PaymentRequest)=>void;onClose:()=>void;onEdit:()=>void;onConversation:()=>void}){
  const [busy,setBusy]=useState<"create"|"regenerate"|"refresh"|"send"|"copy"|"">(""),[error,setError]=useState("");const payment=order.paymentRequest,canRegenerate=payment&&!new Set(["PAID","MARKED_AS_PAID","PAID_EXTERNAL","PARTIALLY_PAID","PAYMENT_PENDING"]).has(payment.status.toUpperCase());
  async function request(action:"create"|"regenerate"|"refresh"|"send"){setBusy(action);setError("");try{const suffix=action==="create"||action==="regenerate"?"":`/${action}`,regenerate=action==="regenerate",result=await authorizedFetch(`/api/v1/orders/${order.id}/payment-request${suffix}`,token,{method:"POST",...(regenerate?{headers:{"content-type":"application/json"},body:JSON.stringify({regenerate:true})}:{})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));if(action==="send"){onToast("付款链接已进入 WhatsApp 发送队列");return;}const next=mapPaymentRequest(body);onPaymentChange(next);onToast(action==="refresh"?"PayPal 付款状态已刷新":regenerate?"旧发票已作废，并按当前模板生成新链接":"PayPal 付款链接已生成");}catch(reason){setError(reason instanceof Error?reason.message:"操作失败");}finally{setBusy("");}}
  async function copyLink(){if(!payment?.url)return;setBusy("copy");try{await navigator.clipboard.writeText(payment.url);onToast("付款链接已复制");}catch{setError("剪贴板不可用，请手动复制链接");}finally{setBusy("");}}
  return <div className="modal-backdrop order-backdrop" role="presentation"><section className="login-dialog order-details-dialog" role="dialog" aria-modal="true" aria-labelledby="order-details-title"><button className="login-close" onClick={onClose} disabled={Boolean(busy)} aria-label="关闭"><X size={17}/></button><span className="login-logo"><ClipboardList size={20}/></span><h2 id="order-details-title">订单 #{order.orderNumber}</h2><p>{order.customerName||order.customerPhone||"未知客户"} · {order.accountName}</p><dl className="order-details-meta"><div><dt>状态</dt><dd>{order.status==="draft"?"草稿":deliveryText(order.messageStatus)}</dd></div><div><dt>创建人</dt><dd>{order.createdByName}</dd></div><div><dt>创建时间</dt><dd>{formatDateTime(order.createdAt)}</dd></div><div><dt>订单金额</dt><dd>{order.currency} {order.amount.toFixed(2)}</dd></div></dl><div className="order-details-items"><h3>商品</h3>{order.items.map(item=><div key={item.id}><span><b>{item.name}</b><small>{item.sku?`${item.sku} · `:""}{item.quantity} × {order.currency} {item.unitAmount.toFixed(2)}</small></span><strong>{order.currency} {(item.quantity*item.unitAmount).toFixed(2)}</strong></div>)}{order.fees.map(item=><div key={item.id}><span><b>{item.name}</b><small>附加费用</small></span><strong>{order.currency} {item.amount.toFixed(2)}</strong></div>)}</div>{order.address&&<div className="order-details-address"><MapPin size={16}/><span><b>{order.address.label}</b>{(order.address.recipientName||order.address.phone)&&<small>{[order.address.recipientName,order.address.phone].filter(Boolean).join(" · ")}</small>}<p>{order.address.address}</p></span></div>}{order.description&&<div className="order-details-notes"><b>订单备注</b><p>{order.description}</p></div>}{order.paymentProfile?.methodType==="paypal"?<section className="payment-request-panel"><header><span><CreditCard size={17}/><span><b>{order.paymentProfile.summary}</b><small>{payment?`${payment.environment==="live"?"Live":"Sandbox"} · ${paymentStatusText(payment.status)}`:"按当前订单金额生成可支付链接"}</small></span></span>{payment&&<button onClick={()=>void request("refresh")} disabled={Boolean(busy)}><RefreshCw className={busy==="refresh"?"spin":""} size={13}/>刷新状态</button>}</header>{payment?.url?<><div className="payment-link"><input value={payment.url} readOnly aria-label="PayPal 付款链接"/><button onClick={()=>void copyLink()} disabled={Boolean(busy)} aria-label="复制付款链接"><Copy size={14}/></button><button onClick={()=>window.open(payment.url??"","_blank","noopener,noreferrer")} disabled={Boolean(busy)} aria-label="打开付款链接"><ExternalLink size={14}/></button></div><small>模板修改只会用于新发票，不会改写当前 PayPal 发票。</small><div className="payment-request-actions">{canRegenerate&&<button className="secondary-action" onClick={()=>void confirmAction("当前 PayPal 发票将作废，并使用最新模板重新生成。",{title:"重新生成付款链接？",confirmLabel:"作废并重新生成",tone:"warning"}).then(confirmed=>{if(confirmed)void request("regenerate");})} disabled={Boolean(busy)}><RefreshCw className={busy==="regenerate"?"spin":""} size={14}/>{busy==="regenerate"?"正在重新生成…":"按当前模板重新生成"}</button>}<button className="primary-action" onClick={()=>void request("send")} disabled={Boolean(busy)}><Send size={14}/>{busy==="send"?"正在发送…":"发送到 WhatsApp"}</button></div></>:<button className="primary-action create-payment-request" onClick={()=>void request("create")} disabled={Boolean(busy)}><CreditCard size={14}/>{busy==="create"?"正在生成…":"Create Payment Request"}</button>}{error&&<span className="login-error">{error}</span>}</section>:order.paymentProfile?<ManualPaymentPanel order={order} token={token} onToken={onToken} onToast={onToast}/>:null}<footer className="order-details-actions"><button className="secondary-action" onClick={onConversation}><ExternalLink size={14}/>打开所属会话</button><button className="primary-action" onClick={onEdit}><Pencil size={14}/>编辑订单</button></footer></section></div>;
}

function ManualPaymentPanel({order,token,onToken,onToast}:{order:OrderItem;token:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),profile=order.paymentProfile!;const rendered=profile.instructions.replace(/{{\s*orderNumber\s*}}/g,order.orderNumber).replace(/{{\s*amount\s*}}/g,order.amount.toFixed(2)).replace(/{{\s*currency\s*}}/g,order.currency),full=[profile.summary,...profile.publicFields.map(field=>`${field.label}: ${field.value}`),rendered].filter(Boolean).join("\n");
  async function copy(){try{await navigator.clipboard.writeText(full);onToast("付款说明已复制");}catch{setError("剪贴板不可用，请手动复制");}}
  async function send(){setBusy(true);setError("");try{const result=await authorizedFetch(`/api/v1/orders/${order.id}/payment-send`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clientSendId:crypto.randomUUID()})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;if(!result.response.ok)throw new Error(String(body.message??body.error??`HTTP ${result.response.status}`));onToast("付款说明已进入 WhatsApp 发送队列");}catch(reason){setError(reason instanceof Error?reason.message:"发送失败");}finally{setBusy(false);}}
  return <section className="payment-request-panel"><header><span><CreditCard size={17}/><span><b>{profile.summary}</b><small>订单创建时保存的付款资料快照</small></span></span></header><div className="order-details-notes">{profile.publicFields.map(field=><p key={field.label}><b>{field.label}:</b> {field.value}</p>)}{rendered&&<p>{rendered}</p>}</div><div className="payment-request-actions"><button className="secondary-action" onClick={()=>void copy()} disabled={busy}><Copy size={14}/>复制说明</button><button className="primary-action" onClick={()=>void send()} disabled={busy}><Send size={14}/>{busy?"正在发送…":"发送到 WhatsApp"}</button></div>{error&&<span className="login-error">{error}</span>}</section>;
}

function paymentStatusText(status:string){return({CREATING:"生成中",DRAFT:"草稿",SENT:"待付款",SHARED:"待付款",UNPAID:"待付款",PAYMENT_PENDING:"付款审核中",PARTIALLY_PAID:"部分付款",PAID:"已付款",MARKED_AS_PAID:"已付款",PAID_EXTERNAL:"已付款",CANCELLED:"已作废",AUTO_CANCELLED:"已自动作废",REFUNDED:"已退款",MARKED_AS_REFUNDED:"已退款",REFUNDED_EXTERNAL:"已退款",FAILED:"生成失败"} as Record<string,string>)[status.toUpperCase()]??status;}
function productPaginationItems(current:number,total:number):Array<number|string>{const pages=new Set<number>([1,total]);for(let value=Math.max(1,current-3);value<=Math.min(total,current+3);value++)pages.add(value);const sorted=[...pages].sort((a,b)=>a-b),items:Array<number|string>=[];for(const value of sorted){const previous=items.at(-1);if(typeof previous==="number"&&value-previous>1)items.push(`ellipsis-${previous}-${value}`);items.push(value);}return items;}

function ProductManagement({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [products,setProducts]=useState<ProductItem[]>([]),[currencyConfig,setCurrencyConfig]=useState<CurrencyConfig>(DEFAULT_CURRENCY_CONFIG),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[exporting,setExporting]=useState(false),[error,setError]=useState(""),[query,setQuery]=useState(""),[currency,setCurrency]=useState(""),[category,setCategory]=useState(""),[brand,setBrand]=useState(""),[tag,setTag]=useState(""),[tagNames,setTagNames]=useState<string[]>([]),[categoryNames,setCategoryNames]=useState<string[]>([]),[brandNames,setBrandNames]=useState<string[]>([]),[page,setPage]=useState(1),[pageSize,setPageSize]=useState<number>(PRODUCT_PAGE_SIZES[0]),[jumpPage,setJumpPage]=useState(""),[total,setTotal]=useState(0),[view,setView]=useState<"card"|"list">("card"),[editing,setEditing]=useState<ProductItem|"new"|null>(null),[importing,setImporting]=useState(false),[selected,setSelected]=useState<string[]>([]),[bulkEditing,setBulkEditing]=useState(false),[generating,setGenerating]=useState(false);const loadVersion=useRef(0);
  const load=useCallback(async(options:{force?:boolean}={})=>{
    const version=++loadVersion.current,subject=tokenSubject(token)||"unknown";
    const input={page,pageSize,query:query.trim(),currency,category,brand,tag},key=productCacheKey(subject,input);
    const params=new URLSearchParams({limit:String(pageSize),offset:String((page-1)*pageSize)});
    if(input.query)params.set("q",input.query);if(currency)params.set("currency",currency);if(category)params.set("category",category);if(brand)params.set("brand",brand);if(tag)params.set("tag",tag);
    const cached=productPageCache.get(key),fresh=Boolean(cached&&Date.now()-cached.fetchedAt<PRODUCT_PAGE_CACHE_TTL),cachedCurrency=productCurrencyCache.get(subject);
    const apply=(entry:ProductPageCacheEntry)=>{entry.lastUsed=Date.now();setProducts(entry.products);setTotal(entry.total);setTagNames(entry.tags);setCategoryNames(entry.categories);setBrandNames(entry.brands);};
    if(cached){apply(cached);setLoading(false);setError("");}else setLoading(true);
    if(cachedCurrency)setCurrencyConfig(cachedCurrency.config);
    if(cached&&fresh&&cachedCurrency&&!options.force)return;
    setRefreshing(Boolean(cached));
    try{
      const [pageResult,currencyResult]=await Promise.all([
        cached&&fresh&&!options.force?Promise.resolve({entry:cached,token}):fetchProductPage(key,`/api/v1/products?${params}`,token),
        fetchProductCurrencies(subject,token),
      ]);
      if(version!==loadVersion.current)return;
      if(pageResult.token!==token)onToken(pageResult.token);else if(currencyResult.token!==token)onToken(currencyResult.token);
      if(page>1&&!pageResult.entry.products.length){productPageCache.delete(key);setPage(page-1);return;}
      apply(pageResult.entry);setCurrencyConfig(currencyResult.config);setError("");
    }catch(reason){
      if(version===loadVersion.current&&!cached)setError(reason instanceof Error?reason.message:"产品库加载失败");
    }finally{if(version===loadVersion.current){setLoading(false);setRefreshing(false);}}
  },[token,onToken,page,pageSize,query,currency,category,brand,tag]);
  const collageRequest=useCallback(async(path:string,init?:RequestInit)=>{const result=await authorizedFetch(path,token,init);if(result.token!==token)onToken(result.token);return result;},[token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),query?250:0);return()=>window.clearTimeout(timer);},[load,query]);
  const pageCount=Math.max(1,Math.ceil(total/pageSize)),pageItems=productPaginationItems(page,pageCount),visible=products;
  useEffect(()=>{
    if(loading||error)return;
    const timer=window.setTimeout(()=>{
      const subject=tokenSubject(token)||"unknown",adjacentPages=[page-1,page+1].filter(value=>value>=1&&value<=pageCount);
      for(const targetPage of adjacentPages){
        const input={page:targetPage,pageSize,query:query.trim(),currency,category,brand,tag},key=productCacheKey(subject,input);
        if(productPageCache.has(key)||productPageFlights.has(key))continue;
        const params=new URLSearchParams({limit:String(pageSize),offset:String((targetPage-1)*pageSize)});
        if(input.query)params.set("q",input.query);if(currency)params.set("currency",currency);if(category)params.set("category",category);if(brand)params.set("brand",brand);if(tag)params.set("tag",tag);
        void fetchProductPage(key,`/api/v1/products?${params}`,token).then(result=>{if(result.token!==token)onToken(result.token);}).catch(()=>{});
      }
    },300);
    return()=>window.clearTimeout(timer);
  },[loading,error,token,onToken,page,pageCount,pageSize,query,currency,category,brand,tag]);
  const allPageSelected=Boolean(visible.length)&&visible.every(product=>selected.includes(product.id));
  function jumpToPage(){if(!/^\d+$/.test(jumpPage))return;setPage(Math.min(pageCount,Math.max(1,Number(jumpPage))));setJumpPage("");}
  function toggleSelected(id:string){setSelected(ids=>ids.includes(id)?ids.filter(item=>item!==id):[...ids,id]);}
  function togglePage(){const pageIds=visible.map(product=>product.id);setSelected(ids=>allPageSelected?ids.filter(id=>!pageIds.includes(id)):[...new Set([...ids,...pageIds])]);}
  async function remove(product:ProductItem){if(!await confirmAction(`产品“${product.name}”将从产品库移除，历史订单不会受到影响。`,{title:"删除产品？",confirmLabel:"删除"}))return;const result=await authorizedFetch(`/api/v1/products/${product.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(result.response.status===403?"只有主管或管理员可以删除产品":`删除失败（HTTP ${result.response.status}）`);return;}invalidateProductCache(tokenSubject(result.token)||"unknown");onToast("产品已从产品库移除，历史订单保持不变");await load({force:true});}
  async function exportProducts(){setExporting(true);try{const exported:ProductItem[]=[];let exportOffset=0;while(true){const params=new URLSearchParams({limit:"100",offset:String(exportOffset)});if(query.trim())params.set("q",query.trim());if(currency)params.set("currency",currency);if(category)params.set("category",category);if(brand)params.set("brand",brand);if(tag)params.set("tag",tag);const result=await authorizedFetch(`/api/v1/products?${params}`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`产品导出失败（HTTP ${result.response.status}）`);const body=await result.response.json() as ProductPageResponse&{hasMore:boolean;nextOffset:number|null};exported.push(...body.data.map(mapProduct));if(!body.hasMore||body.nextOffset===null)break;exportOffset=body.nextOffset;}downloadCsv(`products-${dateFileSuffix()}.csv`,["sku","name","description","category","brand","currency","price","price_tiers","weight_amount","weight_unit","tags","image"],exported.map(product=>[product.sku,product.name,product.description,product.category,product.brand,product.currency,product.defaultUnitAmount.toFixed(2),product.priceTiers.map(tier=>`${tier.minQuantity}:${tier.unitAmount.toFixed(2)}`).join("|"),product.weightAmount??"",product.weightUnit??"",product.tags.map(item=>item.name).join("|"),""]));onToast(`已导出 ${exported.length} 个产品`);}catch(reason){onToast(reason instanceof Error?reason.message:"产品导出失败");}finally{setExporting(false);}}
  return <section className="management-panel product-management"><header className="management-head"><div><span className="eyebrow">团队共享目录</span><h1>产品库</h1><p>集中维护产品 SKU、阶梯价格、图片和标签，创建订单或发送产品卡片时直接选用。</p></div><div><button className="secondary-action" disabled={refreshing} onClick={()=>void load({force:true})}><RefreshCw className={refreshing?"spin":""} size={15}/>{refreshing?"刷新中…":"刷新"}</button><button className="secondary-action" onClick={()=>setImporting(true)}><UploadCloud size={15}/>一键导入</button><button className="secondary-action" disabled={exporting} onClick={()=>void exportProducts()}><FileDown size={15}/>{exporting?"导出中…":"一键导出"}</button><button className="primary-action" onClick={()=>setEditing("new")}><Plus size={15}/>新增产品</button></div></header>
    <div className="product-filters"><label><Search size={14}/><input value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}} placeholder="搜索名称、SKU、描述、分类或品牌"/></label><select value={category} onChange={event=>{setCategory(event.target.value);setPage(1);}} aria-label="按分类筛选"><option value="">全部分类</option>{categoryNames.map(item=><option key={item}>{item}</option>)}</select><select value={brand} onChange={event=>{setBrand(event.target.value);setPage(1);}} aria-label="按品牌筛选"><option value="">全部品牌</option>{brandNames.map(item=><option key={item}>{item}</option>)}</select><select value={currency} onChange={event=>{setCurrency(event.target.value);setPage(1);}} aria-label="按币种筛选"><option value="">全部币种</option>{currencyConfig.currencies.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select><select value={tag} onChange={event=>{setTag(event.target.value);setPage(1);}} aria-label="按标签筛选"><option value="">全部标签</option>{tagNames.map(item=><option key={item}>{item}</option>)}</select><div className="product-view-tools"><span>共 {total} 个产品</span><div role="group" aria-label="产品显示方式"><button className={view==="card"?"active":""} onClick={()=>setView("card")} aria-label="卡片视图" title="卡片视图"><LayoutGrid size={14}/></button><button className={view==="list"?"active":""} onClick={()=>setView("list")} aria-label="列表视图" title="列表视图"><List size={14}/></button></div></div></div>
    {!loading&&!error&&visible.length>0&&<div className="product-bulk-toolbar"><label><input type="checkbox" checked={allPageSelected} onChange={togglePage}/>全选本页（{visible.length}）</label><span>已选择 {selected.length} 个产品</span>{selected.length>0&&<><button className="secondary-action" onClick={()=>setSelected([])}>取消选择</button><button className="secondary-action" onClick={()=>setBulkEditing(true)}><Pencil size={14}/>批量编辑</button><button className="primary-action" onClick={()=>setGenerating(true)}><LayoutGrid size={14}/>生成素材</button></>}</div>}
    {loading?<EmptyState title="正在读取产品库" text="请稍候…"/>:error?<EmptyState title="产品库加载失败" text={error}/>:visible.length?<div className={`product-grid ${view}-view`}>{visible.map(product=>{const last=product.priceTiers.at(-1),isSelected=selected.includes(product.id);return <article className={`product-card ${isSelected?"selected":""}`} key={product.id}><label className="product-select"><input type="checkbox" checked={isSelected} onChange={()=>toggleSelected(product.id)}/><span>{isSelected?<Check size={13}/>:null}</span><i>选择</i></label><ProductImage className="product-library-image" mediaId={product.imageMediaId} token={token} onToken={onToken} alt={product.name}/><div className="product-card-copy"><header><span><b>{product.name}</b><small>{product.sku} · 更新于 {new Date(product.updatedAt).toLocaleDateString("zh-CN")}{product.weightAmount&&product.weightUnit?` · 重量 ${formatWeight(product.weightAmount,product.weightUnit)}`:""}</small></span><strong>{product.currency} {last&&last.unitAmount!==product.defaultUnitAmount?`${last.unitAmount.toFixed(2)}–${product.defaultUnitAmount.toFixed(2)}`:product.defaultUnitAmount.toFixed(2)}</strong></header>{(product.category||product.brand)&&<div className="product-card-taxonomy">{product.brand&&<span>品牌 · {product.brand}</span>}{product.category&&<span>分类 · {product.category}</span>}</div>}<p className={`product-card-description ${product.description?"":"empty"}`}>{product.description||"暂无描述"}</p><div className="product-tier-summary">{product.priceTiers.map(tier=><span key={tier.minQuantity}>{tier.minQuantity}+ · {product.currency} {tier.unitAmount.toFixed(2)}</span>)}</div><div className="product-card-tags">{product.tags.length?product.tags.map(item=><i key={item.id} style={{background:item.color}}>{item.name}</i>):<span>暂无标签</span>}</div><footer><button onClick={()=>setEditing(product)}><Pencil size={13}/>编辑</button>{["admin","supervisor"].includes(role)&&<button className="danger-text" onClick={()=>void remove(product)}><Trash2 size={13}/>删除</button>}</footer></div></article>;})}</div>:<EmptyState title="暂无匹配产品" text="新增产品，或调整搜索与筛选条件"/>}
    {!loading&&!error&&total>0&&<nav className="product-pagination" aria-label="产品分页"><label className="product-page-size">每页<select value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);setJumpPage("");}} aria-label="每页产品数">{PRODUCT_PAGE_SIZES.map(size=><option key={size} value={size}>{size}</option>)}</select>个</label><button disabled={page<=1} onClick={()=>setPage(value=>Math.max(1,value-1))}>上一页</button><div className="product-page-numbers">{pageItems.map(item=>typeof item==="number"?<button key={item} className={item===page?"page-number active":"page-number"} aria-current={item===page?"page":undefined} aria-label={`第 ${item} 页`} onClick={()=>setPage(item)}>{item}</button>:<span className="product-pagination-ellipsis" key={item}>…</span>)}</div><button disabled={page>=pageCount} onClick={()=>setPage(value=>Math.min(pageCount,value+1))}>下一页</button><span className="product-pagination-summary">第 {page} / {pageCount} 页</span><form className="product-page-jump" onSubmit={event=>{event.preventDefault();jumpToPage();}}><label>跳至<input value={jumpPage} onChange={event=>setJumpPage(event.target.value.replace(/\D/g,"").slice(0,6))} inputMode="numeric" aria-label="跳转页码" placeholder={String(page)}/>页</label><button type="submit" disabled={!jumpPage}>跳转</button></form></nav>}
    {editing&&<ProductEditorDialog product={editing==="new"?undefined:editing} products={products} categories={categoryNames} brands={brandNames} currencies={currencyConfig.currencies} baseCurrency={currencyConfig.baseCurrency} request={(path,init)=>authorizedFetch(path,token,init)} onToken={onToken} onClose={()=>setEditing(null)} onSaved={async text=>{setEditing(null);invalidateProductCache(tokenSubject(token)||"unknown");onToast(text);await load({force:true});}}/>}
    {importing&&<ProductImportDialog currencies={currencyConfig.currencies} request={(path,init)=>authorizedFetch(path,token,init)} onToken={onToken} onClose={()=>setImporting(false)} onImported={async result=>{setImporting(false);invalidateProductCache(tokenSubject(token)||"unknown");onToast(`导入完成：新增 ${result.created} 个，更新名称 ${result.updated} 个`);await load({force:true});}}/>}
    {generating&&<CollageGenerateDialog productIds={selected} request={collageRequest} onClose={()=>setGenerating(false)} onGenerated={()=>{setGenerating(false);setSelected([]);onToast("拼图素材已生成");}}/>}
    {bulkEditing&&<ProductBulkEditDialog count={selected.length} productIds={selected} token={token} onToken={onToken} onClose={()=>setBulkEditing(false)} onSaved={async text=>{setBulkEditing(false);setSelected([]);invalidateProductCache(tokenSubject(token)||"unknown");onToast(text);await load({force:true});}}/>}
  </section>;
}

function ProductBulkEditDialog({count,productIds,token,onToken,onClose,onSaved}:{count:number;productIds:string[];token:string;onToken:(token:string)=>void;onClose:()=>void;onSaved:(text:string)=>void}){
  const [field,setField]=useState<"price"|"tags"|"title">("price"),[mode,setMode]=useState("set"),[value,setValue]=useState(""),[search,setSearch]=useState(""),[color,setColor]=useState("#DFF5E8"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const modeOptions=field==="price"?[["set","统一设置为固定值"],["increase","增加固定值"],["decrease","减少固定值"],["percentIncrease","按比例增加"],["percentDecrease","按比例减少"]]:field==="tags"?[["add","增加标签"],["remove","删除标签"],["set","统一设置标签"]]:[["set","统一设置为固定值"],["prefix","添加前缀"],["suffix","添加后缀"],["replace","替换"]];
  function selectField(next:"price"|"tags"|"title"){setField(next);setMode("set");setValue("");setSearch("");setError("");}
  async function save(){setError("");let operation:Record<string,unknown>;if(field==="price"){const amount=Number(value);if(value.trim()===""||!Number.isFinite(amount)||amount<0){setError("请输入有效的非负数值");return;}operation={field,mode,value:amount};}else if(field==="tags"){const names=[...new Set(value.split(/[，,]/).map(item=>item.trim()).filter(Boolean))];if(!names.length){setError("请输入至少一个标签，多个标签用逗号分隔");return;}operation={field,mode,tags:names.map(name=>({name,color}))};}else{if(mode==="replace"&&!search){setError("请输入要被替换的文字");return;}if(mode!=="replace"&&!value){setError("请输入标题内容");return;}operation={field,mode,value,...(mode==="replace"?{search}:{})};}setBusy(true);try{const result=await authorizedFetch("/api/v1/products/bulk-edit",token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({productIds,operation})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {error?:string;updated?:number};if(!result.response.ok)throw new Error(body.error==="invalid_resulting_price"?"操作后有价格低于 0 或超出上限":body.error==="invalid_resulting_title"?"操作后有标题为空或超过 120 个字符":body.error??`HTTP ${result.response.status}`);onSaved(`已批量更新 ${body.updated??count} 个产品`);}catch(reason){setError(reason instanceof Error?reason.message:"批量编辑失败");}finally{setBusy(false);}}
  return <div className="modal-backdrop product-dialog-backdrop" role="presentation"><section className="login-dialog product-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="product-bulk-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><Pencil size={19}/></span><h2 id="product-bulk-title">批量编辑 {count} 个产品</h2><p>一次选择一种属性进行修改；保存后可继续选择产品进行其他操作。</p><div className="product-bulk-fields"><div className="product-bulk-tabs"><button className={field==="price"?"active":""} onClick={()=>selectField("price")}>价格</button><button className={field==="tags"?"active":""} onClick={()=>selectField("tags")}>标签</button><button className={field==="title"?"active":""} onClick={()=>selectField("title")}>标题</button></div><label>操作方式<select value={mode} onChange={event=>{setMode(event.target.value);setError("");}}>{modeOptions.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>{field==="title"&&mode==="replace"&&<label>查找文字<input value={search} maxLength={120} onChange={event=>setSearch(event.target.value)} placeholder="要被替换的文字"/></label>}<label>{field==="price"?(mode.startsWith("percent")?"比例（%）":"金额"):field==="tags"?"标签名称":"标题内容"}<input type={field==="price"?"number":"text"} min={field==="price"?0:undefined} step={field==="price"?"0.01":undefined} maxLength={field==="price"?undefined:field==="tags"?1229:120} value={value} onChange={event=>setValue(event.target.value)} placeholder={field==="tags"?"多个标签用逗号分隔":field==="title"&&mode==="replace"?"替换为（可留空）":"请输入内容"}/></label>{field==="tags"&&mode!=="remove"&&<label>标签颜色<input className="product-bulk-color" type="color" value={color} onChange={event=>setColor(event.target.value)}/></label>}{field==="price"&&<small>价格操作会应用到每个产品的全部阶梯价格，并四舍五入到小数点后两位。</small>}</div>{error&&<span className="login-error">{error}</span>}<footer><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={()=>void save()} disabled={busy}>{busy?"正在保存…":`应用到 ${count} 个产品`}</button></footer></section></div>;
}

const CURRENCIES=DEFAULT_CURRENCY_CONFIG.currencies.map(item=>item.code);
function mapProduct(item:Record<string,unknown>):ProductItem{const priceTiers=Array.isArray(item.priceTiers)?(item.priceTiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[];return{id:String(item.id),sku:String(item.sku??""),name:String(item.name),description:String(item.description??""),category:String(item.category??""),brand:String(item.brand??""),defaultUnitAmount:priceTiers[0]?.unitAmount??Number(item.defaultUnitAmount),priceTiers,currency:String(item.currency),weightAmount:item.weightAmount===null||item.weightAmount===undefined?null:Number(item.weightAmount),weightUnit:item.weightUnit?String(item.weightUnit) as WeightUnit:null,imageMediaId:item.imageMediaId?String(item.imageMediaId):null,imageName:String(item.imageName??""),tags:Array.isArray(item.tags)?(item.tags as Array<Record<string,unknown>>).map(mapTag):[],createdAt:String(item.createdAt),updatedAt:String(item.updatedAt)};}

function ProductImage({
  mediaId,
  token,
  onToken,
  alt,
  className = "",
  preview = false,
}: {
  mediaId: string | null;
  token: string;
  onToken: (token: string) => void;
  alt: string;
  className?: string;
  preview?: boolean;
}) {
  const [loaded, setLoaded] = useState<{id:string;url:string}>({id:"",url:""});
  const hostRef=useRef<HTMLDivElement>(null),tokenRef=useRef(token),onTokenRef=useRef(onToken);
  const url=mediaId&&loaded.id===mediaId?loaded.url:"";
  useEffect(()=>{tokenRef.current=token;},[token]);
  useEffect(()=>{onTokenRef.current=onToken;},[onToken]);
  useEffect(() => {
    if(!mediaId)return;
    let cancelled=false,acquired=false;
    let observer:IntersectionObserver|undefined;
    const cacheKey=`${mediaId}${preview?":preview":""}`,start=()=>{
      if(acquired)return;
      acquired=true;observer?.disconnect();
      void acquireMedia(cacheKey,async()=>{
        const currentToken=tokenRef.current,result=await authorizedFetch(`/api/v1/media/${mediaId}${preview?"?preview=1":""}`,currentToken);
        if(result.token!==currentToken)onTokenRef.current(result.token);
        if(!result.response.ok)throw new Error(`HTTP ${result.response.status}`);
        return result.response.blob();
      }).then(value=>{if(!cancelled)setLoaded({id:mediaId,url:value});}).catch(()=>{});
    };
    const element=hostRef.current;
    if(!element||typeof IntersectionObserver==="undefined")start();
    else{
      observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))start();},{rootMargin:"500px 0px"});
      observer.observe(element);
    }
    return()=>{cancelled=true;observer?.disconnect();if(acquired)releaseMedia(cacheKey);};
  }, [mediaId,preview]);
  return (
    <div ref={hostRef} className={`product-image ${className}`}>
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
  return <div className="modal-backdrop product-dialog-backdrop" role="presentation"><section className="login-dialog product-dialog" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><ShoppingBag size={20}/></span><h2 id="product-dialog-title">{product?"编辑产品":"新增产品"}</h2><p>产品资料供团队创建订单时复用；修改不会影响已保存的订单。</p><label>产品名称<input value={name} onChange={event=>setName(event.target.value)} maxLength={120} autoFocus placeholder="输入产品名称"/></label>{duplicate&&<span className="duplicate-warning"><Info size={13}/>产品库已有同名产品，仍可继续创建或保存。</span>}<div className="product-form-grid"><label>默认单价<input value={amount} onChange={event=>setAmount(event.target.value)} inputMode="decimal" placeholder="0.00"/></label><label>币种<select value={currency} onChange={event=>setCurrency(event.target.value)}>{CURRENCIES.map(item=><option key={item}>{item}</option>)}</select></label></div><label className="product-image-input">产品图片 · 可选<input type="file" accept="image/png,image/jpeg" onChange={event=>{const file=event.target.files?.[0];if(file)chooseImage(file);event.currentTarget.value="";}}/><span><UploadCloud size={14}/>{imageName||"添加 PNG/JPG 图片"}</span></label>{(imageFile||imageMediaId)&&<div className="product-dialog-image-preview">{imagePreviewUrl?<Image src={imagePreviewUrl} alt={imageName||name||"产品图片预览"} width={480} height={310} unoptimized/>:<ProductImage mediaId={imageMediaId} token={token} onToken={onToken} alt={imageName||name||"产品图片预览"}/>}<span title={imageName}>{imageName||"当前产品图片"}</span></div>}{(imageFile||imageMediaId)&&<button type="button" className="product-image-remove" onClick={clearImage}><Trash2 size={11}/>移除图片</button>}<div className="product-label-editor"><b>产品标签</b>{tags.map((item,index)=><div key={item.id}><input value={item.name} maxLength={40} onChange={event=>setTags(all=>all.map((tag,tagIndex)=>tagIndex===index?{...tag,name:event.target.value}:tag))}/><input type="color" value={item.color} onChange={event=>setTags(all=>all.map((tag,tagIndex)=>tagIndex===index?{...tag,color:event.target.value}:tag))}/><button onClick={()=>setTags(all=>all.filter((_,tagIndex)=>tagIndex!==index))} aria-label={`移除标签 ${item.name}`}><Trash2 size={13}/></button></div>)}<div className="product-label-add"><input value={tagName} onChange={event=>setTagName(event.target.value)} maxLength={40} placeholder="新标签名称" onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();addTag();}}}/><input type="color" value={tagColor} onChange={event=>setTagColor(event.target.value)}/><button onClick={addTag}><Plus size={13}/></button></div></div>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!name.trim()||!amount} onClick={()=>void save()}>{busy?"正在保存…":product?"保存产品资料":"创建产品"}</button></section></div>;
}

function AgentManagement({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [agents,setAgents]=useState<ManagedAgent[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);
  const load=useCallback(async(quiet=false)=>{if(!token)return;if(!quiet)setLoading(true);try{const result=await authorizedFetch("/api/v1/agents",token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(result.response.status===403?"当前账号无权查看 Agent":"Agent 列表加载失败");const body=await result.response.json() as {data:ManagedAgent[]};setAgents(body.data);setError("");}catch(reason){setError(reason instanceof Error?reason.message:"Agent 列表加载失败");}finally{if(!quiet)setLoading(false);}},[token,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);const timer=window.setInterval(()=>void load(true),5000);return()=>{window.clearTimeout(initial);window.clearInterval(timer);};},[load]);
  async function createAgent(){const name=await promptAction({title:"注册新 Agent",label:"设备名称",defaultValue:"Windows Agent",description:"使用容易辨认的名称，方便团队管理设备连接。",placeholder:"例如：办公室 Windows Agent",confirmLabel:"生成注册码",maxLength:80});if(!name?.trim())return;const result=await authorizedFetch("/api/v1/agents/enrollment",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:name.trim()})});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`创建失败（HTTP ${result.response.status}）`);return;}const body=await result.response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});void load(true);}
  async function renameAgent(agent:ManagedAgent){const name=await promptAction({title:"修改 Agent 名称",label:"设备名称",defaultValue:agent.name,placeholder:"输入新的设备名称",confirmLabel:"保存名称",maxLength:80});if(!name?.trim()||name.trim()===agent.name)return;await mutate(agent.id,{name:name.trim()},"Agent 名称已更新");}
  async function revokeAgent(agent:ManagedAgent){if(!await confirmAction(`撤销「${agent.name}」后，该设备必须重新注册才能连接。`,{title:"撤销 Agent？",confirmLabel:"确认撤销"}))return;await mutate(agent.id,{revoke:true},"Agent 已撤销");}
  async function deleteAgent(agent:ManagedAgent){if(!await confirmAction(`「${agent.name}」的中心登记将被永久删除，账号历史消息仍会保留。`,{title:"删除 Agent 登记？",confirmLabel:"永久删除"}))return;const result=await authorizedFetch(`/api/v1/agents/${agent.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`删除失败（HTTP ${result.response.status}）`);return;}onToast("Agent 登记已删除");void load(true);}
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
  if(account?.transport==="cloud")return <CloudNewConversationDialog accounts={accounts} accountId={accountId} onAccountId={setAccountId} token={token} onToken={onToken} onClose={onClose} onCreated={onCreated}/>;
  async function submit(){if(!accountId||!phone.trim()||!firstMessage.trim())return;setBusy(true);setError("");try{const result=await authorizedFetch("/api/v1/conversations",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,phone,displayName:displayName.trim()||undefined,firstMessage:firstMessage.trim(),clientMessageId:crypto.randomUUID()})});if(result.token!==token)onToken(result.token);const body=await result.response.json() as {conversationId?:string;error?:string;details?:{fieldErrors?:Record<string,string[]>}};if(!result.response.ok||!body.conversationId){const detail=body.details?.fieldErrors?Object.values(body.details.fieldErrors).flat()[0]:undefined;throw new Error(detail||({account_not_found:"发送账号不存在或已解绑",invalid_request:"请检查号码和消息内容"} as Record<string,string>)[body.error??""]||`创建失败（HTTP ${result.response.status}）`);}await onCreated(body.conversationId,accountId,result.token);}catch(reason){setError(reason instanceof Error?reason.message:"新建会话失败");}finally{setBusy(false);}}
  return <div className="modal-backdrop" role="presentation"><section className="login-dialog new-conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><MessageCircle size={21}/></span><h2 id="new-conversation-title">新建 WhatsApp 会话</h2><p>仅向单个号码发送，不提供群发。号码必须包含国家或地区代码。</p><label>发送账号<select value={accountId} onChange={event=>setAccountId(event.target.value)} disabled={busy||!accounts.length}>{accounts.length?accounts.map(item=><option value={item.id} key={item.id}>{item.name}（{statusText(item.status)}）</option>):<option value="">暂无已绑定账号</option>}</select></label><div className="conversation-form-grid"><label>WhatsApp 号码<input value={phone} onChange={event=>setPhone(event.target.value)} placeholder="例如：+8613800138000" inputMode="tel" autoFocus/></label><label>联系人名称（可选）<input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={80} placeholder="客户名称"/></label></div><label>首条消息<textarea value={firstMessage} onChange={event=>setFirstMessage(event.target.value)} maxLength={65536} placeholder="输入要发送的消息" onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey))void submit();}}/></label>{account&&account.status!=="online"&&<span className="new-conversation-warning"><Clock3 size={13}/>当前账号离线，消息会先进入持久队列。</span>}{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!accountId||!phone.trim()||!firstMessage.trim()} onClick={()=>void submit()}>{busy?"正在创建…":"创建会话并发送"}</button><small className="dialog-hint">Ctrl / Cmd + Enter 快速提交</small></section></div>;
}

function CloudNewConversationDialog({accounts,accountId,onAccountId,token,onToken,onClose,onCreated}:{accounts:Account[];accountId:string;onAccountId:(id:string)=>void;token:string;onToken:(token:string)=>void;onClose:()=>void;onCreated:(conversationId:string,accountId:string,accessToken:string)=>Promise<void>}){
  const [phone,setPhone]=useState(""),[displayName,setDisplayName]=useState(""),[templates,setTemplates]=useState<CloudTemplate[]>([]),[assets,setAssets]=useState<MediaAsset[]>([]),[selected,setSelected]=useState(""),[headerMediaId,setHeaderMediaId]=useState(""),[values,setValues]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{let active=true;void authorizedFetch(`/api/v1/accounts/${accountId}/templates`,token).then(async result=>{if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:CloudTemplate[]};if(active){const first=body.data[0];setTemplates(body.data);setSelected(first?`${first.name}:${first.language}`:"");setValues(Array.from({length:cloudTemplateVariableCount(first)},()=>("")));}}});return()=>{active=false};},[accountId,token,onToken]);
  useEffect(()=>{let active=true;void authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}`,token).then(async result=>{if(result.token!==token)onToken(result.token);if(result.response.ok){const body=await result.response.json() as {data:MediaAsset[]};if(active)setAssets(body.data);}});return()=>{active=false};},[accountId,token,onToken]);
  const template=templates.find(item=>`${item.name}:${item.language}`===selected),bodyText=template?.components.find(item=>item.type.toUpperCase()==="BODY")?.text??"",headerType=cloudTemplateHeaderType(template),headerAssets=assets.filter(asset=>mediaKind(asset.mimeType)===headerType);
  async function submit(){if(!template||!phone.trim()||Boolean(headerType&&!headerMediaId)||values.some(value=>!value.trim()))return;setBusy(true);setError("");const components:Record<string,unknown>[]=[];if(headerType)components.push({type:"header",parameters:[{type:headerType,mediaId:headerMediaId}]});if(values.length)components.push({type:"body",parameters:values.map(text=>({type:"text",text:text.trim()}))});const result=await authorizedFetch("/api/v1/conversations",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,phone,displayName:displayName.trim()||undefined,message:{type:"template",template:{name:template.name,language:template.language,components}},clientMessageId:crypto.randomUUID()})});if(result.token!==token)onToken(result.token);const body=await result.response.json().catch(()=>({})) as {conversationId?:string;message?:string;error?:string};setBusy(false);if(!result.response.ok||!body.conversationId){setError(body.message??body.error??`HTTP ${result.response.status}`);return;}await onCreated(body.conversationId,accountId,result.token);}
  return <div className="modal-backdrop" role="presentation"><section className="login-dialog new-conversation-dialog" role="dialog" aria-modal="true"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><MessageCircle size={21}/></span><h2>新建 Cloud API 会话</h2><p>新会话必须使用 Meta 已审核的消息模板发起。</p><label>发送账号<select value={accountId} onChange={event=>onAccountId(event.target.value)}>{accounts.map(item=><option value={item.id} key={item.id}>{item.name} · {item.transport==="cloud"?"Cloud API":"Web"}</option>)}</select></label><div className="conversation-form-grid"><label>WhatsApp 号码<input value={phone} onChange={event=>setPhone(event.target.value)} placeholder="例如：+8613800138000" inputMode="tel" autoFocus/></label><label>联系人名称（可选）<input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={80}/></label></div><label>已审核模板<select value={selected} onChange={event=>{const next=templates.find(item=>`${item.name}:${item.language}`===event.target.value);setSelected(event.target.value);setHeaderMediaId("");setValues(Array.from({length:cloudTemplateVariableCount(next)},()=>("")));}}>{templates.map(item=><option key={`${item.name}:${item.language}`} value={`${item.name}:${item.language}`}>{item.name} · {item.language}</option>)}</select></label>{headerType&&<label>{headerType} 头部<select value={headerMediaId} onChange={event=>setHeaderMediaId(event.target.value)}><option value="">选择媒体</option>{headerAssets.map(asset=><option value={asset.id} key={asset.id}>{asset.fileName}</option>)}</select></label>}{bodyText&&<p className="template-preview">{bodyText}</p>}{values.map((value,index)=><label key={index}>变量 {index+1}<input value={value} onChange={event=>setValues(all=>all.map((item,i)=>i===index?event.target.value:item))}/></label>)}{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!template||!phone.trim()||Boolean(headerType&&!headerMediaId)||values.some(value=>!value.trim())} onClick={()=>void submit()}>{busy?"正在创建…":"使用模板创建会话"}</button></section></div>;
}

function LoginDialog({connected,token,canClose,onClose,onLogin,onLogout}:{connected:boolean;token:string;canClose:boolean;onClose:()=>void;onLogin:(token:string,user:User,rememberMe:boolean)=>void;onLogout:()=>void}){
  const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [rememberMe,setRememberMe]=useState(true);const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [agentName,setAgentName]=useState("Windows Agent");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);const [copied,setCopied]=useState(false);
  async function submit(){setBusy(true);setError("");try{const response=await fetch(`${API_URL}/api/v1/auth/login`,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({email,password,rememberMe})});const body=await response.json() as {accessToken?:string;user?:User;error?:string};if(!response.ok||!body.accessToken||!body.user)throw new Error(response.status===401?"邮箱或密码错误":`登录失败（HTTP ${response.status}）`);onLogin(body.accessToken,body.user,rememberMe);}catch(reason){setError(reason instanceof Error?reason.message:"登录失败");}finally{setBusy(false);}}
  async function createEnrollment(){setBusy(true);setError("");setEnrollment(null);try{const response=await fetch(`${API_URL}/api/v1/agents/enrollment`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:agentName.trim()||"Windows Agent"})});if(response.status===401)throw new Error("登录已过期");if(response.status===403)throw new Error("只有管理员可以生成注册码");if(!response.ok)throw new Error(`注册码生成失败（HTTP ${response.status}）`);const body=await response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});}catch(reason){setError(reason instanceof Error?reason.message:"注册码生成失败");}finally{setBusy(false);}}
  async function copyEnrollment(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);setCopied(true);window.setTimeout(()=>setCopied(false),1500);}catch{setError("剪贴板不可用，请手动复制");}}
  return <div className="modal-backdrop" role="presentation"><section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">{canClose&&<button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button>}<span className="login-logo"><ShieldCheck size={21}/></span><h2 id="login-title">{connected?"中心设置":"登录 RelayDesk"}</h2><p>{connected?"生成 Agent 一次性注册码，或退出当前坐席。":"仅限获授权的 GeekMT 团队成员。请使用管理员发放的 RelayDesk 坐席凭据。"}</p>{connected?<><div className="center-endpoint"><span>中心地址</span><strong>{API_URL||"当前站点"}</strong></div><label>Agent 设备名称<input value={agentName} onChange={event=>setAgentName(event.target.value)} maxLength={80}/></label><button className="login-submit" disabled={busy} onClick={()=>void createEnrollment()}>{busy?"正在生成...":"生成一次性注册码"}</button>{enrollment&&<div className="enrollment-result"><span>一次性注册码</span><code>{enrollment.code}</code><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small><button onClick={()=>void copyEnrollment()}>{copied?"已复制":"复制注册码"}</button></div>}{error&&<span className="login-error">{error}</span>}<button className="login-submit danger" onClick={onLogout}>退出中心平台</button></>:<><div className="login-safety"><ShieldCheck size={15}/><span>不要输入 WhatsApp / Meta 密码、短信验证码或两步验证 PIN。</span></div><label>RelayDesk 邮箱<input value={email} onChange={event=>setEmail(event.target.value)} autoComplete="username" autoFocus/></label><label>RelayDesk 密码<input type="password" value={password} onChange={event=>setPassword(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void submit();}} autoComplete="current-password"/></label><label className="remember-login"><input type="checkbox" checked={rememberMe} onChange={event=>setRememberMe(event.target.checked)}/><span><b>保持登录</b><small>除非主动退出，否则关闭浏览器后仍保持登录</small></span></label>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!email||!password} onClick={()=>void submit()}>{busy?"正在验证...":"登录私有工作台"}</button><small className="login-affiliation">由 GeekMT 运营 · 与 Meta 或 WhatsApp 无隶属、赞助或背书关系</small></>}</section></div>;
}
