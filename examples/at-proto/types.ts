/**
 * Shared types for the at-proto example.
 *
 * Two wire shapes are supported, because the public service exposes both:
 *   v2 — https://bsky.network/docs/jetstream   (recommended, has `seq` for resume)
 *   v1 — the legacy `/subscribe` socket (timestamps in `time_us`)
 * Both are normalized to `Post` before anything downstream sees them.
 */

/** v1 (legacy) frame: fields at the top level, `time_us` in unix microseconds. */
export type V1Frame = {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: {
    rev?: string;
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: PostRecord;
  };
};

/** v2 frame: an envelope whose `payload` is tagged by `$type`. */
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
  seq?: number;
  timeUs?: number;
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
  | "buffer-overflow";

export type FilterStats = {
  received: number;
  matched: number;
  dropped: Record<string, number>;
};

export type WorkerRequest =
  | {
      type: "init";
      endpoint: string;
      version: "v1" | "v2";
      collection: string;
      filter: FilterConfig;
    }
  | { type: "pull"; max: number }
  | { type: "stop" };

export type WorkerResponse =
  | { type: "batch"; posts: Post[]; stats: FilterStats; connected: boolean }
  | { type: "log"; message: string };
