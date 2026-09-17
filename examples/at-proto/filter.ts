/**
 * Mechanical filtering for the Jetstream firehose.
 *
 * Everything here is structural — wire-level shape, presence of text, text
 * length, declared language, thread position, duplicates. Nothing here judges
 * *meaning*: spam, topic, quality and tone are left to Jev, which is the part
 * ordinary code cannot do.
 *
 * Measured on a 15s sample of `app.bsky.feed.post` (863 events, ~58/s):
 *   create 96% → has text 93% → >=15 chars 84% → not URL-only 84%
 *   → declared `en` 56% → top-level 30% → unique 29%   (~17 posts/s retained)
 * Asking the server for just this collection already removes ~88% of the
 * firehose: posts are 12% of it (likes 65%, reposts 10%, follows 8%).
 */

import type { DropReason, FilterConfig, Post, PostRecord, V2Frame } from "./types";

export const DEFAULT_FILTER: FilterConfig = {
  languages: ["en"],
  minLength: 15,
  topLevelOnly: true,
  dropUrlOnly: true,
};

/**
 * Links appear as full URLs or bare domains (`youtube.com/shorts/…` straight
 * from a share sheet). Two regexes: a global one mutates `lastIndex` on every
 * `test()`, which would make `hasLinks` stateful and wrong.
 */
const URL_SOURCE =
  String.raw`https?://\S+|\b[\w-]+\.(?:com|org|net|io|co|gg|me|tv|app|dev|social|bsky|xyz)\b\S*`;
const URL_STRIP_RE = new RegExp(URL_SOURCE, "gi");
const URL_TEST_RE = new RegExp(URL_SOURCE, "i");

const DEDUPE_CAP = 2048;
const NSID = "app.bsky.feed.post";

type Admit =
  | { ok: true; post: Post }
  | { ok: false; reason: DropReason };

/** The admission test produced by {@link createFilter}. */
export type Filter = (frame: V2Frame) => Admit;

/** Unwrap the envelope: the commit, or null if this frame is not one. */
function commitFields(
  frame: V2Frame,
): { did: string; operation: string; collection: string; rkey: string; record?: PostRecord; seq?: number } | null {
  const payload = frame.payload;
  if (!payload || !(payload.$type ?? "").endsWith("#commit")) return null;
  return {
    did: payload.did ?? "",
    operation: payload.operation ?? "",
    collection: payload.collection ?? "",
    rkey: payload.rkey ?? "",
    record: payload.record,
    seq: payload.seq,
  };
}

function embedKinds(record: PostRecord): string[] {
  const type = record.embed?.$type;
  if (!type) return [];
  return [type.slice(type.lastIndexOf(".") + 1)];
}

function hasLinkFacet(record: PostRecord): boolean {
  // `facets` is not in PostRecord: it is only touched here, and only for this check.
  const facets = (record as { facets?: { features?: { $type?: string }[] }[] }).facets;
  return Boolean(
    facets?.some((facet) =>
      facet.features?.some((feature) => (feature.$type ?? "").endsWith("#link")),
    ),
  );
}

/** Convert a raw frame into a `Post`, or report why it cannot be one. */
export function normalize(frame: V2Frame): Post | DropReason {
  const commit = commitFields(frame);
  if (!commit) return "not-commit";
  if (commit.operation !== "create") return "not-create";
  if (commit.collection !== NSID) return "not-create";
  const record = commit.record;
  if (!record) return "no-record";

  const text = (record.text ?? "").trim();
  const did = commit.did;
  const rootUri = record.reply?.root?.uri ?? "";
  const reply = record.reply !== undefined;

  return {
    uri: `at://${did}/${commit.collection}/${commit.rkey}`,
    did,
    collection: commit.collection,
    operation: commit.operation,
    text,
    langs: record.langs ?? [],
    createdAt: record.createdAt,
    seq: commit.seq,
    isReply: reply,
    isSelfThread: reply && rootUri.startsWith(`at://${did}/`),
    media: embedKinds(record),
    hasLinks: hasLinkFacet(record) || URL_TEST_RE.test(text),
  };
}

/**
 * Build the admission test.
 *
 * Holds the dedupe window, so one filter instance per stream. Text duplicates
 * are dropped as spam-ish repetition; `uri` duplicates come from Jetstream's
 * at-least-once delivery across reconnects.
 */
export function createFilter(config: FilterConfig): Filter {
  const seenText = new Set<string>();
  const seenUri = new Set<string>();

  function remember<T>(set: Set<T>, key: T): boolean {
    if (set.has(key)) return false;
    set.add(key);
    if (set.size > DEDUPE_CAP) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    return true;
  }

  return function admit(frame: V2Frame): Admit {
    const normalized = normalize(frame);
    if (typeof normalized === "string") return { ok: false, reason: normalized };
    const post = normalized;

    if (!post.text) return { ok: false, reason: "no-text" };
    if (post.text.length < config.minLength) return { ok: false, reason: "too-short" };
    if (
      config.dropUrlOnly &&
      post.text.replace(URL_STRIP_RE, "").trim().length < config.minLength
    ) {
      return { ok: false, reason: "url-only" };
    }
    // `langs` is author-declared and sometimes wrong, so this is a cheap
    // prefilter, not a guarantee. Undeclared languages pass: absence is not
    // evidence of a different language.
    if (post.langs.length > 0 && !post.langs.some((lang) => config.languages.includes(lang))) {
      return { ok: false, reason: "language" };
    }
    if (config.topLevelOnly && post.isReply) return { ok: false, reason: "reply" };
    if (!remember(seenUri, post.uri)) return { ok: false, reason: "duplicate" };
    if (!remember(seenText, post.text.toLowerCase())) return { ok: false, reason: "duplicate" };

    return { ok: true, post };
  };
}
