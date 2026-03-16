import { Message } from './dedup';

export function minifyCodeBlocks(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (typeof msg.content !== 'string') return msg;
    return {
      ...msg,
      content: msg.content.replace(/```[\s\S]*?```/g, block =>
        block.replace(/^(```\w*\n?)/, '$1')
          .replace(/\/\/[^\n]*$/gm, '')       // strip single-line comments
          .replace(/\/\*[\s\S]*?\*\//g, '')    // strip block comments
          .replace(/^\s+/gm, l => {            // collapse indentation to 1 space per level
            const depth = Math.round(l.length / 2);
            return ' '.repeat(depth);
          })
          .replace(/\n{2,}/g, '\n')            // collapse blank lines
      )
    };
  });
}
