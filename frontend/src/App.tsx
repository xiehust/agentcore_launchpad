import { BrowserRouter, Route, Routes } from "react-router-dom";

import { ToastProvider } from "./components";
import { Shell } from "./layout/Shell";
import { Chat } from "./pages/Chat";
import { CreateAgent } from "./pages/CreateAgent";
import { Evaluation } from "./pages/Evaluation";
import { Governance } from "./pages/Governance";
import { Observability } from "./pages/Observability";
import { Overview } from "./pages/Overview";
import { Registry } from "./pages/Registry";

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="create" element={<CreateAgent />} />
            <Route path="registry" element={<Registry />} />
            <Route path="chat" element={<Chat />} />
            <Route path="observability" element={<Observability />} />
            <Route path="evaluation" element={<Evaluation />} />
            <Route path="governance" element={<Governance />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
