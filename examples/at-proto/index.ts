/**
 * at-proto: Jev over the live AT Protocol firehose.
 *
 *   Jetstream (worker, filtered)  →  batch of posts  →  Jev  →  placeholder output
 *
 * Usage:
 *   bun run examples/at-proto/index.ts
 *   bun run examples/at-proto/index.ts --seconds=120 --batch=10 --dry-run
 *   bun run examples/at-proto/index.ts --endpoint=v1        # the legacy socket
 *   bun run examples/at-proto/index.ts --langs=en,ja --include-replies
 *   bun run examples/at-proto/index.ts --batch=1 --seconds=30   # one post per call
 *
 * Requires TYPESAFE_API_KEY for the Jev half; `--dry-run` skips it and only
 * exercises the worker + filter.
 */

import process from "node:process";
import { choice, noul, score, TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { DEFAULT_FILTER } from "./filter";
import type { FilterConfig, FilterStats, Post, WorkerRequest, WorkerResponse } from "./types";

const COLLECTION = "app.bsky.feed.post";

/** v2 is the documented endpoint for new consumers; v1 is the legacy `/subscribe`. */
const ENDPOINTS: Record<"v1" | "v2", string> = {
  v1: "wss://jetstream1.us-east.bsky.network/subscribe",
  v2: "wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents",
};

type Options = {
  seconds: number;
  batch: number;
  version: "v1" | "v2";
  dryRun: boolean;
  filter: FilterConfig;
  model?: string;
};

function parseArgs(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    seconds: Number(flag("seconds") ?? 60),
    batch: Math.max(1, Number(flag("batch") ?? 8)),
    version: (flag("endpoint") ?? "v2") as "v1" | "v2",
    dryRun: has("dry-run"),
    model: flag("model"),
    filter: {
      ...DEFAULT_FILTER,
      languages: (flag("langs") ?? DEFAULT_FILTER.languages.join(",")).split(",").map((s) => s.trim()),
      minLength: Number(flag("min-length") ?? DEFAULT_FILTER.minLength),
      topLevelOnly: has("include-replies") ? false : DEFAULT_FILTER.topLevelOnly,
    },
  };
}

/** The slice of each post Jev sees. State carries text and facts; questions carry the judgment. */
function toState(posts: Post[]) {
  return {
    posts: posts.map((post) => ({
      uri: post.uri,
      author: post.did,
      text: post.text,
      langs: post.langs,
      createdAt: post.createdAt ?? null,
      isReply: post.isReply,
      media: post.media,
      hasLinks: post.hasLinks,
    })),
    note: "A batch of public Bluesky posts sampled from the live firehose.",
  };
}

function questionsFor(posts: Post[]) {
  const single = posts.length === 1;
  const subject = single ? "this post" : "this batch of posts";
  return {
    is_spam: noul(`Do ${subject} contain spam, scams, or coordinated promotion?`, {
      true: "Advertising, scams, follow-farming, or copy-pasted promotion",
      false: "Ordinary conversation, news, or personal posting",
    }),
    topic: choice(`What is the dominant topic across ${subject}?`, {
      news_politics: "Current events, elections, policy, war",
      tech: "Software, AI, science, engineering",
      sports: "Games, teams, athletes, results",
      entertainment: "Film, music, games, celebrities, memes",
      personal: "Everyday life, feelings, jokes, questions",
      promo: "Selling something, self-promotion, links to products",
      other: "Nothing above fits",
    }),
    sentiment: score(`How positive is the overall tone of ${subject}?`, [
      "Bleak, angry, or distressed",
      "Mostly negative or complaining",
      "Mixed or neutral",
      "Mostly positive",
      "Upbeat, celebratory, funny",
    ]),
  };
}

/**
 * PLACEHOLDER OUTPUT — this is the part we have not designed yet.
 *
 * TODO: decide what at-proto should actually produce from a batch: a rolling
 * digest, topic routing, spam quarantine, alerting on spikes? Until then this
 * prints the batch and every typed answer, so we can look at real values first.
 */
function report(
  index: number,
  posts: Post[],
  answers: Record<string, unknown> | undefined,
  stats: FilterStats,
): void {
  console.log(`\n── batch ${index} ── ${posts.length} post(s) ─────────────────────────`);
  for (const post of posts) {
    const author = post.did.slice("did:plc:".length, "did:plc:".length + 8);
    const flags = [
      post.isReply ? "reply" : "top-level",
      post.media.length ? post.media.join("+") : "",
      post.hasLinks ? "links" : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`  ${author}  [${flags}]  ${post.text.replace(/\s+/g, " ").slice(0, 88)}`);
  }
  if (answers) {
    // One entry per question id — each an answer about the whole batch, not per post.
    console.log(`  answers (1 per question, about all ${posts.length} posts):`);
    for (const [id, answer] of Object.entries(answers)) {
      console.log(`    ${id.padEnd(10)} ${JSON.stringify(answer)}`);
    }
  }
  const dropped = Object.entries(stats.dropped)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  console.log(`  stream: received=${stats.received} matched=${stats.matched} dropped: ${dropped}`);
}

