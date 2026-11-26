import { expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { EMOJI_TABLE, fingerprint } from "./emoji.ts";

// SHA-256 over the table serialized as `emoji\tzh\ten` lines joined by `\n`. Any change to order, content or count fails.
const TABLE_SHA256 = "1a20aa48a8defe5d3334473c63a3e4b9fdd5b072d59574baa74dd91b92be25de";

const ascending = Uint8Array.from({ length: 32 }, (_, i) => i);
const allFf = new Uint8Array(32).fill(0xff);
const allZero = new Uint8Array(32);

// Frozen vectors. The expected indices are the first 12 bytes of SHA-256(pub) and the expected names are literal, so the
// vectors do not call the table to build themselves.
const VECTORS = [
  {
    name: "ascending 0..31",
    pub: ascending,
    indices: [99, 13, 205, 41, 102, 196, 51, 102, 145, 18, 84, 72],
    emoji: ["🍳", "🤫", "🎱", "🐙", "🍟", "🧬", "🌷", "🍟", "⛺", "🦘", "🍉", "⚡"],
    zh: ["煎锅", "嘘", "台球", "章鱼", "薯条", "基因", "郁金香", "薯条", "帐篷", "袋鼠", "西瓜", "闪电"],
    en: ["cooking", "shush", "billiards", "octopus", "fries", "dna", "tulip", "fries", "tent", "kangaroo", "watermelon", "lightning"],
  },
  {
    name: "all 0xff",
    pub: allFf,
    indices: [175, 150, 19, 118, 15, 114, 99, 95, 189, 180, 74, 90],
    emoji: ["🎈", "🌠", "🐼", "🍙", "😜", "🍯", "🍳", "🍞", "🧩", "🎧", "🗻", "🥑"],
    zh: ["气球", "流星", "熊猫", "饭团", "吐舌", "蜂蜜", "煎锅", "面包", "拼图", "耳机", "富士山", "牛油果"],
    en: ["balloon", "shooting star", "panda", "rice ball", "playful", "honey", "cooking", "bread", "puzzle", "headphones", "mountain", "avocado"],
  },
  {
    name: "all 0x00",
    pub: allZero,
    indices: [102, 104, 122, 173, 248, 98, 189, 119, 108, 143, 193, 139],
    emoji: ["🍟", "🌭", "🏫", "🔔", "📢", "🥚", "🧩", "🍲", "🍦", "🚢", "🔭", "🛴"],
    zh: ["薯条", "热狗", "学校", "铃铛", "喇叭", "鸡蛋", "拼图", "火锅", "冰淇淋", "轮船", "望远镜", "滑板车"],
    en: ["fries", "hot dog", "school", "bell", "loudspeaker", "egg", "puzzle", "pot of food", "ice cream", "ship", "telescope", "scooter"],
  },
];

const SINGLE_CODEPOINT_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const FORBIDDEN_MODIFIER = /[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/u;

test("table has exactly 256 entries and is frozen", () => {
  expect(EMOJI_TABLE.length).toBe(256);
  expect(Object.isFrozen(EMOJI_TABLE)).toBe(true);
  for (const row of EMOJI_TABLE) expect(Object.isFrozen(row)).toBe(true);
});

test("every emoji is one code point with default emoji presentation and no sequence modifiers", () => {
  for (const row of EMOJI_TABLE) {
    expect([...row.emoji].length).toBe(1);
    expect(SINGLE_CODEPOINT_PRESENTATION.test(row.emoji)).toBe(true);
    expect(FORBIDDEN_MODIFIER.test(row.emoji)).toBe(false);
  }
});

test("emoji, zh and en are each unique", () => {
  expect(new Set(EMOJI_TABLE.map((r) => r.emoji)).size).toBe(256);
  expect(new Set(EMOJI_TABLE.map((r) => r.zh)).size).toBe(256);
  expect(new Set(EMOJI_TABLE.map((r) => r.en)).size).toBe(256);
});

test("names are curated: Chinese is Han text, English is short lowercase words", () => {
  for (const row of EMOJI_TABLE) {
    expect(/^\p{Script=Han}{1,4}$/u.test(row.zh)).toBe(true);
    expect(/^[a-z]+( [a-z]+){0,2}$/.test(row.en)).toBe(true);
  }
});

test("table order and content match the frozen digest", () => {
  const serialized = EMOJI_TABLE.map((r) => `${r.emoji}\t${r.zh}\t${r.en}`).join("\n");
  const digest = sha256(new TextEncoder().encode(serialized));
  expect(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(TABLE_SHA256);
});

for (const v of VECTORS) {
  test(`fingerprint vector: ${v.name}`, () => {
    expect(Array.from(sha256(v.pub).subarray(0, 12))).toEqual(v.indices);
    const fp = fingerprint(v.pub);
    expect(fp.emoji).toEqual(v.emoji);
    expect(fp.zh).toEqual(v.zh);
    expect(fp.en).toEqual(v.en);
    expect(fp.short).toEqual(v.emoji.slice(0, 4));
  });
}

test("fingerprint returns 12 entries per list and short is the first four emoji", () => {
  const fp = fingerprint(ascending);
  expect(fp.emoji.length).toBe(12);
  expect(fp.zh.length).toBe(12);
  expect(fp.en.length).toBe(12);
  expect(fp.short.length).toBe(4);
  expect(fp.short).toEqual(fp.emoji.slice(0, 4));
});

test("fingerprint is deterministic and returns fresh arrays", () => {
  const a = fingerprint(allFf);
  const b = fingerprint(allFf);
  expect(b).toEqual(a);
  a.emoji.length = 0;
  expect(fingerprint(allFf).emoji.length).toBe(12);
});
