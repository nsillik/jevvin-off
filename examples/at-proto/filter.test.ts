import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER, createFilter, normalize } from "./filter";
import type { FilterConfig, Post, V1Frame, V2Frame } from "./types";

const URI = "at://did:plc:abc123/app.bsky.feed.post/3kabc";
const TEXT = "Reorganizing a room is basically telling everything you own get rotated";

function v2(record: Record<string, unknown>, overrides: Record<string, unknown> = {}): V2Frame {
  return {
    $type: "message",
    payload: {
      $type: "network.bsky.jetstream.subscribeEvents#commit",
      did: "did:plc:abc123",
      seq: 42,
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kabc",
      record,
      ...overrides,
    },
  };
}

function v1(record: Record<string, unknown>): V1Frame {
  return {
    did: "did:plc:abc123",
    kind: "commit",
    time_us: 1_780_000_000_000_000,
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kabc",
      record,
    },
  };
}

function keep(filter: ReturnType<typeof createFilter>, frame: V1Frame | V2Frame): Post | string {
  const admitted = filter(frame);
  return admitted.ok ? admitted.post : admitted.reason;
}

describe("normalize", () => {
  test("v1 and v2 frames produce the same post", () => {
    const record = { $type: "app.bsky.feed.post", text: TEXT, langs: ["en"] };
    const fromV1 = normalize(v1(record));
    const fromV2 = normalize(v2(record));
    if (typeof fromV1 === "string" || typeof fromV2 === "string") {
      throw new Error(`expected posts, got ${fromV1} / ${fromV2}`);
    }
    expect(fromV1.uri).toBe(URI);
    expect(fromV1.text).toBe(fromV2.text);
    expect(fromV1.langs).toEqual(fromV2.langs);
    expect(fromV1.uri).toBe(fromV2.uri);
    // v2 carries the resume cursor, v1 the microsecond stamp.
    expect(fromV2.seq).toBe(42);
    expect(fromV1.timeUs).toBe(1_780_000_000_000_000);
  });

  test("rejects non-commit, non-create, and recordless commits", () => {
    expect(normalize({ kind: "identity", did: "did:plc:abc123" })).toBe("not-commit");
    expect(normalize(v2({ text: TEXT }, { operation: "delete", record: undefined }))).toBe(
      "not-create",
    );
    expect(normalize(v2({ text: TEXT }, { record: undefined }))).toBe("no-record");
  });

  test("detects embeds and thread position", () => {
    const post = normalize(
      v2({
        text: TEXT,
        reply: { root: { uri: "at://did:plc:other/app.bsky.feed.post/1" } },
        embed: { $type: "app.bsky.embed.images" },
      }),
    );
    if (typeof post === "string") throw new Error(`expected a post, got ${post}`);
    expect(post.isReply).toBe(true);
    expect(post.isSelfThread).toBe(false);
    expect(post.media).toEqual(["images"]);
  });

  test("self-thread replies are not top-level", () => {
    const post = normalize(v2({ text: TEXT, reply: { root: { uri: URI } } }));
    if (typeof post === "string") throw new Error(`expected a post, got ${post}`);
    expect(post.isSelfThread).toBe(true);
  });
});

describe("createFilter", () => {
  test("keeps an ordinary top-level post", () => {
    const filter = createFilter(DEFAULT_FILTER);
    const kept = keep(filter, v2({ text: TEXT, langs: ["en"] }));
    expect(typeof kept).not.toBe("string");
  });

  test("repeat calls agree on hasLinks — the test regex must not carry lastIndex", () => {
    const filter = createFilter({ ...DEFAULT_FILTER, dropUrlOnly: false });
    const first = keep(filter, v2({ text: `${TEXT} see example.com/post/1`, langs: ["en"] }, { rkey: "a" }));
    const second = keep(filter, v2({ text: `${TEXT} see example.com/post/2`, langs: ["en"] }, { rkey: "b" }));
    const third = keep(filter, v2({ text: `${TEXT} see example.com/post/3`, langs: ["en"] }, { rkey: "c" }));
    for (const kept of [first, second, third]) {
      if (typeof kept === "string") throw new Error(`expected a post, got ${kept}`);
      expect(kept.hasLinks).toBe(true);
    }
  });

  test("drops bare-domain and scheme links with nothing else to read", () => {
    const filter = createFilter(DEFAULT_FILTER);
    expect(keep(filter, v2({ text: "https://youtube.com/shorts/KTo8l" }, { rkey: "a" }))).toBe("url-only");
    expect(keep(filter, v2({ text: "youtube.com/shorts/KTo8l" }, { rkey: "b" }))).toBe("url-only");
  });

  test("drops by language, length, reply, and duplicate", () => {
    const filter = createFilter(DEFAULT_FILTER);
    expect(keep(filter, v2({ text: TEXT, langs: ["ja"] }, { rkey: "a" }))).toBe("language");
    expect(keep(filter, v2({ text: "hi" }, { rkey: "b" }))).toBe("too-short");
    expect(
      keep(filter, v2({ text: TEXT, langs: ["en"], reply: { root: { uri: URI } } }, { rkey: "c" })),
    ).toBe("reply");
    expect(keep(filter, v2({ text: TEXT, langs: ["en"] }, { rkey: "d" }))).not.toBe("duplicate");
    expect(keep(filter, v2({ text: TEXT, langs: ["en"] }, { rkey: "e" }))).toBe("duplicate");
  });

  test("undeclared language passes — absence is not a different language", () => {
    const filter = createFilter(DEFAULT_FILTER);
    const kept = keep(filter, v2({ text: "ロシア大統領府は17日、追加制裁について認識を示した", langs: [] }));
    expect(typeof kept).not.toBe("string");
  });

  test("including replies keeps them", () => {
    const config: FilterConfig = { ...DEFAULT_FILTER, topLevelOnly: false };
    const filter = createFilter(config);
    const kept = keep(
      filter,
      v2({ text: TEXT, langs: ["en"], reply: { root: { uri: "at://did:plc:other/app.bsky.feed.post/1" } } }),
    );
    expect(typeof kept).not.toBe("string");
  });
});
