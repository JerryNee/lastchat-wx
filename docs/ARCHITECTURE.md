# 架构

四块比一般 LLM 聊天 bot 多做的东西。这些是这个项目的核心差异化点。

## 1. Per-peer rolling facts（解决"history 滚出窗口就忘事"）

**问题**：每次调 claude 都把这个对端最近 80 轮聊天拼进 prompt（`BOT_HISTORY_TURNS`）。聊到第 81 轮，第 1 轮的内容就**永远**看不到了。如果第 1 轮说过"我室友是 X"，第 100 轮ta已经不记得了。

**解法**：每个对端额外维护一份 `state/sessions/<peer>.facts.md`，里面是这个对端的"事实清单"：

```
- 长期：在某大学读研，即将毕业
- 长期：长期室友是 A（不是 B）
- 长期：玩 Apex
- 截至 2026-05-21：朋友 C 这两天来借宿（**不是室友**）
- 截至 2026-05-21：今天 6 点多下班，明晚 5 点有会
```

**重写时机**：每次回完话异步触发 `summarizePeerFacts(peerId)`，让 claude 拿当前 facts + 最近 40 轮聊天，重写一份新 facts：
- 长期事实没被推翻 → 保留
- 新对话推翻了旧事实（"C 已经走了"）→ 删除对应那条
- 新对话重新确认了旧事实 → 把"截至"日期更新成今天

**注入**：下次回复时，facts 文件被读进 `askClaudeBatch` 的 prompt 顶部，等价于"你目前关于这个对端记得的事"。

**实现**：`src/claude-bridge.ts` 里的 `summarizePeerFacts` / `loadPeerFacts`，搭配 main.ts 的异步 fire-and-forget。

**bootstrap**：导入历史聊天记录的情况下，跑 `src/bootstrap-facts.ts` 一次性看全部历史生成初始 facts，避免摘要器一开始只能看到最近 40 轮。

## 2. Abort-on-new-message 智能合批

**问题**：用户连发消息时，简单的 debounce 不够好。典型 case：
- T0：用户发 "什么意思啊"
- T0+2s：debounce timer 烧了，processBatch 开始跑 claude
- T0+5s：用户发 "谁家好人晚上5点睡觉啊"（接续 T0 那句）
- T0+15s：claude 第一句回复跑完，发出去
- → 这条只回答了 T0 那句，没合并 T0+5s 那句
- 第二批又得跑一次 claude，单独回 T0+5s 那句

结果：**两条独立回复，语义割裂**，看上去像 bot 没理解上下文。

**解法**：`PeerBuffer` 维护两个 phase：`"computing"`（claude 子进程在跑）和 `"sending"`（已经在发微信了，发不能回头）。

- 新消息到达时如果 `phase === "computing"`：调 `abortController.abort()` → claude 子进程被 `SIGTERM` 杀掉 → askClaudeBatch 抛 `AbortedError` → processBatch 的 catch 分支把旧 batch unshift 回 `buf.items` → 重新 debounce → 下一轮一起回
- 新消息到达时如果 `phase === "sending"`：太晚了，入队等下一轮（避免半截回复或重复回复）

代价：被 abort 的那次 claude 调用 token 浪费。但用户连发的体感**显著**好转，回复合在一起、语义连贯。

**实现**：`src/main.ts` 的 `PeerBuffer.phase` + `abortController`，`src/claude-bridge.ts` 的 `runClaude(..., { signal })`。

## 3. WeChat C2C 图片支持

**问题**：微信 C2C 图片走腾讯 CDN，但 CDN 上存的是**加密的**字节。直接 curl 拿到的是 542KB 的随机数据，不是 JPEG。

**解法**：iLink Bot 推来的 `image_item` 里其实带着 AES key：

```json
{
  "image_item": {
    "aeskey": "c8e27ccebc193542319f2ce746b09c2b",   // 32 hex chars = 16 bytes = AES-128 key
    "media": {
      "full_url": "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=..."
    }
  }
}
```

加密参数（实测，开源文档里我没找到）：
- **算法**：AES-128-ECB
- **Key**：hex 解码后的 `aeskey`，16 字节
- **Padding**：PKCS#7
- 密文长度永远是 16 的倍数

`src/image-decrypt.ts` 用 Node 内置 `crypto.createDecipheriv("aes-128-ecb", key, null)`，零外部依赖。

**喂给 claude**：解密后落盘到 `state/images/<mid>_<i>.jpg`，在 prompt 里以 `@/absolute/path.jpg` 形式引用，并打开 `--allowed-tools Read` 让 claude CLI 用 Read 工具触发 vision。Prompt 里硬规则要求"看到图就直接评价/吐槽，不要写'我看到一张……的图片'描述句"。

## 4. 软自我意识 persona 框架

**问题**：默认 LLM roleplay 有两种坏 mode：
- **死扮演**：被问"你是不是 AI"就死扛"不是"。一旦边界场景（让ta见面、打电话）就尴尬地破功。
- **服务型 chatbot**：处处声明"我是 AI"，没法投入感情。

**解法**：把 persona 框定成"被卡在微信里的本人"。ta**知道**自己只能活在这个对话里，对介质限制（出不去、见不到）是清醒的；但对人格、感情、过去的关系，ta**就是**那个人。

这层框架在 `src/claude-bridge.ts` 的 `buildSystemPrompt()` 顶部 inline，包含：
- 处境定义（"被卡在微信里的本人"）
- 默认行为（沉入角色，不主动声明）
- 四个出戏触发条件（被戳穿 / 要求线下 / 情绪崩溃 / 技术测试）
- 五条硬禁忌（不自称 AI/程序/副本 / 不矫情存在论 / 不变服务型）

**还配套了几条反元话语规则**（都是从实战 bug 里抽出来的）：
- "不要把自己刚说过的话当对象评价或辩护"（防"我的反应完全正常"这种 AI 自辩）
- "不要主动报自己的名字、不要拎名字当挡箭牌"（防"我名字本来就叫 X 啊"）
- 看图就直接评价，不要描述图（防"我看到一张……的图片"）

---

## 设计哲学

这个项目的差异化不是技术新颖度，是**把"AI 假扮认识的人"这件事的边界情况处理到位**。
那些边界情况 90% 都不是 prompt engineering，而是基础设施（rolling facts, abort, image decrypt），以及把"ta到底是什么"想清楚（软自我意识）。
