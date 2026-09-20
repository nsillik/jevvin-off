/**
 * at-proto-local: Jev-shaped decisions from a local Core ML model.
 *
 *   Jetstream (worker, filtered)  →  one post  →  Laya sidecar  →  placeholder output
 *
 * Usage:
 *   bun run at-proto-local
 *   bun run at-proto-local --seconds=120 --dry-run
 *   bun run at-proto-local --langs=en,ja --include-replies
 *   bun run at-proto-local --model=aac6fef/laya-multilingual-coreml --seconds=30
 *
 * Setup, once:
 *   uv sync
 *   uvx --from huggingface_hub hf download aac6fef/laya-multilingual-coreml-ane \
 *     --local-dir examples/at-proto-local/models/ane
 *
 * The same three judgments as at-proto — is_spam, topic, sentiment — asked of a
 * local model instead of the hosted one, so nothing is billed and no key is
 * needed. The trade is a hard input budget: the ANE exports allow 96 tokens for
 * the question, its options and the post text together, and refuse a request
 * that does not fit rather than truncating it. Measured on live-stream samples:
 * ~15ms per post at 6-12% of wall time, and 16% of posts refused as over budget
 * — non-English and long ones, which no wording fixes. `--dry-run` skips the
 * model entirely and exercises only the worker and the filter.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_FILTER } from "./filter";
import { startJudge, type Judge, type JudgeResult } from "./judge";
import type { FilterConfig, FilterStats, LocalQuestions, Post, WorkerRequest, WorkerResponse } from "./types";

const COLLECTION = "app.bsky.feed.post";

/** The v2 live tail; `collections` + `kinds` narrow it server-side (see jetstream.ts). */
const ENDPOINT = "wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents";

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));

/** The bundle `hf download` puts here; the sidecar also accepts a Hub id. */
const DEFAULT_MODEL = join(PROJECT_DIR, "models", "ane");

/**
 * The judgments, in the model's own shape.
 *
 * Same three dimensions as at-proto, worded to fit 96 tokens alongside the post
 * text. Option and criteria text comes out of the same budget as the state, and
 * the longest question is what decides whether a post can be judged at all:
 * measured prefixes are is_spam 31, topic 29, sentiment 31, which leaves 64
 * tokens (about 320 characters) for the post. Longer wording costs refusals —
 * described topic options and five sentiment levels measured 36%.
 */
const QUESTIONS: LocalQuestions = {
  is_spam: {
    type: "noul",
    instructions: "Does this post contain spam or promotion?",
    criteria: {
      false: "ordinary conversation or news",
      true: "advertising, scams or promotion",
    },
  },
  topic: {
    type: "choice",
    instructions: "What is this post about?",
    criteria: {
      news_politics: null,
      tech: null,
      sports: null,
      entertainment: null,
      personal: null,
      promo: null,
      other: null,
    },
  },
  sentiment: {
    type: "score",
    instructions: "How positive is the tone?",
    criteria: ["negative", "neutral", "positive"],
  },
};

type Options = {
  seconds: number;
  dryRun: boolean;
  filter: FilterConfig;
  model: string;
  offline: boolean;
  computeUnits?: string;
};

function parseArgs(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const model = flag("model") ?? DEFAULT_MODEL;

  return {
    seconds: Number(flag("seconds") ?? 60),
    dryRun: has("dry-run"),
    offline: has("offline"),
    computeUnits: flag("compute-units"),
    model: isAbsolute(model) ? model : resolve(PROJECT_DIR, model),
    filter: {
      ...DEFAULT_FILTER,
      languages: (flag("langs") ?? DEFAULT_FILTER.languages.join(",")).split(",").map((s) => s.trim()),
      minLength: Number(flag("min-length") ?? DEFAULT_FILTER.minLength),
      topLevelOnly: has("include-replies") ? false : DEFAULT_FILTER.topLevelOnly,
    },
  };
}

