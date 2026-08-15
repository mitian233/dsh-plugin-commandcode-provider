/**
 * Locale bundles for the Command Code settings section.
 *
 * The section registers under the `settings.commandcode` namespace and renders
 * through `PropsLocale<'settings.commandcode'>`, so every key below is also
 * the label contract for the nav row (`nav`).
 */

/**
 * Declare the namespace in the locale registry so the typed seats resolve:
 * `PropsLocale<'settings.commandcode'>` (component `t`), `ctx.locale.register`
 * / `ctx.locale.bind`, and the slot entry's `locale` option.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.commandcode': CommandCodeSettingsKey
  }
}

/** Locale keys the Command Code settings section renders. */
export type CommandCodeSettingsKey =
  | 'nav' | 'title' | 'description'
  | 'loading' | 'configured' | 'notConfigured' | 'readOnly'
  | 'oauthButton' | 'oauthHint'
  | 'keyLabel' | 'keyPlaceholder' | 'keyStored'
  | 'save' | 'saving' | 'clear' | 'clearing' | 'cleared'
  | 'saved' | 'clearConfirm' | 'cancel'
  | 'keyBlank' | 'loadError' | 'saveError' | 'clearError'

/** English copy. */
export const en: Record<CommandCodeSettingsKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  description: 'API key used by the commandcode provider route. It is stored through DSH’s credentials service and read on every request.',
  loading: 'Checking configuration…',
  configured: 'Configured',
  notConfigured: 'Not configured',
  readOnly: 'Read-only: a higher-priority layer (environment) supplies this key.',
  oauthButton: 'Get an API key with Command Code OAuth',
  oauthHint: 'Opens Command Code Studio in a new tab. After signing in, copy the API key it shows and paste it below.',
  keyLabel: 'API key',
  keyPlaceholder: 'Paste your Command Code API key',
  keyStored: 'An API key is stored. Leave the field empty to keep it.',
  save: 'Save',
  saving: 'Saving…',
  clear: 'Clear',
  clearing: 'Clearing…',
  cleared: 'API key cleared.',
  saved: 'API key saved.',
  clearConfirm: 'Clear the stored Command Code API key? Requests will fail until a new one is configured.',
  cancel: 'Cancel',
  keyBlank: 'Enter an API key to save.',
  loadError: 'Could not check the stored API key.',
  saveError: 'Could not save the API key.',
  clearError: 'Could not clear the API key.',
}

/** Simplified Chinese copy. */
export const zh: Record<CommandCodeSettingsKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  description: 'commandcode 提供商路由使用的 API Key，通过 DSH 的凭据服务保存，每次请求时读取。',
  loading: '正在检查配置…',
  configured: '已配置',
  notConfigured: '未配置',
  readOnly: '只读：更高优先级的环境层已提供该 Key。',
  oauthButton: '通过 Command Code OAuth 获取 API Key',
  oauthHint: '在新标签页打开 Command Code Studio。登录后，复制页面显示的 API Key 并粘贴到下方。',
  keyLabel: 'API Key',
  keyPlaceholder: '粘贴你的 Command Code API Key',
  keyStored: '已保存 API Key。留空则保留当前 Key。',
  save: '保存',
  saving: '保存中…',
  clear: '清除',
  clearing: '清除中…',
  cleared: 'API Key 已清除。',
  saved: 'API Key 已保存。',
  clearConfirm: '清除已保存的 Command Code API Key？请求在重新配置前将失败。',
  cancel: '取消',
  keyBlank: '请输入 API Key 后再保存。',
  loadError: '无法读取已保存的 API Key。',
  saveError: '保存 API Key 失败。',
  clearError: '清除 API Key 失败。',
}
