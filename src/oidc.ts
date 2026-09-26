import * as core from "@actions/core";
import { Result } from "better-result";
import { jwtDecode } from "jwt-decode";
import { writeFile, rename } from "node:fs/promises";

// One writer owns authentication for the entire build. The CLI re-reads this
// file at most once a minute, so rotate well before the previous token expires.
export class TokenProvider {
  private token = "";
  private refreshAt = 0;
  private pending?: Promise<string>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly audience: string,
    private readonly file: string,
  ) {}

  get(): Promise<string> {
    if (this.pending) return this.pending;
    if (Date.now() < this.refreshAt) return Promise.resolve(this.token);
    this.pending = (async () => {
      const token = await core.getIDToken(this.audience);
      const { exp } = jwtDecode(token);
      const lifetime = (exp ?? 0) * 1000 - Date.now();
      if (!Number.isFinite(lifetime) || lifetime <= 0)
        throw new Error("GitHub returned an expired token or no expiration");
      await writeFile(`${this.file}.tmp`, token, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.token = token;
      this.refreshAt = Date.now() + Math.max(lifetime / 2, lifetime - 120_000);
      return token;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async start() {
    await this.get();
    this.timer = setInterval(() => {
      void Result.tryPromise(() => this.get()).then((result) => {
        if (result.isErr()) core.setFailed(result.error);
      });
    }, 30_000);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    await this.pending;
  }
}
