const MAX_CHUNK = 4000;
// Cap on how much of a failed-send response body we echo in the thrown error.
const MAX_ERROR_BODY = 200;

export async function sendTelegramMessage(token: string, chatId: number | string, text: string): Promise<void> {
  // The token lives in this URL, so it must never appear in a thrown error.
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' })
    });
    if (res.ok) continue;
    // Fallback: retry without parse_mode in case HTML tags are malformed.
    const fallback = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk })
    });
    if (!fallback.ok) {
      // Both attempts failed. Throw so the caller's delivery machinery (retry /
      // attempts / quarantine) can act instead of treating this as delivered.
      // Include only the status and a truncated body — NEVER the URL, which
      // carries the bot token.
      const body = (await fallback.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      throw new Error(`Telegram sendMessage failed: HTTP ${fallback.status}${body ? ` — ${body}` : ''}`);
    }
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK) {
    let cutAt = remaining.lastIndexOf('\n', MAX_CHUNK);
    if (cutAt < MAX_CHUNK / 2) cutAt = MAX_CHUNK;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
