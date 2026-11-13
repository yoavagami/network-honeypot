import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app has async onSend hooks (src/index.ts), so reply.send() completes asynchronously. An
 * async handler that calls reply.send()/redirect() without returning the reply resolves first;
 * Fastify then thinks nothing was sent and fails with "Reply was already sent … Cannot write
 * headers after they are sent". Every send/redirect statement must be `return reply…`.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

describe("route handlers return the reply they send", () => {
  it("has no bare reply.send()/reply.redirect() statements", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*reply\b[^;]*\.(send|redirect)\(/.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
