import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER, createFilter, normalize } from "./filter";
import type { Filter } from "./filter";
import type { FilterConfig, Post, V2Frame } from "./types";

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

function keep(filter: Filter, frame: V2Frame): Post | string {
  const admitted = filter(frame);
  return admitted.ok ? admitted.post : admitted.reason;
}

describe("normalize", () => {
  test("folds a commit frame into a post", () => {
    const post = normalize(v2({ $type: "app.bsky.feed.post", text: TEXT, langs: ["en"] }));
    if (typeof post === "string") throw new Error(`expected a post, got ${post}`);
    expect(post.uri).toBe(URI);
    expect(post.text).toBe(TEXT);
    expect(post.langs).toEqual(["en"]);
    expect(post.seq).toBe(42); // the resume cursor
  });

  test("rejects non-commit, non-create, and recordless commits", () => {
    expect(
      normalize({
        $type: "message",
        payload: { $type: "network.bsky.jetstream.subscribeEvents#identity", did: "did:plc:abc123" },
      }),
    ).toBe("not-commit");
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
