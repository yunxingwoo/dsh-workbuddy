#!/usr/bin/env bash
# dsh-workbuddy 一键安装脚本
#
# 用法：
#   在仓库目录执行：            ./install.sh
#   指定 profile：              PROFILE=web ./install.sh
#   从 GitHub 直接执行：        curl -fsSL https://raw.githubusercontent.com/yunxingwoo/dsh-workbuddy/main/install.sh | bash
#
# 环境变量：
#   PROFILE   目标 DSH profile，默认 desktop
#   DSH_HOME  DSH 主目录，默认 ~/.dsh
#   DSH_CLI   dsh 可执行文件路径（默认自动查找）
#   REPO_URL  从网络安装时的仓库地址
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/yunxingwoo/dsh-workbuddy.git}"
PROFILE="${PROFILE:-desktop}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="dsh-workbuddy"

say() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

# 1. 定位 dsh
if [[ -n "${DSH_CLI:-}" ]]; then
  DSH_BIN="$DSH_CLI"
elif command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
elif [[ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]]; then
  DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
elif [[ -x "$HOME/.local/bin/dsh" ]]; then
  DSH_BIN="$HOME/.local/bin/dsh"
else
  fail "找不到 dsh 命令。请设置 DSH_CLI=/path/to/dsh 后重试。"
fi
say "使用 dsh：$DSH_BIN"

# 2. 定位插件源码：本地仓库直接用；curl | bash 时自动 clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "${SCRIPT_DIR:-}" && -f "$SCRIPT_DIR/package.json" && -f "$SCRIPT_DIR/lib/host.js" ]]; then
  SOURCE_DIR="$SCRIPT_DIR"
  say "使用本地插件目录：$SOURCE_DIR"
else
  SOURCE_DIR="$DSH_HOME/plugin-src/$PLUGIN_NAME"
  mkdir -p "$(dirname "$SOURCE_DIR")"
  if [[ -d "$SOURCE_DIR/.git" ]]; then
    say "更新插件源码：$SOURCE_DIR"
    git -C "$SOURCE_DIR" pull --ff-only
  else
    say "克隆插件源码到：$SOURCE_DIR"
    git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
  fi
fi

# 3. 初始化 profile（desktop profile 由桌面端管理，忽略这里的报错）
export DSH_HOME
"$DSH_BIN" --profile "$PROFILE" --dump-config >/dev/null 2>&1 || true
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
[[ -f "$PROFILE_DIR/package.json" ]] || fail "找不到 profile：${PROFILE_DIR}（请先启动一次 DSH 的 ${PROFILE}）"

# 4. 安装依赖（link 到本地源码）
say "安装插件到 profile：$PROFILE"
"$DSH_BIN" plugin --profile "$PROFILE" add "link:$SOURCE_DIR"

# 5. 启用 bundle
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  CANDIDATE="$(cd "$(dirname "$DSH_BIN")/../../../bin" 2>/dev/null && pwd || true)/node"
  [[ -x "$CANDIDATE" ]] && NODE_BIN="$CANDIDATE"
fi
[[ -n "$NODE_BIN" ]] || fail "找不到 node，无法写入 profile 配置。请安装 Node.js 后重试。"

"$NODE_BIN" - "$PROFILE_DIR" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [dir, name] = process.argv.slice(2)
const file = path.join(dir, 'package.json')
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
data.dsh ??= {}
data.dsh.profile ??= {}
data.dsh.profile.bundles ??= []
if (data.dsh.profile.bundles.includes(name)) {
  console.log(`bundle 已启用：${name}`)
  process.exit(0)
}
const backup = `${file}.bak-${name}-${Date.now().toString(36)}`
fs.copyFileSync(file, backup)
data.dsh.profile.bundles.push(name)
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
console.log(`已启用 bundle：${name}（原配置备份：${backup}）`)
NODE

say ""
say "安装完成。"
if [[ "$PROFILE" == "desktop" ]]; then
  say "请重启 DeepSeek Harness 桌面端，然后在「设置 → WorkBuddy」里登录。"
else
  say "请重启 DSH（profile: ${PROFILE}），然后在「设置 → WorkBuddy」里登录。"
fi
