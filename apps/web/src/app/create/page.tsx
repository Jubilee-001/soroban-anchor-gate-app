"use client";

import React, { useCallback, useEffect, useState } from "react";
import { getAddress, getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { Address, Contract, rpc, scValToNative } from "@stellar/stellar-sdk";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EscrowWizard } from "@/components/wizard/EscrowWizard";
import { MobileNav } from "@/components/MobileNav";
import { getAppConfig } from "@/lib/config";
import { hashRoutingInfo } from "@/lib/crypto";
import {
  buildEscrowContractCall,
  buildInitialTransaction,
  pollTransactionConfirmation,
  simulateAndPrepareTransaction,
  submitSignedTransaction,
  validateEscrowForm,
  verifyWalletNetwork,
} from "@/lib/transaction";
import type { WizardState } from "@/lib/wizard";

const config = getAppConfig();
const TOKENS = [
  { label: "Native SAC (XLM)", address: config.nativeSacTokenAddress },
  { label: "USDC SAC", address: "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT" },
];

export default function CreateEscrowPage() {
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    isConnected()
      .then((c) => (c ? getAddress() : null))
      .then((a) => a?.address && setWallet(a.address))
      .catch(() => undefined);
  }, []);

  const connect = async () => {
    try {
      await requestAccess();
      setWallet((await getAddress()).address);
    } catch (e) {
      setMessage(`Wallet connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const fetchBalance = useCallback(
    async (token: string) => {
      const server = new rpc.Server(config.rpcUrl);
      const op = new Contract(token).call("balance", new Address(wallet).toScVal());
      const tx = await buildInitialTransaction(server, wallet, op, config.networkPassphrase);
      const sim = await server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
      return BigInt(scValToNative(sim.result.retval));
    },
    [wallet]
  );

  const prepare = async (s: WizardState) => {
    const validated = validateEscrowForm({
      payer: wallet,
      beneficiary: s.beneficiary,
      token: s.token,
      amount: s.amount,
      lockDurationDays: s.lockDurationDays,
      routingInfo: s.routingInfo,
    });
    const hash = await hashRoutingInfo(validated.routingInfo);
    const server = new rpc.Server(config.rpcUrl);
    const tx = await buildInitialTransaction(
      server,
      wallet,
      buildEscrowContractCall(config.contractId, validated, hash),
      config.networkPassphrase
    );
    return { server, ...(await simulateAndPrepareTransaction(server, tx)) };
  };

  const simulate = async (s: WizardState) => {
    const { simulation } = await prepare(s);
    const fee = "minResourceFee" in simulation ? simulation.minResourceFee : "unknown";
    return `Simulation OK. Estimated resource fee: ${fee} stroops.`;
  };

  const submit = async (s: WizardState) => {
    setBusy(true);
    try {
      verifyWalletNetwork(await getNetworkDetails(), config.networkPassphrase);
      setMessage("Simulating transaction…");
      const { server, preparedTx } = await prepare(s);
      setMessage("Awaiting signature in Freighter…");
      const signed = await signTransaction(preparedTx.toXDR(), { networkPassphrase: config.networkPassphrase });
      const xdrStr = typeof signed === "string" ? signed : (signed as { signedTxXdr?: string }).signedTxXdr;
      if (!xdrStr) throw new Error("Freighter did not return a signed transaction");
      setMessage("Submitting…");
      const hash = await submitSignedTransaction(server, xdrStr, config.networkPassphrase);
      const conf = await pollTransactionConfirmation(server, hash);
      setMessage(`Escrow confirmed in ledger ${conf.ledger}. Tx ${hash.slice(0, 10)}…`);
    } catch (e) {
      setMessage(`Escrow creation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <MobileNav className="mb-4" />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Create Escrow</CardTitle>
              <CardDescription>Four guided steps to lock funds with an anchor routing commitment.</CardDescription>
            </div>
            {!wallet && <Button onClick={connect}>Connect Freighter</Button>}
          </div>
        </CardHeader>
        <CardContent>
          <EscrowWizard
            walletAddress={wallet}
            tokens={TOKENS}
            fetchBalance={fetchBalance}
            simulate={simulate}
            onSubmit={submit}
            busy={busy}
            statusMessage={message}
          />
        </CardContent>
      </Card>
    </main>
  );
}
