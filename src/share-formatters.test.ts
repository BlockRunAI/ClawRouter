import { describe, it, expect } from "vitest";
import {
  transform,
  transformForTelegramSplit,
  isSharePreset,
  SHARE_PRESETS,
  __test__,
} from "./share-formatters.js";

const {
  parseTable,
  renderTableMonospace,
  renderTableKeyValue,
  visibleWidth,
  splitTelegramMessage,
} = __test__;

// User's actual screenshot content — semiconductor bubble analysis with table + ###
const SAMPLE_MD = `# 半导体指数泡沫分析

## 当前状态（截至2026年5月初）

| 指标 | 数值 |
|------|------|
| SOX指数 | ~11,200-11,470 |
| 52周区间 | 4,393 → 11,477 |
| 12个月涨幅 | ≈+152% |

---

## 泡沫信号：7个值得警惕的迹象

### 1. 估值已进入极端区域

- SOX当前PE远高于10年中位数 **24.5x**（历史区间 13.5-86.9x）
- S&P 500 Shiller PE达 **41.06**

### 2. 增长靠涨价而非量增

- 行业增长主要由 *AI芯片ASP* 大幅上涨驱动
`;

describe("isSharePreset", () => {
  it("identifies valid presets", () => {
    for (const p of SHARE_PRESETS) expect(isSharePreset(p)).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isSharePreset("wechat")).toBe(false);
    expect(isSharePreset("")).toBe(false);
  });
});

describe("table parsing", () => {
  it("parses a simple two-column markdown table", () => {
    const block = `| 指标 | 数值 |
|------|------|
| SOX | 11470 |
| PE  | 41    |
`;
    const t = parseTable(block);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["指标", "数值"]);
    expect(t!.rows).toEqual([
      ["SOX", "11470"],
      ["PE", "41"],
    ]);
  });

  it("returns null for non-tables", () => {
    expect(parseTable("just some text")).toBeNull();
    expect(parseTable("| only one row |")).toBeNull();
  });

  it("handles escaped pipes within cells", () => {
    const block = `| key | value |
|-----|-------|
| a\\|b | c |
`;
    const t = parseTable(block);
    expect(t!.rows[0]).toEqual(["a|b", "c"]);
  });

  it("renders to monospace with CJK column widths", () => {
    const t = parseTable(`| 指标 | 数值 |
|------|------|
| SOX | 11470 |
`)!;
    const out = renderTableMonospace(t);
    // The two columns should be aligned — header row width matches data row width.
    const lines = out.split("\n");
    expect(lines).toHaveLength(3); // headers + sep + 1 row
    // Visible widths of each line should match (within column alignment).
    expect(visibleWidth(lines[0])).toBe(visibleWidth(lines[2]));
  });

  it("renders to key:value for plain", () => {
    const t = parseTable(`| 指标 | 数值 |
|------|------|
| SOX | 11470 |
| PE | 41 |
`)!;
    const out = renderTableKeyValue(t);
    expect(out).toBe("SOX: 11470\nPE: 41");
  });
});

describe("visibleWidth (CJK)", () => {
  it("counts CJK chars as 2", () => {
    expect(visibleWidth("指标")).toBe(4);
    expect(visibleWidth("PE")).toBe(2);
    expect(visibleWidth("12.5%")).toBe(5);
  });
});

describe("preset: feishu", () => {
  it("converts ### headings to bold (the headline pain point)", () => {
    const out = transform("### 1. 估值已进入极端区域\n\nbody", "feishu");
    expect(out).toContain("**1. 估值已进入极端区域**");
    expect(out).not.toContain("###");
  });

  it("converts # and ## headings to bold too", () => {
    expect(transform("# Title", "feishu")).toContain("**Title**");
    expect(transform("## Section", "feishu")).toContain("**Section**");
  });

  it("strips horizontal rules", () => {
    const out = transform("text\n\n---\n\nmore", "feishu");
    expect(out).not.toMatch(/^---$/m);
  });

  it("preserves markdown tables (Feishu renders them natively)", () => {
    const out = transform(SAMPLE_MD, "feishu");
    expect(out).toContain("| 指标 | 数值 |");
    expect(out).toContain("|------|------|");
  });

  it("preserves bold and italic", () => {
    expect(transform("**bold** and *italic*", "feishu")).toBe("**bold** and *italic*");
  });
});

