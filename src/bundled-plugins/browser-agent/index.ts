import { getConfig } from '@/config'
import { definePlugin } from '@/plugin'

import { createBrowserSubagent } from './browser-agent'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      browser: createBrowserSubagent(getConfig().browser),
    },
  }),
})
