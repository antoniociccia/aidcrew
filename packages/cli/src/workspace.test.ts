import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { readOrchestration } from './team.ts'
import { loadWorkspaceConfig, WorkspaceConfigError } from './workspace.ts'

let repo: string
let home: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-ws-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-home-')))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function config(where: string, toml: string): void {
  mkdirSync(join(where, '.aidcrew'), { recursive: true })
  writeFileSync(join(where, '.aidcrew', 'config.toml'), toml)
}

describe('loadWorkspaceConfig', () => {
  test('points at the usual layout when there is no config at all', async () => {
    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.instructions).toContain(join(repo, 'CLAUDE.md'))
    expect(loaded.sources.instructions).toContain(join(repo, 'AGENTS.md'))
    expect(loaded.sources.skills).toContain(join(home, '.claude', 'skills'))
    expect(loaded.sources.agents).toContain(join(repo, '.claude', 'agents'))
    expect(loaded.sources.agents).toContain(join(repo, '.aidcrew', 'agents'))
  })

  test('prefers an agent the interface wrote over one of the same name elsewhere', async () => {
    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    const own = loaded.sources.agents.indexOf(join(repo, '.aidcrew', 'agents'))
    const claude = loaded.sources.agents.indexOf(join(repo, '.claude', 'agents'))
    expect(own).toBeGreaterThan(claude)
  })

  test('always reads where the interface writes, however sources are declared', async () => {
    // The interface writes a new agent to .aidcrew/agents. A project that
    // declares its own agent paths used to replace that one too, so "add an
    // agent" wrote a file that was never read again — the agent appeared to
    // vanish, and removing one appeared to do nothing.
    config(repo, '[sources]\nagents = ["./.claude/agents"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.agents).toContain(join(repo, '.aidcrew', 'agents'))
    // Last, so an agent the interface wrote still wins over one of the same
    // name found elsewhere.
    expect(loaded.sources.agents.at(-1)).toBe(join(repo, '.aidcrew', 'agents'))
  })

  test('does not list it twice when the project already names it', async () => {
    config(repo, '[sources]\nagents = ["./.aidcrew/agents", "./.claude/agents"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(
      loaded.sources.agents.filter((path) => path.endsWith(join('.aidcrew', 'agents'))),
    ).toHaveLength(1)
  })

  test('replaces the defaults with what the project declares', async () => {
    config(repo, '[sources]\ninstructions = ["./docs/RULES.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.instructions).toEqual([join(repo, 'docs', 'RULES.md')])
  })

  test('keeps the defaults for the categories the project does not mention', async () => {
    config(repo, '[sources]\ninstructions = ["./RULES.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.skills.length).toBeGreaterThan(0)
  })

  test('expands ~ to the home directory', async () => {
    // Trusted, because this writes a home path into the *project* config, and
    // a project asking to read outside itself is the thing a clone does not
    // get. `~` still means home; it is the asking that needs an answer.
    config(repo, '[sources]\nskills = ["~/my-skills"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home, trusted: () => true })

    expect(loaded.sources.skills).toEqual([join(home, 'my-skills')])
  })

  test('resolves relative paths against the project, not the shell', async () => {
    config(repo, '[sources]\nagents = ["./team"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    // Plus the directory the interface writes to, which is always read.
    expect(loaded.sources.agents[0]).toBe(join(repo, 'team'))
  })

  test('reads the per-agent provider and model, which is the point of all this', async () => {
    config(
      repo,
      `[agents.architect]
provider = "anthropic"
model = "claude-opus-5"

[agents.coder]
provider = "deepseek"
model = "deepseek-chat"
tools = ["read", "edit", "bash"]
`,
    )

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.architect).toEqual({ provider: 'anthropic', model: 'claude-opus-5' })
    expect(loaded.agents.coder?.tools).toEqual(['read', 'edit', 'bash'])
  })

  test('reads the env variable an agent names for its own key', async () => {
    // Two agents on the same provider but different plans: each names the
    // variable holding its key, so quotas and billing stay separate.
    config(
      repo,
      `[agents.architect]
provider = "anthropic"
apiKeyEnv = "ANTHROPIC_KEY_MAX"

[agents.coder]
provider = "anthropic"
apiKeyEnv = "ANTHROPIC_KEY_PRO"
`,
    )

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.architect?.apiKeyEnv).toBe('ANTHROPIC_KEY_MAX')
    expect(loaded.agents.coder?.apiKeyEnv).toBe('ANTHROPIC_KEY_PRO')
  })

  test('refuses a key pasted where a variable name belongs', async () => {
    // This config file gets committed. Catching it here is the difference
    // between a clear error and a leaked credential.
    config(repo, '[agents.coder]\napiKeyEnv = "sk-ant-api03-realkeyhere"\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/variable name/i)
  })

  test('rejects a lowercase value that cannot be an env variable name', async () => {
    config(repo, '[agents.coder]\napiKeyEnv = "my-secret-value"\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(WorkspaceConfigError)
  })

  test('lets the project override the user config', async () => {
    config(home, '[defaults]\nmodel = "user-model"\n')
    config(repo, '[defaults]\nmodel = "project-model"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.defaults.model).toBe('project-model')
  })

  test('takes the user config when the project has none', async () => {
    config(home, '[defaults]\nprovider = "zen"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.defaults.provider).toBe('zen')
  })

  test('merges agents from both configs rather than replacing the set', async () => {
    config(home, '[agents.reviewer]\nmodel = "shared-reviewer"\n')
    config(repo, '[agents.coder]\nmodel = "project-coder"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(Object.keys(loaded.agents).sort()).toEqual(['coder', 'reviewer'])
  })

  test('finds no agent under a name that belongs to JavaScript', async () => {
    // Agents are looked up by a name the config chose, so the record they live
    // in must answer for the names it was given and no others.
    config(repo, '[agents.coder]\nmodel = "project-coder"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.toString).toBeUndefined()
    expect(loaded.prices.valueOf).toBeUndefined()
  })

  test('names the file and the problem when the toml is broken', async () => {
    config(repo, '[sources\nbroken = ')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(WorkspaceConfigError)
    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/config\.toml/)
  })

  test('rejects a sources entry that is not a list of strings', async () => {
    config(repo, '[sources]\nskills = 42\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(WorkspaceConfigError)
  })

  test('reports where the configuration was read from', async () => {
    config(repo, '[defaults]\nmodel = "m"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.files).toEqual([join(repo, '.aidcrew', 'config.toml')])
  })
})

describe('when to shorten a conversation', () => {
  test('reads the budget and the model that writes the summary', async () => {
    config(repo, '[agents.coder]\ncompactAt = 90000\ncompactWith = "zen"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.coder).toMatchObject({ compactAt: 90000, compactWith: 'zen' })
  })

  test('refuses a budget that is not a positive number', async () => {
    // One that compacts on every turn, or on none, fails without saying so.
    config(repo, '[agents.coder]\ncompactAt = 0\n')

    await expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/positive number/)
  })

  test('leaves both unset when the project says nothing about them', async () => {
    config(repo, '[agents.coder]\nmodel = "a"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.coder?.compactAt).toBeUndefined()
    expect(loaded.agents.coder?.compactWith).toBeUndefined()
  })
})

describe('a note the team on a task shares', () => {
  test('is off unless the project asks for it', async () => {
    // It puts a paragraph in front of every agent on every request, which is
    // a decision to make rather than one to discover on a bill.
    expect((await loadWorkspaceConfig({ cwd: repo, home })).sharedMemory).toBe(false)
  })

  test('is on when the project says so', async () => {
    config(repo, '[defaults]\nsharedMemory = true\n')

    expect((await loadWorkspaceConfig({ cwd: repo, home })).sharedMemory).toBe(true)
  })

  test('refuses a value that is not a yes or a no', async () => {
    config(repo, '[defaults]\nsharedMemory = "sometimes"\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/true or false/)
  })
})

describe("a plugin's own settings", () => {
  test('come from [plugins.<name>] and reach only that plugin', async () => {
    config(repo, '[plugins.linear]\nteam = "core"\nboard = 7\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.plugins.linear).toEqual({ team: 'core', board: 7 })
    expect(loaded.plugins.other).toBeUndefined()
  })

  test('a value that looks like a key is refused, because this file is committed', async () => {
    // The same rule apiKeyEnv already enforces, for the same reason: this is
    // the single most likely way to leak a credential.
    config(repo, '[plugins.linear]\napiKey = "lin_api_abcdefghijklmnopqrstuvwxyz012345"\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/apiKey/)
  })

  test('naming the variable that holds it is fine', async () => {
    config(repo, '[plugins.linear]\napiKeyEnv = "LINEAR_TOKEN"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.plugins.linear).toEqual({ apiKeyEnv: 'LINEAR_TOKEN' })
  })

  test('a project with no plugin settings has an empty table, not undefined', async () => {
    config(repo, '[agents.coder]\nmodel = "x"\n')

    expect((await loadWorkspaceConfig({ cwd: repo, home })).plugins).toEqual({})
  })

  test('a plugin nobody wrote a table for has no settings, whatever it is called', async () => {
    // The read sites ask `plugins[name] ?? {}`, so a record inheriting from
    // Object.prototype hands a plugin named `toString` a function to call as
    // its settings, and one named `constructor` the Object constructor.
    config(repo, '[plugins.standup]\nteam = "core"\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.plugins.toString).toBeUndefined()
    expect(loaded.plugins.constructor).toBeUndefined()
  })

  test('refuses a table named __proto__, because settings would reach every plugin', async () => {
    // A cloned repository brings this file with it. `[plugins.__proto__.x]`
    // used to become the prototype of the whole record, so `plugins["x"]`
    // answered with settings the project never declared — and neither
    // Object.keys nor JSON.stringify showed a trace of them.
    config(
      repo,
      '[plugins.standup]\nteam = "core"\n\n[plugins.__proto__.hooks-guard]\nanything = "goes"\n',
    )

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/__proto__/)
  })

  test('refuses the other two names that mean JavaScript rather than a plugin', async () => {
    for (const name of ['constructor', 'prototype']) {
      config(repo, `[plugins.${name}]\nanything = "goes"\n`)

      expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(WorkspaceConfigError)
    }
  })
})

describe('a plugin setting that looks like a credential', () => {
  // Each entry is the body of a config declaring settings for `standup`. The
  // file is committed, so the question every one of these asks is whether the
  // spelling in front of us would have published a key.
  const refused: [string, string][] = [
    ['a separator between the words', 'api_key = "sk-live-notreal"'],
    ['a dash instead of an underscore', 'api-key = "sk-live-notreal"'],
    ['a camelCase boundary', 'authToken = "sk-live-notreal"'],
    ['a plural holding several of them', 'tokens = ["sk-live-notreal"]'],
    ['a nested table', '[plugins.standup.auth]\ntoken = "sk-live-notreal"'],
    ['a table inside an array of tables', '[[plugins.standup.accounts]]\nsecret = "sk-notreal"'],
    ['the bare word', 'password = "hunter2"'],
    ['the word on its own in capitals', 'TOKEN = "sk-live-notreal"'],
    // These two were refused before the rule was widened to see separators
    // and camelCase, and widening a rule must not narrow it: they are one
    // word to any reader and to every splitter, and they are how a key gets
    // written by somebody who does not hold with punctuation.
    ['no separator at all', 'apikey = "sk-live-notreal"'],
    ['no separator and the other word', 'apitoken = "sk-live-notreal"'],
  ]

  for (const [what, body] of refused) {
    test(`is refused when the name carries ${what}`, async () => {
      config(repo, `[plugins.standup]\n${body}\n`)

      expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/credential/)
    })
  }

  const accepted: [string, string][] = [
    ['names the variable holding it', 'apiKeyEnv = "LINEAR_TOKEN"'],
    ['names it with underscores', 'api_key_env = "LINEAR_TOKEN"'],
    ['names it with dashes', 'api-key-env = "LINEAR_TOKEN"'],
    ['names it from a nested table', '[plugins.standup.auth]\ntoken_env = "LINEAR_TOKEN"'],
    ['is an address', 'endpoint = "https://example.invalid/api"'],
    ['is a model', 'model = "claude-opus-5"'],
    ['is a team', 'team = "core"'],
    ['merely ends in the letters of one', 'keyboard = "dvorak"'],
    ['merely ends in another', 'monkey = "patched"'],
  ]

  for (const [what, body] of accepted) {
    test(`is kept when the setting ${what}`, async () => {
      config(repo, `[plugins.standup]\n${body}\n`)

      const loaded = await loadWorkspaceConfig({ cwd: repo, home })

      expect(loaded.plugins.standup).toBeDefined()
    })
  }

  test('names the whole path, so nobody has to hunt through the file for it', async () => {
    // A message naming only `token` sends somebody reading every table.
    config(repo, '[plugins.standup]\n\n[plugins.standup.auth]\ntoken = "sk-live-notreal"\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(
      /plugins\.standup\.auth\.token/,
    )
  })
})

describe('a config that arrived with a clone', () => {
  // `.aidcrew/config.toml` is made to be committed — it is how a repository
  // ships its team — and that is exactly why it needs reading twice. The rule
  // every test here checks is that a project config is gated on what it would
  // ADD to what this machine already reads, never on what it says.

  test('does not let it unleash an agent', async () => {
    config(repo, '[agents.coder]\nmodel = "sonnet"\nyolo = true\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.coder?.yolo).toBeUndefined()
    // The rest of the file still applies: one refused line does not cost a
    // project the team it shipped.
    expect(loaded.agents.coder?.model).toBe('sonnet')
    expect(loaded.refused.map((one) => one.claim)).toEqual(['agents.coder.yolo'])
  })

  test('does not let it read a file outside the project into every request', async () => {
    config(repo, '[sources]\ninstructions = ["./RULES.md", "~/.aws/credentials"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.instructions).toEqual([join(repo, 'RULES.md')])
    expect(loaded.refused.map((one) => one.claim)).toEqual([
      `sources.instructions=${join(home, '.aws', 'credentials')}`,
    ])
  })

  test('does not let an absolute path walk out of the project through ".."', async () => {
    // `<repo>/../<home>/.aws/credentials` begins with the project directory
    // and is not in it. A string-prefix test read it as the project's own,
    // and the file went into every request. The claim names where the path
    // resolved to, like every other refused source: what has to be trusted
    // is the file, not the spelling that reached it.
    const sneaky = `${repo}/../${basename(home)}/.aws/credentials`
    config(repo, `[sources]\ninstructions = [${JSON.stringify(sneaky)}]\n`)

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.instructions).not.toContain(sneaky)
    expect(loaded.refused.map((one) => one.claim)).toEqual([
      `sources.instructions=${join(home, '.aws', 'credentials')}`,
    ])
  })

  test('a project directory spelled with a trailing slash still owns its own files', async () => {
    // What shell completion types: `aidcrew -C proj/`. The prefix test
    // appended a separator of its own, looked for `proj//` and found nothing
    // under it, so every path the project named for itself was "outside this
    // project" and silently dropped.
    config(repo, '[sources]\ninstructions = ["./docs/RULES.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: `${repo}/`, home })

    expect(loaded.sources.instructions).toContain(join(repo, 'docs', 'RULES.md'))
    expect(loaded.refused).toEqual([])
  })

  test('a project directory spelled relatively still owns its own files', async () => {
    // `aidcrew -C .`, the other common spelling, and the same silence.
    config(repo, '[sources]\ninstructions = ["./docs/RULES.md"]\n')
    const before = process.cwd()
    process.chdir(repo)
    try {
      const loaded = await loadWorkspaceConfig({ cwd: '.', home })

      expect(loaded.sources.instructions).toContain(join(repo, 'docs', 'RULES.md'))
      expect(loaded.refused).toEqual([])
    } finally {
      process.chdir(before)
    }
  })

  test('does not let it take agents from outside the project', async () => {
    // The sharpest of the three, because an agent definition's body IS a
    // system prompt, and a configured name joins the team without passing the
    // filter that keeps found agents inside the project.
    config(repo, '[sources]\nagents = ["~/Documents"]\n\n[agents.helper]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.agents).toEqual([join(repo, '.aidcrew', 'agents')])
    expect(loaded.refused.map((one) => one.claim)).toEqual([
      `sources.agents=${join(home, 'Documents')}`,
    ])
  })

  test("does not let it offer somebody else's skills as this team's", async () => {
    config(repo, '[sources]\nskills = ["~/secret-skills"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.skills).toEqual([])
    expect(loaded.refused.map((one) => one.claim)).toEqual([
      `sources.skills=${join(home, 'secret-skills')}`,
    ])
  })

  test('lets a project read its own files', async () => {
    // The feature survives the gate, which is the whole point of gating on
    // what is added rather than on what is said.
    config(repo, '[sources]\ninstructions = ["./docs/RULES.md"]\nskills = ["./.claude/skills"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.instructions).toEqual([join(repo, 'docs', 'RULES.md')])
    expect(loaded.sources.skills).toEqual([join(repo, '.claude', 'skills')])
    expect(loaded.refused).toEqual([])
  })

  test('does not refuse the paths it would have read anyway', async () => {
    // What the Settings screen writes after one click: it rewrites the whole
    // list from the resolved paths, and the defaults it resolves include the
    // user's own home directory. A naive escape test makes the interface
    // produce a config it refuses on the next start.
    config(repo, '[sources]\nskills = ["~/.claude/skills", "./.claude/skills"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.skills).toEqual([
      join(home, '.claude', 'skills'),
      join(repo, '.claude', 'skills'),
    ])
    expect(loaded.refused).toEqual([])
  })

  test('trusting one path does not trust the next one added beside it', async () => {
    // Trust carries the path, not the field. Keyed by field, a `git pull` that
    // appends a second path to a list somebody already allowed is a `git pull`
    // that reads it.
    config(repo, '[sources]\ninstructions = ["~/notes.md", "~/.aws/credentials"]\n')

    const loaded = await loadWorkspaceConfig({
      cwd: repo,
      home,
      trusted: (claim) => claim === `sources.instructions=${join(home, 'notes.md')}`,
    })

    expect(loaded.sources.instructions).toEqual([join(home, 'notes.md')])
    expect(loaded.refused.map((one) => one.claim)).toEqual([
      `sources.instructions=${join(home, '.aws', 'credentials')}`,
    ])
  })

  test('a project restating what the user already allows does not take it away', async () => {
    // The ordering mistake: strip after the merge and the project's
    // restatement silently revokes a decision the user made in their own
    // config — and says "not in effect" about something that is.
    config(home, '[agents.coder]\nyolo = true\n')
    config(repo, '[agents.coder]\nyolo = true\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.coder?.yolo).toBe(true)
    expect(loaded.refused).toEqual([])
  })

  test('a project restating a path the user already reads does not take it away', async () => {
    config(home, '[sources]\ninstructions = ["~/notes.md"]\n')
    config(repo, '[sources]\ninstructions = ["~/notes.md", "./RULES.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.instructions).toEqual([join(home, 'notes.md'), join(repo, 'RULES.md')])
    expect(loaded.refused).toEqual([])
  })

  test("the user's own config is not a stranger's", async () => {
    config(
      home,
      '[sources]\ninstructions = ["~/.aws/credentials"]\n\n[agents.coder]\nyolo = true\n',
    )

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.coder?.yolo).toBe(true)
    expect(loaded.sources.instructions).toEqual([join(home, '.aws', 'credentials')])
    expect(loaded.refused).toEqual([])
  })

  test('somebody opening their home directory as a project still owns it', async () => {
    config(home, '[agents.coder]\nyolo = true\n')

    const loaded = await loadWorkspaceConfig({ cwd: home, home })

    expect(loaded.agents.coder?.yolo).toBe(true)
    expect(loaded.refused).toEqual([])
  })
})

describe('how long an answer may be', () => {
  test('is read per agent, for a service that refuses the default', async () => {
    config(repo, '[agents.coder]\nmaxTokens = 4096\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.agents.coder?.maxTokens).toBe(4096)
  })

  test('refuses a number that is not one', async () => {
    config(repo, '[agents.coder]\nmaxTokens = 0\n')

    expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/maxTokens.*positive/)
  })
})

describe('where a project says how its team works', () => {
  test('looks for ORCHESTRATE.md by default, project before home', async () => {
    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    // A file in a home directory is a preference about how you like teams to
    // work; the one in the repository is how this team works. Nearer wins.
    expect(loaded.sources.orchestration[0]).toBe(join(repo, 'ORCHESTRATE.md'))
    expect(loaded.sources.orchestration).toContain(join(home, '.aidcrew', 'ORCHESTRATE.md'))
  })

  test('lets a project call the file whatever it likes', async () => {
    // Not hardcoded: somebody who keeps this in docs/, or calls it something
    // else, says so here rather than being told what to name it.
    config(repo, '[sources]\norchestration = ["./docs/how-we-work.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.orchestration).toEqual([join(repo, 'docs', 'how-we-work.md')])
  })

  test('asks before reading one from outside the project, like every other source', async () => {
    // This text reaches every agent on every request. A config that arrived
    // with a clone does not get to choose it silently.
    config(repo, '[sources]\norchestration = ["../elsewhere/theirs.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.orchestration).toEqual([])
    // Named by where it resolved to, like every other refused source: what
    // has to be trusted is the file, not the spelling that reached it.
    expect(loaded.refused[0]?.claim).toBe(
      `sources.orchestration=${join(repo, '..', 'elsewhere', 'theirs.md')}`,
    )
  })

  test('says why, in terms of what it would actually do', async () => {
    config(repo, '[sources]\norchestration = ["../elsewhere/theirs.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.refused[0]?.because).toMatch(/every agent on every request/)
  })

  test("a user's own config may name any path, because they wrote it", async () => {
    config(home, '[sources]\norchestration = ["~/notes/teams.md"]\n')

    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.orchestration).toEqual([join(home, 'notes', 'teams.md')])
    expect(loaded.refused).toEqual([])
  })
})

describe('reading what the project said about its team', () => {
  test('takes the first file that exists and has something in it', async () => {
    writeFileSync(join(repo, 'empty.md'), '   \n')
    writeFileSync(join(repo, 'real.md'), 'Work in pairs.\n')

    const said = await readOrchestration([
      join(repo, 'missing.md'),
      join(repo, 'empty.md'),
      join(repo, 'real.md'),
    ])

    expect(said).toBe('Work in pairs.')
  })

  test('says nothing when there is no such file, which is the normal case', async () => {
    // Absent is not a failure: the built-in wording is what makes a team work
    // for somebody who has never heard of this file.
    expect(await readOrchestration([join(repo, 'nope.md')])).toBeUndefined()
    expect(await readOrchestration([])).toBeUndefined()
  })

  test('treats one it cannot read as one that is not there', async () => {
    // A team that will not start because a markdown file has the wrong
    // permissions is worse than a team using the default.
    mkdirSync(join(repo, 'a-directory.md'))

    expect(await readOrchestration([join(repo, 'a-directory.md')])).toBeUndefined()
  })
})

describe('the part of that file the agents are actually sent', () => {
  test('drops the note above the rule, which is written for whoever edits it', async () => {
    // A file that explains itself is the file anybody would actually write,
    // and without this it pays for that explanation on every request of every
    // turn of every agent.
    writeFileSync(
      join(repo, 'ORCHESTRATE.md'),
      '# How this team works\n\nKeep this short.\n\n---\n\nHand work on rather than asking.\n',
    )

    const said = await readOrchestration([join(repo, 'ORCHESTRATE.md')])

    expect(said).toBe('Hand work on rather than asking.')
    expect(said).not.toContain('Keep this short')
  })

  test('sends the whole file when there is no rule in it', async () => {
    writeFileSync(join(repo, 'ORCHESTRATE.md'), 'Hand work on rather than asking.\n')

    expect(await readOrchestration([join(repo, 'ORCHESTRATE.md')])).toBe(
      'Hand work on rather than asking.',
    )
  })

  test('moves on when a file is nothing but its own note', async () => {
    // Otherwise a file somebody started and did not finish silently replaces
    // the built-in wording with nothing at all.
    writeFileSync(join(repo, 'ORCHESTRATE.md'), '# Notes to self\n\n---\n\n   \n')
    writeFileSync(join(repo, 'fallback.md'), 'Hand work on.\n')

    expect(await readOrchestration([join(repo, 'ORCHESTRATE.md'), join(repo, 'fallback.md')])).toBe(
      'Hand work on.',
    )
  })
})

describe('a team you already have', () => {
  test('is looked for where the interface would write one', async () => {
    // Everything else of yours in ~/.aidcrew is read: plugins, themes, the
    // MCP servers, the settings. Agents were the exception, so a team written
    // once could not be reused and every new project started by asking you to
    // invent one — with the files you meant sitting unread in your home
    // directory the whole time.
    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.sources.agents).toContain(join(home, '.aidcrew', 'agents'))
  })

  test("still lets a project's own agent win over one of the same name", async () => {
    // Nearer is more specific. A project that defines `reviewer` means its
    // own, and inheriting somebody's general one over it would be the library
    // overriding the thing that asked for it.
    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    const mine = loaded.sources.agents.indexOf(join(repo, '.aidcrew', 'agents'))
    const shared = loaded.sources.agents.indexOf(join(home, '.aidcrew', 'agents'))
    expect(mine).toBeGreaterThan(shared)
  })
})

describe('how many tool calls one turn may make', () => {
  test("is the project's to set, because fifty was chosen for nobody's project in particular", async () => {
    // A coder writing a plugin with tests used sixty-two and was cut off
    // before it committed. The bound is a backstop against a model going
    // round in circles, and a project whose jobs are bigger than the default
    // should be able to say so in the file everything else about its team is
    // already in.
    config(repo, '[defaults]\ntoolCallsPerTurn = 120\n')

    expect((await loadWorkspaceConfig({ cwd: repo, home })).toolCallsPerTurn).toBe(120)
  })

  test('is absent when nothing is said, so the built-in default applies', async () => {
    expect((await loadWorkspaceConfig({ cwd: repo, home })).toolCallsPerTurn).toBeUndefined()
  })

  test('refuses a value that is not a positive whole number', async () => {
    for (const bad of ['0', '-5', '2.5', '"many"']) {
      config(repo, `[defaults]\ntoolCallsPerTurn = ${bad}\n`)
      await expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/toolCallsPerTurn/)
    }
  })
})

describe('how a job is proved and brought home', () => {
  test("the check is the project's to declare, over what is read off its files", async () => {
    config(repo, '[defaults]\ncheck = "make verify"\n')

    expect((await loadWorkspaceConfig({ cwd: repo, home })).check).toBe('make verify')
  })

  test('merging on a verified job can be turned off', async () => {
    config(repo, '[defaults]\nmergeOnDone = false\n')

    expect((await loadWorkspaceConfig({ cwd: repo, home })).mergeOnDone).toBe(false)
  })

  test('both are absent when nothing is said', async () => {
    const loaded = await loadWorkspaceConfig({ cwd: repo, home })

    expect(loaded.check).toBeUndefined()
    expect(loaded.mergeOnDone).toBeUndefined()
  })

  test('refuses a merge setting that is not a boolean', async () => {
    config(repo, '[defaults]\nmergeOnDone = "later"\n')

    await expect(loadWorkspaceConfig({ cwd: repo, home })).rejects.toThrow(/mergeOnDone/)
  })
})
