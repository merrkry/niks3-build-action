import { test, vi, type TestContext } from "vitest";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { execa } from "execa";
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import versions from "../versions.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const storePath = (letter: string) => `/nix/store/${letter.repeat(32)}-package`;

const execute = (script: string, env: NodeJS.ProcessEnv) =>
  execa(process.execPath, [script], { cwd: root, env, reject: false });

async function environment(
  t: TestContext,
  {
    missing = [],
    absent = [],
    reject = [],
    collected = [],
    oidc = true,
    pathTools = false,
  }: {
    missing?: string[];
    absent?: string[];
    reject?: string[];
    collected?: string[];
    oidc?: boolean;
    pathTools?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "niks3-action-test-"));
  const bundle = join(directory, "dist");
  await cp(join(root, "dist"), bundle, { recursive: true });
  const bin = join(directory, "bin");
  await mkdir(bin);
  const completed: string[] = [];
  const created: { roots: string[]; objects: unknown[] }[] = [];
  const tokens: string[] = [];
  const queries: string[][] = [];
  const concurrency = { active: 0, peak: 0 };
  const server = Fastify();
  t.onTestFinished(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  server.get<{ Querystring: { audience: string } }>("/oidc", async (request) => {
    assert.equal(request.headers.authorization, "Bearer request-secret");
    assert.equal(request.query.audience, "test-audience");
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sequence: tokens.length })).toString("base64url")}.signature`;
    tokens.push(token);
    return { value: token };
  });
  server.get<{ Querystring: { issuer: string } }>("/api/cache-config", async (request) => {
    assert.equal(request.query.issuer, "https://token.actions.githubusercontent.com");
    return {
      oidc_audience: "test-audience",
    };
  });
  server.post<{ Body: { keys: string[] } }>("/api/objects/present", async (request) => {
    queries.push(request.body.keys);
    concurrency.active++;
    concurrency.peak = Math.max(concurrency.peak, concurrency.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    concurrency.active--;
    return { present: request.body.keys.filter((key) => !absent.includes(key[0]!)) };
  });
  server.addHook("preHandler", async (request) => {
    if (request.method === "POST") {
      assert.ok(tokens.includes(request.headers.authorization?.slice(7) ?? ""));
    }
  });
  server.post<{ Body: (typeof created)[number] }>("/api/pushes", async (request, reply) => {
    const data = request.body;
    created.push(data);
    assert.ok(data.roots.length > 0);
    assert.deepEqual(
      data.objects,
      data.roots.map((key) => ({ key, type: "narinfo", refs: [] })),
    );
    if (data.roots.some((key) => reject.includes(key[0]!))) return reply.code(503).send({});
    return {
      id: String(created.length),
      pending_objects: Object.fromEntries(
        data.roots
          .filter((key) => missing.includes(key[0]!))
          .map((key) => [key, { type: "narinfo" }]),
      ),
    };
  });
  server.post<{ Params: { id: string } }>("/api/pushes/:id/complete", async (request, reply) => {
    const keys = created[Number(request.params.id) - 1]!.roots;
    if (keys.some((key) => collected.includes(key[0]!))) return reply.code(409).send({});
    completed.push(...keys);
    await writeFile(join(directory, "refreshed"), "done");
    return reply.code(204).send();
  });
  const base = await server.listen({ port: 0, host: "127.0.0.1" });
  const env: Record<string, string> = {
    RUNNER_TEMP: directory,
    PATH: bin,
    ACTIONS_ID_TOKEN_REQUEST_URL: oidc ? `${base}/oidc?api-version=2.0` : "",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc ? "request-secret" : "",
    "INPUT_SERVER-URL": base,
    INPUT_FLAKE: ".#buildJobs.x86_64-linux",
    "INPUT_ACCEPT-FLAKE-CONFIG": "false",
    "INPUT_UPLOAD-CACHED": "true",
    NIX_CONFIG:
      "experimental-features = nix-command flakes\nextra-substituters = https://existing.example",
  };
  env.GITHUB_STATE = join(directory, "state");
  await writeFile(env.GITHUB_STATE, "");
  const realBinary = join(directory, "real-niks3");
  await writeFile(
    realBinary,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const token = readFileSync(process.env.NIKS3_AUTH_TOKEN_FILE, 'utf8');
const paths = args.includes('--stdin') ? readFileSync(0, 'utf8').trim().split('\\n') : args.filter(arg => arg.startsWith('/nix/store/'));
appendFileSync(process.env.PUSH_LOG, JSON.stringify({ args, token, paths, config: process.env.NIX_CONFIG }) + '\\n');
if (args.includes('--stdin')) {
  for (const path of paths) {
    if (path === process.env.MISSING_UPLOAD) continue;
    if (process.env.INVALID_UPLOAD) { console.log('invalid JSON'); break; }
    console.log(JSON.stringify({
      path,
      status: path === process.env.FAIL_UPLOAD ? 'error' : 'ok',
      ...(path === process.env.FAIL_UPLOAD ? { message: 'server returned 503: unavailable' } : {}),
      ...(path === process.env.SKIP_UPLOAD ? { skipped: 'max-nar-size', message: 'dependency exceeds server limit' } : {}),
    }));
  }
  if (process.env.UPLOAD_EXIT) process.exitCode = Number(process.env.UPLOAD_EXIT);
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "nix"),
    `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'flake' || args[0] === 'eval') {
  appendFileSync(process.env.FLAKE_LOG, JSON.stringify(args) + '\\n');
  if (process.env.FAIL_CONFIG) process.exit(1);
  if (args[0] === 'eval') assert.equal(process.env.NIKS3_FLAKE_REF, 'path:/resolved/flake');
  console.log(args[0] === 'flake' ? JSON.stringify({ url: 'path:/resolved/flake' }) : process.env.TEST_FLAKE_CONFIG);
  process.exit(0);
}
const tools = {
  ${JSON.stringify(`github:Mic92/niks3/v${versions.niks3}#niks3`)}: ${JSON.stringify(realBinary)},
  ${JSON.stringify(`github:NixOS/nixpkgs/${versions.nixpkgs}#nix-fast-build`)}: ${JSON.stringify(join(directory, "nix-fast-build"))},
};
assert.equal(args[0], 'run');
assert.equal(args[2], '--');
assert.ok(tools[args[1]], 'unexpected flake');
process.execve(process.execPath, [process.execPath, tools[args[1]], ...args.slice(3)], process.env);
`,
    { mode: 0o755 },
  );
  if (pathTools) {
    await symlink(realBinary, join(bin, "niks3"));
    await symlink(join(directory, "nix-fast-build"), join(bin, "nix-fast-build"));
    // Any fallback to Nix would fail, proving PATH binaries take precedence.
    await writeFile(join(bin, "nix"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  }
  await writeFile(
    join(bin, "nix-store"),
    `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const args = process.argv.slice(2);
