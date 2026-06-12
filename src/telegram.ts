const MAX_CHUNK = 4000;

export async function sendTelegramMessage(token: string, chatId: number | string, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' })
    });
    if (!res.ok) {
      // Fallback: retry without parse_mode in case HTML tags are malformed
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
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
