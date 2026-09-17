/**
 * Jetstream consumer worker.
 *
 * Runs the socket, the filter, and the counters off the main thread, so the
 * firehose never competes with the Jev calls for the event loop. Flow control
 * is pull-based: the worker holds matched posts in a bounded buffer and hands
 * them over a batch at a time, when the main thread asks. Jev is far slower
 * than the stream, so the buffer overflows and drops the oldest posts — this
 * samples the network rather than pretending to evaluate all of it.
 */

import { createFilter, type Filter } from "./filter";
import type {
  DropReason,
  FilterStats,
  Post,
  V2Frame,
  WorkerRequest,
  WorkerResponse,
} from "./types";

/** The worker-global surface this file uses; `self` isn't in the default lib set. */
declare const self: {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const BUFFER_CAP = 200;
const PULL_TIMEOUT_MS = 2000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

type Target = { endpoint: string; collection: string };

let target: Target | undefined;
let admit: Filter | undefined;
let socket: WebSocket | undefined;
let backoffMs = BACKOFF_MIN_MS;
let connected = false;
let stopped = false;
let cursor: number | undefined;

const buffer: Post[] = [];
const stats: FilterStats = { received: 0, matched: 0, dropped: {} };
let pendingPull: { max: number; timer: ReturnType<typeof setTimeout> } | undefined;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function countDrop(reason: DropReason): void {
  stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
}

function batchOf(max: number, posts: Post[]): WorkerResponse {
  return {
    type: "batch",
    posts,
    stats: { ...stats, dropped: { ...stats.dropped } },
    connected,
  };
}

/** Answer a waiting pull, now that the buffer has something worth sending. */
function flushPull(): void {
  if (!pendingPull) return;
  const { max, timer } = pendingPull;
  pendingPull = undefined;
  clearTimeout(timer);
  post(batchOf(max, buffer.splice(0, Math.min(max, buffer.length))));
}

function buildUrl(): string {
  if (!target) throw new Error("worker received a pull before init");
  const url = new URL(target.endpoint);
  url.searchParams.set("collections", target.collection);
  url.searchParams.set("kinds", "commit");
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

function connect(): void {
  if (stopped || !target) return;
  const opened = new WebSocket(buildUrl());
  socket = opened;

  opened.onopen = () => {
    connected = true;
    backoffMs = BACKOFF_MIN_MS;
    post({ type: "log", message: `connected to ${target?.endpoint}` });
  };

  opened.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    stats.received += 1;

    let frame: V2Frame;
    try {
      frame = JSON.parse(event.data) as V2Frame;
    } catch {
      countDrop("unparseable");
      return;
    }

    const admitted = admit?.(frame);
    if (!admitted) return;
    if (!admitted.ok) {
      countDrop(admitted.reason);
      return;
    }

    // Remember where we are for reconnect. The cursor is inclusive and delivery
    // is at-least-once, so the dedupe windows absorb the replay.
    const { post: admittedPost } = admitted;
    if (admittedPost.seq !== undefined) cursor = admittedPost.seq;

    stats.matched += 1;
    if (buffer.length >= BUFFER_CAP) {
      buffer.shift();
      countDrop("buffer-overflow");
    }
    buffer.push(admittedPost);
    // Hand over only once the batch is full, or the pull deadline lapses.
    if (pendingPull && buffer.length >= pendingPull.max) flushPull();
  };

  opened.onerror = () => {
    post({ type: "log", message: "socket error" });
  };

  opened.onclose = () => {
    connected = false;
    if (stopped) return;
    post({ type: "log", message: `disconnected, retrying in ${backoffMs}ms` });
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "init": {
      target = {
        endpoint: message.endpoint,
        collection: message.collection,
      };
      admit = createFilter(message.filter);
      connect();
      break;
    }
    case "pull": {
      // A full batch keeps one Jev request busy with several posts; the timer
      // stops a slow stream from stalling the loop indefinitely.
      if (buffer.length >= message.max) {
        post(batchOf(message.max, buffer.splice(0, message.max)));
        break;
      }
      pendingPull = { max: message.max, timer: setTimeout(flushPull, PULL_TIMEOUT_MS) };
      break;
    }
    case "stop": {
      stopped = true;
      socket?.close();
      if (pendingPull) clearTimeout(pendingPull.timer);
      pendingPull = undefined;
      break;
    }
  }
};
