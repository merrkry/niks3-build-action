import * as core from "@actions/core";
import { HttpClient, HttpClientError } from "@actions/http-client";
import { Result } from "better-result";
import { z } from "zod/mini";
import { execa } from "execa";
import PQueue from "p-queue";
import type { TokenProvider } from "./oidc.js";

const http = new HttpClient("niks3-build-action", [], {
  socketTimeout: 30_000,
  allowRetries: false,
  allowRedirects: false,
});
const pendingPush = z.object({
  id: z.string().check(z.regex(/^\d+$/)),
  pending_objects: z.record(z.string(), z.unknown()),
});
const storePath = z
  .string()
  .check(z.regex(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+$/));

export async function fetchAudience(server: string) {
  const response = await http.getJson(
    `${server}/api/cache-config?issuer=https://token.actions.githubusercontent.com`,
  );
  return z.object({ oidc_audience: z.string().check(z.minLength(1)) }).parse(response.result)
    .oidc_audience;
}

export class Niks3 {
  constructor(
    private readonly server: string,
    private readonly nixOptions: string[],
    private readonly tokens: TokenProvider,
  ) {}

  private async post(path: string, body: unknown = null) {
    const response = await http.postJson(`${this.server}/api/${path}`, body, {
      authorization: `Bearer ${await this.tokens.get()}`,
    });
    // The toolkit returns 404 instead of throwing it.
    if (response.statusCode === 404) throw new HttpClientError("Not found", 404);
    return response.result;
  }

  private async present(paths: string[]) {
    const keys = paths.map(narinfoKey);
    const response = await this.post("objects/present", { keys });
    const { present } = z.object({ present: z.nullable(z.array(z.string())) }).parse(response);
    const found = new Set(present ?? []);
    return paths.filter((_, index) => found.has(keys[index]!));
  }

  private async copy(paths: string[]) {
    if (paths.some((path) => path.endsWith(".drv")))
      throw new Error("Expected output paths, not derivations");
    // Output paths substitute without falling back to a source build.
    await execa("nix-store", ["--realise", ...paths, ...this.nixOptions], {
      stdout: "ignore",
      stderr: "inherit",
    });
    await execa("niks3", ["push", "--server-url", this.server, "--stdin"], {
      input: paths.join("\n") + "\n",
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  private async refresh(paths: string[]) {
    const keys = paths.map(narinfoKey);
    const pending = pendingPush.parse(
      await this.post("pushes", {
        roots: keys,
        objects: keys.map((key) => ({ key, type: "narinfo", refs: [] })),
      }),
    );
    if (Object.keys(pending.pending_objects).length)
      throw new Error("Objects missing from niks3; cannot refresh without downloading");
    // Completing a push also creates roots for existing dependency objects.
    await this.post(`pushes/${pending.id}/complete`);
  }

  async sync(paths: string[], uploadCached: boolean) {
    const present: string[] = [];
    const missing: string[] = [];
    await batches("Cache lookup", paths, async (batch) => {
      const found = new Set(await this.present(batch));
      for (const path of batch) (found.has(path) ? present : missing).push(path);
    });
    core.info(
      `Remote outputs: ${present.length} awaiting TTL refresh, ` +
        `${uploadCached ? missing.length : 0} awaiting cross-cache upload, ` +
        `${uploadCached ? 0 : missing.length} skipped${uploadCached ? "" : " (upload-cached=false)"}, ` +
        `${paths.length - present.length - missing.length} lookup failures`,
    );
    await Promise.all([
      batches("TTL refresh", present, (batch) => this.refresh(batch)),
      batches("Cross-cache upload", uploadCached ? missing : [], (batch) => this.copy(batch)),
    ]);
  }
}

function narinfoKey(path: string) {
  storePath.parse(path);
  return `${path.slice("/nix/store/".length, "/nix/store/".length + 32)}.narinfo`;
}

async function batches(
  operation: string,
  paths: string[],
  action: (paths: string[]) => Promise<unknown>,
) {
  const queue = new PQueue({ concurrency: 4 });
  async function attempt(batch: string[], id: string): Promise<void> {
    const label = `${operation} batch ${id}`;
    core.info(`${label}: starting (${batch.length} outputs)`);
    core.debug(`${label} paths:\n${batch.join("\n")}`);
    const result = await Result.tryPromise(() => action(batch));
    if (result.isOk()) {
      core.info(`${label}: completed (${batch.length} outputs)`);
      return;
    }
    const cause = result.error.cause;
    const message =
      cause instanceof HttpClientError ? `HTTP ${cause.statusCode}` : result.error.message;
    // Split path-specific failures, but don't amplify auth/server failures.
    if (batch.length === 1 || (cause instanceof HttpClientError && cause.statusCode !== 409)) {
      core.setFailed(
        `${label}: failed (${batch.length} outputs): ${message}\nAffected paths:\n${batch.join("\n")}`,
      );
      return;
    }
    core.warning(`${label}: ${message}; splitting batch to isolate failing outputs`);
    const middle = Math.floor(batch.length / 2);
    await attempt(batch.slice(0, middle), `${id}.1`);
    await attempt(batch.slice(middle), `${id}.2`);
  }
  const tasks = [];
  for (let i = 0; i < paths.length; i += 128)
    tasks.push(queue.add(() => attempt(paths.slice(i, i + 128), String(i / 128 + 1))));
  await Promise.all(tasks);
}
