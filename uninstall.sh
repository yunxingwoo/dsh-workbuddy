#!/usr/bin/env bash
# dsh-workbuddy 卸载脚本：移除 profile bundle 与依赖，不删除账号数据。
set -euo pipefail

PROFILE="${PROFILE:-desktop}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="dsh-workbuddy"

say() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

if [[ -n "${DSH_CLI:-}" ]]; then
  DSH_BIN="$DSH_CLI"
elif command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
elif [[ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]]; then
  DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
else
  fail "找不到 dsh 命令。请设置 DSH_CLI=/path/to/dsh 后重试。"
fi

export DSH_HOME
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
[[ -f "$PROFILE_DIR/package.json" ]] || fail "找不到 profile：$PROFILE_DIR"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  CANDIDATE="$(cd "$(dirname "$DSH_BIN")/../../../bin" 2>/dev/null && pwd || true)/node"
  [[ -x "$CANDIDATE" ]] && NODE_BIN="$CANDIDATE"
fi
[[ -n "$NODE_BIN" ]] || fail "找不到 node，无法修改 profile 配置。"

"$NODE_BIN" - "$PROFILE_DIR" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [dir, name] = process.argv.slice(2)
const file = path.join(dir, 'package.json')
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const bundles = data.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.includes(name)) {
  console.log(`bundle 未启用：${name}`)
  process.exit(0)
}
const backup = `${file}.bak-${name}-${Date.now().toString(36)}`
fs.copyFileSync(file, backup)
data.dsh.profile.bundles = bundles.filter((item) => item !== name)
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
console.log(`已移除 bundle：${name}（原配置备份：${backup}）`)
NODE

"$DSH_BIN" plugin --profile "$PROFILE" remove "$PLUGIN_NAME" >/dev/null 2>&1 || true

say ""
say "已卸载。请重启 DSH 使改动生效。"
say "账号数据保留在："
say "  $DSH_HOME/workbuddy/state.json"
say "  $DSH_HOME/.credentials.yaml（记录名以 $PLUGIN_NAME/ 开头）"
say "如需彻底删除，请在确认后手动移除上述文件中的对应内容。"
