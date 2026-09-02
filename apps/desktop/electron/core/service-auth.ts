import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureServiceToken(stateDir: string): Promise<{
  path: string;
  token: string;
}> {
  const path = join(stateDir, "service-token");
  try {
    return { path, token: validateToken(await readFile(path, "utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { path, token: await readTokenAfterConcurrentCreate(path) };
    }
  }

  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    return { path, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { path, token: await readTokenAfterConcurrentCreate(path) };
  }
}

export async function verifyClawRouter(
  url: string,
  fetcher: typeof fetch,
  token: string,
): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString("hex");
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(1_500),
      headers: { "X-ClawRouter-Challenge": challenge },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; wallet?: unknown };
    const proof = response.headers.get("x-clawrouter-proof");
    const expected = createHmac("sha256", token).update(challenge).digest();
    const actual = proof && /^[a-f0-9]{64}$/i.test(proof) ? Buffer.from(proof, "hex") : undefined;
    return (
      body.status === "ok" &&
      typeof body.wallet === "string" &&
      actual !== undefined &&
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function validateToken(raw: string): string {
  const token = raw.trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error("Desktop service token has an invalid format.");
  }
  return token;
}

async function readTokenAfterConcurrentCreate(path: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return validateToken(await readFile(path, "utf8"));
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Desktop service token could not be read.");
}
