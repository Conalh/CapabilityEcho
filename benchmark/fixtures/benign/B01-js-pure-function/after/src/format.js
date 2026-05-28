export function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