describe("preset: slack", () => {
  it("converts **bold** to *bold*", () => {
    expect(transform("**hello**", "slack")).toBe("*hello*");
  });

  it("converts *italic* to _italic_", () => {
    expect(transform("*emphasis*", "slack")).toBe("_emphasis_");
  });

  it("preserves bold even when surrounded by italic-looking patterns", () => {
    // **a** *b* should become *a* _b_, not *a_b_*
    const out = transform("**bold** and *italic*", "slack");
    expect(out).toContain("*bold*");
    expect(out).toContain("_italic_");
  });

  it("converts headings to bold", () => {
    expect(transform("### My Heading", "slack")).toBe("*My Heading*");
  });

  it("converts markdown links to <url|text>", () => {
    expect(transform("[Google](https://google.com)", "slack")).toBe("<https://google.com|Google>");
  });

  it("escapes & < > in plain text but not inside link tokens", () => {
    const out = transform("a & b < c [Foo](https://x.com?a=1&b=2)", "slack");
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;");
    expect(out).toContain("<https://x.com?a=1&amp;b=2|Foo>");
  });

  it("converts tables to monospace code blocks", () => {
    const out = transform(SAMPLE_MD, "slack");
    expect(out).toMatch(/```\n[\s\S]+?\n```/);
    // Table headers should be in the monospace block, not raw markdown.
    expect(out).toContain("指标");
    expect(out).not.toContain("|------|");
  });

  it("converts strikethrough to ~x~", () => {
    expect(transform("~~gone~~", "slack")).toBe("~gone~");
  });

  it("converts leading - bullets to •", () => {
    expect(transform("- item one\n- item two", "slack")).toBe("• item one\n• item two");
  });
});

describe("preset: discord", () => {
  it("preserves ### headings (Discord supports them since 2023)", () => {
    expect(transform("### My Heading", "discord")).toBe("### My Heading");
  });

  it("preserves CommonMark bold/italic/strike", () => {
    expect(transform("**b** *i* ~~s~~", "discord")).toBe("**b** *i* ~~s~~");
  });

  it("converts tables to monospace (Discord doesn't render tables)", () => {
    const out = transform(SAMPLE_MD, "discord");
    expect(out).toMatch(/```\n[\s\S]+?\n```/);
    expect(out).not.toContain("|------|");
  });

  it("preserves CommonMark links", () => {
    expect(transform("[Foo](https://x.com)", "discord")).toBe("[Foo](https://x.com)");
  });
});

describe("preset: telegram (MarkdownV2)", () => {
  it("escapes special characters that would otherwise break sendMessage", () => {
    const out = transform("Hello world. This is fine!", "telegram");
    expect(out).toContain("\\.");
    expect(out).toContain("\\!");
  });

  it("converts ### to *bold* with escaped body", () => {
    const out = transform("### My (Heading) v1.0", "telegram");
    expect(out).toContain("*My \\(Heading\\) v1\\.0*");
  });

  it("converts **bold** to *bold* (single asterisk)", () => {
    const out = transform("hello **bold** world", "telegram");
    expect(out).toContain("*bold*");
    expect(out).not.toMatch(/\*\*[^*]+\*\*/);
  });

  it("escapes `.` and `-` in regular prose (typical sendMessage failure)", () => {
    const out = transform("Cost: $0.10 - $1.00", "telegram");
    // Result should have \. and \- escapes
    expect(out).toMatch(/0\\\.10/);
    expect(out).toMatch(/\\-/);
  });

  it("does not escape inside inline code", () => {
    // `1.0-x` should keep its content literal except for ` and \\
    const out = transform("see `node 1.0-x`", "telegram");
    expect(out).toContain("`node 1.0-x`");
    expect(out).not.toContain("`node 1\\.0\\-x`");
  });

  it("converts tables to ``` pre blocks (no escapes inside)", () => {
    const out = transform(SAMPLE_MD, "telegram");
    expect(out).toMatch(/```\n[\s\S]+?\n```/);
    // Table content uses dots and dashes that would normally need escaping —
    // but inside the ``` pre block they're literal.
    const fenceMatch = out.match(/```\n([\s\S]+?)\n```/);
    if (fenceMatch) {
      expect(fenceMatch[1]).toContain("11,200");
      expect(fenceMatch[1]).not.toContain("\\.");
    }
  });

  it("returns a single message when under 4096 chars", () => {
    const chunks = transformForTelegramSplit("short message");
    expect(chunks).toHaveLength(1);
  });

  it("splits messages over 4096 chars at line boundaries", () => {
    const big = Array.from({ length: 600 }, (_, i) => `Line number ${i} of content here.`).join(
      "\n",
    );
    const chunks = transformForTelegramSplit(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
    }
    // Last chunk should have the (i/N) suffix
    expect(chunks[chunks.length - 1]).toMatch(/\\\(\d+\/\d+\\\)/);
  });
});

