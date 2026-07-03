/**
 * Hook for managing active session state and event subscriptions.
 *
 * TODO: Integrate with useWebSocket to receive real-time session events
 * (messages, tool calls, status changes, turn completions).
 */
export function useSession(sessionId: string | null) {
  // TODO: Subscribe to session events via WebSocket
  // TODO: Maintain messages array, thinking state, tool calls

  return {
    messages: [] as { role: "user" | "assistant"; content: string; timestamp: string }[],
    isThinking: false,
    toolCalls: [] as { name: string; args: string; result?: string; durationMs?: number }[],
  };
}
