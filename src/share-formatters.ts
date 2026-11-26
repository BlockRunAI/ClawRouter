/**
 * Share Formatters — convert markdown responses for IM dialects.
 *
 * Six presets: feishu, slack, discord, telegram, whatsapp, plain.
 * Pure regex + string ops, zero dependencies.
 *
 * Background: OpenClaw's terminal renders gorgeous markdown via Warp, but when
 * users copy that output to IM the formatting collapses. Each IM has its own
 * markdown dialect (Slack mrkdwn uses single asterisks, Telegram MarkdownV2
 * needs strict escaping, etc). This module turns one CommonMark response into
 * the right dialect for the target IM.
 *
 * Related upstream issue: https://github.com/openclaw/openclaw/issues/7909
 */

export type SharePreset = "feishu" | "slack" | "discord" | "telegram" | "whatsapp" | "plain";

export const SHARE_PRESETS: SharePreset[] = [
  "feishu",
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "plain",
];

export function isSharePreset(s: string): s is SharePreset {
  return (SHARE_PRESETS as string[]).includes(s);
}

/** Telegram MarkdownV2 max message length. Longer messages are split. */
const TELEGRAM_MAX_LEN = 4096;

/**
 * Room reserved in each chunk for the `\n\n\(i/N\)` part suffix. The suffix is
 * appended after splitting and its width depends on the final chunk count, so
 * content is capped below the hard limit to guarantee every emitted chunk fits.
 */
const TELEGRAM_SUFFIX_RESERVE = 24;
const TELEGRAM_CHUNK_CONTENT_LIMIT = TELEGRAM_MAX_LEN - TELEGRAM_SUFFIX_RESERVE;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

// Sentinel strings for placeholder substitution. Long enough to never collide with
// real text the assistant emits.
const PH_BOLD = "__CR_PH_BOLD_";
const PH_LINK = "__CR_PH_LINK_";
const PH_END = "__";

// ---------------------------------------------------------------------------
// Fence protection
// ---------------------------------------------------------------------------

interface Segment {
  isFence: boolean;
  content: string;
  fenceLang?: string;
}

