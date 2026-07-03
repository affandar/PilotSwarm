/**
 * Hook for managing the session list (all sessions, tree hierarchy).
 *
 * TODO: Integrate with useWebSocket to receive live session list updates
 * from PilotSwarmManagementClient.listSessions().
 */
export function useSessions() {
  // TODO: Fetch session list from server
  // TODO: Handle create, rename, cancel, delete operations

  return {
    sessions: [] as {
      id: string;
      title: string;
      status: string;
      parentId?: string;
      agentId?: string;
      isSystem?: boolean;
    }[],
    createSession: (_agentId?: string, _model?: string) => {},
    renameSession: (_id: string, _title: string) => {},
    cancelSession: (_id: string) => {},
    deleteSession: (_id: string) => {},
  };
}
