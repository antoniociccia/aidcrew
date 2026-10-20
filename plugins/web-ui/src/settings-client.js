import { settingsText as text } from './settings-text.js'
import { nativeText } from './native-text.js'

export function initSettings({
  node,
  button,
  avatar,
  dialog,
  field,
  act,
  perform,
  inspect,
  editModel,
  editDefinition,
  toast,
}) {
  let selectedTab = 'agents'
  let workspace
  let currentNavigation
  const revealTab = () => {
    const tab = currentNavigation?.querySelector('[aria-selected="true"]')
    if (!tab) return
    const container = currentNavigation.getBoundingClientRect()
    const item = tab.getBoundingClientRect()
    if (item.left < container.left) currentNavigation.scrollLeft -= container.left - item.left
    else if (item.right > container.right)
      currentNavigation.scrollLeft += item.right - container.right
  }
  const resizeObserver = new ResizeObserver(revealTab)

  function action(label, id, run, className = 'subtle') {
    const result = button(label, run, className)
    result.dataset.settingsAction = id
    return result
  }
  function section(host, id, title, description, scope) {
    const result = node('section', undefined, 'settings-section')
    result.dataset.settingsSection = id
    result.id = `settings-panel-${id}`
    result.setAttribute('role', 'tabpanel')
    result.setAttribute('aria-labelledby', `settings-tab-${id}`)
    result.tabIndex = 0
    result.hidden = selectedTab !== id
    const heading = node('div', undefined, 'settings-section-heading')
    const titleNode = node('h3', title)
    titleNode.id = `settings-heading-${id}`
    titleNode.tabIndex = -1
    titleNode.dataset.settingsAction = `heading-${id}`
    heading.append(titleNode, node('span', scope, 'settings-scope'))
    result.append(heading, node('p', description, 'settings-help'))
    host.append(result)
    return result
  }
  function row(parent, title, description) {
    const result = node('div', undefined, 'settings-item')
    const identity = node('div', undefined, 'settings-item-copy')
    identity.append(node('strong', title))
    if (description) identity.append(node('p', description, 'settings-help'))
    const actions = node('div', undefined, 'settings-actions')
    result.append(identity, actions)
    parent.append(result)
    return { result, identity, actions }
  }
  function pressed(label, id, on, run) {
    const control = action(label, id, run)
    if (typeof on === 'boolean') control.setAttribute('aria-pressed', String(on))
    return control
  }
  return {
    render(host, state, inspected) {
      const workspaceChanged = workspace !== state.cwd
      if (workspaceChanged) {
        selectedTab = 'agents'
        workspace = state.cwd
      }
      const scrollTop = workspaceChanged ? 0 : host.scrollTop
      const expanded = new Set(
        [...host.querySelectorAll('details[open]')].map((item) => item.dataset.settingsDisclosure),
      )
      const focused = host.contains(document.activeElement)
        ? document.activeElement?.dataset.settingsAction
        : undefined
      host.replaceChildren()
      const page = node('div', undefined, 'settings-page')
      const header = node('header', undefined, 'settings-header')
      header.append(
        node('h2', text.title),
        node('p', text.subtitle),
        node('p', `${text.project} · ${state.cwd || text.unset}`, 'settings-project'),
      )
      const navigation = node('nav', undefined, 'settings-navigation')
      navigation.setAttribute('aria-label', text.navigation)
      navigation.setAttribute('role', 'tablist')
      resizeObserver.disconnect()
      currentNavigation = navigation
      resizeObserver.observe(navigation)
      const tabs = Object.entries(text.tabs)
      function selectTab(id, focus = false) {
        selectedTab = id
        for (const tab of navigation.querySelectorAll('[role=tab]')) {
          const active = tab.dataset.settingsTab === id
          tab.setAttribute('aria-selected', String(active))
          tab.tabIndex = active ? 0 : -1
          if (active && focus) tab.focus({ preventScroll: true })
        }
        for (const panel of page.querySelectorAll('[role=tabpanel]'))
          panel.hidden = panel.dataset.settingsSection !== id
        revealTab()
        host.scrollTop = 0
      }
      for (const [index, [id, label]] of tabs.entries()) {
        const tab = action(label, `tab-${id}`, () => selectTab(id))
        tab.id = `settings-tab-${id}`
        tab.dataset.settingsTab = id
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-controls', `settings-panel-${id}`)
        tab.setAttribute('aria-selected', String(selectedTab === id))
        tab.tabIndex = selectedTab === id ? 0 : -1
        tab.onkeydown = (event) => {
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : undefined
          if (next === undefined) return
          event.preventDefault()
          selectTab(tabs[next][0], true)
        }
        navigation.append(tab)
      }
      page.append(header, navigation)
      host.append(page)
      const agents = section(page, 'agents', text.agents, text.agentsHelp, text.session)
      const agentGrid = node('div', undefined, 'settings-agent-grid')
      agents.append(agentGrid)
      for (const agent of state.agents) {
        const card = node('article', undefined, 'settings-agent')
        card.dataset.settingsAgent = agent.id
        const identity = node('div', undefined, 'settings-agent-identity')
        const copy = node('div', undefined, 'settings-item-copy')
        copy.append(
          node('h4', agent.id),
          node(
            'p',
            `${agent.provider || text.unset} / ${agent.model || text.unset}`,
            'settings-model',
          ),
        )
        identity.append(avatar(agent.id), copy, node('span', agent.status, 'settings-agent-state'))
        const controls = node('div', undefined, 'settings-actions')
        controls.append(action(text.model, `model-${agent.id}`, () => editModel(agent)))
        controls.append(
          action(agent.yolo ? text.yolo : text.ask, `autonomy-${agent.id}`, () =>
            dialog(
              text.autonomy,
              [node('p', agent.yolo ? text.disableAutonomy : text.enableAutonomy)],
              () => act({ type: 'yolo', agent: agent.id, on: !agent.yolo }),
              text.apply,
            ),
          ),
        )
        if (agent.permissionOwner === 'provider') {
          const permissions = node('span', nativeText.permissions, 'settings-provider-permissions')
          permissions.title = nativeText.permissionHelp
          controls.append(permissions)
        }
        const queue = node('div', undefined, 'settings-queue')
        queue.append(
          node('span', text.queued(agent.queued || 0)),
          action(text.clear, `clear-${agent.id}`, () =>
            perform({ type: 'clearQueue', agent: agent.id }),
          ),
        )
        const more = node('details', undefined, 'settings-agent-more')
        more.dataset.settingsDisclosure = agent.id
        more.open = expanded.has(agent.id)
        const summary = node('summary', text.more)
        summary.dataset.settingsAction = `disclosure-${agent.id}`
        more.append(summary)
        const destructive = node('div', undefined, 'settings-actions')
        destructive.append(
          action(text.reset, `reset-${agent.id}`, () =>
            dialog(
              text.resetTitle,
              [node('p', text.resetHelp)],
              () => act({ type: 'forget', agent: agent.id }),
              text.resetConfirm,
            ),
          ),
          action(
            text.remove,
            `remove-${agent.id}`,
            () =>
              dialog(
                text.removeTitle,
                [node('p', text.removeHelp)],
                () => act({ type: 'kill', agent: agent.id }),
                text.remove,
              ),
            'subtle danger',
          ),
        )
        more.append(destructive)
        card.append(identity, controls, queue, more)
        agentGrid.append(card)
      }
      if (!state.agents.length) agents.append(node('p', text.noAgents, 'settings-empty'))
      const defaults = section(page, 'defaults', text.defaults, text.defaultsHelp, text.saved)
      if (!inspected) defaults.append(node('p', text.loading, 'settings-empty'))
      else {
        const values = node('dl', undefined, 'settings-values')
        values.append(
          node('dt', text.provider),
          node('dd', inspected.defaults?.provider || text.unset),
          node('dt', text.modelLabel),
          node('dd', inspected.defaults?.model || text.unset),
        )
        defaults.append(
          values,
          action(text.editDefaults, 'defaults', () =>
            dialog(
              text.defaultsTitle,
              [
                field(text.provider, 'provider', inspected.defaults?.provider || ''),
                field(text.modelLabel, 'model', inspected.defaults?.model || ''),
              ],
              async (data) => {
                await act({
                  type: 'default',
                  setting: 'provider',
                  value: String(data.get('provider')),
                })
                await act({ type: 'default', setting: 'model', value: String(data.get('model')) })
                await inspect()
              },
              text.saveDefaults,
            ),
          ),
        )
      }
      const definitions = section(page, 'roles', text.roles, text.rolesHelp, text.projectScope)
      definitions.append(action(text.createRole, 'create-role', () => editDefinition()))
      for (const definition of inspected?.definitions || []) {
        const item = row(definitions, definition.id, definition.description)
        item.actions.append(
          action(text.editRole, `role-${definition.id}`, () => editDefinition(definition)),
          action(
            text.deleteRole,
            `delete-role-${definition.id}`,
            () =>
              dialog(
                text.deleteRoleTitle,
                [node('p', text.deleteRoleHelp)],
                () => act({ type: 'removeDefinition', id: definition.id }).then(() => inspect()),
                text.delete,
              ),
            'subtle danger',
          ),
        )
      }
      if (!inspected?.definitions?.length)
        definitions.append(node('p', inspected ? text.noRoles : text.loading, 'settings-empty'))
      const credentials = section(
        page,
        'credentials',
        text.credentials,
        text.credentialsHelp,
        text.saved,
      )
      credentials.append(
        action(text.saveKey, 'save-key', () =>
          dialog(
            text.keyTitle,
            [
              field(text.keyScope, 'scope', 'provider:openrouter'),
              field(text.keyLabel, 'key', '', 'password'),
            ],
            (data) =>
              act({
                type: 'credentials',
                scope: String(data.get('scope')),
                key: String(data.get('key')),
              }).then(() => inspect()),
            text.keySubmit,
          ),
        ),
      )
      for (const credential of inspected?.credentials || []) {
        const item = row(credentials, credential.scope, credential.hint || text.keySaved)
        item.actions.append(
          action(
            text.forgetKey,
            `forget-${credential.scope}`,
            () =>
              dialog(
                text.forgetTitle,
                [node('p', text.forgetHelp(credential.scope))],
                () =>
                  act({ type: 'forgetCredential', scope: credential.scope }).then(() => inspect()),
                text.forgetKey,
              ),
            'subtle danger',
          ),
        )
      }
      if (!inspected?.credentials?.length)
        credentials.append(
          node('p', inspected ? text.noCredentials : text.loading, 'settings-empty'),
        )
      const sources = section(page, 'sources', text.sources, text.sourcesHelp, text.projectScope)
      for (const source of inspected?.sources || []) {
        const item = row(sources, source.label)
        const paths = node('ul', undefined, 'settings-paths')
        for (const path of source.paths) paths.append(node('li', path))
        item.identity.append(source.paths.length ? paths : node('p', text.noPaths, 'settings-help'))
        item.actions.append(
          action(text.editPaths, `sources-${source.label}`, () =>
            dialog(
              text.sourceTitle(source.label),
              [field(text.paths, 'paths', source.paths.join('\n'))],
              (data) =>
                act({
                  type: 'sources',
                  kind: source.label,
                  paths: String(data.get('paths')).split('\n').filter(Boolean),
                }).then(() => inspect()),
              text.savePaths,
            ),
          ),
        )
      }
      if (!inspected?.sources?.length)
        sources.append(node('p', inspected ? text.noSources : text.loading, 'settings-empty'))
      const plugins = section(page, 'plugins', text.plugins, text.pluginsHelp, text.session)
      for (const plugin of state.plugins || [])
        row(
          plugins,
          plugin.name,
          [plugin.version, text.toolCount(plugin.tools?.length || 0)].filter(Boolean).join(' · '),
        )
      if (!state.plugins?.length) plugins.append(node('p', text.noPlugins, 'settings-empty'))
      const terminal = section(
        page,
        'terminal',
        text.terminal,
        text.terminalHelp,
        text.terminalScope,
      )
      const fill = row(terminal, text.fill)
      fill.actions.append(
        pressed(
          text.hairline,
          'fill-hairline',
          inspected ? inspected.fill === 'hairline' : undefined,
          () => perform({ type: 'appearance', fill: 'hairline' }, inspect),
        ),
        pressed(text.solid, 'fill-solid', inspected ? inspected.fill === 'solid' : undefined, () =>
          perform({ type: 'appearance', fill: 'solid' }, inspect),
        ),
      )
      const paths = row(terminal, text.pathsLabel)
      paths.actions.append(
        pressed(text.hidePaths, 'paths-hidden', inspected?.hidePaths, () =>
          perform({ type: 'appearance', hidePaths: true }, inspect),
        ),
        pressed(
          text.showPaths,
          'paths-visible',
          typeof inspected?.hidePaths === 'boolean' ? !inspected.hidePaths : undefined,
          () => perform({ type: 'appearance', hidePaths: false }, inspect),
        ),
      )
      const themes = row(terminal, text.themes)
      for (const name of state.themes || [])
        themes.actions.append(
          action(name, `theme-${name}`, () =>
            perform({ type: 'theme', name }, () => toast(text.themeUpdated)),
          ),
        )
      revealTab()
      host.scrollTop = scrollTop
      if (focused)
        [...page.querySelectorAll('[data-settings-action]')]
          .find((control) => control.dataset.settingsAction === focused)
          ?.focus({ preventScroll: true })
    },
  }
}
