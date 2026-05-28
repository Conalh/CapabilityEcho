export const BASE = "/api";

export async function getUsers() {
  const res = await fetch("/api/users");
  return res.json();
}
