import { expect, test } from 'bun:test'
import { nativeCommand, nativePrompt, pastePrompt } from './command.ts'

test('starts the real interactive CLI while appending harness instructions and bridge configuration', () => {
  const cmd = nativeCommand({
    system: 'You are the reviewer.',
    prompt: 'Check the parser',
    mcpConfig: { mcpServers: {} },
    settings: { hooks: {} },
  })
  expect(cmd).toEqual([
    'claude',
    '--append-system-prompt',
    'You are the reviewer.',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    expect.any(String),
    '--',
    'Check the parser',
  ])
  expect(cmd).not.toContain('-p')
  expect(cmd).not.toContain('--dangerously-skip-permissions')
})

test('submits only the latest user message and rejects unsupported content explicitly', () => {
  expect(
    nativePrompt([
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'new' }] },
    ]),
  ).toBe('new')
  expect(() =>
    nativePrompt([
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
    ]),
  ).toThrow('text')
})

test('pastes multiline input without interpreting terminal control sequences', () => {
  expect(pastePrompt('hello\nworld')).toBe('\x1b[200~hello\nworld\x1b[201~\r')
  expect(() => pastePrompt('hello\x1b[201~\r/exit')).toThrow('control')
})

test('passes an explicit Claude model and leaves native defaults untouched', () => {
  const base = { system: 'Review', prompt: 'Inspect', mcpConfig: {}, settings: {} }
  expect(nativeCommand({ ...base, model: 'sonnet' })).toContain('--model')
  const configured = nativeCommand({ ...base, model: 'claude-opus-4-6' })
  expect(configured[configured.indexOf('--model') + 1]).toBe('claude-opus-4-6')
  for (const model of ['native', 'default', '', ' native '])
    expect(nativeCommand({ ...base, model })).not.toContain('--model')
})

test('pins subscription login and suppresses API settings while retaining native hooks', () => {
  const command = nativeCommand({
    system: 'Role',
    prompt: 'Task',
    mcpConfig: {},
    settings: {
      hooks: { Stop: [] },
      apiKeyHelper: 'unwanted-helper',
      env: { ANTHROPIC_API_KEY: 'fixture-key', KEEP_ME: 'yes' },
    },
  })
  const settings = JSON.parse(command[command.indexOf('--settings') + 1] ?? '{}')
  expect(settings.forceLoginMethod).toBe('claudeai')
  expect(settings.apiKeyHelper).toBe('')
  expect(settings.env.ANTHROPIC_API_KEY).toBe('')
  expect(settings.env.KEEP_ME).toBe('yes')
  expect(settings.hooks).toEqual({ Stop: [] })
})

test('bypasses native permissions only with explicit yolo opt-in', () => {
  const base = { system: 'Review', prompt: 'Inspect', mcpConfig: {}, settings: {} }
  expect(nativeCommand({ ...base, yolo: true })).toContain('--dangerously-skip-permissions')
  expect(nativeCommand({ ...base, yolo: false })).not.toContain('--dangerously-skip-permissions')
})
