import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { pool } from "./db.js";
import type { OrderSummaryFee, OrderSummaryItem } from "./crm.js";
import { renderTemplateOrderImage } from "./order-image.js";
import { parseOrderTemplate, renderSemanticOrder } from "./order-template.js";

const s3=new S3Client({region:config.S3_REGION,endpoint:config.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});

export async function ensureOrderDetailsImage(orderId:string):Promise<string|null>{
  const found=await pool.query("SELECT o.id,o.display_order_number,o.currency,o.description,o.shipping_address_snapshot,o.rendered_media_id,c.account_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) customer_name,co.phone_e164 customer_phone,m.status media_status FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN media m ON m.id=o.rendered_media_id WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);
  if(!found.rowCount)return null;const order=found.rows[0];
  if(order.rendered_media_id&&order.media_status==="ready")return String(order.rendered_media_id);
  const [itemResult,feeResult,templateResult]=await Promise.all([
    pool.query("SELECT i.product_name name,i.quantity,i.unit_amount,m.object_key FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id AND m.status='ready' WHERE i.order_id=$1 ORDER BY i.position",[orderId]),
    pool.query("SELECT name,amount FROM order_fees WHERE order_id=$1 ORDER BY position",[orderId]),
    pool.query("SELECT image_template FROM order_settings WHERE singleton=true"),
  ]);
  if(!itemResult.rowCount)return null;
  const items:OrderSummaryItem[]=itemResult.rows.map(item=>({name:String(item.name),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)}));
  const fees:OrderSummaryFee[]=feeResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)}));
  const template=parseOrderTemplate(templateResult.rows[0]?.image_template,"image"),blocks=renderSemanticOrder(template,{orderNumber:String(order.display_order_number),currency:String(order.currency),customerName:String(order.customer_name??""),customerPhone:String(order.customer_phone??""),description:String(order.description??""),items,fees,address:order.shipping_address_snapshot??null});
  const products=await Promise.all(itemResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));if(!object.Body)return{name:String(item.name)};return{name:String(item.name),image:Buffer.from(await object.Body.transformToByteArray())};}));
  const png=await renderTemplateOrderImage(template,blocks,products),sha256=createHash("sha256").update(png).digest("hex"),objectKey=`orders/${order.account_id}/${orderId}/${sha256}.png`,fileName=`order-${safeFileName(String(order.display_order_number))}.png`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:png,ContentType:"image/png",Metadata:{sha256,orderId,source:"ai-agent"}}));
  const media=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'image/png',$4,$5) ON CONFLICT(object_key) DO UPDATE SET file_name=EXCLUDED.file_name,byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,status='ready' RETURNING id",[order.account_id,objectKey,fileName,png.length,sha256]);
  await pool.query("UPDATE orders SET rendered_media_id=$2 WHERE id=$1",[orderId,media.rows[0].id]);
  return String(media.rows[0].id);
}

function safeFileName(value:string):string{return value.replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,100)||"order";}
