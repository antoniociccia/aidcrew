import { definePlugin } from '@aidcrew/plugin-sdk'
import { createNativeProvider } from './runtime.ts'

export {
  bindNativeDispatcher,
  closeNativeAgent,
  closeNativeAgents,
  createNativeProvider,
  getNativeAgent,
} from './runtime.ts'
export default definePlugin({
  name: 'agent-native',
  providers: [
    {
      id: 'claude-code',
      needsKey: false,
      keepsOwnHistory: true,
      reportsUsage: false,
      permissionOwner: 'provider',
      create: () => createNativeProvider(),
    },
  ],
})
