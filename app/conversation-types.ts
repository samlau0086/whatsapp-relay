export type TagItem={id:string;name:string;color:string};
export type ContactMethodType="phone"|"wechat"|"telegram"|"line"|"website"|"facebook"|"x"|"linkedin"|"instagram"|"other";
export type ContactMethod={id?:string;type:ContactMethodType;label:string;value:string};
export type ConversationMessageStatus="received"|"queued"|"dispatching"|"sent"|"delivered"|"read"|"failed"|"uncertain";
export type Conversation = {
  id:string;name:string;initials:string;color:string;account:string;accountId:string;phone:string;providerUserId:string;
  contactId:string;alias:string;contactName:string;primaryEmail:string;contactMethods:ContactMethod[];
  preview:string;lastDirection:"in"|"out"|null;lastMessageStatus:ConversationMessageStatus|null;time:string;unread:number;accountStatus:string;assignedUserId:string|null;
  lastMessageAt:string|null;favorite:boolean;conversationStatus:string;customerStage:string;tags:TagItem[];remindAt:string|null;
  platform:"whatsapp"|"messenger";pageId:string|null;transport:"web"|"cloud";serviceWindowExpiresAt:string|null;replyWindowExpiresAt:string|null;
};

export type ConversationChangedEvent={type:"conversation.changed";conversationId:string;accountId:string;platform?:"whatsapp"|"messenger";pageId?:string|null};
