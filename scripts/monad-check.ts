/**
 * Print the live state on Monad: chain id, treasury MON, tUSD balances (treasury, merchant, reserve), contract totals.
 * Run: npm run monad:check
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { formatEther, formatUnits, type Address } from "viem";
import { deploymentPath, loadArtifact, loadDeployment, publicClientFor } from "../packages/monad/src/clients.js";

const main = async () => {
  const pub = publicClientFor();
  console.log(`chain ${await pub.getChainId()}  rpc ${pub.chain?.rpcUrls.default.http[0]}`);
  if (!existsSync(deploymentPath())) {
    console.log("no deployment yet: npm run deploy:monad");
    return;
  }
  const d = loadDeployment();
  const usd = loadArtifact("TestUSD").abi;
  const set = loadArtifact("JingleSettlement").abi;
  const balOf = (who: Address) => pub.readContract({ address: d.testUsd, abi: usd, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  const [mon, tre, mer, res, reserve, settled, disputed] = await Promise.all([
    pub.getBalance({ address: d.treasury }),
    balOf(d.treasury),
    balOf(d.merchant),
    balOf(d.settlement),
    pub.readContract({ address: d.settlement, abi: set, functionName: "reserve" }) as Promise<bigint>,
    pub.readContract({ address: d.settlement, abi: set, functionName: "totalSettled" }) as Promise<bigint>,
    pub.readContract({ address: d.settlement, abi: set, functionName: "totalDisputed" }) as Promise<bigint>,
  ]);
  const u = (x: bigint) => `$${formatUnits(x, 6)}`;
  console.log(`treasury   ${d.treasury}  MON ${formatEther(mon)}  tUSD ${u(tre)}`);
  console.log(`merchant   ${d.merchant}  tUSD ${u(mer)}`);
  console.log(`settlement ${d.settlement}  holds ${u(res)}  reserve ${u(reserve)}  settled ${u(settled)}  disputed ${u(disputed)}`);
  console.log(`explorer   ${d.explorerUrl}/address/${d.settlement}`);
};

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
