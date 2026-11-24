import assert from "node:assert";
import { describe, test } from "node:test";
import {
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { resolveTokenMetadata } from "./tokens";
import type { ClientConfig } from "./index";

const tokenAddress =
  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";

function config(rpcUrl: string): ClientConfig {
  return {
    contractId: tokenAddress,
    rpcUrl,
    networkPassphrase: "Test SDF Network ; September 2015",
  };
}

function successfulSimulation(
  retval: xdr.ScVal
): rpc.Api.SimulateTransactionResponse {
  return {
    id: "mock",
    latestLedger: 1,
    events: [],
    _parsed: true,
    minResourceFee: "0",
    transactionData: new SorobanDataBuilder(),
    result: { auth: [], retval },
  } as rpc.Api.SimulateTransactionResponse;
}

describe("resolveTokenMetadata", () => {
  test("queries contract metadata and caches the result, including concurrent lookups", async () => {
    const values = [
      nativeToScVal("Stellar Lumens", { type: "string" }),
      nativeToScVal("XLM", { type: "string" }),
      nativeToScVal(7, { type: "u32" }),
    ];
    let calls = 0;
    const server = {
      simulateTransaction: async () =>
        successfulSimulation(values[calls++]),
    };
    const clientConfig = config("https://metadata-cache.example");

    const [first, concurrent] = await Promise.all([
      resolveTokenMetadata(tokenAddress, clientConfig, server),
      resolveTokenMetadata(tokenAddress, clientConfig, server),
    ]);
    const cached = await resolveTokenMetadata(
      tokenAddress,
      clientConfig,
      server
    );

    assert.deepStrictEqual(first, {
      name: "Stellar Lumens",
      symbol: "XLM",
      decimals: 7,
    });
    assert.deepStrictEqual(concurrent, first);
    assert.deepStrictEqual(cached, first);
    assert.strictEqual(calls, 3);
  });

  test("does not cache failed contract calls", async () => {
    let calls = 0;
    const server = {
      simulateTransaction: async () => {
        calls += 1;
        throw new Error("RPC unavailable");
      },
    };
    const clientConfig = config("https://metadata-failure.example");

    await assert.rejects(
      resolveTokenMetadata(tokenAddress, clientConfig, server),
      /RPC unavailable/
    );
    await assert.rejects(
      resolveTokenMetadata(tokenAddress, clientConfig, server),
      /RPC unavailable/
    );
    // 2 invocations * 3 method calls (name, symbol, decimals) attempted
    assert.strictEqual(calls, 6);
  });

  test("rejects malformed addresses and invalid token metadata", async () => {
    const server = {
      simulateTransaction: async () =>
        successfulSimulation(nativeToScVal("not decimals", { type: "string" })),
    };
    const clientConfig = config("https://metadata-invalid.example");

    await assert.rejects(
      resolveTokenMetadata("not-a-contract", clientConfig, server),
      /Invalid token contract address/
    );
    await assert.rejects(
      resolveTokenMetadata(tokenAddress, clientConfig, server),
      /Token contract decimals\(\) did not return a valid integer/
    );
  });
});
