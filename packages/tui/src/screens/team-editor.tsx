import type { AgentDef } from '@aidcrew/core'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import type { AgentTemplate } from '../agents-file.ts'
import { TEMPLATES } from '../agents-file.ts'
import { Header, Keys, Panel, Problem, Select, Spinner } from '../components/chrome.tsx'
import { Field, TextInput } from '../components/input.tsx'
import type { ModelListing } from '../models.ts'
import { isFree, rankForCoding } from '../models.ts'
import { providerChoices } from '../providers-list.ts'
import { useTheme, useVoice } from '../theme-context.tsx'

/**
 * Managing the team without opening a file.
 *
 * The files are still there — `.aidcrew/agents/*.md`, committed with the
 * project — but nobody has to write the frontmatter by hand or remember which
 * key is called what. Add someone from a template, give them a model, remove
 * them; the file follows.
 */

export type TeamEditorProps = {
  agents: AgentDef[]
  /** Which providers are available, for assigning one to an agent. */
  providers: string[]
  onAdd(template: AgentTemplate): Promise<void>
  onRemove(id: string): Promise<void>
  onSetModel(id: string, provider: string, model: string): Promise<void>
  /** Asks the provider what it has, so a model is chosen rather than typed. */
  listModels(providerId: string): Promise<ModelListing>
  onClose(): void
}

type Mode =
  | { at: 'list' }
  | { at: 'add' }
  | { at: 'provider'; agentId: string }
  /** Asked before an agent is taken off the team: `y` removes, anything else keeps. */
  | { at: 'confirm'; agentId: string }
  | { at: 'loading'; agentId: string; provider: string }
  | { at: 'model'; agentId: string; provider: string; listing: ModelListing }

export function TeamEditor(props: TeamEditorProps) {
  const window = useWindowSize()
  const theme = useTheme()
  const voice = useVoice()
  const [mode, setMode] = useState<Mode>({ at: 'list' })
  const [cursor, setCursor] = useState(0)
  const [model, setModel] = useState('')

  const present = new Set(props.agents.map((agent) => agent.id))
  const available = TEMPLATES.filter((template) => !present.has(template.id))

  useInput((input, key) => {
    if (mode.at === 'list') {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
      if (key.downArrow) setCursor((c) => Math.min(props.agents.length - 1, c + 1))
      if (input === 'a') setMode({ at: 'add' })
      if (input === 'd') {
        // Asked first. One key deleted the agent's file and stopped it, with
        // no way back but writing the file again.
        const target = props.agents[cursor]
        if (target) setMode({ at: 'confirm', agentId: target.id })
      }
      if (key.return) {
        const target = props.agents[cursor]
        if (target) setMode({ at: 'provider', agentId: target.id })
      }
      if (key.escape) props.onClose()
      return
    }
    if (mode.at === 'confirm') {
      if (input === 'y') {
        void props.onRemove(mode.agentId)
        setCursor((at) => Math.max(0, Math.min(at, props.agents.length - 2)))
      }
      setMode({ at: 'list' })
      return
    }
    if (key.escape) setMode({ at: 'list' })
  })

  return (
    // The window's height exactly, padded rather than short. Ink erases the
    // previous frame and writes this one — but a frame shorter than the window,
    // following one that filled it, makes it clear the whole terminal instead,
    // and a clear is the blink people see when a screen opens.
    <Box flexDirection="column" height={window.rows} width={window.columns}>
      <Header title="team" subtitle=".aidcrew/agents" />

      <Box marginY={1}>
        {mode.at === 'list' ? (
          <Panel title="Your team" focused>
            {props.agents.length === 0 ? (
              <Text color={theme.muted}>nobody yet — press a to add someone</Text>
            ) : (
              props.agents.map((agent, index) => (
                <Box key={agent.id} justifyContent="space-between">
                  <Text color={index === cursor ? theme.accent : voice(index)}>
                    {index === cursor ? '❯ ' : '  '}
                    {agent.id.padEnd(12)}
                  </Text>
                  <Text color={theme.muted}>
                    {agent.model ?? 'default model'}
                    {agent.tools ? `  ${agent.tools.length} tools` : '  all tools'}
                  </Text>
                </Box>
              ))
            )}
          </Panel>
        ) : null}

        {mode.at === 'confirm' ? (
          <Panel title={`Remove ${mode.agentId}?`} focused>
            <Text color={theme.muted}>
              Its file goes and it is stopped. <Text color={theme.accent}>y</Text> to remove, any
              other key to keep it.
            </Text>
          </Panel>
        ) : null}

        {mode.at === 'add' ? (
          <Panel title="Add someone" focused>
            {available.length === 0 ? (
              <Text color={theme.muted}>every template is already on the team</Text>
            ) : (
              <Select
                choices={available.map((template) => ({
                  value: template,
                  label: template.id,
                  hint: template.reason,
                }))}
                onChoose={(template) => {
                  void props.onAdd(template)
                  setMode({ at: 'list' })
                }}
              />
            )}
          </Panel>
        ) : null}

        {mode.at === 'provider' ? (
          <Panel title={`Which service for ${mode.agentId}?`} focused>
            <Select
              choices={providerChoices(props.providers)}
              onChoose={(chosen) => {
                setMode({ at: 'loading', agentId: mode.agentId, provider: chosen })
                void props
                  .listModels(chosen)
                  .then((listing) =>
                    setMode({ at: 'model', agentId: mode.agentId, provider: chosen, listing }),
                  )
              }}
            />
          </Panel>
        ) : null}

        {mode.at === 'loading' ? (
          <Panel title="Fetching models" focused>
            <Spinner label={`asking ${mode.provider} what it has`} />
          </Panel>
        ) : null}

        {mode.at === 'model' ? (
          <Panel title={`Model for ${mode.agentId}`} focused>
            {mode.listing.kind === 'listed' ? (
              <Select
                height={14}
                choices={rankForCoding(mode.listing.models).map((id) => ({
                  value: id,
                  label: id,
                  ...(isFree(id) ? { hint: 'free' } : {}),
                }))}
                onChoose={(model) => {
                  void props.onSetModel(mode.agentId, mode.provider, model)
                  setMode({ at: 'list' })
                }}
              />
            ) : (
              <>
                <Field label="model id" focused>
                  <TextInput
                    value={model}
                    onChange={setModel}
                    onSubmit={(value) => {
                      if (value.trim() === '') return
                      void props.onSetModel(mode.agentId, mode.provider, value.trim())
                      setModel('')
                      setMode({ at: 'list' })
                    }}
                    placeholder="e.g. deepseek-v4-flash"
                  />
                </Field>
                <Box marginTop={1}>
                  <Problem
                    text={`Could not list models: ${mode.listing.reason}.`}
                    hint="Type the id instead."
                  />
                </Box>
              </>
            )}
          </Panel>
        ) : null}
      </Box>

      <Keys
        keys={
          mode.at === 'list'
            ? [
                ['↑↓', 'move'],
                ['enter', 'set model'],
                ['a', 'add'],
                ['d', 'remove'],
                ['esc', 'back'],
              ]
            : [
                ['enter', 'choose'],
                ['esc', 'back'],
              ]
        }
      />
    </Box>
  )
}