function splitByFences(md: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRegex = /(^|\n)(```[a-zA-Z0-9_-]*\n[\s\S]*?\n```)(?=\n|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(md)) !== null) {
    const fenceStart = match.index + match[1].length;
    if (fenceStart > lastIndex) {
      segments.push({ isFence: false, content: md.slice(lastIndex, fenceStart) });
    }
    const block = match[2];
    const langMatch = block.match(/^```([a-zA-Z0-9_-]*)\n/);
    segments.push({
      isFence: true,
      content: block,
      fenceLang: langMatch ? langMatch[1] : undefined,
    });
    lastIndex = fenceStart + block.length;
  }
  if (lastIndex < md.length) {
    segments.push({ isFence: false, content: md.slice(lastIndex) });
  }
  return segments;
}

function fenceInner(block: string): string {
  return block.replace(/^```[a-zA-Z0-9_-]*\n/, "").replace(/\n```$/, "");
}

// ---------------------------------------------------------------------------
// Table parsing & rendering
// ---------------------------------------------------------------------------

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

const TABLE_BLOCK_REGEX =
  /(^|\n)((?:[ \t]*\|.*\|[ \t]*\n)(?:[ \t]*\|[\s:|-]+\|[ \t]*\n)(?:[ \t]*\|.*\|[ \t]*\n?)*)/g;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

function parseTable(block: string): ParsedTable | null {
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const sepCells = splitRow(lines[1]);
  if (sepCells.length === 0 || !sepCells.every((c) => /^:?-+:?$/.test(c))) return null;
  const headers = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return { headers, rows };
}

/** CJK chars count as 2 monospace columns. */
function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padRight(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function renderTableMonospace(table: ParsedTable): string {
  const cols = Math.max(table.headers.length, ...table.rows.map((r) => r.length));
  const grid: string[][] = [
    [...table.headers, ...Array(cols - table.headers.length).fill("")],
    ...table.rows.map((r) => [...r, ...Array(cols - r.length).fill("")]),
  ];
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(...grid.map((row) => visibleWidth(row[c] ?? ""))));
  }
  const renderRow = (row: string[]) =>
    row.map((cell, i) => padRight(cell ?? "", widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [renderRow(grid[0]), sep, ...grid.slice(1).map(renderRow)].join("\n");
}

function renderTableKeyValue(table: ParsedTable): string {
  if (table.headers.length === 2) {
    return table.rows.map((r) => `${r[0] ?? ""}: ${r[1] ?? ""}`).join("\n");
  }
  const blocks = table.rows.map((row) =>
    table.headers.map((h, i) => `${h}: ${row[i] ?? ""}`).join("\n"),
  );
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Preset: feishu (Lark / 飞书)
// ---------------------------------------------------------------------------

function applyFeishu(text: string): string {
  let s = text;
  // Headings → bold (Feishu doesn't render `### foo` as a heading).
  s = s.replace(/^(#{1,6}) +(.+)$/gm, (_, _h: string, body: string) => `**${body.trim()}**`);
  // Strip horizontal rules (Feishu shows them as literal `---`).
  s = s.replace(/^[ \t]*-{3,}[ \t]*$/gm, "");
  return s;
}

// ---------------------------------------------------------------------------
// Preset: slack (mrkdwn)
// ---------------------------------------------------------------------------

function applySlackText(text: string): string {
  let s = text;
  // Stage 1: escape `&` first.
  s = s.replace(/&/g, "&amp;");
  // Stage 2: extract markdown links → Slack `<url|text>`, stash so the angle brackets
  // aren't entity-escaped in stage 3.
  const linkPlaceholders: string[] = [];
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt: string, url: string) => {
    const i = linkPlaceholders.length;
    linkPlaceholders.push(`<${url}|${txt}>`);
    return `${PH_LINK}${i}${PH_END}`;
  });
  // Stage 3: escape remaining `<` and `>`.
  s = s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Stage 4: headings → **bold** (double-star, so the next stage scoops them into
  // the bold placeholder along with naturally-occurring **bold**).
  s = s.replace(/^(#{1,6}) +(.+)$/gm, (_, _h: string, body: string) => `**${body.trim()}**`);
  // Stage 5: protect double-star bold (now includes ex-headings).
  const boldPlaceholders: string[] = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => {
    const i = boldPlaceholders.length;
    boldPlaceholders.push(inner);
    return `${PH_BOLD}${i}${PH_END}`;
  });
  // Stage 6: italic `*x*` → `_x_` (Slack italic). Avoid asterisks already consumed
  // by bold extraction; word-boundary guards skip `a*b*c` mid-word.
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "_$1_");
  // Stage 7: strikethrough.
  s = s.replace(/~~([^~\n]+)~~/g, "~$1~");
  // Stage 8: restore bold as Slack-style `*x*`.
  const boldRestoreRe = new RegExp(
    PH_BOLD.replace(/_/g, "\\_") + "(\\d+)" + PH_END.replace(/_/g, "\\_"),
    "g",
  );
  s = s.replace(boldRestoreRe, (_, i: string) => `*${boldPlaceholders[parseInt(i, 10)]}*`);
  // Stage 9: restore links.
  const linkRestoreRe = new RegExp(
    PH_LINK.replace(/_/g, "\\_") + "(\\d+)" + PH_END.replace(/_/g, "\\_"),
    "g",
  );
  s = s.replace(linkRestoreRe, (_, i: string) => linkPlaceholders[parseInt(i, 10)]);
  // Stage 10: bullet `-` → `•` for visual polish.
  s = s.replace(/^([ \t]*)-([ \t]+)/gm, "$1•$2");
  return s;
}

// ---------------------------------------------------------------------------
// Preset: discord
// ---------------------------------------------------------------------------

function applyDiscordText(text: string): string {
  // Discord supports CommonMark closely (including `# ## ###` headings since 2023).
  // Bold, italic, links, strikethrough all pass through unchanged.
  return text;
}

// ---------------------------------------------------------------------------
// Preset: telegram (MarkdownV2)
// ---------------------------------------------------------------------------

const TELEGRAM_ESCAPE_CHARS = "_*[]()~`>#+-=|{}.!";

function escapeTelegramText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (TELEGRAM_ESCAPE_CHARS.includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

interface TgToken {
  kind: "text" | "bold" | "italic" | "code" | "strike" | "link";
  raw: string;
  inner?: string;
  url?: string;
}

function applyTelegramText(text: string): string {
  const tokens: TgToken[] = [];
  let i = 0;
  const len = text.length;
  const peek = (s: string) => text.startsWith(s, i);

  while (i < len) {
    if (peek("**")) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        tokens.push({ kind: "bold", raw: text.slice(i, end + 2), inner: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (peek("~~")) {
      const end = text.indexOf("~~", i + 2);
      if (end !== -1) {
        tokens.push({ kind: "strike", raw: text.slice(i, end + 2), inner: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (peek("`")) {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        tokens.push({ kind: "code", raw: text.slice(i, end + 1), inner: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (peek("[")) {
      const close = text.indexOf("](", i + 1);
      if (close !== -1) {
        const end = text.indexOf(")", close + 2);
        if (end !== -1) {
          tokens.push({
            kind: "link",
            raw: text.slice(i, end + 1),
            inner: text.slice(i + 1, close),
            url: text.slice(close + 2, end),
          });
          i = end + 1;
          continue;
        }
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && !text.slice(i + 1, end).includes("\n")) {
        tokens.push({ kind: "italic", raw: text.slice(i, end + 1), inner: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Always take the character at i as text: it is a marker that failed to
    // close above, and a scan that starts on it would stop at once and never
    // advance i.
    let j = i + 1;
    while (
      j < len &&
      !text.startsWith("**", j) &&
      !text.startsWith("~~", j) &&
      text[j] !== "`" &&
      text[j] !== "[" &&
      !(text[j] === "*" && text[j + 1] !== "*")
    ) {
      j++;
    }
    tokens.push({ kind: "text", raw: text.slice(i, j) });
    i = j;
  }

  let out = "";
  for (const tok of tokens) {
    switch (tok.kind) {
      case "text":
        out += escapeTelegramText(tok.raw);
        break;
      case "bold":
        out += "*" + escapeTelegramText(tok.inner ?? "") + "*";
        break;
      case "italic":
        out += "_" + escapeTelegramText(tok.inner ?? "") + "_";
        break;
      case "strike":
        out += "~" + escapeTelegramText(tok.inner ?? "") + "~";
        break;
      case "code":
        out += "`" + (tok.inner ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
        break;
      case "link":
        out +=
          "[" +
          escapeTelegramText(tok.inner ?? "") +
          "](" +
          (tok.url ?? "").replace(/\\/g, "\\\\").replace(/\)/g, "\\)") +
          ")";
        break;
    }
  }
  return out;
}

function preProcessTelegram(text: string): string {
  return text.replace(/^(#{1,6}) +(.+)$/gm, (_, _h: string, body: string) => `**${body.trim()}**`);
}

/**
 * Pick a hard-split end that never lands between a UTF-16 surrogate pair or
 * inside a MarkdownV2 `\X` escape pair, so each emitted chunk is self-contained.
 */
function safeSplitEnd(line: string, start: number, limit: number): number {
  let end = Math.min(start + limit, line.length);
  if (end >= line.length) return end;
  if (isHighSurrogate(line.charCodeAt(end - 1)) && isLowSurrogate(line.charCodeAt(end))) {
    end--;
  }
  let backslashes = 0;
  for (let j = end - 1; j >= start && line[j] === "\\"; j--) backslashes++;
  if (backslashes % 2 === 1 && end - 1 > start) end--;
  return end;
}

function splitTelegramMessage(s: string): string[] {
  if (s.length <= TELEGRAM_MAX_LEN) return [s];
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      chunks.push(buf);
      buf = "";
    }
  };
  for (const line of s.split("\n")) {
    if (line.length > TELEGRAM_CHUNK_CONTENT_LIMIT) {
      // A single line longer than the cap cannot be broken at a line boundary.
      // Hard-split it so no chunk exceeds Telegram's limit (e.g. a long URL or
      // a code line with no newlines), instead of emitting an oversized message
      // that sendMessage rejects outright.
      flush();
      for (let i = 0; i < line.length;) {
        const end = safeSplitEnd(line, i, TELEGRAM_CHUNK_CONTENT_LIMIT);
        chunks.push(line.slice(i, end));
        i = end;
      }
      continue;
    }
    if (buf.length + line.length + 1 > TELEGRAM_CHUNK_CONTENT_LIMIT) {
      flush();
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  flush();
  if (chunks.length > 1) {
    return chunks.map((c, i) => `${c}\n\n\\(${i + 1}/${chunks.length}\\)`);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Preset: whatsapp
// ---------------------------------------------------------------------------

function applyWhatsappText(text: string): string {
  let s = text;
  // Headings → **bold** (let the next step scoop them into bold protection).
  s = s.replace(/^(#{1,6}) +(.+)$/gm, (_, _h: string, body: string) => `**${body.trim()}**`);
  // Protect bold so single-star italic conversion can't corrupt it.
  const boldPlaceholders: string[] = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => {
    const i = boldPlaceholders.length;
    boldPlaceholders.push(inner);
    return `${PH_BOLD}${i}${PH_END}`;
  });
  // Italic `*x*` → `_x_`.
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "_$1_");
  // Strikethrough.
  s = s.replace(/~~([^~\n]+)~~/g, "~$1~");
  // Restore bold as `*x*`.
  const boldRestoreRe = new RegExp(
    PH_BOLD.replace(/_/g, "\\_") + "(\\d+)" + PH_END.replace(/_/g, "\\_"),
    "g",
  );
  s = s.replace(boldRestoreRe, (_, i: string) => `*${boldPlaceholders[parseInt(i, 10)]}*`);
  // Links: `[text](url)` → "text\nurl" so WhatsApp auto-previews the URL.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1\n$2");
  return s;
}

// ---------------------------------------------------------------------------
// Preset: plain (WeChat / QQ / iMessage / LINE)
// ---------------------------------------------------------------------------

function applyPlainText(text: string): string {
  let s = text;
  // Strip horizontal rules FIRST — before heading underlines get added, otherwise
  // the dashes in `## foo` underlines look like horizontal rules and get nuked.
  s = s.replace(/^[ \t]*-{3,}[ \t]*$/gm, "");
  s = s.replace(
    /^# +(.+)$/gm,
    (_, body: string) => `${body.trim()}\n${"=".repeat(visibleWidth(body.trim()))}`,
  );
  s = s.replace(
    /^## +(.+)$/gm,
    (_, body: string) => `${body.trim()}\n${"-".repeat(visibleWidth(body.trim()))}`,
  );
  s = s.replace(/^#{3,6} +(.+)$/gm, (_, body: string) => body.trim());
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "$1");
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, "$1");
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  s = s.replace(/`([^`\n]+)`/g, "$1");
  return s;
}

// ---------------------------------------------------------------------------
// Per-preset table & fence handlers
// ---------------------------------------------------------------------------

function transformTablesInProse(text: string, preset: SharePreset): string {
  if (preset === "feishu") return text;
  return text.replace(TABLE_BLOCK_REGEX, (whole, lead: string, block: string) => {
    const table = parseTable(block);
    if (!table) return whole;
    if (preset === "plain") {
      return lead + renderTableKeyValue(table);
    }
    const monospace = renderTableMonospace(table);
    return lead + "```\n" + monospace + "\n```\n";
  });
}

function transformFenceForPreset(seg: Segment, preset: SharePreset): string {
  if (preset === "plain") {
    return fenceInner(seg.content);
  }
  if (preset === "telegram") {
    const inner = fenceInner(seg.content).replace(/\\/g, "\\\\").replace(/`/g, "\\`");
    const lang = seg.fenceLang ? seg.fenceLang : "";
    return "```" + lang + "\n" + inner + "\n```";
  }
  return seg.content;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function applyTextRulesPerPreset(text: string, preset: SharePreset): string {
  switch (preset) {
    case "feishu":
      return applyFeishu(text);
    case "slack":
      return applySlackText(text);
    case "discord":
      return applyDiscordText(text);
    case "telegram":
      return applyTelegramText(preProcessTelegram(text));
    case "whatsapp":
      return applyWhatsappText(text);
    case "plain":
      return applyPlainText(text);
  }
}

/**
 * Convert a CommonMark-style markdown response into the dialect of the target IM.
 *
 * Two-pass approach: (1) skip original fences when transforming tables, so we don't
 * break code blocks that happen to contain pipes; (2) re-split after table → fence
 * conversion so the per-preset text rules don't run over the newly-generated fences.
 *
 * For Telegram, the result may exceed 4096 chars; use {@link transformForTelegramSplit}
 * if you need pre-split chunks.
 */
export function transform(md: string, preset: SharePreset): string {
  const originalSegments = splitByFences(md);
  const afterTables = originalSegments
    .map((seg) => (seg.isFence ? seg.content : transformTablesInProse(seg.content, preset)))
    .join("");
  const finalSegments = splitByFences(afterTables);
  return finalSegments
    .map((seg) =>
      seg.isFence
        ? transformFenceForPreset(seg, preset)
        : applyTextRulesPerPreset(seg.content, preset),
    )
    .join("");
}

/**
 * Convenience: transform for Telegram and split into <=4096-char chunks
 * suitable for separate sendMessage calls.
 */
export function transformForTelegramSplit(md: string): string[] {
  const single = transform(md, "telegram");
  return splitTelegramMessage(single);
}

/** Exposed for testing. */
export const __test__ = {
  splitByFences,
  parseTable,
  renderTableMonospace,
  renderTableKeyValue,
  visibleWidth,
  escapeTelegramText,
  splitTelegramMessage,
};
