/**
 * Shared types for the at-proto-local example.
 *
 * One wire shape: the v2 live tail (https://bsky.network/docs/jetstream), an
 * envelope whose `payload` is tagged by `$type`. Every frame is normalized to
 * `Post` before anything downstream sees it.
 *
 * The judgment types at the bottom mirror the Laya model's question and answer
 * shapes, which carry the same three primitives as Jev: choice, score, noul.
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
  | "queue-overflow"
  /** Over the model's input budget: the ANE exports reject rather than truncate. */
  | "capacity";

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

/**
 * A question in the local model's shape. Same three primitives as the hosted
 * model, but the wording has to fit the bundle's token budget: the ANE exports
 * allow 96 tokens for the question, its options and the state together.
 */
export type LocalQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type LocalQuestions = Record<string, LocalQuestion>;

/** `action` is the host action head's own probability, reported alongside the answer. */
type LocalAction = { action?: { act_probability: number } };

export type LocalAnswer =
  | ({ type: "noul"; noul: number; confidence: number } & LocalAction)
  | ({ type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> } & LocalAction)
  | ({
      type: "score";
      score: number;
      legend: Record<string, string>;
      confidence: number;
      probabilities: Record<string, number>;
    } & LocalAction);

/** The sidecar's first line: the bundle is loaded and the Core ML graph is warm. */
export type SidecarReady = {
  ready: true;
  model: string;
  /** Tokens allowed per question, state included. */
  limit: number;
  batch_size: number;
  load_ms: number;
  warmup_ms: number;
};

/** One answered request. `counts` is what the tokenizer measured, per question. */
export type SidecarAnswer = {
  id: number;
  model?: string;
  ms: number;
  counts: Record<string, number>;
  answers: Record<string, LocalAnswer>;
  usage: { input_tokens?: number; output_tokens?: number };
};

/** A refused request. `capacity` carries the counts that overflowed the limit. */
export type SidecarError = {
  id: number;
  /** `transport` is never sent by the sidecar: the client uses it when the pipe dies. */
  error: "capacity" | "prepare" | "model" | "transport";
  message?: string;
  counts?: Record<string, number>;
  limit?: number;
};

export type SidecarMessage = SidecarReady | SidecarAnswer | SidecarError;
