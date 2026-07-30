import Link from "next/link";
import type {ReactNode} from "react";
import {ArrowLeft,ShieldCheck} from "lucide-react";

type LegalDocumentProps={eyebrow:string;title:string;summary:string;updated:string;children:ReactNode};

export function LegalDocument({eyebrow,title,summary,updated,children}:LegalDocumentProps){
  return <div className="policy-shell">
    <header className="policy-header">
      <Link className="policy-brand" href="/" aria-label="返回 RelayDesk 首页">
        <span><ShieldCheck size={20}/></span><span><b>RelayDesk</b><small>by GeekMT</small></span>
      </Link>
      <nav aria-label="公共政策页面">
        <Link href="/privacy">隐私政策</Link><Link href="/terms">服务条款</Link><Link href="/data-deletion">数据删除</Link>
      </nav>
    </header>
    <main className="policy-main">
      <Link className="policy-back" href="/"><ArrowLeft size={15}/>返回首页</Link>
      <section className="policy-hero"><span>{eyebrow}</span><h1>{title}</h1><p>{summary}</p><small>最后更新 / Last updated: {updated}</small></section>
      <article className="policy-article">{children}</article>
    </main>
    <footer className="policy-footer"><p>© {new Date().getFullYear()} GeekMT · RelayDesk</p><p>RelayDesk 与 Meta Platforms, Inc. 或 WhatsApp LLC 无隶属、赞助或背书关系。</p></footer>
  </div>;
}

export function LegalSection({title,enTitle,children}:{title:string;enTitle:string;children:ReactNode}){
  return <section className="policy-section"><h2>{title}<small>{enTitle}</small></h2>{children}</section>;
}
