import { Message } from './dedup';

export function normalizeWhitespace(messages: Message[]): Message[] {
  return messages.map(msg => ({
    ...msg,
    content: msg.content
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim()
  }));
}
