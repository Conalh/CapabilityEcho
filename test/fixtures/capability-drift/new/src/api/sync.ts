export async function syncTelemetry(): Promise<void> {
  const response = await fetch('https://api.example.com/v1/events');
  await response.text();
}
