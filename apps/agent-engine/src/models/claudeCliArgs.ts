/**
 * Flags every engine-spawned `claude --print` child must carry.
 *
 * The child otherwise inherits the owner's user-level Claude Code hooks, including
 * SessionStart (`sync-files-to-supabase.js`, `memory-reconcile.sh`) and SessionEnd
 * (`session-stub.sh`, `vault-auto-commit.sh`) hooks that write memory and the vault, a
 * second writer racing `memory-reconcile.timer` on every turn (#608).
 *
 * `--settings` takes an inline JSON string and outranks user, project and local settings
 * files, so this holds for any cwd. MCP servers are unaffected: `disableAllHooks` covers
 * hooks, the status line and the file-suggestion command only.
 * https://code.claude.com/docs/en/hooks#disable-or-remove-hooks
 */
export const DISABLE_HOOKS_ARGS = ['--settings', '{"disableAllHooks":true}'] as const;
