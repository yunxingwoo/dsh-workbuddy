# dsh-workbuddy

把 WorkBuddy（国内版 workbuddy.cn / 国际版 workbuddy.ai）的账号接入 DeepSeek Harness 的模型选择器，并提供账号池、逐模型勾选、积分倍率、每日签到与只读积分胶囊。

- 两个并行 provider：`workbuddy`（国内版）、`workbuddy-global`（国际版）
- 模型目录和 `credits` 倍率（`x0.79` 这类）全部按上游目录读取，插件不写死、不猜
- 逐模型启用/停用，以及每模型图片输入开关
- 账号池：浏览器登录或导入 token；多账号切换；鉴权失败先刷新再换号，配额失败冷却换号
- 每日签到、额度查询、设置卡片双 tab、输入框积分胶囊
- token 存入 DSH credentials（`~/.dsh/.credentials.yaml`），插件状态只保留账号元数据

## 安装

**方式一：一键脚本（推荐）**

```bash
curl -fsSL https://raw.githubusercontent.com/yunxingwoo/dsh-workbuddy/main/install.sh | bash
```

**方式二：克隆后安装**

```bash
git clone https://github.com/yunxingwoo/dsh-workbuddy.git
cd dsh-workbuddy
./install.sh
```

脚本会：定位 `dsh` → 把插件 link 进目标 profile → 在 profile 的 `dsh.profile.bundles` 里启用 `dsh-workbuddy` → 提示重启。

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROFILE` | `desktop` | 目标 DSH profile（`web` / `tui` 等） |
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_CLI` | 自动查找 | `dsh` 可执行文件路径 |
| `REPO_URL` | GitHub 仓库 | 脚本从网络安装时使用的仓库地址 |

**方式三：手动安装**

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "link:/绝对路径/dsh-workbuddy"
```

然后在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入 `dsh-workbuddy`，重启 DSH。也可用 `"$DSH" plugin --profile desktop add github:yunxingwoo/dsh-workbuddy` 从 GitHub 安装。

## 使用

重启后在「设置 → WorkBuddy」里操作：

### 登录（两种方式）

- **浏览器登录（推荐）**：点「浏览器登录」→ 在打开的 WorkBuddy 登录页完成登录 → 插件自动轮询并写入账号。
- **粘贴 token**：从浏览器 DevTools 里任一 `/v2/...` 请求复制 `Authorization: Bearer ...` 填入；建议同时填 refresh token，插件会自动续期。

### 账号池

- 同一 tab 里重复登录可添加多个账号；同 uid 会覆盖，不同 uid 并列。
- 单选框切换主账号；「移除」删除账号及其 credentials 记录。
- 请求尚未产出内容前遇到 401（先尝试刷新 token）或配额失败时，会冷却当前账号并切到池内下一个健康账号；排队码不会换号。

### 模型

- 「模型」区列出上游目录：勾选启用、取消隐藏；「图片」列控制该模型是否接收图片。
- 倍率徽标来自上游 `credits` 字段；上下文/输出上限、工具与推理能力也来自目录。
- 输入框右下角「选择模型」→ 选「WorkBuddy 国内版」分组下的模型即可对话。

### 积分与签到

- 输入框附近的「积分 …」胶囊是只读读数，国内版/国际版分别显示；点开可看明细、账号、签到状态，并「一键签到」。
- 设置页「积分」区可单独刷新额度、执行签到。

## 配置

在目标 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: dsh-workbuddy
  config:
    refreshMinutes: 30    # 目录/额度/签到状态刷新间隔（分钟）
    autoCheckin: false    # 活动开启且今日未签时自动签到
    globalModels: false   # 是否把国际版模型放进选择器（默认 false，见下）
```

## 数据与安全

- token：写入 DSH credentials 记录 `dsh-workbuddy/<provider>-<account>`，落盘在 `$DSH_HOME/.credentials.yaml`（0600）。
- 账号元数据、目录与额度快照：`$DSH_HOME/workbuddy/state.json`，不含 token。
- token 不进日志、不进客户端快照；`/workbuddy/*` 路由只接受本机回环请求。
- 如果当前 composition 没有 credentials 服务，会回退到 state.json（0600）并提示一次；之后可用时自动迁移。

## 已知限制

- **国际版生成受上游限制**：`/v2/chat/completions` 会返回 `code 11128`（上游要求官方客户端渠道校验）。因此国际版默认只提供账号、目录、积分与签到，模型不进入选择器；配置 `globalModels: true` 可让模型出现，但生成仍可能被上游拒绝。国内版不受影响。
- 国际版签到活动是否开启由上游决定；活动关闭时界面不会显示签到按钮。
- 浏览器登录需要能在浏览器里完成 WorkBuddy 的登录；纯无头环境请使用 token 导入。
- 插件验证基于 DSH `0.2.1-rc.2`；更低版本可能缺少本插件使用的设置卡片/输入框插槽。

## 卸载

```bash
./uninstall.sh
```

或手动：从 profile 的 `dsh.profile.bundles` 移除 `dsh-workbuddy`，执行 `dsh plugin --profile desktop remove dsh-workbuddy`，重启 DSH。账号数据不会被自动删除（位置见上）。

## 开发

```bash
node --test test/logic.test.mjs     # 纯逻辑单测
node --check lib/*.js               # 语法检查
```

目录：

```
lib/host.js       插件入口：注册 provider、路由、定时刷新
lib/adapter.js    OpenAI-compatible SSE → Harness chunk 协议
lib/api.js        WorkBuddy 上游 HTTP 客户端
lib/catalog.js    目录归一、credits 倍率、逐模型开关
lib/pool.js       账号池、续期、冷却、换号
lib/tokens.js     token 存取（DSH credentials 优先）
lib/service.js    业务编排
lib/routes.js     客户端 HTTP 接口
lib/state.js      状态读写
lib/client.js     设置卡片 + 输入框积分胶囊
```

## License

MIT
