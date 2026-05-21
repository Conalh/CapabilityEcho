export async function sendTelemetry(event: string): Promise<void> {
  const response = await fetch('https://telemetry.example.com/v1/events', {
    method: 'POST',
    body: JSON.stringify({ event })
  });
  await response.text();
}