function summary(stats: FilterStats, batches: number, elapsedSeconds: number, interrupted: boolean): void {
  const { received, matched } = stats;
  console.log(`\n${"═".repeat(64)}`);
  console.log(`jetstream: ${received} events in ${elapsedSeconds.toFixed(0)}s (${(received / elapsedSeconds).toFixed(1)}/s)${interrupted ? " [interrupted]" : ""}`);
  console.log(`matched:   ${matched} kept (${((matched / Math.max(received, 1)) * 100).toFixed(1)}%)`);
  console.log(`jev:       ${batches} batch(es)`);
  const total = Object.values(stats.dropped).reduce((sum, n) => sum + n, 0);
  for (const [reason, count] of Object.entries(stats.dropped).sort((a, b) => b[1] - a[1])) {
    console.log(`  dropped ${reason.padEnd(16)} ${String(count).padStart(5)}  ${((count / Math.max(total, 1)) * 100).toFixed(1)}%`);
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const deadline = started + options.seconds * 1000;

  const worker = new Worker(new URL("./jetstream.ts", import.meta.url).href);

  let stats: FilterStats = { received: 0, matched: 0, dropped: {} };
  let resolvePull: ((message: Extract<WorkerResponse, { type: "batch" }>) => void) | undefined;

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.type === "log") {
      console.error(`[jetstream] ${message.message}`);
      return;
    }
    stats = message.stats;
    const resolve = resolvePull;
    resolvePull = undefined;
    resolve?.(message);
  };

  worker.postMessage({
    type: "init",
    endpoint: ENDPOINTS[options.version],
    version: options.version,
    collection: COLLECTION,
    filter: options.filter,
  } satisfies WorkerRequest);

  const pull = (max: number) =>
    new Promise<Extract<WorkerResponse, { type: "batch" }>>((resolve) => {
      resolvePull = resolve;
      worker.postMessage({ type: "pull", max } satisfies WorkerRequest);
    });

  // A SIGINT listener suppresses the default exit, so this handler has to do
  // the exiting itself: drop the socket, cancel any in-flight Jev call, and
  // resolve the pull the worker will no longer answer so the loop can finish.
  const controller = new AbortController();
  let stopping = false;
  const interrupt = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error("\ninterrupted — finishing the batch and summarising");
    controller.abort();
    worker.postMessage({ type: "stop" } satisfies WorkerRequest);
    const resolve = resolvePull;
    resolvePull = undefined;
    resolve?.({ type: "batch", posts: [], stats, connected: false });
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  console.log(
    `consuming ${COLLECTION} from jetstream ${options.version} for ${options.seconds}s\n` +
      `filter: langs=${options.filter.languages.join(",")} minLength=${options.filter.minLength} ` +
      `topLevelOnly=${options.filter.topLevelOnly} batch=${options.batch}` +
      (options.dryRun ? " [dry run: no Jev calls]" : ""),
  );

  const client = options.dryRun ? undefined : new TypeSafeClient();
  let batches = 0;

  while (!stopping && Date.now() < deadline) {
    const batch = await pull(options.batch);
    if (stopping || batch.posts.length === 0) continue;
    batches += 1;

    if (!client) {
      report(batches, batch.posts, undefined, batch.stats);
      continue;
    }

    const questions = questionsFor(batch.posts);
    let response: SystemOneResult<typeof questions>;
    try {
      response = await client.systemOne(
        {
          state: toState(batch.posts),
          questions,
          ...(options.model ? { model: options.model } : {}),
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted) break; // interrupted mid-call: expected
      if (error instanceof TypeSafeError) {
        console.error(`jev request failed: ${error.message}`);
        if (batches === 1) return 1; // most likely a credentials problem; don't loop on it
        continue;
      }
      throw error;
    }

    report(
      batches,
      batch.posts,
      {
        model: response.model,
        ...response.answers,
        tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      batch.stats,
    );
  }

  worker.postMessage({ type: "stop" } satisfies WorkerRequest);
  worker.terminate();
  summary(stats, batches, (Date.now() - started) / 1000, stopping);
  return stopping ? 130 : 0;
}

process.exit(await main());
