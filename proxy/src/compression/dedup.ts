import * as crypto from 'crypto';

export interface Message {
  role: string;
  content: string;
  [key: string]: any;
}

export function dedupMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter(msg => {
    // Never dedup system, user, or tool messages
    if (msg.role === 'system' || msg.role === 'user' || msg.role === 'tool') {
      return true;
    }
    
    const hash = crypto.createHash('md5')
      .update(msg.role + msg.content)
      .digest('hex');
    
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}
