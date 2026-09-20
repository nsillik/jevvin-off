/**
 * The model side of at-proto-local: one Laya judge, loaded once.
 *
 * The model is a Core ML bundle, so the process that owns it is Python
 * (`sidecar.py`) and this file is the transport: spawn it with `uv`, wait for
 * the ready line, then speak newline-delimited JSON at it. Loading costs a
 * one-time Core ML compile (measured: ~20 s cold), which is why the process is
 * long-lived rather than spawned per post.
 *
 * One request is in flight at a time. The ANE bundles are batch-1, so there is
 * nothing to pipeline inside the model, and one post per request keeps the
 * latency attributable to the post being judged.
 */

import { join } from "node:path";
import type { LocalAnswer, LocalQuestions, SidecarMessage } from "./types";

/** Cold Core ML init compiles the graph; the sidecar warms it before reporting ready. */
const READY_TIMEOUT_MS = 600_000;
const CALL_TIMEOUT_MS = 60_000;
const SHUTDOWN_MS = 5_000;

export type JudgeOptions = {
  /** A local bundle directory or a Hugging Face id. */
  model: string;
  /** Refuse Hub access: the bundle must already be on disk. */
  offline: boolean;
  computeUnits?: string;
  /** Directory holding `pyproject.toml` and `sidecar.py`. */
  projectDir: string;
};

export type JudgeResult =
  | {
      ok: true;
      answers: Record<string, LocalAnswer>;
      /** Measured tokens per question, state included. */
      tokens: Record<string, number>;
      /** The model's own wall time for all questions, from the sidecar. */
      ms: number;
    }
  | { ok: false; reason: "capacity"; tokens: Record<string, number>; limit: number }
  | { ok: false; reason: "prepare" | "model" | "transport"; message: string };

export type Judge = {
  judge(state: string, questions: LocalQuestions): Promise<JudgeResult>;
  describe(): string;
  stop(): Promise<void>;
};

/** Split a byte stream into lines, yielding only non-empty ones. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      if (line) yield line;
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

export async function startJudge(options: JudgeOptions): Promise<Judge> {
  const sidecar = join(options.projectDir, "sidecar.py");
  const proc = Bun.spawn(
    [
      "uv",
      "run",
      "--project",
      options.projectDir,
      "python",
      sidecar,
      "--model",
      options.model,
      ...(options.offline ? ["--offline"] : []),
      ...(options.computeUnits ? ["--compute-units", options.computeUnits] : []),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: options.projectDir },
  );

  const pending = new Map<number, (message: SidecarMessage) => void>();
  let ready: Extract<SidecarMessage, { ready: true }> | undefined;
  let failure: string | undefined;
  let nextId = 1;
  let stopping = false;

  /** The sidecar's own diagnostics: Hugging Face progress, Core ML warnings. */
  void (async () => {
    for await (const line of lines(proc.stderr)) console.error(`[laya] ${line}`);
  })();

  const readyPromise = new Promise<Extract<SidecarMessage, { ready: true }>>((resolve, reject) => {
    void (async () => {
      for await (const line of lines(proc.stdout)) {
        let message: SidecarMessage;
        try {
          message = JSON.parse(line) as SidecarMessage;
        } catch {
          // The library prints to stdout too; keep it visible but out of the protocol.
          console.error(`[laya] ${line}`);
          continue;
        }
        if ("ready" in message) {
          ready = message;
          resolve(message);
          continue;
        }
        const resolvePending = pending.get(message.id);
        pending.delete(message.id);
        resolvePending?.(message);
      }
    })()
      .catch((error: unknown) => {
        failure = `sidecar stream failed: ${String(error)}`;
        reject(new Error(failure));
      })
      .finally(() => {
        failure ??= stopping
          ? "sidecar stopped"
          : `sidecar exited with code ${proc.exitCode ?? "unknown"}`;
        for (const resolvePending of pending.values()) {
          resolvePending({ id: 0, error: "transport", message: failure });
        }
        pending.clear();
      });
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, READY_TIMEOUT_MS);
  try {
    await readyPromise;
  } catch {
    throw new Error(
      failure ??
        `the Laya sidecar did not become ready in ${READY_TIMEOUT_MS / 1000}s (is the bundle downloaded?)`,
    );
  } finally {
    clearTimeout(timer);
  }

  const describe = (): string => {
    if (!ready) return `${options.model} (not ready)`;
    return (
      `${ready.model} · ${ready.limit}-token budget · batch ${ready.batch_size} · ` +
      `load ${(ready.load_ms / 1000).toFixed(1)}s, warmup ${ready.warmup_ms.toFixed(1)}ms`
    );
  };

  const judge = async (state: string, questions: LocalQuestions): Promise<JudgeResult> => {
    if (failure) return { ok: false, reason: "transport", message: failure };
    const id = nextId;
    nextId += 1;

    const answered = new Promise<SidecarMessage>((resolve) => pending.set(id, resolve));
    proc.stdin.write(`${JSON.stringify({ id, op: "predict", state, questions })}\n`);
    await proc.stdin.flush();

    const timeout = setTimeout(() => {
      const resolvePending = pending.get(id);
      pending.delete(id);
      resolvePending?.({ id, error: "model", message: `no answer in ${CALL_TIMEOUT_MS}ms` });
    }, CALL_TIMEOUT_MS);

    let message: SidecarMessage;
    try {
      message = await answered;
    } finally {
      clearTimeout(timeout);
    }

    if ("answers" in message) {
      return {
        ok: true,
        answers: message.answers,
        tokens: message.counts,
        ms: message.ms,
      };
    }
    if ("error" in message) {
      if (message.error === "capacity") {
        return {
          ok: false,
          reason: "capacity",
          tokens: message.counts ?? {},
          limit: message.limit ?? 0,
        };
      }
      return { ok: false, reason: message.error, message: message.message ?? message.error };
    }
    // A ready line cannot arrive twice; the runner consumes the first one.
    return { ok: false, reason: "transport", message: "unexpected sidecar message" };
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      proc.stdin.write(`${JSON.stringify({ op: "stop" })}\n`);
      await proc.stdin.flush();
      proc.stdin.end();
    } catch {
      // Already gone: the exit race below settles it.
    }
    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_MS)),
    ]);
    if (exited === "timeout") proc.kill();
  };

  return { judge, describe, stop };
}
