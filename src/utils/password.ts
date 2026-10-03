import crypto from "crypto";

const ITERATIONS = 120000;
const KEYLEN = 64;
const DIGEST = "sha512";
export class PasswordProcessingBusy extends Error {
  readonly status = 503;
  constructor() { super("Password processing busy; try again later"); }
}

// Keep CPU work off the API event loop and reserve libuv capacity for I/O.
let active = 0;
const waiting: Array<() => void> = [];
async function derive(password: string, salt: string, iterations: number): Promise<Buffer> {
  if (active >= 2) {
    if (waiting.length >= 32) throw new PasswordProcessingBusy();
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(password, salt, iterations, KEYLEN, DIGEST, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await derive(password, salt, ITERATIONS)).toString("hex");
  return `${salt}:${ITERATIONS}:${derived}`;
}

// Password Verifier
export async function verifyPassword(password: string, stored: string) {
  if (stored.split(":").length !== 3) return false;
  const [salt, iterStr, hash] = stored.split(":");
  if (!/^[a-f0-9]{32}$/i.test(salt ?? "") || !/^[0-9]+$/.test(iterStr ?? "") || !/^[a-f0-9]{128}$/i.test(hash ?? "")) return false;
  const iters = Number(iterStr);
  if (!Number.isSafeInteger(iters) || iters < 1 || iters > 1_000_000) return false;
  const derived = await derive(password, salt, iters);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), derived);
}
