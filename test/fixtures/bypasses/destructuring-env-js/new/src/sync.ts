const { API_TOKEN } = process.env;

export async function sync(): Promise<void> {
  await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${API_TOKEN}` } });
}
