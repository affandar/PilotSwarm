import { blessedToHtml } from "./blessedToHtml";

interface AgentSplashProps {
  /** Raw blessed-tagged splash content (same source as TUI) */
  splashContent: string;
  /** Agent accent color for the card border */
  accentColor?: string;
}

export default function AgentSplash({ splashContent, accentColor = "#888" }: AgentSplashProps) {
  return (
    <div
      className="rounded-lg p-4 my-4 bg-[#0d0d1a]"
      style={{ borderLeft: `3px solid ${accentColor}` }}
    >
      <pre
        className="font-mono text-sm leading-snug whitespace-pre"
        dangerouslySetInnerHTML={{ __html: blessedToHtml(splashContent) }}
      />
    </div>
  );
}
