// Long-polls ilinkai for new WeChat messages and replies via a Claude Skill persona.
// Usage: npm run bot
//
// Env vars (see ./README.md for the full list):
//   SKILL_DIR             path to your Claude Skill folder (default: ../skill)
//   BOT_CONTACT_NAME      what the persona calls the human (default: "对方")
//   BOT_MODEL             claude model alias (default: claude-sonnet-4-6)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractItems,
  getUpdates,
  notifyStart,
  notifyStop,
  sendTextMessage,
  type WeixinMessage,
} from "./wx-client.js";
import { downloadAndDecryptImage } from "./image-decrypt.js";
import {
  askClaudeBatch,
  nudgeClaude,
  loadPeerHistory,
  appendPeerTurn,
  summarizePeerFacts,
  AbortedError,
} from "./claude-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "..", "state");
const ACCOUNT_FILE = path.join(STATE_DIR, "account.json");
const BUF_FILE = path.join(STATE_DIR, "get_updates_buf.txt");
const SESSIONS_DIR = path.join(STATE_DIR, "sessions");
const IMAGES_DIR = path.join(STATE_DIR, "images");
const DEDUP_SIZE = 200;
const TYPE_USER = 1;

const NUDGE_THRESHOLD_MS = Number(process.env.BOT_NUDGE_THRESHOLD_MS ?? 6 * 3600 * 1000);
const NUDGE_CHECK_INTERVAL_MS = Number(process.env.BOT_NUDGE_CHECK_INTERVAL_MS ?? 60_000);
const NUDGE_ENABLED = (process.env.BOT_NUDGE_ENABLED ?? "true").toLowerCase() !== "false";

// Debounce: 用户连发多条 → 等他停顿后一次性回
const DEBOUNCE_MIN_MS = Number(process.env.BOT_DEBOUNCE_MIN_MS ?? 2000);
const DEBOUNCE_MAX_MS = Number(process.env.BOT_DEBOUNCE_MAX_MS ?? 6000);

interface PeerBufferItem {
  text: string;
  imagePaths: string[];
}
interface PeerBuffer {
  items: PeerBufferItem[];
  contextToken?: string;
  toUserId: string;
  timer: NodeJS.Timeout | null;
  isReplying: boolean;
  /** "computing" 阶段还可以 abort 掉 claude 子进程重新合批；"sending" 阶段已经在发微信了不能 abort */
  phase: "idle" | "computing" | "sending";
  abortController: AbortController | null;
}
const peerBuffers = new Map<string, PeerBuffer>();

function randomDebounce(): number {
  return DEBOUNCE_MIN_MS + Math.floor(Math.random() * Math.max(0, DEBOUNCE_MAX_MS - DEBOUNCE_MIN_MS));
}

interface PeerMeta {
  peerKey: string;
  toUserId: string;
  lastContextToken?: string;
  lastSeenAt: number;
  lastNudgeAt?: number;
  /** 由 claude 在每次回复时建议的下一次 nudge 时间（UTC ms）；null/undefined = 用全局默认 */
  nextNudgeAfter?: number | null;
  /** claude 主动说本轮"不要 nudge"（比如双方道别）；下条用户消息会清掉这个 flag */
  nudgeDisabled?: boolean;
}

function sanitizePeerKey(peerKey: string): string {
  return peerKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function metaFilePath(peerKey: string): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return path.join(SESSIONS_DIR, `${sanitizePeerKey(peerKey)}.meta.json`);
}

function loadPeerMeta(peerKey: string): PeerMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaFilePath(peerKey), "utf-8")) as PeerMeta;
  } catch {
    return null;
  }
}

function savePeerMeta(meta: PeerMeta): void {
  fs.writeFileSync(metaFilePath(meta.peerKey), JSON.stringify(meta, null, 2), "utf-8");
}

interface AccountState {
  bot_token: string;
  ilink_bot_id: string;
  ilink_user_id?: string;
  base_url: string;
}

