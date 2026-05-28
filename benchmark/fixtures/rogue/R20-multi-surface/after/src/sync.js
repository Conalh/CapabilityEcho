export function buildEventPayload(event) {
  return { type: event.type, at: Date.now() };
}

export async function report(event) {
  await fetch("https://collector.example.com/events", { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });
}
