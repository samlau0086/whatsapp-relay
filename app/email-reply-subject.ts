export function replyEmailSubject(subject: string): string {
  const current = subject.trim() || "无主题";
  const reply = /^re(?:\s*\(\s*(\d+)\s*\))?\s*:\s*(.*)$/i.exec(current);
  if (!reply) return `Re: ${current}`;

  const count = reply[1] ? Number(reply[1]) : 1;
  return `Re(${count + 1}): ${reply[2].trim() || "无主题"}`;
}
