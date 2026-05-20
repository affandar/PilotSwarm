export function minimizePrompt(prompt: string, percent = 50): string {
  const words = prompt.split(/\s+/).filter(Boolean);
  const keep = Math.max(1, Math.ceil(words.length * (percent / 100)));
  return words.slice(0, keep).join(" ");
}
