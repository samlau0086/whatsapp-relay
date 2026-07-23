import { notFound } from "next/navigation";
import { WhatsAppInbox } from "../whatsapp-inbox";

const WORKSPACE_VIEWS = new Set([
  "inbox",
  "contacts",
  "tasks",
  "orders",
  "products",
  "agents",
  "settings",
  "help",
] as const);

type WorkspaceView = "inbox"|"contacts"|"tasks"|"orders"|"products"|"agents"|"settings"|"help";

export default async function WorkspacePage({params}:{params:Promise<{view:string}>}) {
  const {view}=await params;
  if(!WORKSPACE_VIEWS.has(view as WorkspaceView))notFound();
  return <WhatsAppInbox initialView={view as WorkspaceView}/>;
}
