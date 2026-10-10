/**
 * Scaffold a demo project for testing ABSENCE v0.2.
 *
 *   node scripts/make-demo.mjs [targetDir] [--force]
 *
 * The generated project is deliberately shaped so that ordinary prompts
 * exercise every ABSENCE panel: file reads with line ranges, searches, repeated
 * edits to one file (File History / Replay), a runnable test script
 * (Terminal) and a TODO.md (Plan).
 */
import fs from "node:fs/promises";
import path from "node:path";

const target = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "E:/0down/absence-demo");
const force = process.argv.includes("--force");

const files = {
  "package.json": `{
  "name": "absence-demo",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/auth.test.ts"
  }
}
`,

  "README.md": `# absence-demo

A small project used to test ABSENCE. Nothing here is important — it exists so the
agent has something realistic to read, search, edit and run.

- \`src/auth.ts\` holds the interesting logic (token refresh).
- \`src/api.ts\` calls into auth.
- \`TODO.md\` is what ABSENCE shows in the Plan panel.
`,

  "TODO.md": `# absence-demo TODO

- [x] create the project
- [x] add the auth module
- [ ] give refreshToken a retry
- [ ] document the api module
- [ ] tighten the token expiry check
`,

  "src/auth.ts": `import { request } from "./api.ts";

const TOKEN_TTL_MS = 15 * 60 * 1000;

let cachedToken: string | null = null;
let cachedAt = 0;

export interface Session {
  token: string;
  expiresAt: number;
}

export function getToken(): string | null {
  if (!cachedToken) return null;
  const age = Date.now() - cachedAt;
  if (age > TOKEN_TTL_MS) return null;
  return cachedToken;
}

export function isExpired(session: Session): boolean {
  return session.expiresAt <= Date.now();
}

export async function login(user: string, password: string): Promise<Session> {
  const body = { user, password };
  const result = await request("/login", body);
  cachedToken = result.token;
  cachedAt = Date.now();
  return { token: result.token, expiresAt: Date.now() + TOKEN_TTL_MS };
}

export async function refreshToken(session: Session): Promise<Session> {
  const result = await request("/refresh", { token: session.token });
  cachedToken = result.token;
  cachedAt = Date.now();
  return { token: result.token, expiresAt: Date.now() + TOKEN_TTL_MS };
}

export async function call(path: string, payload: unknown): Promise<unknown> {
  const session = getToken();
  if (!session) {
    throw new Error("not logged in");
  }
  return request(path, payload, session);
}
`,

  "src/api.ts": `export interface ApiResponse {
  token: string;
  [key: string]: unknown;
}

const BASE_URL = "https://example.invalid";

export async function request(
  path: string,
  body: unknown,
  token?: string,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;

  const response = await fetch(BASE_URL + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("request failed: " + response.status);
  }

  return (await response.json()) as ApiResponse;
}
`,

  "src/utils.ts": `export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`,

  "src/middleware.ts": `import { getToken } from "./auth.ts";

export function requireAuth(headers: Record<string, string>): void {
  const token = getToken();
  if (!token) {
    throw new Error("unauthorized");
  }
  headers.authorization = "Bearer " + token;
}

export function logRequest(path: string): void {
  console.log("[request]", path);
}
`,

  "tests/auth.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpired } from "../src/auth.ts";

test("isExpired is true for a past timestamp", () => {
  assert.equal(isExpired({ token: "t", expiresAt: Date.now() - 1000 }), true);
});

test("isExpired is false for a future timestamp", () => {
  assert.equal(isExpired({ token: "t", expiresAt: Date.now() + 1000 }), false);
});
`,

  "notes.txt": `scratch notes

- used to test file deletion vs. truncation
- emptying this file should show EMPTIED in ABSENCE, not a delete
`,
};

let written = 0;
let skipped = 0;

for (const [relative, content] of Object.entries(files)) {
  const full = path.join(target, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (!force) {
    try {
      await fs.access(full);
      skipped += 1;
      continue;
    } catch {
      // does not exist yet
    }
  }
  await fs.writeFile(full, content, "utf-8");
  written += 1;
}

console.log(`demo project: ${target}`);
console.log(`  written: ${written}, skipped (already existed): ${skipped}`);
if (skipped > 0 && !force) console.log("  pass --force to overwrite existing files");
console.log("");
console.log("Open it in ABSENCE with this path:");
console.log(`  ${target.replace(/\\/g, "/")}`);