describe("preset: whatsapp", () => {
  it("converts **bold** to *bold*", () => {
    expect(transform("**hello**", "whatsapp")).toBe("*hello*");
  });

  it("converts *italic* to _italic_ without corrupting bold", () => {
    const out = transform("**bold** and *italic*", "whatsapp");
    expect(out).toContain("*bold*");
    expect(out).toContain("_italic_");
  });

  it("converts headings to bold", () => {
    expect(transform("## Section Heading", "whatsapp")).toBe("*Section Heading*");
  });

  it("converts strikethrough to ~x~", () => {
    expect(transform("~~gone~~", "whatsapp")).toBe("~gone~");
  });

  it("splits markdown links into text + URL on separate lines", () => {
    expect(transform("[Google](https://google.com)", "whatsapp")).toBe(
      "Google\nhttps://google.com",
    );
  });

  it("converts tables to monospace fences", () => {
    const out = transform(SAMPLE_MD, "whatsapp");
    expect(out).toMatch(/```\n[\s\S]+?\n```/);
  });
});

describe("preset: plain (WeChat / iMessage / QQ)", () => {
  it("strips bold markers", () => {
    expect(transform("**hello**", "plain")).toBe("hello");
  });

  it("strips italic markers (both * and _)", () => {
    expect(transform("*one* and _two_", "plain")).toBe("one and two");
  });

  it("strips strikethrough", () => {
    expect(transform("~~gone~~", "plain")).toBe("gone");
  });

  it("renders # heading with === underline", () => {
    const out = transform("# My Title", "plain");
    expect(out).toContain("My Title");
    expect(out).toMatch(/My Title\n=+/);
  });

  it("renders ## heading with --- underline", () => {
    const out = transform("## Subsection", "plain");
    expect(out).toMatch(/Subsection\n-+/);
  });

  it("strips ### through ###### prefix without underline", () => {
    expect(transform("### deep", "plain")).toBe("deep");
  });

  it("converts a 2-column table to label: value lines", () => {
    const md = `| 指标 | 数值 |
|------|------|
| SOX | 11470 |
| PE | 41 |
`;
    const out = transform(md, "plain");
    expect(out).toContain("SOX: 11470");
    expect(out).toContain("PE: 41");
    expect(out).not.toContain("|---");
  });

  it("formats links as 'text (url)'", () => {
    expect(transform("[Google](https://google.com)", "plain")).toBe("Google (https://google.com)");
  });

  it("strips horizontal rules", () => {
    const out = transform("a\n\n---\n\nb", "plain");
    expect(out).not.toMatch(/^---$/m);
  });

  it("strips inline code backticks but keeps content", () => {
    expect(transform("see `npm install` for details", "plain")).toBe("see npm install for details");
  });
});

describe("fence (code block) protection", () => {
  it("does not transform markdown patterns inside ``` blocks for slack", () => {
    const md = "Use **literal** bold:\n```\n**this stays**\n```\n";
    const out = transform(md, "slack");
    // Outside fence: bold becomes Slack-style
    expect(out).toContain("*literal*");
    // Inside fence: bold stays as ** (verbatim)
    expect(out).toContain("**this stays**");
  });

  it("preserves code blocks for feishu", () => {
    const md = "```ts\nconst x = 1;\n```\n";
    const out = transform(md, "feishu");
    expect(out).toContain("```ts\nconst x = 1;\n```");
  });

  it("strips fence wrappers for plain", () => {
    const md = "```\nliteral content\n```\n";
    const out = transform(md, "plain");
    expect(out).toContain("literal content");
    expect(out).not.toContain("```");
  });
});

