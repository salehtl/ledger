// node verify.mjs <RECIPIENT_PRIV hex> — opens the Go-sealed fixture with the TS crypto.
import { readFileSync } from "node:fs";
import { openBlob, hexToBytes } from "./crypto.ts"; // run with: node --experimental-strip-types verify.mjs

const priv = hexToBytes(process.argv[2]);
const fixture = new Uint8Array(readFileSync("../blobgen/out/fixture.bin"));
const op = JSON.parse(new TextDecoder().decode(openBlob(fixture, priv)));
if (!op.iid || !Number.isInteger(op.amount) || !["debit", "credit"].includes(op.direction)) {
  console.error("FAIL: bad op", op);
  process.exit(1);
}
console.log("PASS: Go-sealed blob opened by TS crypto:", op.iid, op.amount, op.direction);
