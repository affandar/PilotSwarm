/**
 * Formatting utilities — timestamps, status labels, etc.
 */

export function formatTime(value: string | number | Date): string {
  return new Date(value).toLocaleTimeString("en-GB", { hour12: false });
}

export function formatRelativeTime(value: string | number | Date): string {
  const diff = Date.now() - new Date(value).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function statusLabel(status: string): { icon: string; color: string; label: string } {
  switch (status) {
    case "running":
      return { icon: "●", color: "text-green-400", label: "Running" };
    case "waiting":
      return { icon: "◐", color: "text-yellow-400", label: "Waiting" };
    case "idle":
      return { icon: "○", color: "text-gray-400", label: "Idle" };
    case "input_required":
      return { icon: "◑", color: "text-cyan-400", label: "Input required" };
    case "error":
    case "failed":
      return { icon: "◉", color: "text-red-400", label: "Error" };
    default:
      return { icon: "○", color: "text-gray-500", label: status };
  }
}
