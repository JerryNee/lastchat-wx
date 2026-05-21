// 直接通过 bot 发一条 ad-hoc 消息给登录用户。不写入会话历史。
// 用法：tsx src/probe-send.ts "要发的内容"
import fs from "node:fs";
import { sendTextMessage } from "./wx-client.js";

async function main() {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    console.error("usage: tsx src/probe-send.ts <message>");
    process.exit(2);
  }
  const account = JSON.parse(fs.readFileSync("./state/account.json", "utf-8"));
  if (!account.ilink_user_id) {
    console.error("no ilink_user_id in account.json");
    process.exit(1);
  }
  // 尝试读最近的 contextToken（便于送到正确的会话）；没有就不带
  let contextToken: string | undefined;
  try {
    const meta = JSON.parse(
      fs.readFileSync(
        `./state/sessions/dm_${account.ilink_user_id.replace(/[^a-zA-Z0-9_-]/g, "_")}.meta.json`,
        "utf-8",
      ),
    );
    contextToken = meta.lastContextToken;
  } catch { /* no meta yet, skip */ }

  console.log(`sending to ${account.ilink_user_id}: ${text}`);
  await sendTextMessage({
    baseUrl: account.base_url,
    token: account.bot_token,
    toUserId: account.ilink_user_id,
    text,
    contextToken,
  });
  console.log("OK");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
