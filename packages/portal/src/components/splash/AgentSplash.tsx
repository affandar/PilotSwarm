import { terminalMarkupToHtml } from "./terminalMarkupToHtml";

interface AgentSplashProps {
  /** Raw terminal-markup splash content (same source as the terminal UI) */
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
        dangerouslySetInnerHTML={{ __html: terminalMarkupToHtml(splashContent) }}
      />
    </div>
  );
}