assert.equal(args[0], '--realise');
while (process.env.WAIT_FOR_REFRESH && !existsSync(process.env.WAIT_FOR_REFRESH)) await setTimeout(10);
const options = args.indexOf('--option');
const paths = args.slice(1, options < 0 ? undefined : options);
assert.ok(paths.every(path => !path.endsWith('.drv')));
if (process.env.EXPECT_CONFIG_LINE) assert.ok(process.env.NIX_CONFIG.includes(process.env.EXPECT_CONFIG_LINE));
if (process.env.EXPECT_NIX_OPTIONS) assert.deepEqual(args.slice(options), JSON.parse(process.env.EXPECT_NIX_OPTIONS));
appendFileSync(process.env.COPY_LOG, paths.join('\\n') + '\\n');
if (paths.includes(process.env.FAIL_DOWNLOAD)) process.exit(1);
`,
    { mode: 0o755 },
  );
  env.CONFIG_LOG = join(directory, "config");
  env.FLAKE_LOG = join(directory, "flake");
  env.COPY_LOG = join(directory, "copies");
  env.PUSH_LOG = join(directory, "pushes");
  return { directory, bundle, env, created, completed, tokens, queries, concurrency };
}

async function builder(
  context: Awaited<ReturnType<typeof environment>>,
  events: ReturnType<typeof event>[],
  exitCode = 0,
) {
  const filename = join(context.directory, "nix-fast-build");
  await writeFile(
    filename,
    `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.CONFIG_LOG, process.env.NIX_CONFIG);
