import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Shell } from "./layout/Shell";
import { Chat } from "./pages/Chat";
import { CreateAgent } from "./pages/CreateAgent";
import { Governance } from "./pages/Governance";
import { Overview } from "./pages/Overview";
import { PlaceholderPage } from "./pages/Placeholder";
import { Registry } from "./pages/Registry";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Overview />} />
          <Route path="create" element={<CreateAgent />} />
          <Route path="registry" element={<Registry />} />
          <Route path="chat" element={<Chat />} />
          <Route path="evaluation" element={<PlaceholderPage ns="evaluation" phase={10} />} />
          <Route path="governance" element={<Governance />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
