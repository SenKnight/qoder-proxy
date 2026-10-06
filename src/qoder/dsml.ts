/**
 * DeepSeek DSML (native tool-call markup) detection and conversion.
 *
 * Some DeepSeek checkpoints served through the Qoder gateway emit tool calls as
 * plain text using the DSML protocol instead of OpenAI `tool_calls` deltas:
 *
 *   <|DSML|tool_calls>
 *     <|DSML|invoke name="read_file">
 *       <|DSML|parameter name="path" string="true">README.md</|DSML|parameter>
 *     </|DSML|invoke>
 *   </|DSML|tool_calls>
 *
 * Real traffic drifts from that canonical shape: the pipe may be fullwidth
 * (U+FF5C) or missing/repeated, the outer block may be named `tool_calls`,
 * `function_calls` or `calls`, and V4.1 inserts spaces (`<|DSML| calls>`).
 * This module converts any such block into structured tool calls and strips it
 * from the visible text, so a client that only speaks the OpenAI protocol still
 * receives the call instead of a raw markup string.
 */

/** Characters that may stand in for the `|` around the `DSML` token. */
const SEP = "[|!！、｜]";

const BLOCK_OPEN_SRC = `<\\s*(?:${SEP}\\s*)*DSML(?:\\s*${SEP})*\\s*(?:tool_?calls?|function_?calls?|calls)\\s*>`;
const BLOCK_CLOSE_SRC = `</\\s*(?:${SEP}\\s*)*DSML(?:\\s*${SEP})*\\s*(?:tool_?calls?|function_?calls?|calls)\\s*>`;
const INVOKE_OPEN_SRC = `<\\s*(?:${SEP}\\s*)*DSML(?:\\s*${SEP})*\\s*invoke\\b([^>]*)>`;
const INVOKE_CLOSE_SRC = `</\\s*(?:${SEP}\\s*)*DSML(?:\\s*${SEP})*\\s*invoke\\s*>`;
const PARAM_OPEN_SRC = `<\\s*(?:${SEP}\\s*)*DSML(?:\\s*${SEP})*\\s*parameter\\b([^>]*)>`;
const PARAM_CLOSE_SRC = `</\\s*(?:${SEP}\\s*)*DSML(?:\\s*${SEP})*\\s*parameter\\s*>`;

