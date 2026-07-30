import type {Metadata} from "next";
import Link from "next/link";
import {LegalDocument,LegalSection} from "../legal-document";

export const metadata:Metadata={
  title:"隐私政策 | RelayDesk",
  description:"RelayDesk 关于 Facebook Messenger、WhatsApp 及统一消息工作台数据处理方式的公开隐私政策。",
  robots:{index:true,follow:true},
};

export default function PrivacyPage(){
  return <LegalDocument eyebrow="PRIVACY POLICY" title="隐私政策" summary="本政策说明 RelayDesk 在连接 Facebook Page Messenger 与 WhatsApp 业务渠道时收集哪些数据、为何处理、如何保护，以及你可以如何行使数据权利。" updated="2026-07-30">
    <LegalSection title="1. 适用范围与角色" enTitle="Scope and roles">
      <p>RelayDesk 是由 GeekMT 运营的多渠道客户消息工作台。本政策适用于通过已连接的 Facebook Page、WhatsApp 业务账号与商家沟通的客户，以及使用 RelayDesk 的获授权坐席。</p>
      <p lang="en">RelayDesk is a multi-channel customer messaging workspace operated by GeekMT. This policy applies to people who message a connected Facebook Page or WhatsApp business account and to authorized RelayDesk users.</p>
      <p>通常情况下，经营相应 Facebook Page 或 WhatsApp 账号的商家决定客户数据的处理目的，是数据控制者；GeekMT/RelayDesk 按该商家的指示提供处理服务。若相应 Page 由 GeekMT 直接经营，则 GeekMT 是该数据的控制者。</p>
    </LegalSection>
    <LegalSection title="2. 我们处理的数据" enTitle="Data we process">
      <ul>
        <li><b>渠道身份：</b>Facebook Page ID、Page-scoped User ID（PSID）、WhatsApp 渠道标识，以及 Meta 在授权范围内提供的姓名和头像。</li>
        <li><b>会话内容：</b>你主动发送的文字、图片、视频、音频、文件、引用关系，以及消息时间、送达和已读状态。</li>
        <li><b>业务记录：</b>会话分配、标签、内部备注、客户资料、订单或跟进信息；这些内容仅在商家实际使用相应功能时产生。</li>
        <li><b>安全与运维数据：</b>登录、审计、Webhook、错误、设备及必要的网络日志，用于防止滥用、排查故障和保障服务。</li>
      </ul>
      <p lang="en">We process channel identifiers, content you send, message and delivery metadata, business records created by the Page operator, and limited security and operational logs. RelayDesk does not ask messaging customers for their Facebook password, two-factor code, or payment credentials.</p>
    </LegalSection>
    <LegalSection title="3. 处理目的与依据" enTitle="Purposes and legal bases">
      <p>我们仅为接收和回复客户咨询、在多个已授权渠道中显示会话、提供客户服务记录、执行用户要求的翻译或 AI 草稿、保障安全、履行法律义务而处理数据。处理依据可能包括履行与你的交易或服务请求、你的同意、商家提供客户服务的合法利益，以及适用法律要求。</p>
      <p>RelayDesk 不出售个人数据，也不使用 Messenger 消息建立跨平台广告画像。不同 Facebook Page、不同 WhatsApp 账号的身份默认保持分离，除非客户与商家明确要求并依法完成合并。</p>
    </LegalSection>
    <LegalSection title="4. 数据共享" enTitle="Sharing and processors">
      <p>数据可能在实现上述目的所必需的范围内提供给：经营相应渠道的获授权人员；Meta/WhatsApp 等消息平台；受合同约束的云托管、数据库、对象存储和备份服务商；以及商家明确启用的翻译或 AI 服务商。我们也可能为遵守法律、法院命令或保护用户安全而披露必要信息。</p>
      <p lang="en">We share data only as needed with the relevant Page operator, Meta messaging services, contracted infrastructure providers, optional AI or translation providers enabled by the operator, and authorities where legally required.</p>
    </LegalSection>
    <LegalSection title="5. 保存与安全" enTitle="Retention and security">
      <p>商家可按照其业务、合同和法定义务设置保存周期。收到经验证的删除请求后，RelayDesk 将在 30 天内删除或匿名化活动系统中的相关客户数据；备份副本会随轮换到期，并最迟在 90 天内清除，法律要求保留的记录除外。</p>
      <p>我们使用 HTTPS 传输、凭据加密、基于角色的账号权限、账号级数据隔离、审计日志和受限运维访问等措施。任何系统都无法保证绝对安全，请勿通过聊天发送不必要的敏感信息。</p>
    </LegalSection>
    <LegalSection title="6. 你的权利" enTitle="Your choices and rights">
      <p>依适用法律，你可以请求访问、更正、导出、限制处理、反对处理或删除个人数据，也可以撤回同意。最可靠的身份验证方式是从原 Facebook Page 或 WhatsApp 会话提交请求。详细步骤见 <Link href="/data-deletion">用户数据删除说明</Link>。</p>
      <p>你也可以在 Facebook 或 WhatsApp 中停止发送消息、删除本地会话或屏蔽相应商家；这些平台操作不会自动删除商家已依法保存的副本，因此如需完整删除，请另行提交删除请求。</p>
    </LegalSection>
    <LegalSection title="7. 国际传输、未成年人及变更" enTitle="Transfers, children and changes">
      <p>服务商可能在你所在国家/地区以外处理数据，我们会要求使用适用的合同与安全保障。RelayDesk 面向商业客户服务，不以未成年人为目标；如发现未经适当授权处理了未成年人数据，请立即通过原 Page 联系商家。</p>
      <p>本政策更新时会修改页面顶部日期。重大变更会通过适当的产品或商家渠道通知。关于本政策的问题，请联系你最初发送消息的 Facebook Page 或 WhatsApp 商家账号，并注明“RelayDesk 隐私请求”。</p>
    </LegalSection>
  </LegalDocument>;
}
