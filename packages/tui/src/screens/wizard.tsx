import { ORCHESTRATION, ORCHESTRATION_FILE } from '@aidcrew/core'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import type { AgentTemplate } from '../agents-file.ts'
import { TEMPLATES } from '../agents-file.ts'
import { Header, Keys, Panel, Problem, Select, Spinner } from '../components/chrome.tsx'
import { Field, SecretInput, TextInput } from '../components/input.tsx'
import type { ModelListing } from '../models.ts'
import { isFree, rankForCoding } from '../models.ts'
import { useTheme } from '../theme-context.tsx'

/**
 * First run: from nothing to a working team, without opening a file.
 *
 * The order is deliberate — provider, key, model, agents — because each answer
 * makes the next question answerable. Asking which model before there is a key
 * would mean asking someone to type an id from memory; with the key we can ask
 * the provider and offer a list.
 */

export type WizardResult = {
  provider: string
  model: string
  agents: { template: AgentTemplate; model?: string }[]
  /**
   * Whether to write the built-in orchestration into the project.
   *
   * The wording every agent reads on every request is one of the two files
   * that decide how a team behaves, and until it is on disk nobody knows it
   * exists — so it is offered here, once, where somebody is already deciding
   * what their team is.
   */
  writeOrchestration: boolean
}

export type WizardDeps = {
  /** Provider ids the loaded plugins offer. */
  providers: string[]
  /** Saves the key where the operating system keeps secrets. */
  saveKey(providerId: string, apiKey: string): Promise<void>
  /** Asks the provider what it has; may report that it cannot say. */
  listModels(providerId: string, apiKey: string): Promise<ModelListing>
  onDone(result: WizardResult): void
  onCancel(): void
}

type Step = 'provider' | 'key' | 'checking' | 'model' | 'agents' | 'orchestration' | 'review'

export function Wizard(deps: WizardDeps) {
  const window = useWindowSize()
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [listing, setListing] = useState<ModelListing | undefined>()
  const [model, setModel] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set(['architect', 'coder', 'reviewer']))
  const [cursor, setCursor] = useState(0)
  const [writeOrchestration, setWriteOrchestration] = useState(false)

  async function acceptKey(): Promise<void> {
    if (apiKey.trim() === '') return
    setStep('checking')

    await deps.saveKey(provider, apiKey.trim())
    const found = await deps.listModels(provider, apiKey.trim())

    setListing(found)
    setStep('model')
  }

  function finish(): void {
    const agents = TEMPLATES.filter((template) => chosen.has(template.id)).map((template) => ({
      template,
    }))
    deps.onDone({ provider, model, agents, writeOrchestration })
  }

  useInput(
    (input, key) => {
      if (key.escape) deps.onCancel()

      if (step === 'agents') {
        if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
        if (key.downArrow) setCursor((c) => Math.min(TEMPLATES.length - 1, c + 1))
        if (input === ' ') {
          const template = TEMPLATES[cursor]
          if (template) {
            setChosen((current) => {
              const next = new Set(current)
              if (next.has(template.id)) next.delete(template.id)
              else next.add(template.id)
              return next
            })
          }
        }
        if (key.return) setStep('orchestration')
      }

      if (step === 'orchestration') {
        // Two ways forward and no way to get it wrong: take the built-in
        // wording, or put it in the project where it can be argued with.
        if (input === 'e') {
          setWriteOrchestration(true)
          setStep('review')
        }
        if (key.return) setStep('review')
      }

      if (step === 'review' && key.return) finish()
    },
    // Active throughout: the footer says "esc quit" on every step, and it
    // used to do nothing until the fourth.
    { isActive: true },
  )

  return (
    // The window's height exactly, padded rather than short. Ink erases the
    // previous frame and writes this one — but a frame shorter than the window,
    // following one that filled it, makes it clear the whole terminal instead,
    // and a clear is the blink people see when a screen opens.
    <Box flexDirection="column" height={window.rows} width={window.columns}>
      <Header title="setup" subtitle={`step ${stepNumber(step)} of 5`} />

      <Box marginY={1}>
        {step === 'provider' ? (
          <ProviderStep
            providers={deps.providers}
            onChoose={(id) => {
              setProvider(id)
              setStep('key')
            }}
          />
        ) : null}

        {step === 'key' ? (
          <KeyStep
            provider={provider}
            apiKey={apiKey}
            onChange={setApiKey}
            onSubmit={() => void acceptKey()}
          />
        ) : null}

        {step === 'checking' ? (
          <Panel title="checking">
            <Spinner label={`asking ${provider} which models it has`} />
          </Panel>
        ) : null}

        {step === 'model' ? (
          <ModelStep
            listing={listing}
            model={model}
            onChange={setModel}
            onChoose={(id) => {
              setModel(id)
              setStep('agents')
            }}
          />
        ) : null}

        {step === 'agents' ? <AgentStep chosen={chosen} cursor={cursor} /> : null}

        {step === 'orchestration' ? <OrchestrationStep /> : null}

        {step === 'review' ? (
          <ReviewStep
            provider={provider}
            model={model}
            chosen={chosen}
            writeOrchestration={writeOrchestration}
          />
        ) : null}
      </Box>

      <Keys keys={keysFor(step)} />
    </Box>
  )
}

