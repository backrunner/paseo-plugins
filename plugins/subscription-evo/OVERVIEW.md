SubscriptionEvo queues messages for a chosen time or a delay after subscription quota recovers. It can also queue a continuation after a temporary provider failure and run a bounded goal loop across providers.

Open **Send later** beside the composer to enter a message and choose a time or quota recovery delay in a popover. **Queue · N** appears only while messages need attention. Messages can be edited, paused, reordered or canceled. **Schedule** authorizes only that message; **Queue only** waits for later approval. Automatic continuation, retries and quota resumption all start off.

Configure continuation per conversation under **Settings → Plugins → SubscriptionEvo → Continuation settings**. Open a goal with `/evo-goal`; opening the form does not start work. The composer popover is only for scheduling messages.

Editing a queued message pauses it first. Save its text and timing in place with **Save paused** or **Save & schedule**; closing or discarding an edit leaves the original paused. **Withdraw** removes an unsent message and keeps its text in delivery history. Messages being sent or awaiting a receipt cannot be withdrawn.

This development version requires Paseo 0.15.4 and a local daemon endpoint on the host where the plugin runs. Connect it to that host's Paseo home on first use. It reads session state, recent history and quota reports, then sends to the existing conversation through the selected host. Queued text and settings are stored locally in the plugin's own directory. It uses Paseo's local connection credential; provider login tokens are not read or stored.

Quota recovery needs one fresh report with remaining capacity in every window. Providers without usable quota reports can still use timed messages and goals. Unknown errors, authentication problems, permissions, manual input and ambiguous delivery outcomes pause automation. Goal completion is reported by the model with evidence and is not independently verified.

Paseo 0.15.4 places plugin buttons above the composer and does not expose its lower toolbar, native draft or queue. Messages are entered in the popover and kept in Evo's own queue; ordinary composer text and attachments are not imported. Final idle checks cannot completely prevent another client from sending at the same moment. Turn off native Codex `/goal` before enabling Evo automation. `/evo-*` commands work only without attachments.

The development store retains at most 500 message records, 100 session policies and 8 MB of data. Reaching a limit stops new additions. Unsubmitted popover drafts remain in this client until it closes or the plugin reloads. Compilation and simulated behavior have been checked; real delivery and this popover's native presentation still need manual acceptance.
