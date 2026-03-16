import { Message } from './dedup';

export function normalizeWhitespace(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (typeof msg.content !== 'string') return msg;
    return {
      ...msg,
      content: msg.content
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim()
    };
  });
}
