
# TODO

- evals for prompts
- update the packages/portal to host the new Ink based TUI, add entraid auth to the portal
    - proposal: [docs/proposals/portal-native-web-experience.md](docs/proposals/portal-native-web-experience.md)
    - proposal: [docs/proposals/portal-web-experience.md](docs/proposals/portal-web-experience.md)
    - proposal: [docs/proposals/entra-auth-gateway.md](docs/proposals/entra-auth-gateway.md)
- session-store-driven durability cleanup
    - proposal: [docs/proposals/session-store-driven-durability.md](docs/proposals/session-store-driven-durability.md)
- pilotswarm provider (local + remote) which can support different auth methods
    - proposal: [docs/proposals/entra-auth-gateway.md](docs/proposals/entra-auth-gateway.md)
- startup/shutdown performance.
- add interrupt/steer for LLMs
- self contained docker image 
- session titles are not sticking
- review rules for producing knowledge, human interactions and questions that were answered.
    - proposal: [docs/proposals/shared-skills-pipeline.md](docs/proposals/shared-skills-pipeline.md)
- multitenancy/workspacing
- optimizations
    - ability for agents to specify models 
- MCP server
    - proposal: [docs/proposals-impl/mcp-server-and-agent.md](docs/proposals-impl/mcp-server-and-agent.md)
- emit metrics / analytics 
- website version with oauth logins
    - proposal: [docs/proposals/portal-web-experience.md](docs/proposals/portal-web-experience.md)
    - proposal: [docs/proposals/entra-auth-gateway.md](docs/proposals/entra-auth-gateway.md)
- standalone docker container version of pilotswarm
- profiling, why is it slow
- evals, prompt validations & hardening, various models

- for diagnostics and reporting, put all sessions in a markdown file in blob. do it on a key press. 
- agent to agent messaging

# DONE
- junk / stray text on the panes
- spin up all system agents via orchestrations, don't depend on bootstrapping agent
- stabilize `system-prompt-refactor` branch after regressions before merging it
- use copilot system prompt sections rather than flat prompt
- update smelter with it, update waldemort
- GC old orchestration versions
- don't use logs for worker <-> activity node tracking
    - indication of context sizes
- optimizations
    - expose compaction settings to layered apps
    - make sure skill frontmatter is passed and progressively loaded
- https://github.com/affandar/PilotSwarm/blob/main/templates/builder-agents/skills/pilotswarm-azure-lessons/SKILL.md <-- remove any mention of Microsoft tenant and make sure it doesnt leak. Also squash it so history doesnt show either.
- fix the TUI
- figure out what to do with hdb prev preview gist: https://gist.github.com/affandar/3ab0a8ac7ad5ad9bd9dbdd80e7f8420a
- ability to pass in md files as input
- ability to open md files in vscode
- UX fixes
    - md viewer/upload/download
    - prompt pane needs lot of fixes
    - junk characters in UX pane
- switch back to glm-1
- .md file creation and piping to user. maybe add an md file viewer inline as well??
- users should NOT be able to change the default md files and agent instructions or skills
- parallel subagent spin off "getting interrupted"
- splashscreen not showing
- pilotswarm agent stuck on a single node, not deh/hyd
- build a user TUI guide
- update copilot sdk and the duroxide-node sdks
- update copilot sdk and the duroxide-node sdks
- pull in facts table into the session catalog
- customized TUI for devops cc not working
    - agents not starting work automatically
    - quit key is not working
    - splash screen not showing up
    - model selector not working
    - why is this not tested via the SDK

# REJECTED

- pull spawn agent into orchestration code and not an activity
- squad samples
