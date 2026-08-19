import { useEffect, useRef, useState } from "react";
import { API_BASE, type EventRow } from "../api.js";

/** Live event stream via SSE — see docs/ARCHITECTURE.md (SSE chosen over WebSockets). */
export function useLiveEvents(maxItems = 200) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/stream`, { withCredentials: true });
    sourceRef.current = source;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("honeypot_event", (e) => {
      try {
        const row = JSON.parse((e as MessageEvent).data) as EventRow;
        setEvents((prev) => [row, ...prev].slice(0, maxItems));
      } catch {
        /* ignore malformed frame */
      }
    });
    return () => source.close();
  }, [maxItems]);

  return { events, connected };
}
