// One-off: 用整个 history 给指定 peer 跑一次事实摘要。
// 用法：BOT_FACTS_TURNS=999 npx tsx src/bootstrap-facts.ts <peerId>
import { summarizePeerFacts } from "./claude-bridge.js";

const peerId = process.argv[2];
if (!peerId) {
  console.error("用法: tsx src/bootstrap-facts.ts <peerId>");
  process.exit(1);
}

await summarizePeerFacts(peerId);
console.log("done");
