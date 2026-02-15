declare module "@t54-labs/clawcredit-sdk" {
  export class ClawCredit {
    constructor(config?: Record<string, unknown>);
    pay(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  }

  export function withTrace<T>(fn: () => Promise<T>): Promise<T>;
}