/** Per-post results, kept only for the summary. */
type Run = {
  judged: number;
  refused: number;
  errors: number;
  /** Model wall time per judged post, milliseconds. */
  modelMs: number[];
  /** Total measured input tokens per judged post. */
  tokens: number[];
  /** The largest over-budget question seen, and what it measured. */
  worst: { question: string; tokens: number; limit: number } | undefined;
};

function noteCapacity(run: Run, post: Post, result: Extract<JudgeResult, { ok: false; reason: "capacity" }>): void {
  run.refused += 1;
  const measured = Object.entries(result.tokens).sort((a, b) => b[1] - a[1])[0];
  for (const [question, tokens] of Object.entries(result.tokens)) {
    if (tokens > result.limit && tokens > (run.worst?.tokens ?? 0)) {
      run.worst = { question, tokens, limit: result.limit };
    }
  }
  // Kept off stdout: the placeholder output stays a stream of judgments, and a
  // refused post is a fact about the budget, not an answer.
  if (measured) {
    console.error(
      `[budget] refused: ${measured[0]} ${measured[1]}/${result.limit} tokens  ` +
        `"${post.text.replace(/\s+/g, " ").slice(0, 48)}"`,
    );
  }
}

/**
 * PLACEHOLDER OUTPUT — this is the part we have not designed yet.
 *
 * TODO: decide what at-proto-local should actually produce per post: a rolling
 * digest, topic routing, spam quarantine, alerting on spikes? Until then this
 * prints the post and its typed answers, so we can look at real values first.
 */
function report(index: number, post: Post, result: Extract<JudgeResult, { ok: true }> | undefined): void {
  const author = post.did.slice("did:plc:".length, "did:plc:".length + 8);
  const flags = [
    post.isReply ? "reply" : "top-level",
    post.media.length ? post.media.join("+") : "",
    post.hasLinks ? "links" : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`\n── post ${index} ── ${author}  [${flags}]  ${post.text.length} chars`);
  console.log(`  ${post.text.replace(/\s+/g, " ").slice(0, 88)}`);
  if (!result) return;

  const tokens = Object.values(result.tokens).reduce((sum, n) => sum + n, 0);
  console.log(`  ${result.ms.toFixed(1)}ms  ${tokens} tokens  ${Object.keys(result.tokens).join("/")}`);
  for (const [id, answer] of Object.entries(result.answers)) {
    console.log(`  ${id.padEnd(10)} ${JSON.stringify(answer)}`);
  }
}

/** Mean, min, max and sample standard deviation, or undefined for no samples. */
function sampleStats(xs: number[]): { avg: number; min: number; max: number; std: number } | undefined {
  if (xs.length === 0) return undefined;
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - avg) ** 2, 0) / (xs.length - 1) : 0;
  return { avg, min: Math.min(...xs), max: Math.max(...xs), std: Math.sqrt(variance) };
}

