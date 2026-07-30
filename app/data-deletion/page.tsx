import type {Metadata} from "next";
import {LegalDocument,LegalSection} from "../legal-document";

export const metadata:Metadata={
  title:"用户数据删除 | RelayDesk",
  description:"请求删除通过 Facebook Messenger 或 WhatsApp 由 RelayDesk 处理的个人数据的公开操作说明。",
  robots:{index:true,follow:true},
};

export default function DataDeletionPage(){
  return <LegalDocument eyebrow="USER DATA DELETION" title="用户数据删除" summary="无需登录 RelayDesk。请从产生数据的原 Facebook Page 或 WhatsApp 会话发起请求，以便安全确认渠道身份并定位需要删除的记录。" updated="2026-07-30">
    <div className="deletion-callout">
      <b>Facebook 用户说明 / Instructions for Facebook users</b>
      <p>RelayDesk 不使用 Facebook Login 为消息客户创建账号。我们只会在你主动向已连接的 Facebook Page 发消息后，通过 Messenger Webhook 接收该 Page 范围内的身份和消息数据。</p>
    </div>
    <LegalSection title="1. 提交删除请求" enTitle="How to request deletion">
      <ol className="deletion-steps">
        <li><span>1</span><div><b>打开原会话</b><p>在 Facebook Messenger 或 WhatsApp 中，打开你曾联系的同一个商家 Page/账号。</p></div></li>
        <li><span>2</span><div><b>发送明确请求</b><p>发送“删除我的 RelayDesk 数据”或 “Delete my RelayDesk data”，并说明是否要求删除全部历史消息、附件和客户资料。</p></div></li>
        <li><span>3</span><div><b>完成身份核验</b><p>商家会通过同一 Page-scoped User ID（PSID）或 WhatsApp 渠道身份核对请求。请勿发送密码、短信验证码、两步验证 PIN 或证件照片，除非适用法律确实要求其它验证方式。</p></div></li>
        <li><span>4</span><div><b>保存确认信息</b><p>核验后，商家将回复受理日期或删除请求编号。活动系统中的适用数据会在 30 天内删除或匿名化。</p></div></li>
      </ol>
      <p lang="en">Open the original Messenger or WhatsApp conversation, send “Delete my RelayDesk data,” complete verification through the same channel identity, and retain the confirmation or request reference supplied by the Page operator.</p>
    </LegalSection>
    <LegalSection title="2. 无法访问原会话时" enTitle="If you cannot access the original chat">
      <p>请使用该 Facebook Page“关于”区域或商家网站公布的公开联系渠道联系 Page 经营者，主题注明“RelayDesk 数据删除请求”，并提供 Page 名称、你联系 Page 的大致日期和足以定位会话的非敏感信息。为保护隐私，商家可能要求你重新从原 Facebook/WhatsApp 账号发送确认。</p>
    </LegalSection>
    <LegalSection title="3. 删除范围" enTitle="What will be deleted">
      <ul>
        <li>该 Page/渠道下与请求身份关联的 PSID 或渠道用户标识、姓名和头像缓存。</li>
        <li>消息正文、附件、引用关系、送达/已读元数据和会话摘要。</li>
        <li>与该联系人直接关联的标签、备注、客户资料、任务和其它业务记录，但法律要求保留的交易凭证除外。</li>
        <li>可合理关联到该客户的 AI 草稿、翻译和派生内容。</li>
      </ul>
      <p>不同 Facebook Page 使用不同 PSID，并在 RelayDesk 中形成独立记录。若你联系过多个 Page 或 WhatsApp 账号，请分别向每个渠道提交请求，以确保完整定位。</p>
    </LegalSection>
    <LegalSection title="4. 完成时间与例外" enTitle="Timing and exceptions">
      <p>经验证的请求通常在 30 天内完成。备份中的副本会停止用于日常处理，并随备份轮换最迟在 90 天内清除。若记录必须用于履行税务、会计、争议处理、安全调查或其它法定义务，我们会仅保留必要部分、限制访问，并在保留依据结束后删除。</p>
      <p>如果请求无法验证、范围不清或法律允许拒绝，Page 经营者会通过原渠道说明原因及可采取的下一步。提交删除请求不会产生费用，也不会要求你提供 Facebook 密码或 RelayDesk 登录信息。</p>
    </LegalSection>
    <LegalSection title="5. Facebook 应用移除" enTitle="Removing app access on Facebook">
      <p>你还可以在 Facebook 的“设置与隐私 → 设置 → 业务集成/Apps and Websites”中移除相关应用权限（具体菜单名称可能随 Meta 更新）。移除权限可以阻止未来的授权访问，但不会替代上述删除请求，也不会自动删除商家依法保存的既有消息副本。</p>
    </LegalSection>
  </LegalDocument>;
}
