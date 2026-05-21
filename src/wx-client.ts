// HTTP client for Tencent ilinkai (the backend behind WeChat openclaw-weixin plugin).
// Mirrors the protocol from https://github.com/Tencent/openclaw-weixin (v2.4.3).

import crypto from "node:crypto";

export const FIXED_LOGIN_BASE = "https://ilinkai.weixin.qq.com";
export const ILINK_APP_ID = "bot";
export const CHANNEL_VERSION = "2.4.3";
export const BOT_AGENT = "lastchat-wx/0.1.0";
export const DEFAULT_BOT_TYPE = "3";

const CLIENT_VERSION = (2 << 16) | (4 << 8) | 3;

function randomWechatUin(): string {
  const u32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(u32), "utf-8").toString("base64");
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
}

function postHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token?.trim()) h.Authorization = `Bearer ${token.trim()}`;
  return h;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}

async function postJSON(opts: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const url = new URL(opts.endpoint, ensureTrailingSlash(opts.baseUrl));
  const controller = opts.timeoutMs != null ? new AbortController() : undefined;
  const t = controller && opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  const signal = mergeSignals(controller?.signal, opts.signal);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: postHeaders(opts.token),
      body: JSON.stringify(opts.body),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${opts.endpoint} ${res.status}: ${text}`);
    return text;
  } finally {
    if (t) clearTimeout(t);
  }
}

async function getRaw(opts: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
}): Promise<string> {
  const url = new URL(opts.endpoint, ensureTrailingSlash(opts.baseUrl));
  const controller = opts.timeoutMs != null ? new AbortController() : undefined;
  const t = controller && opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: commonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${opts.endpoint} ${res.status}: ${text}`);
    return text;
  } finally {
    if (t) clearTimeout(t);
  }
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const fwd = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  else {
    a.addEventListener("abort", fwd, { once: true });
    b.addEventListener("abort", fwd, { once: true });
  }
  return ctrl.signal;
}

// ---------------------------------------------------------------------------
// Login (QR)
// ---------------------------------------------------------------------------