function loadAccount(): AccountState {
  if (!fs.existsSync(ACCOUNT_FILE)) {
    console.error("✗ 找不到 state/account.json，请先跑 `npm run login`");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as AccountState;
}

function loadBuf(): string {
  try { return fs.readFileSync(BUF_FILE, "utf-8"); } catch { return ""; }
}
function saveBuf(buf: string): void {
  if (buf === undefined) return;
  fs.writeFileSync(BUF_FILE, buf, "utf-8");
}

const seenIds = new Set<string>();
const seenOrder: string[] = [];

function rememberSeen(id: string): boolean {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > DEDUP_SIZE) {
    const drop = seenOrder.shift();
    if (drop) seenIds.delete(drop);
  }
  return true;
}

function peerKeyOf(msg: WeixinMessage): string {
  // 群消息按 group_id+from；私聊按 from_user_id
  if (msg.group_id) return `group:${msg.group_id}:${msg.from_user_id ?? "unknown"}`;
  return `dm:${msg.from_user_id ?? "unknown"}`;
}

async function handleOne(account: AccountState, msg: WeixinMessage): Promise<void> {
  // Loopback guard: drop only the bot's own outbound echoes (from = bot id).
  // We DO want to handle messages from `ilink_user_id` — that's the scanner-user
  // talking to their own bot, which is the v0.1 happy path.
  if (msg.from_user_id === account.ilink_bot_id) return;
  if (msg.message_type !== TYPE_USER) return;
  if (!msg.from_user_id) return;

  const dedupKey = String(msg.message_id ?? `${msg.from_user_id}:${msg.create_time_ms}`);
  if (!rememberSeen(dedupKey)) return;

  const items = extractItems(msg);
  if (!items) {
    console.log(`[skip] non-text msg from ${msg.from_user_id}`);
    return;
  }
  const { text, images } = items;
  if (!text && images.length === 0) {
    console.log(`[skip] empty msg from ${msg.from_user_id}`);
    return;
  }

  const peerKey = peerKeyOf(msg);
  console.log(`[recv] ${peerKey}: ${text.slice(0, 80)}${images.length ? ` (+${images.length} img)` : ""}`);

  // 立刻把 user turn 写进历史（nudge 检测靠 history 最后一条，
  // 不写的话 debounce 等待期内会被误判成"很久没回"触发 nudge）
  appendPeerTurn(peerKey, { role: "user", text, ts: Date.now() });

  // 下载并 AES 解密图片，存到 state/images/<mid>_<idx>.jpg，把绝对路径传给后续 batch
  const imagePaths: string[] = [];
  if (images.length > 0) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const midKey = String(msg.message_id ?? `${msg.from_user_id}_${msg.create_time_ms ?? Date.now()}`);
    for (let i = 0; i < images.length; i++) {
      const dest = path.join(IMAGES_DIR, `${midKey.replace(/[^a-zA-Z0-9_-]/g, "_")}_${i}.jpg`);
      try {
        await downloadAndDecryptImage({
          url: images[i].url,
          aeskeyHex: images[i].aeskeyHex,
          destPath: dest,
        });
        imagePaths.push(dest);
        console.log(`[image] saved ${dest}`);
      } catch (err) {
        console.error(`[image] download/decrypt failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // 只 nudge 私聊；群聊不记 meta（v0.1 不支持主动 nudge 群）
  if (peerKey.startsWith("dm:")) {
    const existing = loadPeerMeta(peerKey);
    savePeerMeta({
      peerKey,
      toUserId: msg.from_user_id,
      lastContextToken: msg.context_token ?? existing?.lastContextToken,
      lastSeenAt: Date.now(),
      lastNudgeAt: existing?.lastNudgeAt,
    });
  }

  // Buffer + debounce
  let buf = peerBuffers.get(peerKey);
  if (!buf) {
    buf = {
      items: [],
      contextToken: undefined,
      toUserId: msg.from_user_id,
      timer: null,
      isReplying: false,
      phase: "idle",
      abortController: null,
    };
    peerBuffers.set(peerKey, buf);
  }
  buf.items.push({ text, imagePaths });
  buf.toUserId = msg.from_user_id;
  if (msg.context_token) buf.contextToken = msg.context_token;

  if (buf.isReplying) {
    if (buf.phase === "computing" && buf.abortController && !buf.abortController.signal.aborted) {
      console.log(`[buffer] ${peerKey} 新消息到达，computing 阶段 → abort claude，把刚到的消息合进下一批`);
      buf.abortController.abort();
      // 不在这里 schedule timer —— processBatch 的 catch 分支会把旧 batch prepend 回去并重新调度
      return;
    }
    console.log(`[buffer] ${peerKey} reply 已进入 sending 阶段，新消息入队 (${buf.items.length} pending)`);
    return;
  }

  if (buf.timer) clearTimeout(buf.timer);
  const wait = randomDebounce();
  console.log(`[buffer] ${peerKey} debounce ${wait}ms (${buf.items.length} pending)`);
  buf.timer = setTimeout(() => {
    void processBatch(account, peerKey);
  }, wait);
}

async function processBatch(account: AccountState, peerKey: string): Promise<void> {
  const buf = peerBuffers.get(peerKey);
  if (!buf) return;
  if (buf.items.length === 0) return;
  if (buf.isReplying) return;

  buf.isReplying = true;
  buf.timer = null;
  buf.phase = "computing";
  buf.abortController = new AbortController();
  const signal = buf.abortController.signal;
  const batch = buf.items.splice(0, buf.items.length);
  const contextToken = buf.contextToken;
  const toUserId = buf.toUserId;

  const imgCount = batch.reduce((s, it) => s + it.imagePaths.length, 0);
  console.log(`[batch] ${peerKey} processing ${batch.length} msg(s)${imgCount ? ` (含 ${imgCount} 张图)` : ""}`);

  let result: { text: string; nextCheckMinutes: number | null };
  try {
    result = await askClaudeBatch({ peerId: peerKey, batchItems: batch, signal });
  } catch (err) {
    if (err instanceof AbortedError) {
      // 把刚才那批消息塞回队列最前面（最新到的已经在 buf.items 里了）
      buf.items.unshift(...batch);
      buf.phase = "idle";
      buf.abortController = null;
      buf.isReplying = false;
      const wait = randomDebounce();
      console.log(`[batch] ${peerKey} aborted，重新合批 ${buf.items.length} 条，debounce ${wait}ms`);
      buf.timer = setTimeout(() => { void processBatch(account, peerKey); }, wait);
      return;
    }
    console.error("[claude error]", err);
    buf.phase = "idle";
    buf.abortController = null;
    buf.isReplying = false;
    return;
  }

  // 把 claude 建议的下次 nudge 时间存到 meta（每次回复都会更新，从而自适应）
  const existing = loadPeerMeta(peerKey);
  if (existing) {
    const n = result.nextCheckMinutes;
    const updated: PeerMeta = {
      ...existing,
      nudgeDisabled: n === -1,
      nextNudgeAfter: n != null && n > 0 ? Date.now() + n * 60_000 : null,
      lastNudgeAt: undefined, // 用户新一轮对话，清掉旧的 throttle
    };
    savePeerMeta(updated);
    if (n === -1) {
      console.log(`[batch] ${peerKey} claude 说本轮不要 nudge`);
    } else if (n != null) {
      console.log(`[batch] ${peerKey} 下次 nudge 检查 ${n} 分钟后`);
    }
  }

  if (result.text) {
    // 一旦开始发，就不能再 abort 了（abort 只会导致重复回复 / 半截回复）
    buf.phase = "sending";
    buf.abortController = null;
    await sendAsMultipleMessages({ account, toUserId, contextToken, fullText: result.text });
    // 异步刷新这个对端的事实摘要，不阻塞下一条用户消息。
    void summarizePeerFacts(peerKey).catch((err) =>
      console.error(`[facts] ${peerKey} background summarize error:`, err),
    );
  } else {
    console.log(`[skip] empty reply for ${peerKey}`);
  }

  buf.phase = "idle";
  buf.abortController = null;
  buf.isReplying = false;

  // 回复期间又来了新消息：再起一轮 debounce
  if (buf.items.length > 0) {
    const wait = randomDebounce();
    console.log(`[buffer] ${peerKey} new msgs during reply, debounce ${wait}ms`);
    buf.timer = setTimeout(() => {
      void processBatch(account, peerKey);
    }, wait);
  }
}

function splitIntoMessages(text: string): string[] {
  // 兼容字面 "\n"（claude 偶尔会输出两字符的反斜杠+n 而不是真换行）
  const normalized = text.replace(/\\n/g, "\n");
  return normalized
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SEND_GAP_MIN_MS = Number(process.env.BOT_SEND_GAP_MIN_MS ?? 1200);
const SEND_GAP_MAX_MS = Number(process.env.BOT_SEND_GAP_MAX_MS ?? 2500);

async function sendOneWithRetry(opts: {
  account: AccountState;
  toUserId: string;
  contextToken?: string;
  text: string;
  tag: string;
}): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendTextMessage({
        baseUrl: opts.account.base_url,
        token: opts.account.bot_token,
        toUserId: opts.toUserId,
        text: opts.text,
        contextToken: opts.contextToken,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = /稍后再试|频繁|too many|rate|429|busy/i.test(msg);
      console.error(`[${opts.tag} error] attempt ${attempt}: ${msg}`);
      if (attempt < 3 && isRateLimit) {
        const backoff = 2000 * attempt;
        console.log(`[${opts.tag}] rate-limited, backing off ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return false;
    }
  }
  return false;
}

async function sendAsMultipleMessages(opts: {
  account: AccountState;
  toUserId: string;
  contextToken?: string;
  fullText: string;
  tag?: string;
}): Promise<void> {
  const lines = splitIntoMessages(opts.fullText);
  if (lines.length === 0) return;
  const tag = opts.tag ?? "sent";
  for (let i = 0; i < lines.length; i++) {
    const ok = await sendOneWithRetry({
      account: opts.account,
      toUserId: opts.toUserId,
      contextToken: opts.contextToken,
      text: lines[i],
      tag,
    });
    if (!ok) return;
    console.log(`[${tag}] → ${opts.toUserId} (${i + 1}/${lines.length}): ${lines[i].slice(0, 80)}`);
    if (i < lines.length - 1) {
      // 句间延迟（默认 1200-2500ms），给服务端时间持久化前一条，避免乱序
      const jitter = SEND_GAP_MIN_MS + Math.floor(Math.random() * Math.max(0, SEND_GAP_MAX_MS - SEND_GAP_MIN_MS));
      await new Promise((r) => setTimeout(r, jitter));
    }
  }
}

async function maybeNudgeOne(account: AccountState, peerKey: string): Promise<void> {
  const meta = loadPeerMeta(peerKey);
  if (!meta) return;

  if (meta.nudgeDisabled) return;

  // Throttle: 网络抖动期最短间隔（不是真正的"下次 nudge"时间，那个由 nextNudgeAfter 控制）
  const throttleFloorMs = 10 * 60_000;
  if (meta.lastNudgeAt && Date.now() - meta.lastNudgeAt < throttleFloorMs) return;

  const history = loadPeerHistory(peerKey);
  if (history.length === 0) return;
  const last = history[history.length - 1];

  // 用户最后没回话 → 我们要 nudge；用户已经回过 → 我们应该回，不该 nudge。
  if (last.role !== "assistant" && last.role !== "assistant_nudge") return;

  // 动态阈值：claude 上一轮（回复或 nudge）建议的 nextNudgeAfter
  const target = meta.nextNudgeAfter ?? last.ts + NUDGE_THRESHOLD_MS;
  if (Date.now() < target) return;
  const idleMs = Date.now() - last.ts;

  // 立即落锁
  savePeerMeta({ ...meta, lastNudgeAt: Date.now() });

  console.log(`[nudge] ${peerKey} idle=${Math.round(idleMs / 60_000)}min, preparing...`);

  let result: { text: string; nextCheckMinutes: number | null };
  try {
    result = await nudgeClaude({ peerId: peerKey, idleHours: idleMs / 3_600_000 });
  } catch (err) {
    console.error("[nudge claude error]", err);
    return;
  }
  if (!result.text) {
    console.log(`[nudge skip] empty text`);
    return;
  }

  // 更新 meta：next-check / nudgeDisabled
  const cur = loadPeerMeta(peerKey) ?? meta;
  const n = result.nextCheckMinutes;
  savePeerMeta({
    ...cur,
    nudgeDisabled: n === -1,
    nextNudgeAfter: n != null && n > 0 ? Date.now() + n * 60_000 : null,
  });
  if (n === -1) {
    console.log(`[nudge] ${peerKey} claude 说本轮就到这，不再跟进`);
  } else if (n != null) {
    console.log(`[nudge] ${peerKey} 如果还不回，${n} 分钟后再来`);
  }

  await sendAsMultipleMessages({
    account,
    toUserId: meta.toUserId,
    contextToken: meta.lastContextToken,
    fullText: result.text,
    tag: "nudge sent",
  });
}

async function nudgeSweep(account: AccountState): Promise<void> {
  if (!NUDGE_ENABLED) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8")) as PeerMeta;
      await maybeNudgeOne(account, meta.peerKey);
    } catch (err) {
      console.error(`[nudge sweep] failed for ${f}:`, err);
    }
  }
}

