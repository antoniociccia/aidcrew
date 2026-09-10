import type { SessionBridge, WebAction, WebState } from '@aidcrew/web-ui'

/** Stable connection while React replaces the current session callbacks. */
export function webSession(): SessionBridge & { connect(bridge: SessionBridge): () => void } {
  let current: SessionBridge | undefined
  return {
    snapshot: () =>
      current?.snapshot() ??
      ({
        sessionId: 'opening',
        cwd: '',
        ready: false,
        agents: [],
        lines: [],
        target: '',
        sharedMemory: false,
        outstanding: 0,
        plugins: [],
        themes: [],
      } satisfies WebState),
    dispatch: async (action: WebAction) => {
      if (!current) throw new Error('The terminal is still opening the session')
      return current.dispatch(action)
    },
    connect: (bridge) => {
      current = bridge
      return () => {
        if (current === bridge) current = undefined
      }
    },
  }
}
export type WebSession = ReturnType<typeof webSession>
