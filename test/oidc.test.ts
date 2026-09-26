import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenProvider } from "../src/oidc.js";

const auth = vi.hoisted(() => ({ getIDToken: vi.fn(), setFailed: vi.fn() }));
vi.mock("@actions/core", () => auth);

test("one OIDC owner shares requests and rotates the CLI file before its cached token expires", async (t) => {
  vi.useFakeTimers();
  const directory = await mkdtemp(join(tmpdir(), "niks3-oidc-test-"));
  const file = join(directory, "token");
  const tokens = new TokenProvider("audience", file);
  t.onTestFinished(async () => {
    await tokens.stop();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });
  auth.getIDToken.mockImplementation(
    async () =>
      `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.signature`,
  );
  await Promise.all([tokens.start(), tokens.get(), tokens.get()]);
  assert.equal(auth.getIDToken.mock.calls.length, 1);
  const before = await readFile(file, "utf8");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // No API/CLI demand is needed to refresh: a long-running upload can just
  // re-read the file, including its own one-minute file cache delay.
  await vi.advanceTimersByTimeAsync(180_000);
  assert.equal(auth.getIDToken.mock.calls.length, 2);
  const api = await tokens.get();
  const after = await readFile(file, "utf8");
  assert.notEqual(before, after);
  assert.equal(api, after);

  auth.getIDToken.mockRejectedValueOnce(new Error("OIDC unavailable"));
  await vi.advanceTimersByTimeAsync(180_000);
  assert.equal(auth.setFailed.mock.calls.length, 1);
  assert.equal(await readFile(file, "utf8"), after, "failed refresh preserves the last token");
  await vi.advanceTimersByTimeAsync(30_000);
  await tokens.stop();
  assert.notEqual(await readFile(file, "utf8"), after, "refresh resumes after a transient error");
});
