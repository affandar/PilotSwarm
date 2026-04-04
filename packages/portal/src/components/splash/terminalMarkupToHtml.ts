/**
 * Convert terminal-style color tags to HTML <span> elements with CSS classes.
 *
 * Markup tags:  {cyan-fg}text{/cyan-fg}  {bold}text{/bold}
 * Output:       <span class="splash-cyan">text</span>  <span class="splash-bold">text</span>
 *
 * This allows the same splash content to be shared between the terminal UI
 * and the web portal.
 */

const TAG_MAP: Record<string, string> = {
  "cyan-fg": "splash-cyan",
  "magenta-fg": "splash-magenta",
  "yellow-fg": "splash-yellow",
  "green-fg": "splash-green",
  "red-fg": "splash-red",
  "blue-fg": "splash-blue",
  "white-fg": "splash-white",
  "gray-fg": "splash-gray",
  bold: "splash-bold",
};

/**
 * Convert tagged terminal markup to HTML with CSS classes.
 * Handles nested tags. Unknown tags are stripped.
 */
export function terminalMarkupToHtml(input: string): string {
  let html = input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/\{([a-z-]+)\}/g, (_match, tag: string) => {
    const cls = TAG_MAP[tag];
    return cls ? `<span class="${cls}">` : "";
  });

  html = html.replace(/\{\/([a-z-]+)\}/g, (_match, tag: string) => {
    const cls = TAG_MAP[tag];
    return cls ? "</span>" : "";
  });

  return html;
}
