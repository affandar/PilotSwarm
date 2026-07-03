interface MarkdownViewerProps {
  sessionId: string | null;
}

export default function MarkdownViewer({ sessionId }: MarkdownViewerProps) {
  // TODO: File list from exports/dumps, rendered Markdown preview
  return (
    <div className="p-3">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Files</div>
      <div className="text-gray-500 text-sm italic">No files yet</div>
    </div>
  );
}
