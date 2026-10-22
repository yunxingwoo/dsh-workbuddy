/**
 * dsh-workbuddy 的浏览器半边。
 *
 * 两张界面：
 * 1. 设置 → WorkBuddy：以 tab 区分国内版/国际版，管理账号池、逐模型勾选与
 *    图片输入开关、积分与签到；
 * 2. 输入框 dock 的积分胶囊：只读显示当前额度与签到状态，点开是明细。
 *
 * 与 Host 的唯一通道是 `/workbuddy/*` 路由（见 routes.js）。这里不 import
 * 宿主包，只用 ModuleLoader 提供的 react / react-dom。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // -----------------------------------------------------------------------
    // 基础工具
    // -----------------------------------------------------------------------

    /** 调 Host 路由，统一解信封。 */
    async function call(path, body) {
      let response
      try {
        response = await fetch(`workbuddy/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        throw new Error(`WorkBuddy 接口不可用：${String(error && error.message ? error.message : error)}`)
      }
      let envelope
      try {
        envelope = await response.json()
      } catch {
        throw new Error(`WorkBuddy 接口返回非 JSON（HTTP ${String(response.status)}）`)
      }
      if (envelope && envelope.ok === true) return envelope.value
      throw new Error(envelope && envelope.error ? String(envelope.error.message) : `WorkBuddy 接口失败（HTTP ${String(response.status)}）`)
    }

    /** 数字格式化：大数用 k 表示。 */
    function fmt(value) {
      if (value === null || value === undefined) return '—'
      if (value === -1) return '不限'
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      if (Math.abs(number) >= 10_000) return `${(number / 1000).toFixed(1)}k`
      return number.toLocaleString('zh-CN')
    }

    /** 倍率展示：0.79 → x0.79。 */
    function fmtMultiplier(value) {
      if (value === null || value === undefined) return '—'
      return `x${Number(value).toFixed(2)}`
    }

    /** 相对时间。 */
    function fmtAgo(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '从未'
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 60) return `${String(seconds)} 秒前`
      if (seconds < 3600) return `${String(Math.round(seconds / 60))} 分钟前`
      return `${String(Math.round(seconds / 3600))} 小时前`
    }

    /** 读快照：供设置页与胶囊共用。 */
    function useSnapshot(pollMs) {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const alive = useRef(true)
      const refresh = useCallback(async () => {
        try {
          const value = await call('snapshot')
          if (!alive.current) return
          setSnapshot(value)
          setError(null)
        } catch (cause) {
          if (!alive.current) return
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])
      useEffect(() => {
        alive.current = true
        void refresh()
        if (typeof pollMs !== 'number' || pollMs <= 0) return undefined
        const timer = setInterval(() => { void refresh() }, pollMs)
        return () => { alive.current = false; clearInterval(timer) }
      }, [refresh, pollMs])
      return { snapshot, error, loading, refresh, setSnapshot }
    }

    /** 小圆点。 */
    function Dot(props) {
      const color = props.color ?? 'var(--dswb-accent, #4f7cff)'
      return h('span', {
        style: {
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          marginRight: 6,
          flex: '0 0 auto',
        },
      })
    }

    /** 徽标。 */
    function Badge(props) {
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 7px',
          borderRadius: 999,
          fontSize: 11,
          lineHeight: '18px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          background: props.tone === 'good' ? 'rgba(52,168,113,.14)' : props.tone === 'warn' ? 'rgba(214,150,40,.16)' : props.tone === 'bad' ? 'rgba(220,80,80,.14)' : 'rgba(127,127,127,.14)',
          color: props.tone === 'good' ? '#2f9e6a' : props.tone === 'warn' ? '#b07a18' : props.tone === 'bad' ? '#c74b4b' : 'inherit',
        },
      }, props.children)
    }

    /** 按钮。 */
    function Button(props) {
      const disabled = props.disabled === true || props.busy === true
      return h('button', {
        type: 'button',
        disabled,
        onClick: disabled ? undefined : props.onClick,
        title: props.title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 8,
          border: '1px solid rgba(127,127,127,.28)',
          background: props.primary === true ? 'rgba(79,124,255,.92)' : 'transparent',
          color: props.primary === true ? '#fff' : 'inherit',
          fontSize: 12,
          lineHeight: '18px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          ...props.style,
        },
      }, props.busy === true ? '处理中…' : props.children)
    }

    /** 复选行。 */
    function CheckRow(props) {
      return h('label', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: props.disabled === true ? 'default' : 'pointer', opacity: props.disabled === true ? 0.5 : 1 },
        title: props.title,
      },
      h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled === true,
        onChange: (event) => { props.onChange && props.onChange(event.target.checked) },
        style: { margin: 0 },
      }),
      h('span', { style: { fontSize: 12 } }, props.children))
    }

    // -----------------------------------------------------------------------
    // 设置页
    // -----------------------------------------------------------------------

    /** 一个 provider 的登录区。 */
    function LoginPanel(props) {
      const { provider, onChanged, refresh } = props
      const [pending, setPending] = useState(null)
      const [message, setMessage] = useState(null)
      const [mode, setMode] = useState(null) // 'token' | null
      const [token, setToken] = useState('')
      const [refreshToken, setRefreshToken] = useState('')
      const timer = useRef(null)

      useEffect(() => () => {
        if (timer.current) { clearInterval(timer.current); timer.current = null }
      }, [])

      const poll = useCallback(async (state) => {
        try {
          const result = await call('login/poll', { providerId: provider.id, state })
          if (result && result.pending === true) return
          if (timer.current) { clearInterval(timer.current); timer.current = null }
          setPending(null)
          if (result && result.error) setMessage(result.error)
          else {
            setMessage(`已登录：${result && result.account ? (result.account.nickname ?? result.account.uid ?? '账号') : '账号'}`)
            await refresh()
            onChanged && onChanged()
          }
        } catch (error) {
          if (timer.current) { clearInterval(timer.current); timer.current = null }
          setPending(null)
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [provider.id, refresh, onChanged])

      const startLogin = useCallback(async () => {
        setMessage(null)
        try {
          const result = await call('login/start', { providerId: provider.id })
          setPending({ authUrl: result.authUrl, state: result.state })
          try {
            window.open(result.authUrl, '_blank', 'noopener,noreferrer')
          } catch {
            // 弹窗被拦截时用户仍可点链接。
          }
          if (timer.current) clearInterval(timer.current)
          timer.current = setInterval(() => { void poll(result.state) }, 2000)
          void poll(result.state)
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [provider.id, poll])

      const submitToken = useCallback(async () => {
        setMessage(null)
        try {
          const account = await call('login/token', {
            providerId: provider.id,
            accessToken: token,
            refreshToken: refreshToken === '' ? undefined : refreshToken,
          })
          setToken('')
          setRefreshToken('')
          setMode(null)
          setMessage(`已导入：${account.nickname ?? account.uid ?? '账号'}`)
          await refresh()
          onChanged && onChanged()
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [provider.id, token, refreshToken, refresh, onChanged])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(Button, { primary: true, onClick: () => { void startLogin() }, busy: pending !== null }, '浏览器登录'),
          h(Button, { onClick: () => setMode(mode === 'token' ? null : 'token') }, '粘贴 token'),
          h('span', { style: { fontSize: 11, opacity: 0.6 } }, provider.endpoint)),
        pending !== null
          ? h('div', { style: { fontSize: 12, lineHeight: '20px', padding: '8px 10px', borderRadius: 8, background: 'rgba(127,127,127,.08)' } },
            '已打开浏览器登录页，完成后会自动回到这里。',
            h('br'),
            h('a', { href: pending.authUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit', textDecoration: 'underline' } }, '没弹出窗口？点这里打开登录页'),
            h('div', { style: { marginTop: 6 } }, h(Button, {
              onClick: () => {
                if (timer.current) { clearInterval(timer.current); timer.current = null }
                setPending(null)
              },
            }, '取消')))
          : null,
        mode === 'token'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px', borderRadius: 8, background: 'rgba(127,127,127,.08)' } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, '手动导入 access token'),
            h('div', { style: { fontSize: 11, opacity: 0.65 } }, '从已登录 WorkBuddy 的浏览器 DevTools 里复制任意 `/v2/...` 请求的 `Authorization: Bearer ...`，或填 refresh token 让插件自动续期。'),
            h('input', {
              value: token,
              onChange: (event) => setToken(event.target.value),
              placeholder: 'access token',
              style: inputStyle,
            }),
            h('input', {
              value: refreshToken,
              onChange: (event) => setRefreshToken(event.target.value),
              placeholder: 'refresh token（可选，建议填）',
              style: inputStyle,
            }),
            h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { primary: true, onClick: () => { void submitToken() }, disabled: token.trim() === '' }, '导入'),
              h(Button, { onClick: () => setMode(null) }, '取消')))
          : null,
        message !== null ? h('div', { style: { fontSize: 12, opacity: 0.8 } }, message) : null)
    }

    /** Host 端返回的 JSON 输入框样式。 */
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid rgba(127,127,127,.3)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
      fontFamily: 'inherit',
    }

    /** 账号列表。 */
    function AccountsPanel(props) {
      const { provider, refresh } = props
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)

      const act = useCallback(async (path, body) => {
        setBusy(path + (body?.accountId ?? ''))
        setError(null)
        try {
          await call(path, { providerId: provider.id, ...body })
          await refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(null)
        }
      }, [provider.id, refresh])

      const accounts = provider.accounts ?? []
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, `账号池（${String(accounts.length)}）`),
          h(Badge, { tone: accounts.length === 0 ? 'warn' : 'good' }, accounts.length === 0 ? '未登录' : '已连接')),
        accounts.length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.65 } }, '还没有账号。点上面的「浏览器登录」，或粘贴 token。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, accounts.map((account) => h('div', {
            key: account.id,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px',
              borderRadius: 8,
              border: '1px solid ' + (account.active ? 'rgba(79,124,255,.55)' : 'rgba(127,127,127,.22)'),
              background: account.active ? 'rgba(79,124,255,.08)' : 'transparent',
            },
          },
          h('input', {
            type: 'radio',
            name: `dswb-account-${provider.id}`,
            checked: account.active === true,
            onChange: () => { void act('accounts/select', { accountId: account.id }) },
            style: { margin: 0 },
          }),
          h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              account.nickname ?? account.uid ?? account.id,
              account.enterpriseName ? ` · ${account.enterpriseName}` : ''),
            h('div', { style: { fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `${account.accountType ?? 'personal'} · ${account.uid ?? account.id} · ${account.source === 'manual-token' ? '手动 token' : account.source === 'local' ? '本机登录态' : '浏览器登录'}`)),
          account.needsLogin === true ? h(Badge, { tone: 'bad' }, '需重登') : null,
          account.cooling === true ? h(Badge, { tone: 'warn' }, '冷却中') : null,
          h(Button, {
            onClick: () => { void act('accounts/remove', { accountId: account.id }) },
            busy: busy === 'accounts/remove' + account.id,
          }, '移除'))))
        , error !== null ? h('div', { style: { fontSize: 12 } }, h(Badge, { tone: 'bad' }, error)) : null)
    }

    /** 积分与签到卡片。 */
    function CreditsPanel(props) {
      const { provider, refresh } = props
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const credits = provider.credits
      const checkin = provider.checkin
      const status = checkin && checkin.status ? checkin.status : null

      const refreshCredits = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          await call('credits/refresh', { providerId: provider.id })
          await refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [provider.id, refresh])

      const doCheckin = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          await call('checkin', { providerId: provider.id })
          await refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [provider.id, refresh])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, '积分'),
          h('div', { style: { display: 'flex', gap: 6 } },
            h(Button, { onClick: () => { void refreshCredits() }, busy: busy }, '刷新'),
            status !== null && status.active === true && status.todayCheckedIn !== true
              ? h(Button, { primary: true, onClick: () => { void doCheckin() }, busy: busy }, status.claimButtonText ?? '签到')
              : null)),
        credits === null || credits === undefined
          ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, '暂无积分数据')
          : credits.error
            ? h('div', { style: { fontSize: 12 } }, h(Badge, { tone: 'warn' }, credits.error))
            : h('div', { style: { display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' } },
              h('div', null,
                h('div', { style: { fontSize: 11, opacity: 0.6 } }, credits.kind === 'enterprise' ? '企业剩余额度' : '剩余积分'),
                h('div', { style: { fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } }, fmt(credits.left))),
              h('div', null,
                h('div', { style: { fontSize: 11, opacity: 0.6 } }, '总额度'),
                h('div', { style: { fontSize: 14, fontVariantNumeric: 'tabular-nums' } }, fmt(credits.total))),
              credits.isPaidUser === true ? h(Badge, { tone: 'good' }, '付费') : h(Badge, null, '免费'),
              h('div', { style: { fontSize: 11, opacity: 0.55 } }, `更新于 ${fmtAgo(credits.fetchedAt)}`)),
        status !== null
          ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
            h(Dot, { color: status.todayCheckedIn ? '#2f9e6a' : '#b07a18' }),
            status.todayCheckedIn ? '今日已签到' : '今日未签到',
            status.streakDays > 0 ? h('span', { style: { opacity: 0.65 } }, `连签 ${String(status.streakDays)} 天`) : null,
            status.dailyCredit > 0 ? h(Badge, { tone: 'good' }, `+${String(status.dailyCredit)}/天`) : null,
            status.todayCredit > 0 ? h('span', { style: { opacity: 0.65 } }, `今日 +${String(status.todayCredit)}`) : null)
          : null,
        error !== null ? h('div', { style: { fontSize: 12 } }, h(Badge, { tone: 'bad' }, error)) : null)
    }

    /** 模型清单。 */
    function ModelsPanel(props) {
      const { provider, refresh } = props
      const [query, setQuery] = useState('')
      const [busyId, setBusyId] = useState(null)
      const models = provider.models ?? []
      const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        if (keyword === '') return models
        return models.filter((model) => model.id.toLowerCase().includes(keyword) || String(model.name).toLowerCase().includes(keyword))
      }, [models, query])

      const toggle = useCallback(async (model, patch) => {
        setBusyId(model.id)
        try {
          await call('models/toggle', { providerId: provider.id, modelId: model.id, ...patch })
          await refresh()
        } finally {
          setBusyId(null)
        }
      }, [provider.id, refresh])

      const setAll = useCallback(async (enabled) => {
        // 逐个写：每次 toggle 都会重建快照，串行避免竞态。
        for (const model of models) {
          await call('models/toggle', { providerId: provider.id, modelId: model.id, enabled })
        }
        await refresh()
      }, [models, provider.id, refresh])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, `模型（${String(models.filter((model) => model.enabled !== false).length)}/${String(models.length)} 已启用）`),
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '搜索模型 / id',
            style: { ...inputStyle, width: 180, marginLeft: 'auto' },
          }),
          h(Button, { onClick: () => { void call('catalog/refresh', { providerId: provider.id, force: true }).then(refresh) } }, '刷新目录'),
          h(Button, { onClick: () => { void setAll(true) } }, '全选'),
          h(Button, { onClick: () => { void setAll(false) } }, '全不选')),
        h('div', { style: { fontSize: 11, opacity: 0.6 } },
          `目录来源：${provider.catalog ? (provider.catalog.source === 'upstream' ? '上游 /v3/config' : provider.catalog.source === 'local-cache' ? '本机 WorkBuddy 缓存' : provider.catalog.source) : '未加载'}`,
          provider.catalog ? ` · 更新于 ${fmtAgo(provider.catalog.fetchedAt)}` : '',
          ' · 倍率来自上游 credits 字段，插件不写死'),
        h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 380,
            overflow: 'auto',
            border: '1px solid rgba(127,127,127,.18)',
            borderRadius: 8,
          },
        }, filtered.length === 0
          ? h('div', { style: { padding: 12, fontSize: 12, opacity: 0.6 } }, '没有匹配的模型')
          : filtered.map((model, index) => h('div', {
            key: model.id,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderTop: index === 0 ? 'none' : '1px solid rgba(127,127,127,.12)',
              opacity: model.enabled === false ? 0.55 : 1,
            },
          },
          h('input', {
            type: 'checkbox',
            checked: model.enabled !== false,
            onChange: () => { void toggle(model, { enabled: model.enabled === false }) },
            disabled: busyId === model.id,
            style: { margin: 0 },
          }),
          h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
              h('span', { style: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, model.name),
              h('span', { style: { fontSize: 10.5, opacity: 0.45, fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)' } }, model.id)),
            h('div', { style: { fontSize: 10.5, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              [
                model.contextWindow ? `${fmt(model.contextWindow)} ctx` : null,
                model.maxOutputTokens ? `${fmt(model.maxOutputTokens)} out` : null,
                model.supportsToolCall === false ? '无工具' : '工具',
                model.reasoning ? '推理' : null,
              ].filter(Boolean).join(' · '))),
          h(Badge, { tone: model.multiplier !== null ? 'good' : null }, fmtMultiplier(model.multiplier)),
          h('span', { style: { fontSize: 11, opacity: 0.5, minWidth: 72, textAlign: 'right' } }, model.creditText || '—'),
          h(CheckRow, {
            checked: model.image === true,
            disabled: model.supportsImages !== true || busyId === model.id,
            title: model.supportsImages !== true ? '上游未声明图片输入' : '允许该模型接收图片',
            onChange: (next) => { void toggle(model, { image: next }) },
          }, '图片')))),
        errorBlock(null))
    }

    /** 占位：错误块由各面板自己渲染，这里保留统一出口。 */
    function errorBlock(error) {
      return error === null ? null : h('div', { style: { fontSize: 12 } }, h(Badge, { tone: 'bad' }, error))
    }

    /** 设置页主体。 */
    function SettingsSection() {
      const { snapshot, error, refresh } = useSnapshot(15_000)
      const [tab, setTab] = useState('workbuddy')
      const providers = snapshot && snapshot.providers ? snapshot.providers : []
      const active = providers.find((provider) => provider.id === tab) ?? providers[0]

      if (error !== null && snapshot === null) {
        return h('div', { style: panelStyle }, h('div', { style: { fontSize: 13 } }, h(Badge, { tone: 'bad' }, error)), h('div', { style: { marginTop: 8 } }, h(Button, { onClick: () => { void refresh() } }, '重试')))
      }
      if (active === undefined) return h('div', { style: panelStyle }, '加载中…')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', color: 'inherit' } },
        h('style', null, CSS),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 15, fontWeight: 700 } }, 'WorkBuddy'),
          h('div', { style: { fontSize: 11, opacity: 0.6 } }, '国内版 / 国际版并行供应商 · 账号池 · 积分倍率 · 每日签到'),
          h('div', { style: { marginLeft: 'auto' } }, h(Button, { onClick: () => { void refresh() } }, '刷新'))),
        h('div', { style: { display: 'flex', gap: 6, borderBottom: '1px solid rgba(127,127,127,.2)', paddingBottom: 6 } },
          providers.map((provider) => h('button', {
            key: provider.id,
            type: 'button',
            onClick: () => setTab(provider.id),
            style: {
              padding: '5px 12px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              background: provider.id === active.id ? 'rgba(79,124,255,.14)' : 'transparent',
              color: 'inherit',
              fontSize: 12.5,
              fontWeight: provider.id === active.id ? 700 : 500,
            },
          }, provider.displayName,
          provider.accounts.length > 0
            ? h('span', { style: { marginLeft: 6, fontSize: 10, opacity: 0.6 } }, `(${String(provider.accounts.length)})`)
            : null))),
        active.id === 'workbuddy-global'
          ? h('div', { style: { fontSize: 11.5, lineHeight: '18px', padding: '7px 10px', borderRadius: 8, background: 'rgba(214,150,40,.12)' } },
            '国际版：账号、模型目录、积分与签到均可用；生成调用被上游要求「官方客户端渠道校验」（code 11128），第三方客户端会被拒绝。因此模型默认不放进选择器（profile 配置 globalModels: true 可恢复试验）。国内版不受影响。')
          : null,
        h(LoginPanel, { provider: active, refresh }),
        h(AccountsPanel, { provider: active, refresh }),
        h(CreditsPanel, { provider: active, refresh }),
        h(ModelsPanel, { provider: active, refresh }),
        h('div', { style: { fontSize: 11, opacity: 0.5, lineHeight: '18px' } },
          '积分倍率、模型目录与图片能力都来自 WorkBuddy 上游目录；插件只做只读展示与转发。',
          '账号 token 保存在本机 DSH 目录（0600），不会上传到 DSH 之外的服务。'))
    }

    /** 设置页容器样式。 */
    const panelStyle = {
      padding: '16px 18px',
      borderRadius: 12,
      border: '1px solid rgba(127,127,127,.18)',
      background: 'rgba(127,127,127,.04)',
      color: 'inherit',
      fontSize: 13,
    }

    /** 胶囊与列表共用的最小样式。 */
    const CSS = `
.dswb-cap { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px;
  border:1px solid rgba(127,127,127,.25); background:rgba(127,127,127,.06); font-size:11px;
  line-height:18px; color:inherit; cursor:pointer; user-select:none; white-space:nowrap; }
.dswb-cap:hover { background:rgba(127,127,127,.12); }
.dswb-cap b { font-variant-numeric: tabular-nums; font-weight:700; }
.dswb-pop { position:fixed; z-index:2147483000; min-width:280px; max-width:360px;
  padding:10px 12px; border-radius:10px; border:1px solid rgba(127,127,127,.28);
  background:#fff; color:#111; box-shadow:0 8px 28px rgba(0,0,0,.22); font-size:12px; }
@media (prefers-color-scheme: dark) { .dswb-pop { background:#1f1f22; color:#eee; border-color:rgba(255,255,255,.18); } }
`

    // -----------------------------------------------------------------------
    // 输入框胶囊
    // -----------------------------------------------------------------------

    /** 只读积分胶囊 + 展开明细。 */
    function CreditCapsule(props) {
      const { snapshot, refresh } = useSnapshot(20_000)
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState(null)
      const [busy, setBusy] = useState(false)
      const root = useRef(null)

      const openPopover = () => {
        const rect = root.current?.getBoundingClientRect()
        if (rect !== undefined) {
          setPos({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 6) })
        }
        setOpen(!open)
      }

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (root.current && !root.current.contains(event.target) && !event.target.closest?.('.dswb-pop')) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      const providers = snapshot && snapshot.providers ? snapshot.providers : []
      const connected = providers.filter((provider) => (provider.accounts ?? []).length > 0)
      const totals = connected.map((provider) => {
        const credits = provider.credits ?? {}
        return {
          id: provider.id,
          name: provider.displayName,
          left: credits.error ? null : credits.left,
          unlimited: credits.unlimited === true,
          error: credits.error ?? null,
          account: provider.activeAccount,
          checkin: provider.checkin && provider.checkin.status ? provider.checkin.status : null,
        }
      })

      if (connected.length === 0) {
        return h('div', { ref: root, style: { position: 'relative', display: 'inline-flex' } },
          h('button', {
            type: 'button',
            className: 'dswb-cap',
            title: 'WorkBuddy 未登录：打开设置登录一次',
            onClick: openPopover,
          }, h(Dot, { color: '#b07a18' }), 'WorkBuddy 未登录'))
      }

      const summary = totals.map((total) => total.unlimited ? '不限' : total.error ? '—' : fmt(total.left)).join(' / ')
      return h('div', { ref: root, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          className: 'dswb-cap',
          title: 'WorkBuddy 剩余积分（只读）',
          onClick: openPopover,
        },
        h(Dot, null),
        h('span', null, '积分 '),
        h('b', null, summary)),
        open && pos !== null
          ? ReactDOM.createPortal(h('div', { className: 'dswb-pop', style: { left: pos.left, bottom: pos.bottom } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
              h('div', { style: { fontWeight: 700 } }, 'WorkBuddy 积分'),
              h(Button, { onClick: () => { void refresh() }, busy: busy }, '刷新')),
            totals.map((total) => h('div', { key: total.id, style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0', borderTop: '1px solid rgba(127,127,127,.15)' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                h('span', { style: { fontWeight: 600 } }, total.name),
                h('span', null, total.unlimited ? '不限' : total.error ? '不可用' : fmt(total.left))),
              h('div', { style: { fontSize: 11, opacity: 0.65, display: 'flex', justifyContent: 'space-between', gap: 8 } },
                h('span', null, total.account ? `${total.account.nickname ?? total.account.uid ?? '账号'}` : '未登录'),
                h('span', null, total.checkin
                  ? total.checkin.todayCheckedIn ? `今日已签到 · 连签 ${String(total.checkin.streakDays)}` : '今日未签到'
                  : '签到状态未知')),
              total.error ? h('div', { style: { fontSize: 11 } }, h(Badge, { tone: 'bad' }, total.error)) : null)),
            h('div', { style: { marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' } },
              h(Button, {
                onClick: async () => {
                  setBusy(true)
                  try {
                    for (const provider of connected) {
                      const status = provider.checkin && provider.checkin.status
                      if (status && status.active === true && status.todayCheckedIn !== true) {
                        await call('checkin', { providerId: provider.id })
                      }
                    }
                    await refresh()
                  } catch {
                    // 明细里重新读取错误状态。
                  } finally {
                    setBusy(false)
                  }
                },
                busy,
              }, '一键签到'),
              h(Button, {
                onClick: () => {
                  try { window.location.hash = '#settings/workbuddy' } catch { /* 忽略 */ }
                  setOpen(false)
                },
              }, '打开设置'))), document.body)
          : null)
    }

    // -----------------------------------------------------------------------
    // 插件入口
    // -----------------------------------------------------------------------

    /** 需要 slots 服务。 */
    const inject = ['slots']

    /** 把胶囊/弹层样式挂到 document.head（聊天页也要生效）。 */
    function installStyles() {
      if (typeof document === 'undefined' || document.getElementById('dswb-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dswb-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 客户端插件主体。 */
    function apply(ctx) {
      installStyles()
      // 设置卡片：WorkBuddy 独占一个 section（内部再按国内/国际 tab）。
      ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'workbuddy',
            order: 70,
            label: () => 'WorkBuddy',
            icon: 'extension',
            inject: () => ({}),
          }, SettingsSection)
        } catch {
          return () => {}
        }
      })

      // 输入框胶囊：只读积分读数。
      ctx.slots.inject('conversation.input.dock', () => {
        try {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'workbuddy-credits',
            order: 140,
            inject: () => ({}),
          }, CreditCapsule)
        } catch {
          return () => {}
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.SettingsSection = SettingsSection
    exports.CreditCapsule = CreditCapsule
    return module.exports
  },
})
