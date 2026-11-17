import type {Conversation} from "./conversation-types";

export type ConversationMode="email"|"whatsapp"|"livechat"|"messenger";
export type ConversationModeMember=Conversation&{mode:ConversationMode;hasMailbox:boolean;hasEmailProvider:boolean;whatsappUsername:string};
export function initialConversationMode(item:Pick<Conversation,"platform"|"phone"|"providerUserId"|"primaryEmail"|"originMode"|"whatsappUsername">):ConversationMode{
  return item.originMode??(item.platform==="whatsapp"&&!item.phone&&!item.providerUserId&&!item.whatsappUsername&&item.primaryEmail?"email":item.platform);
}
export function modeMembers(members:ConversationModeMember[],mode:ConversationMode){
  return members.filter(item=>mode==="email"?Boolean(item.primaryEmail&&(item.hasMailbox||item.hasEmailProvider)):item.mode===mode);
}
export function matchesMessageMode(message:{email?:unknown;platform?:string},mode:ConversationMode){
  return mode==="email"?Boolean(message.email):!message.email&&(message.platform??"whatsapp")===mode;
}
