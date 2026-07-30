import type {Metadata} from "next";
import {LegalDocument,LegalSection} from "../legal-document";

export const metadata:Metadata={
  title:"服务条款 | RelayDesk",
  description:"使用 RelayDesk 及其 Facebook Messenger、WhatsApp 消息集成功能时适用的公开服务条款。",
  robots:{index:true,follow:true},
};

export default function TermsPage(){
  return <LegalDocument eyebrow="TERMS OF SERVICE" title="服务条款" summary="这些条款规范获授权商家和坐席对 RelayDesk 的使用，也说明通过已连接 Facebook Page 或 WhatsApp 账号与商家沟通时适用的基本规则。" updated="2026-07-30">
    <LegalSection title="1. 接受条款" enTitle="Acceptance">
      <p>访问或使用 RelayDesk 即表示你同意本条款与我们的隐私政策。代表企业使用本服务的人确认其有权使该企业受本条款约束。若你只是向已连接的商家 Page 发送消息，你与该商家之间的商品、服务和交易仍适用该商家的条款。</p>
      <p lang="en">By accessing or using RelayDesk, you agree to these Terms and the Privacy Policy. If you message a connected business Page, the business remains responsible for its products, services, and customer commitments.</p>
    </LegalSection>
    <LegalSection title="2. 服务说明" enTitle="Service description">
      <p>RelayDesk 将获授权的 Facebook Page Messenger 与 WhatsApp 业务消息汇集到统一收件箱，并提供回复、媒体、会话分配、CRM 记录、翻译、AI 草稿和可靠队列等功能。具体功能取决于部署配置、账号权限和第三方平台能力。</p>
      <p>Messenger 的主动消息、回复窗口、权限和审核受 Meta Platform Terms、Messenger Platform Policies 及相关法律约束。RelayDesk 不保证第三方平台会批准 App、权限或消息发送。</p>
    </LegalSection>
    <LegalSection title="3. 账号与授权" enTitle="Accounts and authorization">
      <ul>
        <li>只有获商家明确授权的人员可以登录 RelayDesk 或连接 Page/WhatsApp 账号。</li>
        <li>用户必须保护登录凭据、Page Access Token、App Secret 和 Verify Token，不得共享给无关人员。</li>
        <li>发现账号、Token 或设备可能泄露时，应立即撤销凭据并通知管理员。</li>
        <li>连接渠道的人确认其拥有必要管理权限，并已向客户提供适用的隐私告知。</li>
      </ul>
    </LegalSection>
    <LegalSection title="4. 可接受使用" enTitle="Acceptable use">
      <p>不得利用 RelayDesk 发送垃圾消息、骚扰或欺诈内容，冒充他人，传播恶意软件，侵犯隐私或知识产权，规避 Meta 的消息窗口、审核或速率限制，抓取无授权数据，或从事违反法律和平台政策的活动。商家应确保营销消息具有有效同意和退订机制。</p>
      <p lang="en">You may not use RelayDesk for spam, harassment, fraud, impersonation, malware, unlawful surveillance, rights infringement, or circumvention of Meta review, messaging windows, rate limits, or platform policies.</p>
    </LegalSection>
    <LegalSection title="5. 内容与数据责任" enTitle="Content and data responsibility">
      <p>用户保留其合法内容的权利，并授予 RelayDesk 为提供、保护和维护服务所必需的有限处理权限。商家负责其坐席输入、自动化规则、AI 草稿批准、客户回复和数据保存决定。不得上传无权处理的个人或机密数据。</p>
      <p>AI 与翻译输出可能不准确，应由获授权人员在发送或用于业务决定前复核。RelayDesk 不应被用于完全自动化作出对个人具有重大法律或类似影响的决定。</p>
    </LegalSection>
    <LegalSection title="6. 第三方服务与商标" enTitle="Third-party services">
      <p>Meta、Facebook、Messenger、WhatsApp、云基础设施和可选 AI Provider 均为独立第三方，其服务可能变更、中断或撤销权限。RelayDesk 与 Meta Platforms, Inc. 或 WhatsApp LLC 无隶属、赞助或背书关系；相关名称和商标归其各自权利人所有。</p>
    </LegalSection>
    <LegalSection title="7. 可用性与责任限制" enTitle="Availability and limitation">
      <p>服务按“现状”和“可用”状态提供。我们会采取合理措施维护可靠性与安全性，但不保证服务持续无错误，也不保证消息一定送达。在法律允许的最大范围内，GeekMT 不对间接、附带、特殊或后果性损失负责。任何不能依法排除的责任仍按适用法律处理。</p>
    </LegalSection>
    <LegalSection title="8. 暂停、终止与变更" enTitle="Suspension, termination and changes">
      <p>对于安全风险、违法使用、平台政策违规或严重违反本条款的账号，我们可以限制或暂停访问。终止后，数据将依合同、隐私政策、删除请求和法定义务处理。条款更新会在本页公布并修改生效日期；继续使用重大更新后的服务表示接受更新。</p>
      <p>条款问题可通过你所属的 RelayDesk 管理员提出；消息客户可联系其最初沟通的 Facebook Page 或 WhatsApp 商家账号。</p>
    </LegalSection>
  </LegalDocument>;
}