function stepNumber(step: Step): number {
  return step === 'provider'
    ? 1
    : step === 'key' || step === 'checking'
      ? 2
      : step === 'model'
        ? 3
        : step === 'agents'
          ? 4
          : 5
}

function keysFor(step: Step): [string, string][] {
  if (step === 'agents') {
    return [
      ['↑↓', 'move'],
      ['space', 'include'],
      ['enter', 'continue'],
      ['esc', 'quit'],
    ]
  }
  if (step === 'orchestration') {
    return [
      ['enter', 'keep this wording'],
      ['e', 'put it in the project to edit'],
      ['esc', 'quit'],
    ]
  }
  if (step === 'review') {
    return [
      ['enter', 'create the team'],
      ['esc', 'quit'],
    ]
  }
  return [
    ['↑↓', 'move'],
    ['enter', 'choose'],
    ['esc', 'quit'],
  ]
}

function ProviderStep({
  providers,
  onChoose,
}: {
  providers: string[]
  onChoose: (id: string) => void
}) {
  const theme = useTheme()
  return (
    <Panel title="Which service will your agents use?" focused>
      <Select
        choices={providers.map((id) => ({ value: id, label: id, hint: hintForProvider(id) }))}
        onChoose={onChoose}
      />
      <Box marginTop={1}>
        <Text color={theme.muted}>You can add others later, and use several at once.</Text>
      </Box>
    </Panel>
  )
}

function hintForProvider(id: string): string {
  const hints: Record<string, string> = {
    zen: 'pay as you go, free tier',
    'opencode-go': 'flat monthly subscription',
    ollama: 'runs on this machine',
    'openai-compat': 'any other endpoint',
    anthropic: 'Claude models',
  }
  return hints[id] ?? ''
}

