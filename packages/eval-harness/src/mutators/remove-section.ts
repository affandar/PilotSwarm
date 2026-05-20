export function removeSection(prompt: string, heading: string): string {
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading.trim());
  if (start < 0) return prompt;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
}
