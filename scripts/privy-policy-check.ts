/**
 * Proves the treasury policy bites: ask the Privy treasury wallet to sign a TestUSD transfer to the previous
 * treasury. The policy allows only JingleSettlement.settle / absorbDispute / setOperator(previous) and
 * TestUSD.approve(settlement), so Privy must refuse. Nothing is broadcast either way.
 * Run: npm run privy:policy-check     needs TREASURY_SIGNER=privy and the Privy ids in .env
 */
import "dotenv/config";
import { loadArtifact, loadDeployment, privyWalletClientFor } from "../packages/monad/src/clients.js";

const main = async () => {
  const d = loadDeployment();
  if (d.treasurySigner !== "privy" || !d.previousTreasury) {
    console.log("treasury signer is the raw key; run npm run privy:treasury first");
    process.exit(0);
  }
  const pv = privyWalletClientFor(process.env);
  try {
    const hash = await pv.writeContract({ address: d.testUsd, abi: loadArtifact("TestUSD").abi, functionName: "transfer", args: [d.previousTreasury, 1n], chain: pv.chain, account: pv.account });
    console.error(`✗ policy ${d.privyPolicyId} let the treasury wallet sign a plain transfer: ${hash}`);
    process.exit(1);
  } catch (err) {
    // viem wraps the signer error; the Privy response is the innermost cause.
    let root: unknown = err;
    while (root instanceof Error && root.cause instanceof Error) root = root.cause;
    console.log(`✓ policy ${d.privyPolicyId} refused a transfer outside JingleSettlement:\n  ${(root instanceof Error ? root.message : String(root)).split("\n")[0].slice(0, 300)}`);
  }
};

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
