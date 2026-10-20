import { definePlugin } from '@/plugin'

import { createQaSubagent } from './qa'

export default definePlugin({
  plugin: async (ctx) => ({
    subagents: {
      qa: createQaSubagent({ resolveTokenForRepo: ctx.github.resolveTokenForRepo }),
    },
  }),
})
