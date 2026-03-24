/**
 * WebSocket message protocol types.
 *
 * These define the message format between the browser client and the
 * portal server. Both sides serialize/deserialize using JSON.
 */

export interface WSMessage {
  type: string;
  data?: unknown;
}

// ── Client → Server messages ──────────────────────────────────

export interface CreateSessionMessage extends WSMessage {
  type: "createSession";
  data: { agentId?: string; model?: string };
}

export interface SendMessage extends WSMessage {
  type: "send";
  data: { sessionId: string; message: string };
}

export interface RenameSessionMessage extends WSMessage {
  type: "renameSession";
  data: { sessionId: string; title: string };
}

export interface CancelSessionMessage extends WSMessage {
  type: "cancelSession";
  data: { sessionId: string };
}

export interface DeleteSessionMessage extends WSMessage {
  type: "deleteSession";
  data: { sessionId: string };
}

export interface ListSessionsMessage extends WSMessage {
  type: "listSessions";
}

export interface ListModelsMessage extends WSMessage {
  type: "listModels";
}

// ── Server → Client messages ──────────────────────────────────

export interface SessionCreatedEvent extends WSMessage {
  type: "sessionCreated";
  data: { sessionId: string };
}

export interface MessageEvent extends WSMessage {
  type: "message";
  data: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  };
}

export interface ToolCallEvent extends WSMessage {
  type: "toolCall";
  data: {
    sessionId: string;
    name: string;
    args: string;
    status: "started" | "completed" | "failed";
    result?: string;
    durationMs?: number;
  };
}

export interface StatusUpdateEvent extends WSMessage {
  type: "statusUpdate";
  data: {
    sessionId: string;
    status: string;
  };
}

export interface SessionListEvent extends WSMessage {
  type: "sessionList";
  data: {
    sessions: {
      id: string;
      title: string;
      status: string;
      parentId?: string;
      agentId?: string;
      isSystem?: boolean;
      model?: string;
    }[];
  };
}

export interface ErrorEvent extends WSMessage {
  type: "error";
  data: { message: string };
}
