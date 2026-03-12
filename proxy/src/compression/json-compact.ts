import { Message } from './dedup';

export function compactJson(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.tool_calls) {
      msg.tool_calls = msg.tool_calls.map((tc: any) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function.arguments === 'string' 
            ? JSON.stringify(JSON.parse(tc.function.arguments))
            : JSON.stringify(tc.function.arguments)
        }
      }));
    }
    return msg;
  });
}
