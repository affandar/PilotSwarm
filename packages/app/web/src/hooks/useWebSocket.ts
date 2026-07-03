import { useState, useEffect, useRef, useCallback } from "react";
import type { WSMessage } from "../lib/api";

/**
 * Manages the WebSocket connection to the portal server.
 */
export function useWebSocket(url = `ws://${location.host}/ws`) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data);
        const handlers = listenersRef.current.get(msg.type);
        handlers?.forEach((fn) => fn(msg.data));
      } catch {
        // ignore malformed messages
      }
    };

    return () => {
      ws.close();
    };
  }, [url]);

  const send = useCallback((msg: WSMessage) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const on = useCallback((type: string, handler: (data: unknown) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(handler);
    return () => {
      listenersRef.current.get(type)?.delete(handler);
    };
  }, []);

  return { connected, send, on };
}
