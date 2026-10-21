import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, TrendingUp, Building2, Rocket, Target, Landmark, Droplets, ClipboardCheck, LogOut, Zap, BookOpen, Bell, Compass, ScrollText, Scale, Newspaper, FolderOpen, FileSpreadsheet, Wallet, PieChart, Settings as SettingsIcon, Map } from "lucide-react";
import { api, session } from "./lib/api";
import { Pill } from "./components";

/** In-app inbox fed by the task engine; polls every minute, marks read on open. */
function Notifications() {
  const [open, setOpen] = useState(false); const [data, setData] = useState<{ items: any[]; unread: number }>({ items: [], unread: 0 }); const nav = useNavigate();
  const load = () => api<{ items: any[]; unread: number }>("/notifications?limit=20").then(setData).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  const toggle = async () => { const next = !open; setOpen(next); if (next && data.unread) { await api("/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }).catch(() => {}); setData((d) => ({ ...d, unread: 0 })); } };
  return (
    <div style={{ position: "relative" }}>
      <button className="btn btn-s" onClick={toggle} title="Notifications"><Bell size={14} />{data.unread > 0 && <span className="pill pill-red" style={{ marginLeft: 4 }}>{data.unread}</span>}</button>
      {open && <div className="card" style={{ position: "absolute", right: 0, top: 36, width: 380, zIndex: 30, maxHeight: 420, overflow: "auto", boxShadow: "0 8px 24px rgba(18,33,58,.15)" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}><b>Notifications</b><button className="btn btn-s" onClick={() => { setOpen(false); nav("/tasks"); }}>Open tasks</button></div>
        {!data.items.length && <div className="small mute">Nothing yet — new tasks land here and on your phone.</div>}
        {data.items.map((n) => <div key={n.id} className="attn" style={{ alignItems: "flex-start", opacity: n.read_at ? 0.75 : 1 }}><div style={{ flex: 1 }}><div><b>{n.title}</b></div><div className="small mute">{n.body}</div></div><div className="small mute" style={{ whiteSpace: "nowrap" }}>{new Date(n.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</div>{n.payload?.severity === 1 && <Pill tone="red">urgent</Pill>}</div>)}
      </div>}
    </div>
  );
}
const NAV = [["/", "Dashboard", LayoutDashboard], ["/investments", "Investments", TrendingUp], ["/real-estate", "Real estate", Building2], ["/startups", "Startups", Rocket], ["/goals", "Goals & buckets", Target], ["/banking", "Banking", Landmark], ["/working-capital", "Working capital", Droplets], ["/tasks", "Tasks", ClipboardCheck], ["/action-plane", "Action plane", Zap], ["/books", "Books", BookOpen], ["/planning", "Planning & tax", Compass], ["/policy", "Investment policy", ScrollText], ["/rebalancing", "Rebalancing", Scale], ["/research", "Research", Newspaper], ["/documents", "Documents", FolderOpen], ["/reports", "Reports", FileSpreadsheet], ["/balance-sheet", "Balance sheet", Wallet], ["/analytics", "Analytics", PieChart], ["/settings", "Settings", SettingsIcon], ["/product-map", "Product map", Map]] as const;
export function Shell() {
  const s = session.get()!; const loc = useLocation(); const nav = useNavigate();
  const title = NAV.find(([p]) => p === loc.pathname)?.[1] ?? "Family Office";
  return (
    <div className="app">
      <aside className="rail">
        <div className="brand"><div className="brand-mark" />Family Office</div>
        <select className="entity" value={session.family() ?? ""} onChange={(e) => { session.setFamily(e.target.value); location.reload(); }}>{s.families.map((f) => <option key={f.id} value={f.id}>{f.name} · {f.role}</option>)}</select>
        <nav>{NAV.map(([p, n, I]) => <NavLink key={p} to={p} end={p === "/"}><I size={16} />{n}</NavLink>)}</nav>
        <div className="rail-foot">{s.user.name}<br /><button className="btn btn-s" style={{ marginTop: 8 }} onClick={() => { session.set(null); nav("/login"); }}><LogOut size={13} /> Sign out</button></div>
      </aside>
      <main><header className="top"><h1>{title}</h1><span className="small mute">Live from API · {new Date().toLocaleDateString("en-IN")}</span><Notifications /></header><div className="content"><Outlet /></div></main>
    </div>
  );
}
