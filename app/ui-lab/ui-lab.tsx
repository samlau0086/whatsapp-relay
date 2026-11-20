"use client";

import { Check, Ellipsis, PanelRight, Pencil, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LivechatSessionBoundary } from "../livechat-session-boundary";
import { AsyncState, Button, Dialog, Drawer, FormField, IconButton, Popover, type AsyncStatus } from "../ui";

export function UiLab() {
  const [editor, setEditor] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [name, setName] = useState("网站客服");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("failure");
  const [status, setStatus] = useState<AsyncStatus>("ready");
  const [notice, setNotice] = useState("");
  const [loadingButton, setLoadingButton] = useState(false);
  const submitLock = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const dirty = name !== "网站客服" || notes !== "";

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (buttonTimer.current) clearTimeout(buttonTimer.current);
  }, []);

  function closeEditor() {
    if (submitLock.current) return;
    if (dirty) setDiscard(true);
    else setEditor(false);
  }
  function save() {
    if (submitLock.current) return;
    if (!name.trim()) { setError("请输入渠道名称"); input.current?.focus(); return; }
    submitLock.current = true;
    setBusy(true);
    setError("");
    timer.current = setTimeout(() => {
      submitLock.current = false;
      setBusy(false);
      if (outcome === "failure") setError("保存失败，填写内容已保留");
      else { setEditor(false); setNotice("示例配置已保存"); }
    }, 900);
  }

  return <main className="rd-lab">
    <header className="rd-lab-header">
      <span className="rd-lab-brand"><img src="/relaydesk-icon-64.png" alt="" width={32} height={32} /><strong>RelayDesk</strong></span>
      <span>UI 验收台</span><span className="rd-lab-version">标准 v1.0</span>
    </header>
    <div className="rd-lab-content">
      <div className="rd-lab-heading"><div><h1>组件验收</h1><p>基础组件 · 独立测试数据</p></div><ShieldCheck size={28} aria-hidden="true" /></div>
      <section className="rd-lab-section" aria-labelledby="actions-title">
        <h2 id="actions-title">操作</h2>
        <div className="rd-lab-actions">
          <Button variant="primary" icon={Save} loading={loadingButton} onClick={() => {
            setLoadingButton(true);
            buttonTimer.current = setTimeout(() => setLoadingButton(false), 900);
          }}>保存配置</Button>
          <Button icon={Pencil} onClick={() => { setName("网站客服"); setNotes(""); setError(""); setEditor(true); }}>编辑渠道</Button>
          <Button icon={PanelRight} onClick={() => setDrawer(true)}>客户详情</Button>
          <Button disabled>不可用</Button>
          <IconButton icon={Trash2} label="删除示例" variant="danger" onClick={() => setNotice("示例记录已移除")} />
          <Popover label="更多操作" icon={Ellipsis}>{close => <>
            <strong>网站客服</strong><p>运营渠道 / 亚洲团队</p>
            <Button icon={Check} onClick={() => { setNotice("示例渠道已启用"); close(); }}>启用渠道</Button>
          </>}</Popover>
        </div>
        <div className="rd-lab-notice" role="status">{notice}</div>
      </section>
      <section className="rd-lab-section" aria-labelledby="fields-title">
        <h2 id="fields-title">字段</h2>
        <div className="rd-lab-grid">
          <FormField label="联系人名称" required hint="最多 80 个字符">{props => <input {...props} maxLength={80} defaultValue="上海跨境销售团队" />}</FormField>
          <FormField label="联系邮箱" error="邮箱格式不正确">{props => <input {...props} type="email" defaultValue="support@" />}</FormField>
          <FormField label="所属渠道">{props => <select {...props} defaultValue="livechat"><option value="livechat">Live Chat</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select>}</FormField>
          <FormField label="只读编号">{props => <input {...props} disabled value="RD-2026-001" readOnly />}</FormField>
        </div>
      </section>
      <section className="rd-lab-section" aria-labelledby="boundary-title">
        <h2 id="boundary-title">会话结束</h2>
        <LivechatSessionBoundary id="lab-ended-session" onSend={() => setNotice("已选择示例历史段，未发送邮件")} />
      </section>
      <section className="rd-lab-section" aria-labelledby="async-title">
        <div className="rd-lab-section-head"><h2 id="async-title">记录状态</h2>
          <label>数据状态<select value={status} onChange={event => setStatus(event.target.value as AsyncStatus)}>
            <option value="ready">正常</option><option value="loading">首次加载</option><option value="refreshing">后台刷新</option>
            <option value="empty">空记录</option><option value="error">加载失败</option><option value="partial">部分失败</option>
          </select></label>
        </div>
        <div className="rd-lab-records"><AsyncState status={status} onRetry={() => setStatus("ready")}>
          <ul>{["网站客服 · 亚洲团队", "售前咨询 / International-Sales-Channel-With-A-Very-Long-Unbroken-Name-2026", "订单跟进 · 欧洲团队"].map((item, index) =>
            <li key={item}><span className="rd-lab-record-index">0{index + 1}</span><span>{item}</span><span className="rd-lab-badge">已启用</span></li>)}</ul>
        </AsyncState></div>
      </section>
    </div>
    <Dialog open={editor} title="编辑渠道" description="网站客服 / 亚洲团队" busy={busy} initialFocus={input} onRequestClose={closeEditor}
      footer={<>{error && error !== "请输入渠道名称" && <p className="rd-field-error rd-lab-save-error" role="alert">{error}</p>}<Button disabled={busy} onClick={closeEditor}>取消</Button><Button form="rd-lab-form" type="submit" icon={Save} variant="primary" loading={busy}>保存渠道</Button></>}>
      <form id="rd-lab-form" className="rd-lab-form" onSubmit={event => { event.preventDefault(); save(); }}>
        <FormField label="渠道名称" required error={error === "请输入渠道名称" ? error : undefined}>{props => <input {...props} ref={input} maxLength={80} value={name} onChange={event => setName(event.target.value)} />}</FormField>
        <FormField label="保存结果">{props => <select {...props} value={outcome} onChange={event => setOutcome(event.target.value)}><option value="failure">模拟失败</option><option value="success">模拟成功</option></select>}</FormField>
        <FormField label="备注">{props => <textarea {...props} rows={5} value={notes} onChange={event => setNotes(event.target.value)} />}</FormField>
        <Popover label="渠道操作" icon={Ellipsis}>{close => <Button onClick={() => { setNotes("已添加渠道备注"); close(); }}>添加备注</Button>}</Popover>
        <div className="rd-lab-history"><h3>变更记录</h3>{Array.from({ length: 8 }, (_, index) => <p key={index}>2026-11-{String(18 - index).padStart(2, "0")} · 运营团队更新渠道配置</p>)}</div>
      </form>
    </Dialog>
    <Dialog open={discard} title="放弃未保存的修改？" role="alertdialog" initialFocus={keepEditing}
      onRequestClose={() => setDiscard(false)} footer={<>
        <button ref={keepEditing} type="button" className="rd-button" onClick={() => setDiscard(false)}>继续编辑</button>
        <Button variant="danger" onClick={() => { setDiscard(false); setEditor(false); }}>放弃修改</Button>
      </>}><p>渠道名称和备注的修改尚未保存。</p></Dialog>
    <Drawer open={drawer} title="客户详情" onRequestClose={() => setDrawer(false)} dismissOnBackdrop
      footer={<Button onClick={() => setDrawer(false)}>完成</Button>}>
      <dl className="rd-lab-details"><dt>客户</dt><dd>上海跨境销售团队</dd><dt>邮箱</dt><dd>international-sales-operations@example.com</dd><dt>最近记录</dt><dd>等待确认报价与交付时间。</dd></dl>
    </Drawer>
  </main>;
}
