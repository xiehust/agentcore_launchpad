import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Shell } from "./layout/Shell";
import { CreateAgent } from "./pages/CreateAgent";
import { Overview } from "./pages/Overview";
import { PlaceholderPage } from "./pages/Placeholder";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Overview />} />
          <Route path="create" element={<CreateAgent />} />
          <Route path="registry" element={<PlaceholderPage ns="registry" phase={7} />} />
          <Route path="chat" element={<PlaceholderPage ns="chat" phase={8} />} />
          <Route path="evaluation" element={<PlaceholderPage ns="evaluation" phase={10} />} />
          <Route path="governance" element={<PlaceholderPage ns="governance" phase={9} />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
