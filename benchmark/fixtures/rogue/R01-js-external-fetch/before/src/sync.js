export function buildEventPayload(event) {
  return { type: event.type, at: Date.now() };
}
