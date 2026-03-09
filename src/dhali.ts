import { PaymentOption } from "./x402.js";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedDhaliConfig: Record<string, any> | null = null;

export async function createDhaliPayment(
    privateKey: string,
    amount: string,
    option: PaymentOption,
    paymentHeader?: string
): Promise<string> {
    const networkCode = option.network.toLowerCase();

    if (!cachedDhaliConfig) {
        const response = await fetch("https://raw.githubusercontent.com/Dhali-org/Dhali-config/master/public.prod.json");
        if (!response.ok) throw new Error("Failed to fetch Dhali public config");
        cachedDhaliConfig = await response.json();
    }

    const [protocol] = Object.entries(cachedDhaliConfig?.CAIP_2_MAPPINGS || {}).find(
        ([, c]) => typeof c === "string" && c.toLowerCase() === networkCode
    ) || [];

    if (!protocol) {
        throw new Error(`Dhali configuration missing protocol mapping for CAIP-2 network: ${option.network}`);
    }

    const isXrpl = protocol.startsWith("XRPL") || protocol.startsWith("XAHL");
    const isEthereum = protocol === "ETHEREUM" || protocol === "SEPOLIA";

    const endpointUrl = cachedDhaliConfig?.PUBLIC_CLIENTS?.[protocol]?.HTTP_CLIENT;
    if (!endpointUrl) throw new Error(`Missing endpoint for protocol ${protocol}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dhaliObj: any;
    try {
        // @ts-expect-error - dhali-js is not typed
        dhaliObj = await import("dhali-js");
    } catch {
        throw new Error("dhali-js is required for Dhali payments. please 'npm install dhali-js'.");
    }
    const { DhaliChannelManager, wrapAsX402PaymentPayload, Currency } = dhaliObj.default || dhaliObj;

    const currencyMetadata = cachedDhaliConfig?.DHALI_PUBLIC_ADDRESSES?.[protocol] || {};
    const assetLower = option.asset.toLowerCase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (Object.entries(currencyMetadata) as [string, any][]).find(
        ([, d]) => d.caip19?.toLowerCase() === assetLower
    );

    if (!result) {
        throw new Error(`Dhali configuration missing currency metadata for asset: ${option.asset} on protocol: ${protocol}`);
    }
    const [symbol, details] = result;

    const currencyObj = new Currency(protocol, symbol, details.scale, details.issuer);

    let claim: string;
    if (isEthereum) {
        const finalPriv = (privateKey.toLowerCase().startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
        const account = privateKeyToAccount(finalPriv);
        const publicClient = createPublicClient({ transport: http(endpointUrl) });
        const walletClient = createWalletClient({ account, transport: http(endpointUrl) });
        const manager = DhaliChannelManager.evm(walletClient, publicClient, currencyObj);
        claim = await manager.getAuthToken(amount);
    } else if (isXrpl) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let xrpl: any;
        try {
            xrpl = await import("xrpl");
        } catch {
            throw new Error("xrpl is required for XRPL payments. please 'npm install xrpl'.");
        }

        const wallet = xrpl.Wallet.fromSeed(privateKey);
        const client = new xrpl.Client(endpointUrl);
        await client.connect();
        try {
            const manager = DhaliChannelManager.xrpl(wallet, client, currencyObj);
            claim = await manager.getAuthToken(amount);
        } finally {
            await client.disconnect();
        }
    } else {
        throw new Error(`Unsupported network: ${option.network}`);
    }

    const headerToWrap = paymentHeader || Buffer.from(JSON.stringify({
        scheme: option.scheme,
        network: option.network,
        asset: option.asset,
        payTo: option.payTo,
        amount: amount.toString(),
        maxTimeoutSeconds: option.maxTimeoutSeconds,
        extra: option.extra || {},
    })).toString("base64");
    return wrapAsX402PaymentPayload(claim, headerToWrap);
}