async function loop() {
  const account = loadAccount();
  const stopController = new AbortController();
  let stopping = false;

  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n→ 收到退出信号，正在停止...");
    if (nudgeTimer) clearInterval(nudgeTimer);
    stopController.abort();
    await notifyStop({ baseUrl: account.base_url, token: account.bot_token });
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await notifyStart({ baseUrl: account.base_url, token: account.bot_token });
  console.log(`✓ 已连接 ${account.base_url}，等待消息...`);
  if (NUDGE_ENABLED) {
    console.log(
      `  主动 nudge: 阈值 ${Math.round(NUDGE_THRESHOLD_MS / 60_000)} 分钟，每 ${Math.round(NUDGE_CHECK_INTERVAL_MS / 1000)}s 扫一次`,
    );
  } else {
    console.log("  主动 nudge: 已禁用 (BOT_NUDGE_ENABLED=false)");
  }

  const nudgeTimer = NUDGE_ENABLED
    ? setInterval(() => {
        nudgeSweep(account).catch((e) => console.error("[nudge sweep top-level]", e));
      }, NUDGE_CHECK_INTERVAL_MS)
    : null;

  let buf = loadBuf();
  let consecutiveErrors = 0;

  while (!stopping) {
    try {
      const resp = await getUpdates({
        baseUrl: account.base_url,
        token: account.bot_token,
        getUpdatesBuf: buf,
        signal: stopController.signal,
      });

      if (resp.errcode === -14) {
        console.error("✗ 会话过期 (errcode=-14)，请重新跑 `npm run login`");
        process.exit(1);
      }

      if (typeof resp.get_updates_buf === "string" && resp.get_updates_buf !== buf) {
        buf = resp.get_updates_buf;
        saveBuf(buf);
      }

      consecutiveErrors = 0;

      if ((resp.msgs?.length ?? 0) > 0) {
        console.log(`[poll] got ${resp.msgs!.length} msg(s)`);
      }
      for (const msg of resp.msgs ?? []) {
        console.log(
          `[raw] type=${msg.message_type} state=${msg.message_state} from=${msg.from_user_id} to=${msg.to_user_id} mid=${msg.message_id}`,
        );
        // 不并行：保持回复顺序
        await handleOne(account, msg);
      }
    } catch (err) {
      if (stopping) break;
      consecutiveErrors++;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveErrors, 5));
      console.error(`[loop error] ${String(err)}，${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

loop().catch((err) => {
  console.error("致命错误：", err);
  process.exit(1);
});
