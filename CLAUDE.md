@AGENTS.md

## Context management

For long orchestration chains (multi-hour sessions delegating across several sub-agents,
or a control-plane session supervising many parallel tasks), watch context usage and run
`/compact` proactively rather than waiting for an automatic compaction to interrupt a
delegation mid-flight.

ccbot used to back this with a Telegram pre-compact warning and a remote `/compact`
trigger. It is decommissioned (argus#302) and its source removed (argus#382), so there is
no remote compaction path — compact from the session itself.
