import type { TeamsMessageFormat } from 'agent-messenger/teams'

// Teams posts every outbound as `RichText/Html`, so the SDK has to decide how
// our string becomes markup. TypeClaw's contract is PLAIN TEXT — `OutboundMessage`
// carries no format metadata and no tool or skill can ask for another rendering,
// so `text` (HTML-escape) is the only mode that shows what the agent wrote;
// `html`/`markdown` would promote arbitrary prose, which routinely relays text
// authored by untrusted channel users, into live markup. Native Teams mentions,
// if ever needed, belong in a structured mention field the adapter converts —
// not in a blanket format switch.
//
// Passed EXPLICITLY at every call site, never left to the SDK default: 2.35.0
// escaped the chat path but posted the team/channel path raw, and 2.37.2
// defaulted both to `text`. Naming it pins what lands in users' chats against a
// future upstream flip.
export const TEAMS_OUTBOUND_FORMAT: TeamsMessageFormat = 'text'
