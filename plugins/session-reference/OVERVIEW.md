# Session Reference

Attach a previous conversation to a new prompt and let the agent retrieve the parts it needs to continue. Choose **Reference conversation** from the native attachment menu, select a source, then write what you want the new agent to do and send normally.

The attachment contains a short reference instead of the full transcript. The agent can read an overview, page through older messages, search for text, and read long entries in chunks. The overview contains verbatim excerpts; it is not an AI-generated handoff summary. This plugin does not call a model to generate summaries.

The daemon and client require Paseo 0.16.2 or later within 0.16.x, or 0.17.4 or later within 0.17.x. The source must be on the composer's host and have readable history. Search covers titles, directories and IDs in the 2,000 most recently updated visible conversations, including archived conversations, and returns up to 12 candidates. Conversations without history are omitted. Failed history reads are omitted when other results are available; when all reads fail, the picker reports an error.

The reference records the source host, conversation, history epoch and cutoff when the search result is prepared. Later messages are excluded. A history reset, removed source, or changed cutoff entry requires attaching the source again. References survive plugin reloads as long as the underlying history remains valid; they are not independent transcript backups.

History stays on the source daemon until requested through an agent tool. Retrieved excerpts enter the receiving agent's context and are processed by its selected provider. Tool-call details are excluded by default and can be requested; reasoning and plugin-owned rows are excluded. No separate transcript database, credentials or account configuration is required.

The plugin does not stop the old agent, copy files, switch branches or clear an existing context. Use a fresh conversation to reduce accumulated context. Savings depend on how much history the receiving agent reads. Providers must allow Paseo plugin tools; if the tools are disabled or unavailable, the reference alone cannot convey the old task.
