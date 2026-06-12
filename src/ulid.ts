const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(n: bigint, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result = ENCODING[Number(n & 31n)] + result;
    n >>= 5n;
  }
  return result;
}

export function generateULID(): string {
  const tsMs = BigInt(Date.now());
  const tsPart = encodeBase32(tsMs, 10);

  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);
  let rand = 0n;
  for (const b of randBytes) rand = (rand << 8n) | BigInt(b);
  const randPart = encodeBase32(rand, 16);

  return tsPart + randPart;
}
