#!/usr/bin/env bash
# 一键安装：拉 ex-skill + 装 Python 依赖 + 装 Node 依赖。
# 用法：./setup.sh

set -e
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
red()  { printf "\033[31m%s\033[0m\n" "$1"; }
green(){ printf "\033[32m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }

bold "==> 检查依赖"
missing=0
for cmd in node npm git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    red "  ✗ 找不到 $cmd"
    missing=1
  else
    dim "  ✓ $cmd ($(command -v "$cmd"))"
  fi
done
if ! command -v claude >/dev/null 2>&1; then
  red "  ⚠ 找不到 claude CLI。lastchat-wx 运行时必须有它。"
  red "    装：https://docs.claude.com/claude-code  →  装完跑一次 'claude' 登录"
  missing=1
else
  dim "  ✓ claude ($(command -v claude))"
fi
if [ $missing -ne 0 ]; then
  red "请先把缺的工具装上再重跑 ./setup.sh"
  exit 1
fi
echo ""

bold "==> [1/3] 拉取 perkfly/ex-skill（蒸馏 persona 用）"
if [ -d "./ex-skill/.git" ]; then
  dim "  ex-skill 已存在。如要更新到最新版：cd ex-skill && git pull"
else
  git clone --depth 1 https://github.com/perkfly/ex-skill.git ./ex-skill
fi
echo ""

bold "==> [2/3] 装 ex-skill 的 Python 依赖"
if [ -f "./ex-skill/requirements.txt" ]; then
  (cd ex-skill && python3 -m pip install -q -r requirements.txt) || {
    red "  Python 依赖装失败。手动跑：cd ex-skill && pip install -r requirements.txt"
    exit 1
  }
else
  dim "  ex-skill/requirements.txt 不存在，跳过"
fi
echo ""

bold "==> [3/3] 装 lastchat-wx 的 Node 依赖"
npm install --silent
echo ""

green "==> 准备完成 ✓"
echo ""
bold "接下来按这 5 步走："
cat <<'EOF'

  1. 蒸馏你的 persona
     cd ex-skill && claude
     # 在 Claude Code 里跑 /create-ex（用法详见 ex-skill/README.md）

  2. 把蒸馏出来的 skill 链接到 ./skill
     ln -sf ./ex-skill/exes/<your-slug> ./skill

  3. 配置环境变量（至少改 BOT_CONTACT_NAME = persona 里对你的称呼）
     cp .env.example .env  &&  $EDITOR .env

  4. 扫码绑定一个测试 / 小号微信
     npm run login

  5. 启动 bot
     npm run bot

EOF
