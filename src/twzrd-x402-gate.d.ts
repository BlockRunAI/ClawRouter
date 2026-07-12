/**
 * Ambient types for optional peer `twzrd-x402-gate`.
 * Package is not required at compile or runtime unless CLAWROUTER_TWZRD is set.
 */
declare module "twzrd-x402-gate" {
  export function installTwzrdX402ClientHook(
    client: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onBeforePaymentCreation: (hook: (...args: any[]) => any) => any;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ): unknown;

  export function twzrdBeforePaymentCreation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    selectedRequirements: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ): Promise<{ abort: true; reason: string } | void>;
}