export function KeyStep({
  provider,
  apiKey,
  onChange,
  onSubmit,
}: {
  provider: string
  apiKey: string
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  const theme = useTheme()
  return (
    <Panel title={`Your key for ${provider}`} focused>
      <Field label="key" focused>
        <SecretInput value={apiKey} onChange={onChange} onSubmit={onSubmit} />
      </Field>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>It is not shown as you type and is never displayed again.</Text>
        {/* Somebody who has just downloaded the binary and has no key at all
            reaches this screen and cannot go forward: an empty key submits to
            nothing. Ctrl-C was the only way out, which is a first run that
            ends in quitting. There is somewhere to send them now. */}
        <Text color={theme.muted}>
          No key yet? <Text color={theme.text}>ctrl-c</Text>, then{' '}
          <Text color={theme.text}>aidcrew demo</Text> — the whole loop against real files, with no
          key and no account.
        </Text>
      </Box>
    </Panel>
  )
}

function ModelStep({
  listing,
  model,
  onChange,
  onChoose,
}: {
  listing: ModelListing | undefined
  model: string
  onChange: (value: string) => void
  onChoose: (id: string) => void
}) {
  const theme = useTheme()
  if (listing?.kind === 'listed') {
    const ranked = rankForCoding(listing.models).slice(0, 12)
    return (
      <Panel title="Which model?" focused>
        <Select
          choices={ranked.map((id) => ({
            value: id,
            label: id,
            ...(isFree(id) ? { hint: 'free' } : {}),
          }))}
          onChoose={onChoose}
        />
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {listing.models.length} available; the ones that work well with tools are first.
          </Text>
        </Box>
      </Panel>
    )
  }

  return (
    <Panel title="Which model?" focused>
      <Field label="model id" focused>
        <TextInput
          value={model}
          onChange={onChange}
          onSubmit={() => model.trim() !== '' && onChoose(model.trim())}
          placeholder="e.g. claude-opus-5"
        />
      </Field>
      {listing?.kind === 'unavailable' ? (
        <Box marginTop={1}>
          <Problem
            text={`Could not list models: ${listing.reason}.`}
            hint="Type the id yourself, or press esc and try another key."
          />
        </Box>
      ) : null}
    </Panel>
  )
}

function AgentStep({ chosen, cursor }: { chosen: Set<string>; cursor: number }) {
  const theme = useTheme()
  return (
    <Panel title="Who is on the team?" focused>
      {TEMPLATES.map((template, index) => {
        const included = chosen.has(template.id)
        const here = index === cursor
        return (
          <Box key={template.id} justifyContent="space-between">
            <Text {...(here ? { color: theme.accent } : {})} bold={here}>
              {here ? '❯ ' : '  '}
              <Text color={included ? theme.ok : theme.muted}>{included ? '✓' : '·'}</Text>{' '}
              {template.id.padEnd(11)}
            </Text>
            <Text color={theme.muted}>{template.reason}</Text>
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          Each one is a file in your project, so your team travels with the repository.
        </Text>
      </Box>
    </Panel>
  )
}

/**
 * The wording every agent reads on every request.
 *
 * The second of the two files that decide how a team behaves — the first is
 * what each agent is for — and the one nobody discovers, because a team works
 * without it. Shown once, here, where somebody is already deciding what their
 * team is: keep it as it is, or have it written into the project where it can
 * be argued with.
 */
function OrchestrationStep() {
  const theme = useTheme()
  const said = ORCHESTRATION.trim().split('\n')

  return (
    <Panel title="How the team works together" focused>
      <Box flexDirection="column">
        {said.slice(0, 12).map((row, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: prose rows have no id but never move
            key={index}
            color={row.trim() === '' ? theme.surface : theme.muted}
          >
            {row.trim() === '' ? ' ' : `  ${row}`}
          </Text>
        ))}
        {said.length > 12 ? (
          <Text color={theme.faint}>{`  … and ${said.length - 12} more`}</Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>
          Every agent reads this on every request, after its own file.
        </Text>
        <Text color={theme.muted}>
          <Text color={theme.accent}>e</Text> writes it to {ORCHESTRATION_FILE} so you can change
          it; the team works either way.
        </Text>
      </Box>
    </Panel>
  )
}

function ReviewStep({
  provider,
  model,
  chosen,
  writeOrchestration,
}: {
  provider: string
  model: string
  chosen: Set<string>
  writeOrchestration: boolean
}) {
  const theme = useTheme()
  return (
    <Panel title="Ready" focused>
      <Field label="service">
        <Text>{provider}</Text>
      </Field>
      <Field label="model">
        <Text>{model}</Text>
      </Field>
      <Field label="team">
        <Text>{[...chosen].join(', ') || 'nobody yet'}</Text>
      </Field>
      <Field label="how they work">
        <Text>
          {writeOrchestration ? `${ORCHESTRATION_FILE}, yours to edit` : 'the built-in wording'}
        </Text>
      </Field>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>
          Agents go in .aidcrew/agents — commit them to share the team.
        </Text>
        <Text color={theme.muted}>You can give each one its own model afterwards.</Text>
      </Box>
    </Panel>
  )
}
