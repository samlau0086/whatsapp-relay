import {isPostgresUuid} from "./conversation-cursor.js";

export function parseConversationTagFilter(query:{tagId?:unknown;tagIds?:unknown}):string[]|null{
  if(query.tagId!==undefined&&typeof query.tagId!=="string"||query.tagIds!==undefined&&typeof query.tagIds!=="string")return null;
  const ids=[...(query.tagId?[query.tagId as string]:[]),...(query.tagIds?(query.tagIds as string).split(","):[])];
  if(ids.some(id=>!isPostgresUuid(id)))return null;
  return [...new Set(ids.map(id=>id.toLowerCase()))];
}

export function matchesConversationTags(tags:unknown,selectedIds:string[]):boolean{
  return !selectedIds.length||Array.isArray(tags)&&tags.some(tag=>tag&&typeof tag.id==="string"&&selectedIds.includes(tag.id.toLowerCase()));
}