const ATTR_NAME = /name\s*=\s*["']([^"']*)["']/i;
const ATTR_STRING_FALSE = /string\s*=\s*["']false["']/i;

/**
 * A trailing fragment that could still grow into a DSML opening tag. Shapes
 * covered: a bare opening bracket, an optional slash, separators, a partial
 * DSML token, and a partial block name (a chunk ending mid `tool_calls`).
 * Ordinary text after an opening bracket (like a space, or `div`) does not
 * match, so it is never held back.
 */
const PARTIAL_MARKER = new RegExp(
  `^<\\/?\\s*(?:${SEP}\\s*)*(?:[Dd][Ss]?[Mm]?[Ll]?)?(?:\\s*${SEP}\\s*)*` +
    `(?:t?o?o?l?_?c?a?l?l?s?|f?u?n?c?t?i?o?n?_?c?a?l?l?s?|c?a?l?l?s?)?\\s*$`,
);

export interface DsmlToolCall {
  name: string;
  arguments: string;
}

export interface DsmlExtraction {
  calls: DsmlToolCall[];
  text: string;
}

function attributeName(attrs: string): string | undefined {
  const name = ATTR_NAME.exec(attrs)?.[1]?.trim();
  return name ? name : undefined;
}

function coerceValue(raw: string, asString: boolean): unknown {
  const value = raw.trim();
  if (asString) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseParameters(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const open = new RegExp(PARAM_OPEN_SRC, "gi");
  const close = new RegExp(PARAM_CLOSE_SRC, "i");
  let match = open.exec(body);
  while (match) {
    const attrs = match[1] || "";
    const name = attributeName(attrs);
    const asString = !ATTR_STRING_FALSE.test(attrs);
    const rest = body.slice(match.index + match[0].length);
    const end = close.exec(rest);
    const raw = end ? rest.slice(0, end.index) : rest;
    if (name) out[name] = coerceValue(raw, asString);
    if (end) open.lastIndex = match.index + match[0].length + end.index + end[0].length;
    match = open.exec(body);
  }
  return out;
}

function parseInvokes(body: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];
  const open = new RegExp(INVOKE_OPEN_SRC, "gi");
  const close = new RegExp(INVOKE_CLOSE_SRC, "i");
  let match = open.exec(body);
  while (match) {
    const name = attributeName(match[1] || "");
    const rest = body.slice(match.index + match[0].length);
    const end = close.exec(rest);
    const inner = end ? rest.slice(0, end.index) : rest;
    if (name) calls.push({ name, arguments: JSON.stringify(parseParameters(inner)) });
    if (end) open.lastIndex = match.index + match[0].length + end.index + end[0].length;
    match = open.exec(body);
  }
  return calls;
}

/** Blank out fenced code blocks and inline code spans, preserving length. */
function maskCode(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, (s) => "\u0000".repeat(s.length))
    .replace(/`[^`\n]*`/g, (s) => "\u0000".repeat(s.length));
}

/**
 * Extract DSML tool calls from a complete text, returning the calls together
 * with the text with those blocks removed. Markup inside markdown code fences or
 * inline code spans is treated as illustrative and left untouched.
 */
export function extractDsmlToolCalls(input: string): DsmlExtraction {
  const masked = maskCode(input);
  const open = new RegExp(BLOCK_OPEN_SRC, "gi");
  const close = new RegExp(BLOCK_CLOSE_SRC, "i");
  const calls: DsmlToolCall[] = [];
  let text = "";
  let cursor = 0;
  let match = open.exec(masked);
  while (match) {
    const blockStart = match.index;
    const rest = masked.slice(blockStart + match[0].length);
    const end = close.exec(rest);
    if (end) {
      const parsed = parseInvokes(rest.slice(0, end.index));
      if (parsed.length > 0) {
        const blockEnd = blockStart + match[0].length + end.index + end[0].length;
        text += input.slice(cursor, blockStart);
        cursor = blockEnd;
        calls.push(...parsed);
        open.lastIndex = blockEnd;
      }
    }
    match = open.exec(masked);
  }
  text += input.slice(cursor);
  return { calls, text };
}

/**
 * Incremental DSML filter for a single content/reasoning stream.
 *
 * Feed chunks with {@link push}; it returns the portion of text that is safe to
 * forward now (holding back any trailing fragment that might be the start of a
 * DSML block). Converted calls are collected by {@link takeCalls}. Call
 * {@link flush} at end of stream to release whatever remains.
 */
export class DsmlStreamFilter {
  private buffer = "";
  private pending: DsmlToolCall[] = [];

  push(chunk: string): string {
    if (chunk) this.buffer += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  takeCalls(): DsmlToolCall[] {
    const calls = this.pending;
    this.pending = [];
    return calls;
  }

  private drain(final: boolean): string {
    let emitted = "";
    for (;;) {
      const open = new RegExp(BLOCK_OPEN_SRC, "i").exec(this.buffer);
      if (open) {
        const rest = this.buffer.slice(open.index + open[0].length);
        const end = new RegExp(BLOCK_CLOSE_SRC, "i").exec(rest);
        if (end) {
          const blockEnd = open.index + open[0].length + end.index + end[0].length;
          const parsed = parseInvokes(rest.slice(0, end.index));
          if (parsed.length > 0) {
            emitted += this.buffer.slice(0, open.index);
            this.pending.push(...parsed);
          } else {
            emitted += this.buffer.slice(0, blockEnd);
          }
          this.buffer = this.buffer.slice(blockEnd);
          continue;
        }
        if (final) {
          emitted += this.buffer;
          this.buffer = "";
          return emitted;
        }
        emitted += this.buffer.slice(0, open.index);
        this.buffer = this.buffer.slice(open.index);
        return emitted;
      }
      if (final) {
        emitted += this.buffer;
        this.buffer = "";
        return emitted;
      }
      const hold = this.partialStart();
      if (hold >= 0) {
        emitted += this.buffer.slice(0, hold);
        this.buffer = this.buffer.slice(hold);
      } else {
        emitted += this.buffer;
        this.buffer = "";
      }
      return emitted;
    }
  }

  private partialStart(): number {
    const lt = this.buffer.lastIndexOf("<");
    if (lt === -1) return -1;
    const fragment = this.buffer.slice(lt);
    if (fragment.includes(">")) return -1;
    return PARTIAL_MARKER.test(fragment) ? lt : -1;
  }
}
