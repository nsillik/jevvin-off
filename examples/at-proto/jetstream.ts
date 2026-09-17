/**
 * Jetstream consumer worker.
 *
 * Runs the socket, the filter, and the counters off the main thread, so the
 * firehose never competes with the Jev calls for the event loop. Flow control
 * is pull-based: the worker holds matched posts in a bounded queue and hands
 * them over one at a time, when the main thread asks. One post per Jev request,
 * and Jev is far slower than the stream, so the queue overflows and drops the
 * oldest posts — this samples the network rather than pretending to evaluate
 * all of it.
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

/**
 * Queue capacity, in posts. Sized from one measured run (15s, live firehose):
 * the filter admitted ~14 posts/s while Jev answered at ~3.8 calls/s (≈260ms
 * per call), so the queue grew ~10 posts/s and never overflowed. A longer run
 * exhausts it and drops the oldest posts.
 */
const QUEUE_CAP = 200;
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

const queue: Post[] = [];
const stats: FilterStats = { received: 0, matched: 0, dropped: {} };
let pendingPull: { timer: Timer } | undefined;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function countDrop(reason: DropReason): void {
  stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
}

function nextResponse(post: Post | null): WorkerResponse {
  return {
    type: "next",
    post,
    stats: { ...stats, dropped: { ...stats.dropped } },
    connected,
  };
}

/**
 * Answer a waiting pull: the next queued post, or `null` when the timer fires
 * on an empty queue.
 */
function flushPull(): void {
  if (!pendingPull) return;
  clearTimeout(pendingPull.timer);
  pendingPull = undefined;
  post(nextResponse(queue.shift() ?? null));
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
    if (queue.length >= QUEUE_CAP) {
      queue.shift();
      countDrop("queue-overflow");
    }
    queue.push(admittedPost);
    // One post per Jev request: hand it over as soon as the caller asks.
    if (pendingPull) flushPull();
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
      // Answer immediately when a post is queued; otherwise wait out the pull
      // deadline so a quiet stream cannot stall the caller forever.
      if (queue.length > 0) {
        post(nextResponse(queue.shift() ?? null));
        break;
      }
      pendingPull = { timer: setTimeout(flushPull, PULL_TIMEOUT_MS) };
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
