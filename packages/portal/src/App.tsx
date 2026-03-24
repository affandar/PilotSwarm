import { Routes, Route } from "react-router-dom";
import Shell from "./components/layout/Shell";
import { PortalProvider } from "./hooks/PortalContext";

export default function App() {
  return (
    <PortalProvider>
      <Routes>
        <Route path="/*" element={<Shell />} />
      </Routes>
    </PortalProvider>
  );
}
