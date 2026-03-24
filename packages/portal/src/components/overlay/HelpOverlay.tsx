interface HelpOverlayProps {
  onClose: () => void;
}

export default function HelpOverlay({ onClose }: HelpOverlayProps) {
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#16213e] border border-gray-700 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Section title="Navigation">
            <Row keys="Tab / Shift+Tab" action="Cycle panels" />
            <Row keys="h / l" action="Left / Right" />
            <Row keys="p" action="Focus input" />
            <Row keys="?" action="This help" />
            <Row keys="Esc" action="Exit / quit" />
          </Section>

          <Section title="Session List">
            <Row keys="j / k" action="Navigate sessions" />
            <Row keys="Enter" action="Switch to session" />
            <Row keys="n" action="New session" />
            <Row keys="N" action="New + model picker" />
            <Row keys="t" action="Rename session" />
            <Row keys="c" action="Cancel session" />
            <Row keys="d" action="Delete session" />
            <Row keys="+/-" action="Expand/collapse tree" />
          </Section>

          <Section title="Chat">
            <Row keys="j / k" action="Scroll up/down" />
            <Row keys="g / G" action="Top / Bottom" />
            <Row keys="e" action="Load more history" />
            <Row keys="a" action="Artifact picker" />
            <Row keys="u" action="Dump to Markdown" />
          </Section>

          <Section title="Inspector">
            <Row keys="m" action="Cycle view mode" />
            <Row keys="v" action="Markdown viewer" />
            <Row keys="[ / ]" action="Resize panels" />
          </Section>

          <Section title="Input">
            <Row keys="Enter" action="Send" />
            <Row keys="Alt+Enter" action="Newline" />
            <Row keys="Alt+←/→" action="Word jump" />
            <Row keys="/" action="Slash commands" />
          </Section>

          <Section title="Slash Commands">
            <Row keys="/models" action="List models" />
            <Row keys="/model" action="Switch model" />
            <Row keys="/info" action="Session info" />
            <Row keys="/done" action="Close session" />
            <Row keys="/new" action="New session" />
          </Section>
        </div>

        <div className="text-center mt-6 text-xs text-gray-500">
          Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-gray-300">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between">
      <kbd className="text-cyan-400 font-mono text-xs">{keys}</kbd>
      <span className="text-gray-400 text-xs">{action}</span>
    </div>
  );
}