export interface QrCode {
  qrcode: string;
  qrcode_img_content: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResp {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export async function getBotQrcode(opts: {
  botType?: string;
  localTokenList?: string[];
}): Promise<QrCode> {
  const botType = opts.botType ?? DEFAULT_BOT_TYPE;
  const text = await postJSON({
    baseUrl: FIXED_LOGIN_BASE,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: opts.localTokenList ?? [] },
  });
  return JSON.parse(text) as QrCode;
}

export async function pollQrcodeStatus(opts: {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
  timeoutMs?: number;
}): Promise<QrStatusResp> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(opts.qrcode)}`;
  if (opts.verifyCode) endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode)}`;
  try {
    const text = await getRaw({
      baseUrl: opts.baseUrl,
      endpoint,
      timeoutMs: opts.timeoutMs ?? 35_000,
    });
    return JSON.parse(text) as QrStatusResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export interface TextItem { text?: string }
export interface ImageItemMedia {
  full_url?: string;
  aes_key?: string;
  encrypt_query_param?: string;
}
export interface ImageItem {
  aeskey?: string;       // hex string, 32 chars = 16 bytes（AES-128 key）
  media?: ImageItemMedia;
  mid_size?: number;
  thumb_size?: number;
}
export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: { text?: string; encode_type?: number };
  file_item?: { file_name?: string };
  video_item?: unknown;
  ref_msg?: { title?: string };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;   // 1 = USER, 2 = BOT
  message_state?: number;  // 0 NEW, 1 GENERATING, 2 FINISH
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export async function getUpdates(opts: {
  baseUrl: string;
  token: string;
  getUpdatesBuf?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GetUpdatesResp> {
  const timeout = opts.timeoutMs ?? 35_000;
  try {
    const text = await postJSON({
      baseUrl: opts.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: opts.getUpdatesBuf ?? "", base_info: baseInfo() },
      token: opts.token,
      timeoutMs: timeout,
      signal: opts.signal,
    });
    return JSON.parse(text) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: opts.getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `lc-${crypto.randomBytes(8).toString("hex")}-${Date.now()}`;
}

export interface SendMessageResult {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export async function sendTextMessage(opts: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
}): Promise<SendMessageResult> {
  const raw = await postJSON({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: {
      msg: {
        from_user_id: "",
        to_user_id: opts.toUserId,
        client_id: generateClientId(),
        message_type: 2,   // BOT
        message_state: 2,  // FINISH
        item_list: [{ type: 1, text_item: { text: opts.text } }],
        context_token: opts.contextToken,
      },
      base_info: baseInfo(),
    },
    token: opts.token,
    timeoutMs: 15_000,
  });
  let parsed: SendMessageResult = {};
  try { parsed = JSON.parse(raw) as SendMessageResult; } catch { /* empty body ok */ }
  if ((parsed.ret != null && parsed.ret !== 0) || (parsed.errcode != null && parsed.errcode !== 0)) {
    const err = new Error(
      `sendMessage server error: ret=${parsed.ret} errcode=${parsed.errcode} errmsg=${parsed.errmsg}`,
    );
    (err as Error & { sendResult?: SendMessageResult }).sendResult = parsed;
    throw err;
  }
  return parsed;
}

export async function notifyStart(opts: { baseUrl: string; token: string }): Promise<void> {
  try {
    await postJSON({
      baseUrl: opts.baseUrl,
      endpoint: "ilink/bot/msg/notifystart",
      body: { base_info: baseInfo() },
      token: opts.token,
      timeoutMs: 10_000,
    });
  } catch {
    // observability only; safe to ignore
  }
}

export async function notifyStop(opts: { baseUrl: string; token: string }): Promise<void> {
  try {
    await postJSON({
      baseUrl: opts.baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      body: { base_info: baseInfo() },
      token: opts.token,
      timeoutMs: 10_000,
    });
  } catch {
    // observability only; safe to ignore
  }
}

// Extract a plain-text representation of an inbound message (best-effort).
export function extractText(msg: WeixinMessage): string | null {
  if (!msg.item_list?.length) return null;
  const parts: string[] = [];
  for (const it of msg.item_list) {
    if (it.text_item?.text) parts.push(it.text_item.text);
    else if (it.voice_item?.text) parts.push(`[语音转文字] ${it.voice_item.text}`);
    else if (it.image_item) parts.push("[图片]");
    else if (it.file_item) parts.push(`[文件 ${it.file_item.file_name ?? ""}]`);
    else if (it.video_item) parts.push("[视频]");
    else if (it.ref_msg?.title) parts.push(`[引用 ${it.ref_msg.title}]`);
  }
  return parts.length ? parts.join("\n") : null;
}

export interface ExtractedImage {
  url: string;
  aeskeyHex: string;
}

export interface ExtractedItems {
  text: string;                  // 占位符 + 文本拼接（用于历史回放展示）
  images: ExtractedImage[];      // 需要下载解密的图片
}

export function extractItems(msg: WeixinMessage): ExtractedItems | null {
  if (!msg.item_list?.length) return null;
  const parts: string[] = [];
  const images: ExtractedImage[] = [];
  for (const it of msg.item_list) {
    if (it.text_item?.text) parts.push(it.text_item.text);
    else if (it.voice_item?.text) parts.push(`[语音转文字] ${it.voice_item.text}`);
    else if (it.image_item) {
      const url = it.image_item.media?.full_url;
      const aeskeyHex = it.image_item.aeskey;
      if (url && aeskeyHex) {
        images.push({ url, aeskeyHex });
      }
      parts.push("[图片]");
    }
    else if (it.file_item) parts.push(`[文件 ${it.file_item.file_name ?? ""}]`);
    else if (it.video_item) parts.push("[视频]");
    else if (it.ref_msg?.title) parts.push(`[引用 ${it.ref_msg.title}]`);
  }
  if (parts.length === 0 && images.length === 0) return null;
  return { text: parts.join("\n"), images };
}
