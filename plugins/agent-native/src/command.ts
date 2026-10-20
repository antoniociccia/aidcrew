import type { Message } from '@aidcrew/core'
import { subscriptionSettings } from './subscription.ts'

export function nativePrompt(messages: readonly Message[]) {
  const message = messages.findLast((entry) => entry.role === 'user')
  if (!message || message.content.some((block) => block.type !== 'text'))
    throw new Error('Native Claude orchestration currently accepts text messages only')
  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  if (!text.trim()) throw new Error('Native Claude requires a nonempty text message')
  return text
}

export function pastePrompt(prompt: string) {
  if (
    [...prompt].some((char) => {
      const code = char.charCodeAt(0)
      return (code < 32 && code !== 10 && code !== 9) || code === 127
    })
  )
    throw new Error('Harness prompts cannot contain terminal control characters')
  return `\x1b[200~${prompt}\x1b[201~\r`
}

export function nativeCommand(options: {
  system: string
  prompt: string
  model?: string
  yolo?: boolean
  mcpConfig: unknown
  settings: Record<string, unknown>
}) {
  const model = nativeModel(options.model)
  return [
    'claude',
    '--append-system-prompt',
    options.system,
    '--mcp-config',
    JSON.stringify(options.mcpConfig),
    '--settings',
    JSON.stringify({
      ...options.settings,
      ...subscriptionSettings,
      env: {
        ...(typeof options.settings.env === 'object' && options.settings.env !== null
          ? options.settings.env
          : {}),
        ...subscriptionSettings.env,
      },
    }),
    ...(model ? ['--model', model] : []),
    ...(options.yolo === true ? ['--dangerously-skip-permissions'] : []),
    '--',
    options.prompt,
  ]
}

/** Native /model changes are owned by Claude; this value tracks the harness launch setting only. */
export function nativeModel(model?: string) {
  const configured = model?.trim() ?? ''
  return ['', 'native', 'default'].includes(configured) ? undefined : configured
}
