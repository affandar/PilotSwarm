import { useState, useEffect } from "react";
import { blessedToHtml } from "./blessedToHtml";

interface StartupSplashProps {
  onNewSession: () => void;
}

export default function StartupSplash({ onNewSession }: StartupSplashProps) {
  const [splashHtml, setSplashHtml] = useState("");

  useEffect(() => {
    fetch("/splash.txt")
      .then((r) => r.text())
      .then((text) => setSplashHtml(blessedToHtml(text)))
      .catch(() => setSplashHtml("PilotSwarm"));
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8">
      <pre
        className="font-mono text-xs select-none whitespace-pre"
        style={{ lineHeight: "1.1" }}
        dangerouslySetInnerHTML={{ __html: splashHtml }}
      />

      <button
        onClick={onNewSession}
        className="px-6 py-3 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-white font-medium text-sm"
      >
        + New Session
      </button>
    </div>
  );
}
