// WeChat C2C 图片解密：CDN 上存的是 AES-128-ECB 加密的原图，aeskey 是 16 字节 hex。
// 经过实测：aes-128-ecb + PKCS#7 padding，密文长度是 16 的倍数。

import { createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export async function downloadAndDecryptImage(opts: {
  url: string;
  aeskeyHex: string;
  destPath: string;
  timeoutMs?: number;
}): Promise<void> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let encrypted: Buffer;
  try {
    const res = await fetch(opts.url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    encrypted = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
  const key = Buffer.from(opts.aeskeyHex, "hex");
  if (key.length !== 16) {
    throw new Error(`aeskey 长度异常：解出 ${key.length}B，期望 16B`);
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  fs.mkdirSync(path.dirname(opts.destPath), { recursive: true });
  fs.writeFileSync(opts.destPath, decrypted);
}
