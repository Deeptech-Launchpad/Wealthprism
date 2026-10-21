import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import "./styles.css";
import { Shell } from "./Shell";
import { Login } from "./pages/Login";
import { InviteAccept } from "./pages/InviteAccept";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { Welcome } from "./pages/Welcome";
import { Dashboard } from "./pages/Dashboard";
import { Investments } from "./pages/Investments";
import { RealEstate } from "./pages/RealEstate";
import { Banking } from "./pages/Banking";
import { Goals } from "./pages/Goals";
import { Tasks } from "./pages/Tasks";
import { Startups } from "./pages/Startups";
import { WorkingCapital } from "./pages/WorkingCapital";
import { ActionPlane } from "./pages/ActionPlane";
import { Books } from "./pages/Books";
import { Planning } from "./pages/Planning";
import { Policy } from "./pages/Policy";
import { Rebalancing } from "./pages/Rebalancing";
import { Research } from "./pages/Research";
import { Documents } from "./pages/Documents";
import { Reports } from "./pages/Reports";
import { BalanceSheet } from "./pages/BalanceSheet";
import { Analytics } from "./pages/Analytics";
import { Settings } from "./pages/Settings";
import { ProductMap } from "./pages/ProductMap";
import { session } from "./lib/api";
// Signed-out visitors land on the public Welcome page only at "/"; a deep link to any other
// app page (e.g. /investments) still redirects to /login exactly as before.
const Root = () => {
  const location = useLocation();
  if (!session.get()) return location.pathname === "/" ? <Welcome /> : <Navigate to="/login" replace />;
  return <Shell />;
};
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite" element={<InviteAccept />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/" element={<Root />}>
          <Route index element={<Dashboard />} />
          <Route path="investments" element={<Investments />} />
          <Route path="real-estate" element={<RealEstate />} />
          <Route path="startups" element={<Startups />} />
          <Route path="goals" element={<Goals />} />
          <Route path="banking" element={<Banking />} />
          <Route path="working-capital" element={<WorkingCapital />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="action-plane" element={<ActionPlane />} />
          <Route path="books" element={<Books />} />
          <Route path="planning" element={<Planning />} />
          <Route path="policy" element={<Policy />} />
          <Route path="rebalancing" element={<Rebalancing />} />
          <Route path="research" element={<Research />} />
          <Route path="documents" element={<Documents />} />
          <Route path="reports" element={<Reports />} />
          <Route path="balance-sheet" element={<BalanceSheet />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="settings" element={<Settings />} />
          <Route path="product-map" element={<ProductMap />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
