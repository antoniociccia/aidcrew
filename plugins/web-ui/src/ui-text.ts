/** English catalog for transcript navigation. */
export const feedText = {
  search: 'Search text or agent…',
  searchLabel: 'Search conversation',
  filterLabel: 'Filter activity',
  filters: {
    all: 'All activity',
    conversation: 'Messages',
    tools: 'Tools',
    changes: 'Changes',
    errors: 'Errors',
    notes: 'Notes & handoffs',
  },
  clear: 'Clear filters',
  latest: 'Jump to latest ↓',
  updates: 'New activity · Jump to latest ↓',
  live: 'Following live',
  paused: 'Reading earlier activity',
  noMatches: 'No matching activity.',
  tryAgain: 'Try another search or clear the filters.',
  searchHelp: 'Search conversation or team activity',
  scope: 'Search covers the recent session window; earlier history remains in the journal.',
  results: (shown: number, total: number) => `${shown} of ${total} entries`,
}

export const workspaceText = {
  views: {
    overview: 'Overview',
    mission: 'Agents',
    graph: 'Team graph',
    grid: 'Split screen',
    tasks: 'Tasks',
    memory: 'Memory',
    settings: 'Settings',
  },
  help: 'Help & shortcuts',
  workspace: 'Workspace',
  descriptions: {
    overview: 'Session status, decisions, and the live event log in one place.',
    mission: 'Select an agent to read its work, send instructions, or review changes.',
    graph: 'Select an agent or a connection count to inspect the messages exchanged.',
    grid: 'Arrange your agents. Drag headers to dock, resize dividers, and follow each conversation.',
    tasks: 'Inspect task checkouts and the work assigned to them.',
    memory: 'Explore saved knowledge and where it came from.',
    settings: 'Manage agents, models, and plugins.',
  },
  message: (id: string) => `Message ${id}`,
  placeholder: (id: string) => `Give ${id} an instruction or ask about its work…`,
  footer: (count: number, shared: boolean) =>
    `${count} agents · Shared memory ${shared ? 'on' : 'off'}`,
}

export const commandText = {
  trigger: 'Commands',
  guide: 'Command palette',
  agent: (id: string) => `Go to ${id}`,
  views: workspaceText.views,
  compose: 'Write a message',
  search: 'Search activity',
  latest: 'Jump to latest activity',
  help: 'Keyboard shortcuts',
}

export const crewText = {
  label: 'Crew overview',
  working: (count: number) => `${count} working`,
  queued: (count: number) => `${count} queued`,
  attention: (count: number) => `${count} to review`,
  clear: 'No agents need attention',
  reason: {
    decision: 'Decision needed',
    stopped: 'Stopped',
    queued: 'Queue waiting',
    behind: 'Worktree behind',
  },
  behind: (count: number) => `${count} commits behind`,
}
