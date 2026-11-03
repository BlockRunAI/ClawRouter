/**
 * The MPP rails depend on `mppx` and `@solana/pay-kit`, which are OPTIONAL peer dependencies:
 * most ClawRouter users never pay over MPP, so installing ClawRouter must not pull ~28 MB for them.
 * The rails load these packages with a dynamic import on first use and fail with an instruction,
 * not a bare module-resolution error, when one is missing.
 */
export async function loadOptional<T>(
  name: string,
  range: string,
  importer: () => Promise<T>,
): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const missing =
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND" ||
      /Cannot find (package|module)/.test(message);
    if (!missing || !message.includes(name)) throw err;
    throw new Error(
      `ClawRouter's MPP payment rail needs the optional package "${name}", which is not installed. ` +
        `Install it next to ClawRouter: npm install ${name}@${range}`,
      { cause: err },
    );
  }
}

/** Versions the rails were built and verified against (also the peerDependencies ranges). */
export const MPPX_RANGE = "~0.17.0";
export const PAY_KIT_RANGE = "~0.13.1";
