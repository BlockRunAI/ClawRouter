import * as crypto from 'crypto';

export interface Message {
  role: string;
  content: string;
  [key: string]: any;
}

export function dedupMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter(msg => {
    // Never dedup system, user, tool, or assistant messages with tool_calls
    if (msg.role === 'system' || msg.role === 'user' || msg.role === 'tool' || msg.tool_calls) {
      return true;
    }
    
    const hash = crypto.createHash('md5')
      .update(msg.role + (msg.content ?? '') + (msg.tool_call_id ?? ''))
      .digest('hex');
    
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}
