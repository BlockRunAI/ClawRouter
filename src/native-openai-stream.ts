import { extractTextualToolCalls } from "./textual-tool-calls.js";

export type NativeOpenAIStreamEvent = {
  event?: string;
  data: string;
};

/** Parse an SSE body without buffering the complete model response. */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<NativeOpenAIStreamEvent> {
  const reader = body.getReader();
  const abortRead = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abortRead, { once: true });
  if (signal?.aborted) abortRead();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let data: string[] = [];
  let frameChars = 0;

  const dispatch = (): NativeOpenAIStreamEvent | undefined => {
    if (data.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const event = { ...(eventName ? { event: eventName } : {}), data: data.join("\n") };
    eventName = undefined;
    data = [];
    frameChars = 0;
    return event;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new Error("upstream stream aborted");
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: RegExpExecArray | null;
      while ((newline = /\r\n|\r|\n/.exec(buffer)) !== null) {
        if (!done && newline[0] === "\r" && newline.index === buffer.length - 1) break;
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline[0].length);
        if (line.length > 1_048_576) throw new Error("upstream SSE frame exceeded 1 MiB");
        if (line === "") {
          const parsed = dispatch();
          if (parsed) yield parsed;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
        if (field === "event") eventName = fieldValue;
        else if (field === "data") {
          frameChars += fieldValue.length;
          if (frameChars > 1_048_576) throw new Error("upstream SSE frame exceeded 1 MiB");
          data.push(fieldValue);
        }
      }
      if (buffer.length > 1_048_576) throw new Error("upstream SSE frame exceeded 1 MiB");
      if (done) break;
    }

    if (buffer !== "") {
      if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
      if (buffer.startsWith("data:")) {
        let value = buffer.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        data.push(value);
      } else if (buffer.startsWith("event:")) {
        let value = buffer.slice(6);
        if (value.startsWith(" ")) value = value.slice(1);
        eventName = value;
      }
    }
    const parsed = dispatch();
    if (parsed) yield parsed;
  } finally {
    signal?.removeEventListener("abort", abortRead);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Incrementally remove hidden reasoning tags, including tags split between SSE chunks. */
export class ThinkingTokenStripper {
  private buffer = "";
  private thinkingDepth = 0;

  push(value: string, final = false): string {
    this.buffer += value;
    let output = "";

    while (this.buffer.length > 0) {
      const open = this.buffer.indexOf("<");
      if (open === -1) {
        if (this.thinkingDepth === 0) output += this.buffer;
        this.buffer = "";
        break;
      }

      if (open > 0) {
        if (this.thinkingDepth === 0) output += this.buffer.slice(0, open);
        this.buffer = this.buffer.slice(open);
      }

      const close = this.buffer.indexOf(">");
      if (close === -1) {
        const compact = this.buffer.toLowerCase().replace(/\s/g, "");
        const tags = [
          "<think",
          "</think",
          "<thought",
          "</thought",
          "<antthinking",
          "</antthinking",
          "<antml:thinking",
          "</antml:thinking",
          "<｜",
          "<|",
        ];
        if (!tags.some((tag) => tag.startsWith(compact) || compact.startsWith(tag))) {
          if (this.thinkingDepth === 0) output += "<";
          this.buffer = this.buffer.slice(1);
          continue;
        }
        if (this.buffer.length > 512 || final) {
          this.buffer = "";
        }
        break;
      }

      const token = this.buffer.slice(0, close + 1);
      this.buffer = this.buffer.slice(close + 1);
      const lower = token.toLowerCase();
      const standard =
        /^<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\b[^>]*>$/i.exec(token);
      const kimi = /^<[｜|][^<>]*[｜|]>$/.test(token);

      if (standard) {
        this.thinkingDepth =
          standard[1] === "/" ? Math.max(0, this.thinkingDepth - 1) : this.thinkingDepth + 1;
      } else if (kimi) {
        if (/begin[^<>]*thinking/i.test(lower)) this.thinkingDepth++;
        else if (/end[^<>]*thinking/i.test(lower))
          this.thinkingDepth = Math.max(0, this.thinkingDepth - 1);
      } else if (this.thinkingDepth === 0) {
        output += token;
      }
    }

    if (final && this.buffer.length > 0 && this.thinkingDepth === 0) {
      output += this.buffer;
      this.buffer = "";
    }
    return output;
  }
}

export type TextualToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type TextualToolPushResult = { content: string; toolCalls: TextualToolCall[] };

/**
 * Preserve ClawRouter's text-encoded tool-call recovery while allowing ordinary
 * content to flow immediately. Candidate syntax is held until the existing
 * whole-message extractor can decide whether it is a call or literal prose.
 */
export class TextualToolCallStream {
  private fullContent = "";
  private sentRawLength = 0;
  private emittedContent = "";

  constructor(private readonly tools: unknown) {}

  flushLiteral(value = ""): string {
    this.fullContent += value;
    const content = this.fullContent.slice(this.sentRawLength);
    this.sentRawLength = this.fullContent.length;
    this.emittedContent += content;
    return content;
  }

  push(value: string, final = false): TextualToolPushResult {
    this.fullContent += value;
    if (final) {
      // The legacy extractor classifies whole/trailing objects. Applying it
      // before the choice finishes can mistake a nested argument object for
      // a completed call and leak its surrounding wrapper as prose.
      const extraction = extractTextualToolCalls(this.fullContent, { tools: this.tools });
      const content = extraction.cleanedContent.startsWith(this.emittedContent)
        ? extraction.cleanedContent.slice(this.emittedContent.length)
        : "";
      this.sentRawLength = this.fullContent.length;
      this.emittedContent = extraction.cleanedContent;
      return { content, toolCalls: extraction.toolCalls };
    }
    const candidate = findToolSyntaxCandidate(this.fullContent, this.sentRawLength, this.tools);
    const safeEnd = candidate ?? this.fullContent.length;
    const content =
      safeEnd > this.sentRawLength ? this.fullContent.slice(this.sentRawLength, safeEnd) : "";
    this.sentRawLength = Math.max(this.sentRawLength, safeEnd);
    this.emittedContent += content;
    return { content, toolCalls: [] };
  }
}

function findToolSyntaxCandidate(
  content: string,
  from: number,
  tools: unknown,
): number | undefined {
  const tail = content.slice(from);
  const candidates: number[] = [];
  const add = (index: number) => {
    if (index >= 0) candidates.push(from + index);
  };

  for (const pattern of [
    /<tool_call>/i,
    /<function_calls\b/i,
    /\[Called function\s+["']/i,
    /\{\s*"type"\s*:\s*"function"/i,
    /\{\s*"name"\s*:/i,
  ]) {
    add(pattern.exec(tail)?.index ?? -1);
  }
  // Retain only a possible syntax prefix, not an arbitrary tail of ordinary
  // text. This permits even one-character content deltas to reach the client.
  const prefixes = [
    "<tool_call>",
    "<function_calls",
    "[called function ",
    '{"type"',
    '{"name"',
    "terminal\n",
  ];
  const lower = tail.toLowerCase();
  const maxPrefix = Math.max(...prefixes.map((prefix) => prefix.length));
  for (let i = Math.max(0, lower.length - maxPrefix); i < lower.length; i++) {
    const suffix = lower.slice(i);
    if (prefixes.some((prefix) => prefix.startsWith(suffix))) add(i);
  }
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const name = tool?.function?.name;
      if (
        typeof name === "string" &&
        from === 0 &&
        `${name}(parameters=`.startsWith(content.replace(/\s/g, ""))
      )
        add(0);
    }
  }

  if (from === 0) {
    add(/^\s*terminal\s*\n/i.exec(content)?.index ?? -1);
    add(/^\s*[A-Za-z_]\w*\(\s*parameters\s*=/i.exec(content)?.index ?? -1);
  }

  // Kimi's nameless tool shape is a trailing JSON object matched against the
  // request's tool schemas. Hold a candidate object so it can be resolved.
  if (Array.isArray(tools)) {
    const brace = tail.indexOf("{");
    if (brace >= 0) add(brace);
  }

  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

export type NativeOpenAIStreamResult = {
  inputTokens?: number;
  outputTokens?: number;
  content: string;
  sawDone: boolean;
  sawFinish: boolean;
  error?: string;
};

/** Transform a native OpenAI-compatible stream while retaining ClawRouter's text policy. */
export async function pumpNativeOpenAIStream(
  body: ReadableStream<Uint8Array>,
  options: {
    model: string;
    tools: unknown;
    signal?: AbortSignal;
    onChunk: (sseFrame: string) => void;
    forwardToolCallProse?: boolean;
  },
): Promise<NativeOpenAIStreamResult> {
  type ChoiceState = {
    thinking: ThinkingTokenStripper;
    tools: TextualToolCallStream;
    nextToolIndex: number;
    recoveredToolCalls: boolean;
    structuredToolCalls: boolean;
    heldContent: string;
    finished: boolean;
  };
  const choices = new Map<number, ChoiceState>();
  const getState = (index: number): ChoiceState => {
    let state = choices.get(index);
    if (!state) {
      state = {
        thinking: new ThinkingTokenStripper(),
        tools: new TextualToolCallStream(options.tools),
        nextToolIndex: 0,
        recoveredToolCalls: false,
        structuredToolCalls: false,
        heldContent: "",
        finished: false,
      };
      choices.set(index, state);
    }
    return state;
  };
  const result: NativeOpenAIStreamResult = {
    content: "",
    sawDone: false,
    sawFinish: false,
  };
  const write = (chunk: Record<string, unknown>) => {
    options.onChunk(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  for await (const event of readSseEvents(body, options.signal)) {
    if (event.event === "error") {
      result.error = event.data || "upstream stream reported an error";
      break;
    }
    if (event.data.trim() === "[DONE]") {
      result.sawDone = true;
      break;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      result.error = `malformed upstream SSE data: ${event.data.slice(0, 160)}`;
      break;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      result.error = "upstream SSE data was not a JSON object";
      break;
    }
    const chunk = raw as Record<string, unknown>;
    const providerError = chunk.error;
    if (providerError !== undefined) {
      result.error =
        typeof providerError === "string"
          ? providerError
          : JSON.stringify(providerError).slice(0, 400);
      break;
    }

    const usage = chunk.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const usageRecord = usage as Record<string, unknown>;
      if (typeof usageRecord.prompt_tokens === "number")
        result.inputTokens = usageRecord.prompt_tokens;
      if (typeof usageRecord.completion_tokens === "number")
        result.outputTokens = usageRecord.completion_tokens;
    }

    const outgoing: Record<string, unknown> = {
      ...chunk,
      object: "chat.completion.chunk",
      model: options.model || (typeof chunk.model === "string" ? chunk.model : "unknown"),
    };
    // The host emits one final cost-aware usage event after this pump returns.
    delete outgoing.usage;
    if (Array.isArray(chunk.choices) && chunk.choices.length === 0 && usage) continue;
    const rawChoices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const outputChoices: Record<string, unknown>[] = [];
    let eventContent = "";
    for (const rawChoice of rawChoices) {
      if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) continue;
      const choice = rawChoice as Record<string, unknown>;
      const index = typeof choice.index === "number" ? choice.index : 0;
      const state = getState(index);
      const rawDelta = choice.delta;
      const delta =
        rawDelta && typeof rawDelta === "object" && !Array.isArray(rawDelta)
          ? { ...(rawDelta as Record<string, unknown>) }
          : {};
      delete delta.reasoning_content;
      delete delta.reasoning;
      delete delta.reasoning_details;
      delete delta.thinking;

      const sourceToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      if (sourceToolCalls.length > 0) state.structuredToolCalls = true;
      for (const call of sourceToolCalls) {
        if (typeof call?.index === "number")
          state.nextToolIndex = Math.max(state.nextToolIndex, call.index + 1);
      }

      let recoveredCalls: TextualToolCall[] = [];
      const rawContent = delta.content;
      if (typeof rawContent === "string") {
        const visible = state.thinking.push(rawContent);
        const transformed = state.structuredToolCalls
          ? { content: state.tools.flushLiteral() + visible, toolCalls: [] }
          : state.tools.push(visible);
        if (options.forwardToolCallProse === false) {
          state.heldContent += transformed.content;
          transformed.content = "";
        }
        if (transformed.content) {
          delta.content = transformed.content;
          eventContent += transformed.content;
        } else {
          delete delta.content;
        }
        recoveredCalls = transformed.toolCalls;
      }

      if (recoveredCalls.length > 0) {
        state.recoveredToolCalls = true;
        const synthetic = recoveredCalls.map((call) => ({
          index: state.nextToolIndex++,
          id: call.id,
          type: call.type,
          function: call.function,
        }));
        delta.tool_calls = [...sourceToolCalls, ...synthetic];
      }

      const finishReason = choice.finish_reason;
      if (typeof finishReason === "string") {
        result.sawFinish = true;
        state.finished = true;
        const lastThinking = state.thinking.push("", true);
        const lastText = state.structuredToolCalls
          ? { content: state.tools.flushLiteral(lastThinking), toolCalls: [] }
          : state.tools.push(lastThinking, true);
        if (options.forwardToolCallProse === false) {
          state.heldContent += lastText.content;
          lastText.content =
            state.structuredToolCalls || state.recoveredToolCalls || lastText.toolCalls.length > 0
              ? ""
              : state.heldContent;
          state.heldContent = "";
        }
        if (lastText.content) {
          delta.content = `${typeof delta.content === "string" ? delta.content : ""}${lastText.content}`;
          eventContent += lastText.content;
        }
        if (lastText.toolCalls.length > 0) {
          state.recoveredToolCalls = true;
          const synthetic = lastText.toolCalls.map((call) => ({
            index: state.nextToolIndex++,
            id: call.id,
            type: call.type,
            function: call.function,
          }));
          delta.tool_calls = [
            ...(Array.isArray(delta.tool_calls) ? delta.tool_calls : []),
            ...synthetic,
          ];
        }
        if (state.recoveredToolCalls || state.structuredToolCalls) {
          choice.finish_reason = "tool_calls";
        }
      }

      const outputChoice: Record<string, unknown> = { ...choice, delta };
      outputChoices.push(outputChoice);
    }
    if (rawChoices.length > 0) outgoing.choices = outputChoices;
    result.content += eventContent;
    write(outgoing);
  }

  result.sawFinish = choices.size > 0 && [...choices.values()].every((state) => state.finished);
  return result;
}
