// QR-code login: scan with WeChat, get bot_token + baseurl, save to state/account.json.
// Usage: npm run login

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import qrTerm from "qrcode-terminal";

import {
  FIXED_LOGIN_BASE,
  getBotQrcode,
  pollQrcodeStatus,
  type QrStatusResp,
} from "./wx-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "..", "state");
const ACCOUNT_FILE = path.join(STATE_DIR, "account.json");

const MAX_QR_REFRESH = 3;
const LOGIN_TIMEOUT_MS = 8 * 60_000;

interface AccountState {
  bot_token: string;
  ilink_bot_id: string;
  ilink_user_id?: string;
  base_url: string;
  saved_at: string;
}

function loadExistingTokens(): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as AccountState;
    return data.bot_token ? [data.bot_token] : [];
  } catch {
    return [];
  }
}

function saveAccount(s: AccountState) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(s, null, 2), "utf-8");
}

function displayQr(content: string) {
  qrTerm.generate(content, { small: true });
  process.stdout.write(`\n如果二维码看不清，用浏览器打开：${content}\n\n`);
}

function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function run() {
  console.log("→ 正在向 ilinkai 申请二维码...");
  let qr = await getBotQrcode({ localTokenList: loadExistingTokens() });
  let baseUrl = FIXED_LOGIN_BASE;
  let qrRefreshCount = 1;
  let pendingVerifyCode: string | undefined;

  console.log("→ 请用手机微信扫码：\n");
  displayQr(qr.qrcode_img_content);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp: QrStatusResp = await pollQrcodeStatus({
      baseUrl,
      qrcode: qr.qrcode,
      verifyCode: pendingVerifyCode,
    });

    switch (resp.status) {
      case "wait":
        process.stdout.write(".");
        break;

      case "scaned":
        if (pendingVerifyCode) {
          console.log("\n✓ 配对码正确，等待手机确认...");
          pendingVerifyCode = undefined;
        } else {
          console.log("\n✓ 已扫描，等待手机确认...");
        }
        break;

      case "need_verifycode": {
        const prompt = pendingVerifyCode
          ? "❌ 配对码不正确，请重新输入："
          : "请输入手机上显示的数字配对码：";
        pendingVerifyCode = await readLine(prompt);
        continue; // 不 sleep，立即下一轮
      }

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH) {
          console.error("\n✗ 二维码多次过期，已放弃。");
          process.exit(1);
        }
        console.log(`\n⏳ 二维码过期，正在刷新 (${qrRefreshCount}/${MAX_QR_REFRESH})...`);
        qr = await getBotQrcode({ localTokenList: loadExistingTokens() });
        displayQr(qr.qrcode_img_content);
        break;
      }

      case "scaned_but_redirect":
        if (resp.redirect_host) {
          baseUrl = `https://${resp.redirect_host}`;
          console.log(`\n→ 切换轮询地址到 ${baseUrl}`);
        }
        break;

      case "verify_code_blocked":
        console.error("\n✗ 配对码输入错误次数过多，已被拦截。请稍后再试。");
        process.exit(1);

      case "binded_redirect":
        console.log("\n✓ 这个微信号已经绑过本机，不需要重新登录。");
        process.exit(0);

      case "confirmed": {
        if (!resp.ilink_bot_id || !resp.bot_token || !resp.baseurl) {
          console.error("\n✗ 服务端返回缺字段：", resp);
          process.exit(1);
        }
        const state: AccountState = {
          bot_token: resp.bot_token,
          ilink_bot_id: resp.ilink_bot_id,
          ilink_user_id: resp.ilink_user_id,
          base_url: resp.baseurl,
          saved_at: new Date().toISOString(),
        };
        saveAccount(state);
        console.log("\n✓ 登录成功，账号已保存到", ACCOUNT_FILE);
        console.log("   ilink_bot_id:", resp.ilink_bot_id);
        console.log("   base_url:    ", resp.baseurl);
        process.exit(0);
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.error("\n✗ 登录超时。");
  process.exit(1);
}

run().catch((err) => {
  console.error("登录失败：", err);
  process.exit(1);
});
