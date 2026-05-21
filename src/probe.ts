import fs from "node:fs";
import { getUpdates } from "./wx-client.js";

async function main() {
  const account = JSON.parse(fs.readFileSync("./state/account.json", "utf-8"));
  const buf = fs.existsSync("./state/get_updates_buf.txt")
    ? fs.readFileSync("./state/get_updates_buf.txt", "utf-8")
    : "";
  console.log("current buf bytes:", buf.length);

  const r1 = await getUpdates({
    baseUrl: account.base_url,
    token: account.bot_token,
    getUpdatesBuf: buf,
    timeoutMs: 8000,
  });
  console.log("--- poll1 (current buf) ---");
  console.log("ret/errcode:", r1.ret, r1.errcode, r1.errmsg);
  console.log("msg count:", r1.msgs?.length ?? 0);
  console.log("new buf bytes:", (r1.get_updates_buf ?? "").length);
  if (r1.msgs?.length) {
    console.log("first msg:", JSON.stringify(r1.msgs[0], null, 2).slice(0, 800));
  }

  const r2 = await getUpdates({
    baseUrl: account.base_url,
    token: account.bot_token,
    getUpdatesBuf: "",
    timeoutMs: 8000,
  });
  console.log("--- poll2 (empty buf) ---");
  console.log("ret/errcode:", r2.ret, r2.errcode, r2.errmsg);
  console.log("msg count:", r2.msgs?.length ?? 0);
  console.log("new buf bytes:", (r2.get_updates_buf ?? "").length);
  if (r2.msgs?.length) {
    console.log("first msg:", JSON.stringify(r2.msgs[0], null, 2).slice(0, 800));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