describe("integration: user's screenshot-equivalent input", () => {
  it("feishu output addresses the exact user-reported issue (### → bold)", () => {
    const out = transform(SAMPLE_MD, "feishu");
    expect(out).toContain("**1. 估值已进入极端区域**");
    expect(out).toContain("**当前状态（截至2026年5月初）**");
    expect(out).toContain("| 指标 | 数值 |"); // table preserved
    expect(out).not.toMatch(/^### /m);
    expect(out).not.toMatch(/^---$/m);
  });

  it("slack output produces only Slack-compatible primitives", () => {
    const out = transform(SAMPLE_MD, "slack");
    expect(out).not.toMatch(/^# /m);
    expect(out).not.toMatch(/^### /m);
    expect(out).not.toMatch(/\*\*[^*]+\*\*/); // no double-stars
    // Table is in a fenced block, not raw pipes
    expect(out).not.toContain("|------|");
  });

  it("plain output is fully markdown-free", () => {
    const out = transform(SAMPLE_MD, "plain");
    expect(out).not.toMatch(/\*\*/);
    expect(out).not.toMatch(/^### /m);
    expect(out).not.toContain("|------|");
    expect(out).toContain("SOX指数: ~11,200-11,470");
  });
});

describe("splitTelegramMessage", () => {
  it("returns single chunk for short input", () => {
    expect(splitTelegramMessage("short")).toEqual(["short"]);
  });

  it("splits at line boundaries when over 4096 chars", () => {
    const big = "x".repeat(2000) + "\n" + "y".repeat(2500);
    const chunks = splitTelegramMessage(big);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= 4096 + 30)).toBe(true); // +30 for (i/N) suffix
  });

  it("hard-splits a single line longer than the 4096-char limit", () => {
    const longLine = "x".repeat(9000);
    const chunks = splitTelegramMessage(longLine);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    // Every character of the original line survives the split (the suffix has no x).
    expect(chunks.join("").match(/x/g)?.length ?? 0).toBe(9000);
  });

  it("hard-splits an over-long line without dropping its neighbouring lines", () => {
    const big = "intro\n" + "y".repeat(5000) + "\noutro";
    const chunks = splitTelegramMessage(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    const joined = chunks.join("");
    expect(joined).toContain("intro");
    expect(joined).toContain("outro");
    expect(joined.match(/y/g)?.length ?? 0).toBe(5000);
  });

  it("does not split a UTF-16 surrogate pair at the hard-split boundary", () => {
    // "x"*4071 + emoji (2 code units) + "yyyy" -> the first hard-split boundary
    // (4072) used to land between the emoji's high and low surrogates.
    const input = "x".repeat(4071) + "😀yyyy\n" + "z".repeat(30);
    const chunks = splitTelegramMessage(input);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      for (let i = 0; i < chunk.length; i++) {
        const unit = chunk.charCodeAt(i);
        // No chunk may contain a lone high or low surrogate.
        if (unit >= 0xd800 && unit <= 0xdbff) {
          expect(chunk.charCodeAt(i + 1) >= 0xdc00 && chunk.charCodeAt(i + 1) <= 0xdfff).toBe(true);
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          expect(chunk.charCodeAt(i - 1) >= 0xd800 && chunk.charCodeAt(i - 1) <= 0xdbff).toBe(true);
        }
      }
    }
    // The emoji (both surrogates) survives in exactly one chunk.
    const emoji = "😀";
    expect(chunks.filter((c) => c.includes(emoji)).length).toBe(1);
  });

  it("does not end a hard-split chunk on a dangling MarkdownV2 escape backslash", () => {
    // transformForTelegramSplit escapes "!" -> "\!"; a boundary used to leave a
    // trailing lone "\" in one chunk and an unescaped "!" at the start of the next.
    // transformForTelegramSplit escapes "!" -> "\!" and then splits in one step.
    const chunks = transformForTelegramSplit("x".repeat(4071) + "!yyyy\n" + "z".repeat(30));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      const content = chunk.replace(/\n\n\\\(\d+\/\d+\\\)$/, "");
      let trailing = 0;
      for (let i = content.length - 1; i >= 0 && content[i] === "\\"; i--) trailing++;
      expect(trailing % 2).toBe(0);
    }
  });

  it("handles supplementary-only text, combining marks, and empty input at boundaries", () => {
    expect(splitTelegramMessage("")).toEqual([""]);
    const below = "x".repeat(4095);
    expect(splitTelegramMessage(below)).toEqual([below]);
    const atLimit = "x".repeat(4096);
    expect(splitTelegramMessage(atLimit)).toEqual([atLimit]);
    const over = "x".repeat(4097);
    expect(splitTelegramMessage(over).length).toBeGreaterThan(1);

    for (const sample of ["😀".repeat(3000), "e\u0301".repeat(3000), "\u{1F680}".repeat(2500)]) {
      const chunks = splitTelegramMessage(sample);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});