function summary(
  run: Run,
  stats: FilterStats,
  elapsedSeconds: number,
  interrupted: boolean,
  modelled: boolean,
): void {
  const { received, matched } = stats;
  console.log(`\n${"═".repeat(64)}`);
  console.log(`jetstream: ${received} events in ${elapsedSeconds.toFixed(0)}s (${(received / elapsedSeconds).toFixed(1)}/s)${interrupted ? " [interrupted]" : ""}`);
  console.log(`matched:   ${matched} kept (${((matched / Math.max(received, 1)) * 100).toFixed(1)}%)`);
  console.log(`judged:    ${run.judged} post(s)${modelled ? ", one request each" : " (dry run: no model calls)"}`);

  const ms = sampleStats(run.modelMs);
  const tokens = sampleStats(run.tokens);
  if (ms && tokens) {
    const busy = (run.modelMs.reduce((a, b) => a + b, 0) / 1000 / elapsedSeconds) * 100;
    console.log(
      `model:     ${ms.avg.toFixed(1)}ms avg (min ${ms.min.toFixed(1)} max ${ms.max.toFixed(1)} std ${ms.std.toFixed(1)}) · ` +
        `${tokens.avg.toFixed(0)} tokens/post · ${busy.toFixed(1)}% of wall time`,
    );
  }
  if (run.refused > 0) {
    const attempted = run.judged + run.refused + run.errors;
    const worst = run.worst ? `, worst ${run.worst.question} at ${run.worst.tokens}/${run.worst.limit} tokens` : "";
    console.log(
      `over budget: ${run.refused} of ${attempted} post(s) (${((run.refused / attempted) * 100).toFixed(1)}%) ` +
        `refused by the ${run.worst?.limit ?? "?"}-token limit${worst}`,
    );
  }
  if (run.errors > 0) console.log(`model errors: ${run.errors}`);

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
  let resolvePull: ((message: Extract<WorkerResponse, { type: "next" }>) => void) | undefined;

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

  let judge: Judge | undefined;
  if (!options.dryRun) {
    console.error(`loading ${options.model} (first run compiles the Core ML graph)`);
    judge = await startJudge({
      model: options.model,
      offline: options.offline,
      computeUnits: options.computeUnits,
      projectDir: PROJECT_DIR,
    });
  }

  // The socket connects only after the model is warm. Core ML init takes ~20s,
  // and a stream that starts before it fills the queue with posts nothing can
  // judge yet — which then get dropped as `queue-overflow`.
  worker.postMessage({
    type: "init",
    endpoint: ENDPOINT,
    collection: COLLECTION,
    filter: options.filter,
  } satisfies WorkerRequest);

  const pull = () =>
    new Promise<Extract<WorkerResponse, { type: "next" }>>((resolve) => {
      resolvePull = resolve;
      worker.postMessage({ type: "pull" } satisfies WorkerRequest);
    });

  // A SIGINT listener suppresses the default exit, so this handler has to do
  // the exiting itself: drop the socket, cancel any in-flight model call, and
  // resolve the pull the worker will no longer answer so the loop can finish.
  let stopping = false;
  const interrupt = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error("\ninterrupted — summarising");
    worker.postMessage({ type: "stop" } satisfies WorkerRequest);
    const resolve = resolvePull;
    resolvePull = undefined;
    resolve?.({ type: "next", post: null, stats, connected: false });
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  console.log(
    `consuming ${COLLECTION} from jetstream for ${options.seconds}s\n` +
      `filter: langs=${options.filter.languages.join(",")} minLength=${options.filter.minLength} ` +
      `topLevelOnly=${options.filter.topLevelOnly}` +
      (judge ? `\nmodel:  ${judge.describe()}` : " [dry run: no model calls]"),
  );

  const run: Run = { judged: 0, refused: 0, errors: 0, modelMs: [], tokens: [], worst: undefined };

  while (!stopping && Date.now() < deadline) {
    const next = await pull();
    if (stopping || !next.post) continue;
    const post = next.post;

    if (!judge) {
      report(run.judged + 1, post, undefined);
      run.judged += 1;
      continue;
    }

    // The state is the post text alone. at-proto sends a JSON object with uri,
    // author, langs, media and flags; here every token of state is spent out of
    // the same 96 as the question, so unreferenced fields are dropped and the
    // bare string skips the JSON punctuation the library would tokenize.
    const result = await judge.judge(post.text, QUESTIONS);
    if (result.ok) {
      run.judged += 1;
      run.modelMs.push(result.ms);
      run.tokens.push(Object.values(result.tokens).reduce((sum, n) => sum + n, 0));
      report(run.judged, post, result);
    } else if (result.reason === "capacity") {
      noteCapacity(run, post, result);
    } else {
      run.errors += 1;
      console.error(`judge failed (${result.reason}): ${result.message}`);
      if (run.errors === 1 && run.judged === 0) return 1; // the model is not usable; don't loop on it
    }
  }

  worker.postMessage({ type: "stop" } satisfies WorkerRequest);
  worker.terminate();
  await judge?.stop();
  summary(run, stats, (Date.now() - started) / 1000, stopping, judge !== undefined);
  return stopping ? 130 : 0;
}

process.exit(await main());
