"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";

interface Invite { email: string; is_admin: boolean; added_at: string }
interface UsageRow { email: string; day: string; feature: string; provider: string; calls: number; input_tokens: number; output_tokens: number }

export default function AdminPanel({ me }: { me: string }) {
  const [emails, setEmails] = useState<Invite[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [days, setDays] = useState(14);
  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, u] = await Promise.all([api<{ emails: Invite[] }>("/api/admin/emails"), api<{ usage: UsageRow[] }>(`/api/admin/usage?days=${days}`)]);
      setEmails(e.emails); setUsage(u.usage);
    } catch (e) { setMsg({ text: (e as Error).message, err: true }); }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!e) return;
    try { await api("/api/admin/emails", { method: "POST", json: { email: e, isAdmin } }); setEmail(""); setIsAdmin(false); setMsg({ text: `Invited ${e}.` }); load(); }
    catch (err) { setMsg({ text: (err as Error).message, err: true }); }
  };
  const remove = async (e: string) => {
    if (!confirm(`Remove ${e}? They won’t be able to sign in. Their writing stays in the database.`)) return;
    try { await api("/api/admin/emails", { method: "DELETE", json: { email: e } }); load(); }
    catch (err) { setMsg({ text: (err as Error).message, err: true }); }
  };

  const totals = useMemo(() => {
    const m = new Map<string, { email: string; calls: number; input: number; output: number }>();
    for (const r of usage) {
      const t = m.get(r.email) || { email: r.email, calls: 0, input: 0, output: 0 };
      t.calls += r.calls; t.input += r.input_tokens; t.output += r.output_tokens; m.set(r.email, t);
    }
    return [...m.values()].sort((a, b) => b.calls - a.calls);
  }, [usage]);

  const n = (x: number) => x.toLocaleString();
  return (
    <div className="admin">
      <p><a href="/" className="btn small">← Back to writing</a></p>
      <h1>Admin</h1>
      <p className="hint">Signed in as {me}. You can manage invites and see AI usage. You can’t read anyone’s writing.</p>

      <h2>Invited writers</h2>
      <div className="row">
        <input className="in" style={{ maxWidth: 320 }} type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} aria-label="Email to invite" />
        <label className="hint" style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin</label>
        <button className="btn primary small" onClick={add}>Invite</button>
      </div>
      {msg && <p className={msg.err ? "err-text" : "hint"}>{msg.text}</p>}
      <div className="tablewrap"><table>
        <thead><tr><th>Email</th><th>Role</th><th>Added</th><th /></tr></thead>
        <tbody>
          {emails.map((e) => (
            <tr key={e.email}>
              <td>{e.email}</td><td>{e.is_admin ? "Admin" : "Writer"}</td><td>{new Date(e.added_at).toLocaleDateString()}</td>
              <td className="num">{e.email !== me && <button className="btn ghost small" onClick={() => remove(e.email)}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <h2>AI usage</h2>
      <div className="row">
        <label className="hint">Last <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      </div>
      <div className="tablewrap"><table>
        <thead><tr><th>Writer</th><th className="num">Calls</th><th className="num">Input tokens</th><th className="num">Output tokens</th></tr></thead>
        <tbody>
          {!totals.length && <tr><td colSpan={4} className="hint">No usage yet.</td></tr>}
          {totals.map((t) => <tr key={t.email}><td>{t.email}</td><td className="num">{n(t.calls)}</td><td className="num">{n(t.input)}</td><td className="num">{n(t.output)}</td></tr>)}
        </tbody>
      </table></div>
      <h2>By day</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Day (UTC)</th><th>Writer</th><th>Feature</th><th>Provider</th><th className="num">Calls</th><th className="num">In</th><th className="num">Out</th></tr></thead>
        <tbody>
          {usage.map((r, i) => (
            <tr key={i}><td>{r.day}</td><td>{r.email}</td><td>{r.feature}</td><td>{r.provider}</td><td className="num">{n(r.calls)}</td><td className="num">{n(r.input_tokens)}</td><td className="num">{n(r.output_tokens)}</td></tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
