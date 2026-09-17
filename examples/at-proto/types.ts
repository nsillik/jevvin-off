/**
 * Shared types for the at-proto example.
 *
 * One wire shape: the v2 live tail (https://bsky.network/docs/jetstream), an
 * envelope whose `payload` is tagged by `$type`. Every frame is normalized to
 * `Post` before anything downstream sees it.
 */

/** A Jetstream frame: event envelope, with the commit itself under `payload`. */
export type V2Frame = {
  $type?: string;
  payload?: {
    $type?: string;
    did?: string;
    seq?: number;
    time?: string;
    operation?: string;
    collection?: string;
    rkey?: string;
    rev?: string;
    record?: PostRecord;
  };
};

/** The parts of an `app.bsky.feed.post` record this example looks at. */
export type PostRecord = {
  $type?: string;
  text?: string;
  langs?: string[];
  createdAt?: string;
  reply?: { root?: { uri?: string }; parent?: { uri?: string } };
  embed?: { $type?: string };
};

/** A commit normalized from either wire shape. */
export type Post = {
  uri: string; // at://{did}/{collection}/{rkey}
  did: string;
  collection: string;
  operation: string;
  text: string;
  langs: string[];
  createdAt?: string;
  /** v2 sequence number; the resume cursor for a reconnect. */
  seq?: number;
  isReply: boolean;
  isSelfThread: boolean;
  media: string[]; // embed kinds, e.g. ["images"], ["external"], ["record"], ["video"]
  hasLinks: boolean;
};

/** Mechanical (non-semantic) admission rules. */
export type FilterConfig = {
  /** Accept only these BCP-47 language tags. Records with no `langs` pass either way. */
  languages: string[];
  minLength: number;
  /** Drop replies, keeping only posts that start a thread. */
  topLevelOnly: boolean;
  /** Drop posts whose text is nothing but a URL. */
  dropUrlOnly: boolean;
};

export type DropReason =
  | "not-commit"
  | "not-create"
  | "no-text"
  | "too-short"
  | "url-only"
  | "language"
  | "reply"
  | "duplicate"
  | "no-record"
  | "unparseable"
  | "queue-overflow";

export type FilterStats = {
  received: number;
  matched: number;
  dropped: Record<string, number>;
};

export type WorkerRequest =
  | {
      type: "init";
      endpoint: string;
      collection: string;
      filter: FilterConfig;
    }
  | { type: "pull" }
  | { type: "stop" };

/**
 * A pull is answered with one post, or `post: null` if the queue is still empty
 * when the worker's deadline lapses — the caller asks again.
 */
export type WorkerResponse =
  | { type: "next"; post: Post | null; stats: FilterStats; connected: boolean }
  | { type: "log"; message: string };
