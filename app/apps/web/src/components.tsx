import React from "react";
export const Card = ({ title, action, children, style }: { title?: string; action?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) => (
  <section className="card" style={style}>{(title || action) && <header className="card-h"><h3>{title}</h3>{action}</header>}{children}</section>
);
export const Pill = ({ tone, children }: { tone?: "teal" | "amber" | "red" | "blue"; children: React.ReactNode }) => <span className={`pill ${tone ? "pill-" + tone : ""}`}>{children}</span>;
export const Status = ({ loading, error }: { loading: boolean; error: string | null }) => <div className="card mute">{loading ? "Loading…" : error}</div>;
export const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
