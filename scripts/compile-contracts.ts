/**
 * Compile contracts/*.sol with solc-js and write ABI + bytecode to contracts/artifacts/<Name>.json.
 * Run: npm run compile:contracts   (artifacts are committed so judges and the deploy script need no toolchain)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const solc = require("solc") as { compile(input: string): string; version(): string };

const dir = join(process.cwd(), "contracts");
const outDir = join(dir, "artifacts");
const files = readdirSync(dir).filter((f) => f.endsWith(".sol"));

const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(dir, f), "utf8") }])),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
};

const errors = (out.errors ?? []).filter((e) => e.severity === "error");
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

mkdirSync(outDir, { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces have no bytecode
    const artifact = { contractName: name, sourceName: file, compiler: `solc ${solc.version()}`, abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(artifact, null, 2) + "\n");
    console.log(`✓ ${name}  (${c.evm.bytecode.object.length / 2} bytes)  -> contracts/artifacts/${name}.json`);
  }
}