for (const event of ${JSON.stringify(events)}) {
  console.log(JSON.stringify(event));
  // Stand in for nix-fast-build's native uploader at its external CLI boundary.
  if (event.success && (event.type === 'BUILD' || event.cacheStatus === 'local') && process.argv.includes('--niks3-server')) {
    const pushed = spawnSync('niks3', ['push', ...Object.values(event.outputs)], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (pushed.status !== 0) process.exit(90);
  }
}
process.exitCode = ${exitCode};
`,
    { mode: 0o755 },
  );
  context.env.ARGS_LOG = join(context.directory, "args");
}

const event = (type: string, letter: string, success = true, cacheStatus?: string) => ({
  type,
  attr: letter,
  success,
  cacheStatus,
  outputs: { out: storePath(letter) },
});

test.for([false, true])(
  "upload and retain successful outputs despite build failure (PATH tools: %s)",
  async (pathTools, t) => {
    const context = await environment(t, { pathTools });
    await builder(
      context,
      [
        event("EVAL", "a", true, "local"),
        event("BUILD", "b", false),
        event("BUILD", "c"),
        event("EVAL", "d", true, "cached"),
        event("EVAL", "d", true, "cached"),
      ],
      7,
    );
    const result = await execute(join(context.bundle, "build.mjs"), context.env);
    assert.equal(result.exitCode, 7, result.stderr);
    const pushes = (await readFile(context.env.PUSH_LOG!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; token: string; paths: string[] });
    assert.deepEqual(
      pushes.map((push) => push.args.at(-1)),
      [storePath("a"), storePath("c")],
    );
    assert.equal(pushes[0]!.token, pushes[1]!.token);
    assert.deepEqual(context.completed, [`${"d".repeat(32)}.narinfo`]);
    assert.equal(context.tokens.length, 1, "CLI and batch API share one token");
    assert.equal(context.created.length, 1, "only skipped remote roots need an extra push");
    const args = JSON.parse(await readFile(context.env.ARGS_LOG!, "utf8"));
    assert.ok(args.includes("--skip-cached"));
    assert.ok(args.includes("--niks3-server"));
    const work = (await readFile(context.env.GITHUB_STATE!, "utf8")).split("\n")[1]!;
    const cleanup = await execute(join(context.bundle, "cleanup.mjs"), { STATE_work: work });
    assert.equal(cleanup.exitCode, 0);
    await assert.rejects(readFile(join(work, "token")), { code: "ENOENT" });
  },
);

test("missing remote objects and HTTP failures never commit and do not block later roots", async (t) => {
  const context = await environment(t, { missing: ["a"], collected: ["b", "c"] });
  await builder(
    context,
    ["a", "b", "c", "d"].map((letter) => event("EVAL", letter, true, "cached")),
  );
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout + result.stderr, /cannot refresh without downloading/);
  assert.match(result.stdout + result.stderr, /HTTP 409/);
  const failures = result.stdout.split("\n").filter((line) => line.startsWith("::error::"));
  for (const letter of ["a", "b", "c"]) {
    assert.ok(
      failures.some(
        (line) => line.includes("TTL refresh batch") && line.includes(storePath(letter)),
      ),
      `TTL failure must identify ${storePath(letter)}`,
    );
  }
  assert.doesNotMatch(result.stdout, /TTL refresh batch 1: completed/);
  assert.deepEqual(context.completed, [`${"d".repeat(32)}.narinfo`]);
});

test("fork jobs without OIDC still build with the substituter and perform no writes", async (t) => {
  const context = await environment(t, { oidc: false });
  await builder(context, [event("BUILD", "a"), event("EVAL", "b", true, "cached")]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(context.created, []);
  assert.deepEqual(context.tokens, []);
  assert.match(result.stdout, /OIDC unavailable; skipping uploads and TTL refresh/);
  await assert.rejects(readFile(context.env.PUSH_LOG!), { code: "ENOENT" });
});

test("forwards quoted multiline arguments without shell expansion", async (t) => {
  const context = await environment(t);
  await builder(context, []);
  const args = [
    "--eval-workers",
    "4",
    "--fail-fast",
    "--option",
    "message",
    "spaces and $(shell syntax)",
    "--option",
    "empty",
    "",
    "--option",
    "label",
    "--skip-cached",
  ];
  context.env.INPUT_FLAKE = "./project#checks.x86_64-linux";
  context.env.INPUT_ARGS = [
    "--eval-workers 4",
    "--fail-fast",
    '--option message "spaces and $(shell syntax)"',
    '--option empty ""',
    '--option label "--skip-cached"',
  ].join("\n");
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(await readFile(context.env.ARGS_LOG!, "utf8")), [
    "--flake",
    "./project#checks.x86_64-linux",
    ...args,
    "--skip-cached",
    "--stream-json-lines",
    "--no-nom",
    "--niks3-server",
    context.env["INPUT_SERVER-URL"],
  ]);
});

test.for(["--flake=.#other", "--option accept-flake-config false", "--nom"])(
  "rejects managed args: %s",
  async (args, t) => {
    const context = await environment(t);
    await builder(context, []);
    context.env.INPUT_ARGS = args;
    const result = await execute(join(context.bundle, "build.mjs"), context.env);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout + result.stderr, /The action manages/);
    await assert.rejects(readFile(context.env.ARGS_LOG!), { code: "ENOENT" });
  },
);

test("a missing Nix command reports failure without hanging or an unhandled rejection", async (t) => {
  const context = await environment(t);
  context.env.PATH = context.directory;
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout + result.stderr, /ENOENT/);
});

test("cancelling the action terminates its build subprocess", async (t) => {
  const context = await environment(t);
  const stopped = join(context.directory, "stopped");
  await writeFile(
    join(context.directory, "nix-fast-build"),
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(stopped)}, 'stopped');
  process.exit(0);
});
console.log(JSON.stringify({ type: 'EVAL', attr: 'waiting', success: true }));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const child = execa(process.execPath, [join(context.bundle, "build.mjs")], {
    env: context.env,
    reject: false,
  });
  t.onTestFinished(() => {
    child.kill();
  });
  for await (const line of child) {
    if (line.includes("EVAL waiting: ok")) child.kill("SIGTERM");
  }
  assert.equal((await child).signal, "SIGTERM");
  await vi.waitFor(async () => assert.equal(await readFile(stopped, "utf8"), "stopped"));
});

test("upload-cached=false skips missing objects while retaining target-cache hits", async (t) => {
  const context = await environment(t, { absent: ["b"] });
  context.env["INPUT_UPLOAD-CACHED"] = "false";
  await builder(context, [event("EVAL", "a", true, "cached"), event("EVAL", "b", true, "cached")]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.deepEqual(context.completed, [`${"a".repeat(32)}.narinfo`]);
  assert.match(result.stdout, /1 awaiting TTL refresh, 0 awaiting cross-cache upload, 1 skipped/);
  await assert.rejects(readFile(context.env.COPY_LOG!), { code: "ENOENT" });
  await assert.rejects(readFile(context.env.PUSH_LOG!), { code: "ENOENT" });
});

test("failed downloads do not prevent later copies and refreshes", async (t) => {
  const context = await environment(t, { absent: ["a", "c"] });
  context.env.FAIL_DOWNLOAD = storePath("a");
  context.env.INPUT_ARGS =
    '--option extra-substituters "https://other.example https://second.example"';
  context.env.EXPECT_NIX_OPTIONS = JSON.stringify([
    "--option",
    "extra-substituters",
    "https://other.example https://second.example",
  ]);
  await builder(
    context,
    ["a", "c", "d"].map((letter) => event("EVAL", letter, true, "cached")),
  );
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    new Set((await readFile(context.env.COPY_LOG!, "utf8")).trim().split("\n")),
    new Set([storePath("a"), storePath("c")]),
  );
  const push = JSON.parse((await readFile(context.env.PUSH_LOG!, "utf8")).trim());
  assert.deepEqual(push.paths, [storePath("c")]);
  assert.deepEqual(context.completed, [`${"d".repeat(32)}.narinfo`]);
});

test("hundreds of cached outputs use bounded concurrent batch requests and one OIDC token", async (t) => {
  const context = await environment(t);
  const alphabet = "0123456789abcdfghijklmnpqrsvwxyz";
  const events = Array.from({ length: 513 }, (_, index) => ({
    ...event("EVAL", "a", true, "cached"),
    attr: String(index),
    outputs: {
      out: `/nix/store/${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}${"a".repeat(30)}-package`,
    },
  }));
  await builder(context, [...events, ...events]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(context.queries.length, 5);
  assert.equal(context.created.length, 5);
  assert.equal(new Set(context.completed).size, 513);
  assert.ok(context.queries.every((keys) => keys.length <= 128));
  assert.ok(context.created.every((push) => push.roots.length <= 128));
  assert.ok(context.concurrency.peak > 1 && context.concurrency.peak <= 4);
  assert.equal(context.tokens.length, 1);
});

test("remote copies share one CLI push and cannot block TTL refresh", async (t) => {
  const context = await environment(t, { absent: ["b", "c"] });
  context.env.WAIT_FOR_REFRESH = join(context.directory, "refreshed");
  await builder(
    context,
    ["a", "b", "c"].map((letter) => event("EVAL", letter, true, "cached")),
  );
  const result = await execa(process.execPath, [join(context.bundle, "build.mjs")], {
    env: context.env,
    reject: false,
    timeout: 5000,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const push = JSON.parse((await readFile(context.env.PUSH_LOG!, "utf8")).trim());
  assert.deepEqual(push.paths, [storePath("b"), storePath("c")]);
  assert.match(result.stdout, /1 awaiting TTL refresh, 2 awaiting cross-cache upload/);
  assert.match(result.stdout, /TTL refresh batch 1: completed \(1 outputs\)/);
  assert.match(result.stdout, /Cross-cache upload: 2 uploaded, 0 skipped, 0 failed/);
  const normalLogs = result.stdout
    .split("\n")
    .filter((line) => !line.startsWith("::debug::"))
    .join("\n");
  assert.ok(!normalLogs.includes(storePath("b")), "successful path lists belong in debug logs");
  assert.equal(context.tokens.length, 1);
  assert.deepEqual(context.completed, [`${"a".repeat(32)}.narinfo`]);
});

test("hundreds of cross-cache outputs share one streaming upload process", async (t) => {
  const context = await environment(t, { absent: ["a"] });
  const events = Array.from({ length: 513 }, (_, index) => ({
    ...event("EVAL", "a", true, "cached"),
    outputs: { out: `/nix/store/a${index.toString().padStart(31, "0")}-package` },
  }));
  await builder(context, events);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const pushes = (await readFile(context.env.PUSH_LOG!, "utf8")).trim().split("\n");
  assert.equal(pushes.length, 1);
  const push = JSON.parse(pushes[0]!);
  assert.equal(push.paths.length, 513);
  assert.deepEqual(push.args.slice(-3), ["--stdin", "--retry-timeout", "2m"]);
  assert.match(result.stdout, /513 uploaded, 0 skipped, 0 failed/);
});

test("streaming upload errors fail the job even when niks3 exits successfully", async (t) => {
  const context = await environment(t, { absent: ["b", "c"] });
  context.env.FAIL_UPLOAD = storePath("b");
  await builder(context, [event("EVAL", "b", true, "cached"), event("EVAL", "c", true, "cached")]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Cross-cache upload failed:.*server returned 503: unavailable/);
  assert.match(result.stdout, /1 uploaded, 0 skipped, 1 failed/);
  assert.equal((await readFile(context.env.PUSH_LOG!, "utf8")).trim().split("\n").length, 1);
});

test("size-limited streaming uploads warn without claiming the path was cached", async (t) => {
  const context = await environment(t, { absent: ["b"] });
  context.env.SKIP_UPLOAD = storePath("b");
  await builder(context, [event("EVAL", "b", true, "cached")]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /::warning::Cross-cache upload skipped:.*dependency exceeds server limit/,
  );
  assert.match(result.stdout, /0 uploaded, 1 skipped, 0 failed/);
});

test.for(["MISSING_UPLOAD", "INVALID_UPLOAD", "UPLOAD_EXIT"])(
  "incomplete or invalid streaming upload fails the job: %s",
  async (failure, t) => {
    const context = await environment(t, { absent: ["b"] });
    context.env[failure] = failure === "MISSING_UPLOAD" ? storePath("b") : "1";
    await builder(context, [event("EVAL", "b", true, "cached")]);
    const result = await execute(join(context.bundle, "build.mjs"), context.env);
    assert.equal(result.exitCode, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /No niks3 upload result|Invalid niks3 upload result|niks3 upload process failed/,
    );
  },
);

test("server errors fail one batch without request fan-out or blocking later batches", async (t) => {
  const context = await environment(t, { reject: ["a"] });
  const events = Array.from({ length: 128 }, (_, index) => ({
    ...event("EVAL", "a", true, "cached"),
    outputs: { out: `/nix/store/a${index.toString().padStart(31, "0")}-package` },
  }));
  await builder(context, [...events, event("EVAL", "d", true, "cached")]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout + result.stderr, /HTTP 503/);
  assert.equal(context.queries.length, 2);
  assert.equal(context.created.length, 2);
  assert.deepEqual(context.completed, [`${"d".repeat(32)}.narinfo`]);
});

test("accepted flake config reaches all commands", async (t) => {
  const context = await environment(t, { absent: ["b"] });
  context.env["INPUT_ACCEPT-FLAKE-CONFIG"] = "true";
  context.env.INPUT_FLAKE = "./selected#checks";
  context.env.TEST_FLAKE_CONFIG = JSON.stringify({
    "extra-substituters": ["https://first.example", "https://second.example"],
    sandbox: true,
    "max-jobs": 4,
  });
  context.env.EXPECT_CONFIG_LINE =
    "extra-substituters = https://first.example https://second.example";
  await builder(context, [event("EVAL", "b", true, "cached")]);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const commands = (await readFile(context.env.FLAKE_LOG!, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(commands[0].at(-1), "./selected");
  assert.equal(commands[1][0], "eval");
  assert.deepEqual(JSON.parse(await readFile(context.env.ARGS_LOG!, "utf8")).slice(0, 2), [
    "--flake",
    "./selected#checks",
  ]);
  const config = await readFile(context.env.CONFIG_LOG!, "utf8");
  assert.ok(config.includes(context.env.EXPECT_CONFIG_LINE));
  assert.match(config, /https:\/\/existing.example/);
  assert.match(config, /sandbox = true/);
  assert.match(config, /max-jobs = 4/);
  const push = JSON.parse((await readFile(context.env.PUSH_LOG!, "utf8")).trim());
  assert.equal(push.config, config);
});

test("failure to load accepted flake config stops before building", async (t) => {
  const context = await environment(t);
  context.env["INPUT_ACCEPT-FLAKE-CONFIG"] = "true";
  context.env.FAIL_CONFIG = "true";
  await builder(context, []);
  const result = await execute(join(context.bundle, "build.mjs"), context.env);
  assert.equal(result.exitCode, 1);
  await assert.rejects(readFile(context.env.ARGS_LOG!), { code: "ENOENT" });
});
