import { webkit, devices } from "playwright";
import { screenById, settle } from "/root/Coding/ledger/.claude/worktrees/ui-polish/frontend/harness/nav.mjs";
const b = await webkit.launch();
const c = await b.newContext({ ...devices["iPhone 14 Pro"], viewport:{width:393,height:852} });
const p = await c.newPage();
await p.goto("http://127.0.0.1:5199", { waitUntil:"domcontentloaded" });
await settle(p, 1200);
await screenById("plan").goto(p);
await settle(p, 600);
const btns = await p.evaluate(()=>[...document.querySelectorAll("button")]
  .filter(x=>{const r=x.getBoundingClientRect();return r.width&&r.height})
  .map(x=>({t:(x.textContent||"").trim().replace(/\s+/g," ").slice(0,60), len:(x.textContent||"").trim().length})));
console.log("BUTTONS ON PLAN:", JSON.stringify(btns.slice(0,14), null, 1));
// tap the first envelope row
const row = p.locator('button[aria-label^="Open "]').first();
console.log("envelope rows:", await p.locator('button[aria-label^="Open "]').count());
if (await row.count()) { await row.click(); await p.waitForTimeout(900); }
console.log("dialog open?", await p.locator('[role=dialog]').count());
const geo = await p.evaluate(()=>{const d=document.querySelector('[role=dialog]'); if(!d) return null;
  const r=d.getBoundingClientRect(); return {vh:innerHeight, top:Math.round(r.top), bottom:Math.round(r.bottom), h:Math.round(r.height),
   scrollable:d.scrollHeight-d.clientHeight, inputs:d.querySelectorAll('input').length};});
console.log("SHEET GEO:", JSON.stringify(geo));
await b.close();
