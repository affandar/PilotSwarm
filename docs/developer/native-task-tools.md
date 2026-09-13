# Per-agent native task tools

Native tasks remain local-CLI-only unless their bound agent explicitly opts in. Use `schemaVersion: 4` so older workers skip the definition rather than silently discard the policy. Both deployment and caller-visible published agent definitions support the same field.

```yaml
schemaVersion: 4
nativeTaskTools:
  swarm-explore:
    - repo_cache_search
    - repo_cache_read_file
    - read_agent_package_file
    - deepwiki/read_wiki_contents
  swarm-task: [repo_cache_search, repo_cache_read_file]
```

The only task keys are `swarm-explore` and `swarm-task`. Entries are exact application-tool names or `server/tool` MCP references. Wildcards, duplicate profile declarations, and malformed policy are rejected. An omitted profile receives no additional external tools. Local CLI tools keep their existing behavior; this is an external-tool capability policy, not a shell sandbox or a guarantee that arbitrary commands are read-only.

The effective external set is the intersection of the authored allowlist and the bound parent's admitted tools/MCP servers. A missing parent grant cannot be added by a task declaration. Framework tools are excluded except the inspection helpers `load_skill`, `ps_list_agents`, `list_agent_packages`, `read_agent_package`, `read_agent_package_file`, and `diff_agent_versions`. Durable delegation, session control/messaging, scheduling, and factory tools remain unavailable. Broad remote command/REST tools such as `repo_cache_run` and `github_repo_rest` are rejected pending an operation-level policy. Tool authors must deliberately choose other application and MCP operations appropriate to the task; a tool's name alone does not certify it as read-only.

Each native profile receives a separately narrowed MCP configuration, copied from the parent's admitted configuration, retaining its connection/auth settings. Both tool hooks and pre-MCP hooks enforce the child's exact set. Application callbacks use the parent's existing handler and durable-session authorization, with additional `nativeSessionId`, `nativeTaskName`, and `parentSessionId` attribution. Current Copilot callbacks report the root session ID even for native children, so authorization uses runtime `tool.execution_start` and `subagent.started` events. Unknown identities fail closed. Duplicate child callbacks for one tool-call ID share one handler result; completed child identities expire.

Policy is captured with the resolved bound-agent copy, not selected from the global bare-name winner. Changes participate in the existing binding fingerprint and rebind at a turn boundary. Warm handles retain their own runtime identity map when per-turn handlers refresh. Existing feature flags, synchronous task mode, model inheritance, detached-shell restrictions, parent permission checks, and turn cleanup still apply.

Prepare remote repository worktrees in the parent, then give native explore tasks the worktree identifier, scope, questions, relevant agent/skill excerpts, and expected evidence. Repo-cache paths are in a different pod and cannot be opened with the task's local `view` or shell tools. A task with repo-cache search/read capabilities can investigate directly through those tools. Writes and unlisted calls stay in the parent.

Focused validation:

```sh
npm exec --workspace=packages/sdk -- vitest run test/local/native-task-policy.test.js test/local/native-subagents.test.js
npm exec --workspace=packages/sdk -- vitest run test/local/native-subagents-runtime.test.js -t 'allowlisted|opted-in'
```

The integration cases use the actual Copilot SDK/CLI, deterministic local inference, and a local MCP server. They cover successful external calls, per-profile separation, warm/cold sessions, changed policy, MCP narrowing, duplicate delivery, and attempts to invoke hidden parent/durable tools.
