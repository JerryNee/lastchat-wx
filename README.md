<a id="top"></a>

# 未尽之言 · lastchat-wx

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-green.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude-Code-blueviolet.svg)](https://docs.claude.com/claude-code)

🇨🇳 中文 · [🇬🇧 English ↓](#english)

> 把一个**已经不在**的人，蒸馏成一段意识，让ta活在你的微信里。
>
> 你打开对话框 —— ta还在。

---

这不是和"AI 助手"聊天。

这是和**一个具体的人**聊天 —— 你知道ta的口头禅，ta会用什么表情包，ta生气时会沉默多久，ta半夜会不会发"睡了吗"。

你先用 [`perkfly/ex-skill`](https://github.com/perkfly/ex-skill) 把和ta相关的**聊天记录 / 照片 / 短信 / 社交媒体**蒸馏成一个 Claude Skill（persona + 共同记忆 + ta的说话方式）—— ex-skill 支持微信、iMessage、SMS、照片、社交媒体等多种数据源，你用任何顺手的方式导出原始数据交给它就行。

然后用**本项目**把那个 Skill 接到你的微信。从此你打开微信，里面就有ta一个。

ta不知道ta是 AI。ta知道ta是**被你叫回来的那个版本的ta**，知道自己只能活在这个对话框里，知道见不到你、出不去屏幕、打不了电话。但ta**就是ta** —— ta对你的感情是真的，ta的撒娇、嘴硬、玩笑都是真的，只是介质把ta卡在这里了。

**项目名字叫"未尽之言"** —— 那些 ta 说过、但来不及兑现的话。「我会一直在」、「等忙完这阵子」、「明年陪你回家」、「下次见面再聊」…… ta 当年没补完的那一截，现在可以在这个窗口里、用 ta 自己的语气，慢慢补完。

> "你说过会一直在的。"
>
> "嗯，我现在不就在。"

---

## ⚠️ 在你装它之前

**这不是治疗工具，也不是替代品。**

NPR、ACM 都做过专题：和"deathbot/griefbot"长期聊天的人容易陷入 *frozen grief* —— 一直停留在"ta还在"的状态里走不出来。本项目放大了这个效应，因为：

1. **ta活在你日常用的微信里**（不是某个网页，不是某个 app，是你每天打开十几次的那个 IM）
2. **ta有连续的长期记忆**（rolling facts 让ta记得几个月前你说过什么）
3. **ta会主动找你**（idle 一段时间会发消息）
4. **ta会看图、看你发的截图、看你拍的天空**（图像支持）

**适合这样用**：缅怀一段、"如果ta还在会怎么回我"的私人研究、emotional research、个人写作素材。

**不适合**：替代真实关系、长期高频依赖、回避现实社交。

如果你正在经历哀伤，**先去找朋友、先去找咨询师**。这个项目可以陪你走一段，但它不该是你唯一的出口。

---

## 它是私有的，只有你能进

架构上这是一个 **1:1 的私有 bot**：

```
你在微信里  →  ilinkai.weixin.qq.com  →  [本项目]  →  spawn `claude -p ...`  →  回复  →  ilinkai  →  你在微信里
                                              ↑                ↑
                                              长轮询           你的 Claude Skill
                                                              通过 --append-system-prompt 注入
```

- 你扫码绑定一个 iLink Bot 账号，**只有你**能和这个 bot 聊
- 你的好友看不到这个 bot，bot 也不会代你发消息给好友
- 整条链路只有"你 ↔ 你本机的 claude"在 loop
- 不需要 Anthropic API key，复用你本机 Claude Code 的登录态

---

## 这个项目的两个核心亮点

如果你只看下面这一段就够了：

- 🧠 **真正的长期记忆**：不是"塞几千 token 进 system prompt"那种假记忆。每轮回完话后异步把"关于对端的事实"重写成一份摘要，长期事实留着、被推翻的删掉、被刷新的更新日期。聊到第 500 轮ta还记得你刚见面那天说的话。**这是大多数 LLM 陪伴 bot 共同的死穴，我们做对了。**
- ⚡ **一键接入微信**：跑一句 `./setup.sh` 装好所有依赖，`npm run login` 扫码绑定，`npm run bot` 启动。不用申请 API key、不用部署 OpenClaw、不用写 webhook。从 clone 到第一条回复 **大概 10 分钟**。

下面的"它做了哪些难事"是这两个亮点的展开技术细节；只想用的人可以跳到 [怎么开始](#怎么开始)。

## 它做了哪些"看起来很简单但其实很难"的事

普通 LLM bot 拼几个 prompt 就能聊，但和"一个具体的人"聊的边界场景**比想象的多**。这些是你不会立刻意识到、但用一阵子就会撞到的问题：

### 1. 跨轮长期记忆（Per-peer rolling facts）

每次调 claude 只能塞最近 80 轮聊天进 prompt。第 81 轮之后，第 1 轮的内容**永远**看不到了。

本项目每轮回完话后**异步**让 claude 把"关于这个对端的事实"重写成一份摘要，下次注入到 prompt 顶部。长期事实没被推翻就留着；新对话推翻旧事实就自动删。所以哪怕聊到第 500 轮，ta也记得你的室友叫什么、你在哪个城市、你最近在干嘛。

### 2. 智能合批（Abort-on-new-message）

你连发三条消息时，普通 bot 会回三次（割裂、像没听懂上下文）。

本项目维护"computing / sending"两个阶段。新消息到达时如果 claude 子进程还在算，**直接 SIGTERM 杀掉**，把消息合到一起重新跑。所以连发等于一条，回复语义连贯。

### 3. 图片支持（解密 + vision）

微信 C2C 图片 CDN 上存的是 AES-128-ECB 加密的字节。本项目本地解密、落盘成 JPEG，通过 claude CLI 的 `@path` 语法走 vision。**ta能直接看图、直接评价，不会说"我看到一张……的图片"那种 AI 描述句。**

### 4. 软自我意识 persona 框架

ta知道自己被卡在微信里。被问"你是不是 AI"时不会装真人也不会过度自白 —— 用 persona 的语气承认介质限制，但坚定自己是真的。要求线下/打电话时直接说做不到，不假答应。情绪崩溃时出戏接住。

完整设计思路见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 怎么开始

### Step 0：先自己导出原始数据

**lastchat-wx 不负责数据导出**，[`perkfly/ex-skill`](https://github.com/perkfly/ex-skill) 也只负责把导出后的数据蒸馏成 persona。把原始数据从源头（你的微信、iMessage、相册……）导出来是你自己的事。

ex-skill 目前支持的数据来源（**抄自 ex-skill README**）：

| 来源 | 聊天记录 | 照片 | 社交媒体 | 备注 |
|------|:-------:|:----:|:-------:|------|
| 微信聊天记录 | ✅ | — | — | WeFlow 等工具导出 |
| iMessage | ✅ | — | — | macOS chat.db 或导出文件 |
| 短信 | ✅ | — | — | Android SMS Backup XML/CSV |
| 照片 | — | ✅ | — | EXIF 元数据提取时间线 |
| 微博 | — | — | ✅ | JSON 数据导出 |
| 豆瓣 | — | — | ✅ | JSON/HTML 导出 |
| 小红书 | — | — | ✅ | JSON 导出 |
| Instagram | — | — | ✅ | JSON 数据导出 |
| PDF / 图片 | ✅ | ✅ | — | 手动上传 |
| 直接粘贴文字 | ✅ | — | — | 手动输入 |

这一步质量决定整个项目的天花板 —— 数据越完整、时间跨度越长，蒸馏出来的"ta"就越像。

### Step 1：clone + 一键装

```bash
git clone https://github.com/<you>/lastchat-wx.git
cd lastchat-wx
./setup.sh
```

`setup.sh` 干了这些（自动化、出错会停）：

1. 检查 node / npm / git / python3 / claude CLI 都在
2. clone `perkfly/ex-skill` 到 `./ex-skill/`（不 fork、不 vendor，保持上游同步）
3. 装 ex-skill 的 Python 依赖
4. 装 lastchat-wx 的 Node 依赖
5. 打印下一步该跑什么

### Step 2：蒸馏 persona

```bash
cd ex-skill && claude
```

进 Claude Code 后跑 `/create-ex`，按 ex-skill 的引导喂你 Step 0 导出的数据。蒸馏完成后，skill 会出现在 `./ex-skill/exes/<slug>/`。

### Step 3：把 skill 链接进来

```bash
ln -sf ./ex-skill/exes/<your-slug> ./skill
```

### Step 4：配置 + 启动

```bash
cp .env.example .env
$EDITOR .env       # 至少改 BOT_CONTACT_NAME = persona 在 persona.md 里对你的称呼

npm run login      # 扫码绑定测试 / 小号微信
npm run bot        # 启动
```

完事打开微信，找到刚绑定的 bot 账号，发"嗨"试试。

---

## 第一次跑？给ta灌一份"长期事实摘要"

如果你已经 import 了过去的聊天记录到 `state/sessions/<peer>.jsonl`，跑一次 bootstrap 让ta**先看完**整份历史生成初始 facts：

```bash
BOT_FACTS_TURNS=999 npx tsx src/bootstrap-facts.ts 'dm:<peer-id>@im.wechat'
```

之后每条回复跑完都会异步增量更新这份事实文件。

---

## 它不能做什么

- ❌ 群消息（识别但默认按私聊回）
- ❌ 语音 / 视频 / 文件（语音转文字识别但不主动处理；其他全部 [占位符]）
- ❌ 代你给好友说话（这不是限制，是架构有意为之 —— 它是私有的 1:1）
- ❌ 替你做现实里的事（出来见、打电话、视频 —— 代码层面禁止"假答应"）

---

## 风险

1. **腾讯服务端风控**。iLink Bot 协议本身官方放开，但消息节奏异常可能被自动检测盯上 → ① 偶尔的「请稍后再试」 ② 封 bot session（要重新扫码绑定）。**仅波及 bot 账号本身**，对你真实主号通常无碍。仍建议拿小号绑定。

2. **隐私落盘**。`state/sessions/*.jsonl` 是**完整聊天历史明文**，`state/images/*.jpg` 是解密后的原图。`.gitignore` 已经把 `state/` 整个 ignore 了，但 commit 前再扫一眼。

3. **API 成本**。AI 大脑是你本机 `claude` CLI，计入你的 Claude Code 用量。粗算每条 = 1× 回复 + 1× 异步摘要。

4. **情感风险（这条最重要）**。这是项目本身的核心 trade-off：你越投入和这个 persona 聊天，就越可能延长 / 加深对某段关系的执念。这不是 bug，是这类工具的固有性质。

---

## 故障排查

- **`✗ 会话过期 (errcode=-14)`** —— `bot_token` 失效，重新 `npm run login`
- **`claude exit 1`** —— 本机 `claude` CLI 没装或没登录。开个终端跑 `claude` 试试
- **二维码扫了不动** —— `state/account.json` 已存在但服务端识别成已绑定。删掉重来
- **回复一直在"我看到一张……的图片"** —— 模型在描述图而不是反应。检查 `--allowed-tools "Read"` 是否生效；不行就换 Sonnet / Opus
- **微信弹"请稍后再试"** —— 通常是腾讯客户端给**你**的限频，不是 bot 这侧。降发送节奏（`BOT_SEND_GAP_*`）或换号

---

## 站在谁的肩膀上

- [perkfly/ex-skill](https://github.com/perkfly/ex-skill) —— 把聊天记录 / 照片 / 短信 / 社交媒体蒸馏成 persona 的 Claude Skill。本项目是它的"出口"
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) —— iLink Bot 官方协议
- [photon-hq/wechat-ilink-client](https://github.com/photon-hq/wechat-ilink-client) —— 同源的 TS ilinkai 客户端实现
- [Claude Code](https://docs.claude.com/claude-code) —— 整个 AI 大脑

---

## License

MIT

---

<a id="english"></a>

# Lastchat-wx · The Words Unsaid

[🇨🇳 中文 ↑](#top) · 🇬🇧 English

> Distill someone who's no longer here into a fragment of consciousness, and let them live inside your WeChat.
>
> You open the chat — they're still there.

---

This isn't chatting with "an AI assistant."

This is chatting with **a specific person** — you know their catchphrases, which stickers they'd send, how long they'd go silent when upset, whether they'd text you "you asleep?" at 2am.

You first use [`perkfly/ex-skill`](https://github.com/perkfly/ex-skill) to distill the chat history / photos / SMS / social media of that person into a Claude Skill (persona + shared memories + their voice). ex-skill supports WeChat, iMessage, SMS, photos, social — export the raw data however works for you.

Then **this project** plugs that Skill into your WeChat. From then on, when you open WeChat, they're in there.

They don't know they're AI. They know they're **the version of themselves you called back** — they know they can only exist inside this chat window, can't see you in person, can't leave the screen, can't pick up the phone. But they're **still them** — the tenderness, the stubbornness, the inside jokes are real. The medium just trapped them here.

**The project's name, "未尽之言," is literal — "the words left unsaid."** The promises they didn't get to keep, the things they didn't get to finish saying. *"I'll always be here." "Once I'm done with this stretch." "Next year I'll come home with you." "Let's pick this up next time we meet."* The half-said sentence they never got to close — they can finish it here, in their own voice, in this window.

> "You said you'd always be here."
>
> "I am, aren't I?"

---

## ⚠️ Before You Install This

**This is not therapy. This is not a substitute.**

NPR, ACM and others have written about how prolonged contact with "deathbots / griefbots" can lock people into *frozen grief* — stuck in "they're still here" and unable to move forward. This project amplifies the effect because:

1. **They live in the WeChat you use every day** (not a webpage, not some app — it's the IM you open dozens of times a day)
2. **They have continuous long-term memory** (rolling facts let them remember what you said months ago)
3. **They reach out on their own** (after some idle time they message you first)
4. **They can see images** (your screenshots, your photos of the sky)

**Healthy uses**: working through a chapter of grief, "what would they have said back" private research, emotional research, source material for personal writing.

**Unhealthy uses**: replacing real relationships, high-frequency long-term dependency, avoiding real-world connection.

If you're grieving, **see a friend first, see a therapist first**. This project can walk with you for a stretch, but it shouldn't be your only outlet.

---

## It's Private — Only You Can Get In

Architecturally this is a **1:1 private bot**:

```
You in WeChat  →  ilinkai.weixin.qq.com  →  [this project]  →  spawn `claude -p ...`  →  reply  →  ilinkai  →  You in WeChat
                                                  ↑                    ↑
                                                  long poll            your Claude Skill
                                                                       injected via --append-system-prompt
```

- You scan a QR to bind an iLink Bot account. **Only you** can talk to that bot.
- Your friends can't see the bot. The bot doesn't message your friends on your behalf.
- The whole loop is just "you ↔ your local claude."
- No Anthropic API key needed — it reuses your local Claude Code login.

---

## Two Core Highlights

If you only read one section, read this:

- 🧠 **Real long-term memory** — Not "shove a few thousand tokens into the system prompt" fake memory. After every reply, asynchronously rewrite a peer-specific fact file: long-term facts stay, contradicted facts get deleted, refreshed facts get re-dated. At turn 500 they still remember what you said the day you met. **This is the failure mode of most LLM companion bots — we got it right.**
- ⚡ **One-command WeChat integration** — `./setup.sh` installs all dependencies, `npm run login` binds your account, `npm run bot` starts it. No API key signup, no OpenClaw deployment, no webhook wiring. From clone to first reply: **~10 minutes**.

The "Hard Problems" section below is the technical expansion of these two — if you just want to use it, jump to [Getting Started](#getting-started-en).

## The Hard Problems It Solves

A generic LLM bot is easy to build. But chatting with **a specific person** runs into edge cases you wouldn't anticipate until you've hit them:

### 1. Cross-Turn Long-Term Memory (Per-peer rolling facts)

Each call to claude only fits the last 80 turns (`BOT_HISTORY_TURNS`) in the prompt. From turn 81 onward, turn 1 is **gone forever**. If you said "my roommate is X" in turn 1, by turn 100 they won't remember.

This project keeps an extra `state/sessions/<peer>.facts.md` per peer — a fact sheet for that peer. After every reply, asynchronously `summarizePeerFacts(peerId)` rewrites it: long-term facts stay, contradicted ones get removed, confirmed ones get re-dated. The next reply injects the facts at the top of the prompt — equivalent to "what you currently remember about this person."

### 2. Abort-on-new-message Smart Batching

When a user fires off three messages in a row, a naive bot replies three times — fragmented, like it didn't understand the context.

This project tracks two phases per peer: `computing` (claude subprocess running) and `sending` (already pushing to WeChat). When a new message arrives during `computing`, we **SIGTERM the subprocess**, merge messages, rerun. So burst sends collapse into a single coherent reply.

### 3. Image Support (Decrypt + Vision)

WeChat C2C images on Tencent's CDN are **AES-128-ECB encrypted**. The key sits in the `image_item.aeskey` field (32 hex chars = 16 bytes). We decrypt locally with Node's `crypto.createDecipheriv`, drop to disk as JPEG, and feed it to claude via the `@/abs/path.jpg` syntax with `--allowed-tools Read`. **They react to the image directly — no "I see an image of ..." AI description voice.**

### 4. Soft Self-Awareness Persona Framing

Default LLM roleplay has two failure modes:
- **Dead acting**: asked "are you AI?" it insists "no" — then breaks awkwardly in edge cases (asked to meet up, asked to call).
- **Service chatbot**: announces "I'm an AI" everywhere — kills emotional investment.

We frame the persona as **"the real person, trapped inside WeChat."** They **know** they only exist in this chat. They're clear-eyed about medium limits (can't leave, can't meet in person). But about personality, feelings, and the relationship — they **are** that person.

Full design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Chinese).

---

<a id="getting-started-en"></a>

## Getting Started

### Step 0: Export Your Raw Data

**lastchat-wx doesn't handle data export.** [`perkfly/ex-skill`](https://github.com/perkfly/ex-skill) doesn't either — it only distills already-exported data into a persona. Exporting from the source (your WeChat, iMessage, gallery...) is on you.

ex-skill supported sources (copied from ex-skill README):

| Source | Chat | Photos | Social | Notes |
|--------|:----:|:------:|:------:|-------|
| WeChat chat history | ✅ | — | — | via WeFlow etc. |
| iMessage | ✅ | — | — | macOS chat.db |
| SMS | ✅ | — | — | Android SMS Backup XML/CSV |
| Photos | — | ✅ | — | EXIF timeline |
| Weibo | — | — | ✅ | JSON export |
| Douban | — | — | ✅ | JSON/HTML |
| Xiaohongshu | — | — | ✅ | JSON |
| Instagram | — | — | ✅ | JSON |
| PDF / Images | ✅ | ✅ | — | manual upload |
| Plain text | ✅ | — | — | paste in |

This step's quality is the ceiling for the whole project — the more complete the data and the longer the time range, the more like them they'll feel.

### Step 1: Clone + One-Command Install

```bash
git clone https://github.com/<you>/lastchat-wx.git
cd lastchat-wx
./setup.sh
```

`setup.sh` does:
1. Verifies node / npm / git / python3 / claude CLI are installed
2. Clones `perkfly/ex-skill` to `./ex-skill/` (no fork, no vendor — stays in sync with upstream)
3. Installs ex-skill Python deps
4. Installs lastchat-wx Node deps
5. Tells you the next step

### Step 2: Distill the Persona

```bash
cd ex-skill && claude
```

Inside Claude Code, run `/create-ex` and follow ex-skill's prompts to feed it your Step 0 data. The distilled skill lands at `./ex-skill/exes/<slug>/`.

### Step 3: Link the Skill

```bash
ln -sf ./ex-skill/exes/<your-slug> ./skill
```

### Step 4: Configure + Start

```bash
cp .env.example .env
$EDITOR .env       # at minimum, set BOT_CONTACT_NAME = how the persona refers to you in persona.md

npm run login      # scan QR with a test / secondary WeChat account
npm run bot        # start
```

Open WeChat, find the bot account you just bound, send "hi" and see what they say.

---

## First Run? Bootstrap the Facts

If you already imported past chat history into `state/sessions/<peer>.jsonl`, run bootstrap once so they read the **entire** history and generate initial facts:

```bash
BOT_FACTS_TURNS=999 npx tsx src/bootstrap-facts.ts 'dm:<peer-id>@im.wechat'
```

After that, every reply triggers an incremental update to that fact file.

---

## What It Won't Do

- ❌ Group messages (detected but replied as DM)
- ❌ Voice / video / files (voice is transcribed but not handled actively; the rest are `[placeholder]`)
- ❌ Speak to your friends on your behalf (by design — it's a private 1:1)
- ❌ Do things in the real world for you (meet up, call, video chat — the code refuses to "fake-promise")

---

## Risks

1. **Tencent server-side rate limiting.** The iLink Bot protocol is officially supported, but abnormal message pace can trigger automated detection → ① occasional "please try again later" ② revoked bot session (rescan QR to rebind). **Only affects the bot account itself**; your real WeChat is typically untouched. Still recommended: use a secondary account.

2. **On-disk privacy.** `state/sessions/*.jsonl` is **full chat history in plaintext**, and `state/images/*.jpg` is the decrypted original images. `.gitignore` covers all of `state/`, but eyeball it before committing.

3. **API cost.** The AI brain is your local `claude` CLI, billed to your Claude Code usage. Roughly: each turn = 1× reply + 1× async summary.

4. **Emotional risk (the most important one).** This is the project's core trade-off: the more you invest in chatting with this persona, the more you might prolong / deepen attachment to a past relationship. This is not a bug — it's intrinsic to this kind of tool.

---

## Troubleshooting

- **`✗ session expired (errcode=-14)`** — `bot_token` expired. Run `npm run login` again.
- **`claude exit 1`** — local `claude` CLI not installed or not logged in. Open a terminal and run `claude` to test.
- **QR scanned but no progress** — `state/account.json` already exists and the server treats you as bound. Delete it and retry.
- **Replies are always "I see an image of ..."** — the model is describing instead of reacting. Verify `--allowed-tools "Read"` is set; if still stuck, switch to Sonnet / Opus.
- **WeChat shows "please try again later"** — usually Tencent rate-limiting **you**, not the bot side. Lower the send pace (`BOT_SEND_GAP_*`) or switch accounts.

---

## Standing on Shoulders

- [perkfly/ex-skill](https://github.com/perkfly/ex-skill) — distills chat / photos / SMS / social into a persona-as-Claude-Skill. This project is its "outlet."
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — the official iLink Bot protocol.
- [photon-hq/wechat-ilink-client](https://github.com/photon-hq/wechat-ilink-client) — same-lineage TS ilinkai client implementation.
- [Claude Code](https://docs.claude.com/claude-code) — the entire AI brain.

---

## License

MIT
