/**
 * Soroban token contract metadata resolution with an in-memory cache.
 *
 * @packageDocumentation
 */

import {
  Account,
  Contract,
  Keypair,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ClientConfig, validateClientConfig } from "./index";

/** Name, symbol, and decimal precision reported by a token contract. */
export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
}

type TokenMetadataRpcServer = Pick<rpc.Server, "simulateTransaction">;

const metadataCache = new Map<string, TokenMetadata>();
const inFlightLookups = new Map<string, Promise<TokenMetadata>>();

function cacheKey(tokenAddress: string, config: ClientConfig): string {
  return JSON.stringify([
    config.rpcUrl,
    config.networkPassphrase,
    tokenAddress,
  ]);
}

async function callTokenMethod(
  tokenAddress: string,
  method: "name" | "symbol" | "decimals",
  config: ClientConfig,
  server: TokenMetadataRpcServer
): Promise<unknown> {
  const source = new Account(Keypair.random().publicKey(), "0");
  const transaction = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(tokenAddress).call(method))
    .setTimeout(30)
    .build();

  const response = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(response)) {
    throw new Error(
      `Token contract ${tokenAddress} ${method}() simulation failed: ${response.error}`
    );
  }
  if (!rpc.Api.isSimulationSuccess(response)) {
    throw new Error(
      `Token contract ${tokenAddress} ${method}() simulation returned no result`
    );
  }
  const retval = response.result?.retval;
  if (!retval) {
    throw new Error(
      `Token contract ${tokenAddress} ${method}() simulation returned no value`
    );
  }
  return scValToNative(retval);
}

function metadataString(value: unknown, method: "name" | "symbol"): string {
  if (typeof value !== "string") {
    throw new Error(`Token contract ${method}() did not return a string`);
  }
  return value;
}

function metadataDecimals(value: unknown): number {
  const decimals =
    typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  if (
    typeof decimals !== "number" ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0
  ) {
    throw new Error("Token contract decimals() did not return a valid integer");
  }
  return decimals;
}

/**
 * Resolves `name()`, `symbol()`, and `decimals()` from a Soroban token
 * contract. Results are cached by token address and network configuration.
 *
 * `config` is required because the token address alone does not identify an
 * RPC endpoint or network passphrase. Pass a mockable RPC server in tests or
 * when using a custom Soroban transport.
 *
 * @param tokenAddress - Soroban token contract address.
 * @param config - RPC URL, network passphrase, and contract-client settings.
 * @param server - Optional RPC server implementation used to simulate calls.
 * @returns Resolved token metadata.
 * @throws {Error} If the address/configuration is invalid or a contract call
 *   fails or returns malformed metadata.
 */
export async function resolveTokenMetadata(
  tokenAddress: string,
  config: ClientConfig,
  server: TokenMetadataRpcServer = new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  })
): Promise<TokenMetadata> {
  if (!StrKey.isValidContract(tokenAddress)) {
    throw new Error(`Invalid token contract address: ${tokenAddress}`);
  }
  validateClientConfig(config);

  const key = cacheKey(tokenAddress, config);
  const cached = metadataCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = inFlightLookups.get(key);
  if (pending) {
    return pending;
  }

  const lookup = (async () => {
    const [nameValue, symbolValue, decimalsValue] = await Promise.all([
      callTokenMethod(tokenAddress, "name", config, server),
      callTokenMethod(tokenAddress, "symbol", config, server),
      callTokenMethod(tokenAddress, "decimals", config, server),
    ]);
    const metadata = {
      name: metadataString(nameValue, "name"),
      symbol: metadataString(symbolValue, "symbol"),
      decimals: metadataDecimals(decimalsValue),
    };
    metadataCache.set(key, metadata);
    return metadata;
  })();
  inFlightLookups.set(key, lookup);

  try {
    return await lookup;
  } finally {
    inFlightLookups.delete(key);
  }
}

