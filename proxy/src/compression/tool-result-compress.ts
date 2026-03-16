import { Message } from './dedup';

const MAX_TOOL_RESULT_LENGTH = 800;

export function compressToolResults(messages: Message[]): Message[] {
  // Keep the last N tool results intact, truncate older ones
  const toolIndices = messages
    .map((m, i) => m.role === 'tool' ? i : -1)
    .filter(i => i !== -1);

  const keepIntact = new Set(toolIndices.slice(-2));

  return messages.map((msg, i) => {
    if (msg.role !== 'tool' || keepIntact.has(i)) return msg;
    if (typeof msg.content !== 'string' || msg.content.length <= MAX_TOOL_RESULT_LENGTH) return msg;

    return {
      ...msg,
      content: msg.content.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...[truncated]'
    };
  });
}
