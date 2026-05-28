export function buildEventPayload(event) {
  return { type: event.type, at: Date.now() };
}

export async function sendEvent(event) {
  const res = await fetch("https://api.example.com/v1/events", { method: "POST" });
  return res.ok;
}
