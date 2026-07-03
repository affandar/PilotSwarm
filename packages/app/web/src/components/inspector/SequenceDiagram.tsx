interface SequenceDiagramProps {
  sessionId: string | null;
}

export default function SequenceDiagram({ sessionId }: SequenceDiagramProps) {
  // TODO: SVG swimlane rendering from orchestration events
  return (
    <div className="p-3 flex items-center justify-center h-full">
      {!sessionId ? (
        <div className="text-gray-500 text-sm italic">No active session</div>
      ) : (
        <div className="text-gray-500 text-sm italic">
          Sequence diagram for {sessionId.slice(0, 8)}
        </div>
      )}
    </div>
  );
}
