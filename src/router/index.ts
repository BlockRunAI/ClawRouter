/**
 * Backward-compatible ClawRouter export surface.
 *
 * The implementation lives in the product-neutral @blockrun/router-core
 * package. Keeping this adapter preserves @blockrun/clawrouter/router for
 * existing SDK consumers without coupling Router Core back to this product.
 */
export * from "@blockrun/router-core";
