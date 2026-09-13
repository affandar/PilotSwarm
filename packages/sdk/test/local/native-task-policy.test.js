import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFiles } from "../../src/agent-loader.ts";
import { NativeTaskAccess, validateNativeTaskTools } from "../../src/native-task-policy.ts";
import { guardNativeExternalTools, nativeSubagentDefinitions, nativeSubagentHooks } from "../../src/native-subagents.ts";
const start = (access, id, task) => access.observe({type:"subagent.started",agentId:id,data:{agentName:task,executionMode:"sync"}});
const make = () => new NativeTaskAccess({"swarm-explore":["repo_read", "notes/read"],"swarm-task":["repo_write"]},
    [{name:"repo_read"},{name:"repo_write"}],new Set(),{notes:{command:"fixture",tools:["read"]}});
describe("native task capability policy", () => {
    it.each([{explore:["read"]},{"swarm-explore":["*"]},{"swarm-explore":["notes/*"]},{"swarm-explore":["spawn_agent"]},{"swarm-task":["create_agent_session"]},{"swarm-task":["start_pod_process"]},{"swarm-task":["remote/spawn_agent"]},{"swarm-task":["remote/create_session"]}])("rejects unsafe/malformed declarations %j", policy => {
        expect(()=>validateNativeTaskTools(policy)).toThrow();
    });
    it("admits explicitly granted synchronous writes and commands while denying every durable control", () => {
        const names=["repo_cache_run","github_repo_rest","ado_rest","exec_in_pod","store_fact","stage_agent_package_edit","publish_agent_package"];
        const access=new NativeTaskAccess({"swarm-task":names},names.map(name=>({name})),new Set(["store_fact","stage_agent_package_edit","publish_agent_package"]),{});
        expect(access.tools["swarm-task"]).toEqual(names);
        for (const name of ["wait","wait_on_worker","cron","cron_at","report_cycle","ask_user","spawn_agent","message_agent","wait_for_agents","complete_agent","cancel_agent","delete_agent","regenerate_context","regenerate_agent","set_session_model","create_agent_session","message_agent_session","manage_agent_session","manage_embedder","start_pod_process"]) {
            expect(()=>validateNativeTaskTools({"swarm-task":[name]})).toThrow();
            expect(()=>validateNativeTaskTools({"swarm-task":[`remote/${name}`]})).toThrow();
        }
    });
    it("does not serialize runtime grants or MCP connection secrets",()=>{
        const access=make();
        expect(JSON.stringify({nativeTaskAccess:access})).toBe("{}");
    });
    it("intersects with parent tools and MCP scope, excluding framework controls", () => {
        const access = new NativeTaskAccess({"swarm-explore":["available","missing","future_framework_control","store_fact","read_agent_package_file","notes/read","notes/write","private/read"]},
            [{name:"available"},{name:"future_framework_control"},{name:"store_fact"},{name:"read_agent_package_file"}],new Set(["future_framework_control","store_fact","read_agent_package_file"]),{notes:{tools:["read"]}});
        expect(access.tools['swarm-explore']).toEqual(["available","store_fact","read_agent_package_file","notes/read"]);
        expect(access.mcpServers['swarm-explore'].notes.tools).toEqual(["read"]);
    });
    it("separates simultaneous child profiles and expires access on completion", async () => {
        const access=make();start(access,"a","swarm-explore");start(access,"b","swarm-task");
        const read=vi.fn(()=>"read"),write=vi.fn(()=>"write");
        const tools=guardNativeExternalTools([{name:"repo_read",handler:read},{name:"repo_write",handler:write}],"parent",access);
        let index=0;
        const invoke=(tool,owner)=>{
            const toolCallId=String(++index);
            access.observe({type:"tool.execution_start",agentId:owner,data:{toolCallId,toolName:tools[tool].name}});
            return tools[tool].handler({}, {sessionId:"parent",toolCallId});
        };
        expect(await invoke(0,"a")).toBe("read");
        expect(()=>invoke(1,"a")).toThrow();
        expect(await invoke(1,"b")).toBe("write");
        expect(()=>invoke(0,"unknown")).toThrow();
        access.observe({type:"subagent.completed",agentId:"a"});
        expect(()=>invoke(0,"a")).toThrow();
        expect(await invoke(0,undefined)).toBe("read");
        expect(()=>tools[0].handler({}, {sessionId:"parent",toolCallId:"unattributed"})).toThrow();
    });
    it("attributes root-ID callbacks to their child and deduplicates concurrent delivery", async()=>{
        const access=make();start(access,"child","swarm-explore");
        const handler=vi.fn(async(args,invocation)=>invocation);
        const [tool]=guardNativeExternalTools([{name:"repo_read",handler}],"parent",access);
        access.observe({type:"tool.execution_start",agentId:"child",data:{toolCallId:"call",toolName:"repo_read"}});
        const results=await Promise.all([tool.handler({}, {sessionId:"parent",toolCallId:"call"}),tool.handler({}, {sessionId:"parent",toolCallId:"call"})]);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(results[0]).toMatchObject({sessionId:"parent",nativeSessionId:"child",nativeTaskName:"swarm-explore"});
        expect(results[0]).toEqual(results[1]);
        access.observe({type:"session.idle"});
        expect(()=>tool.handler({}, {sessionId:"parent",toolCallId:"call"})).toThrow();
    });
    it("enforces hooks and MCP calls even if a task guesses a hidden tool", async () => {
        const access=make();start(access,"a","swarm-explore");
        const hooks=nativeSubagentHooks("model",undefined,()=>true,access);
        const call=(name,args={})=>hooks.onPreToolUse({sessionId:"a",toolName:name,toolArgs:args},{sessionId:"parent"});
        expect(await call("repo_read")).toBeUndefined();
        for(const name of ["repo_write","spawn_agent","task","manage_schedule"]) expect((await call(name)).permissionDecision).toBe("deny");
        await expect(hooks.onPreMcpToolCall({sessionId:"a",serverName:"notes",toolName:"write"},{sessionId:"parent"})).rejects.toThrow(/allowlisted/);
        expect(await hooks.onPreMcpToolCall({sessionId:"a",serverName:"notes",toolName:"read"},{sessionId:"parent"})).toBeUndefined();
        expect((await call("bash",{mode:"async"})).permissionDecision).toBe("deny");
    });
    it("preserves application denials and uses rewritten arguments for detachment checks", async () => {
        const access=make();start(access,"a","swarm-task");
        const hooks=nativeSubagentHooks("model",{onPreToolUse:()=>({modifiedArgs:{detach:true}})},()=>true,access);
        expect((await hooks.onPreToolUse({sessionId:"a",toolName:"bash",toolArgs:{}},{sessionId:"parent"})).permissionDecision).toBe("deny");
    });
    it("keeps defaults local-only and narrows each custom MCP server", () => {
        expect(nativeSubagentDefinitions("m")[0].tools).not.toContain("repo_read");
        const defs=nativeSubagentDefinitions("m",make());
        expect(defs[0].description).toMatch(/allowlisted external sources/);
        expect(defs[0].tools).toContain("repo_read");expect(defs[0].tools).not.toContain("repo_write");
        expect(defs[0].mcpServers.notes.tools).toEqual(["read"]);
        expect(defs[1].mcpServers).toEqual({});
    });
    it("loads the authored YAML mapping and rejects unsupported or duplicate profiles", () => {
        const dir=mkdtempSync(join(tmpdir(),"native-policy-"));
        const write=(policy,schema=4)=>writeFileSync(join(dir,"agent.agent.md"),`---\nname: fixture\nversion: 1\nschemaVersion: ${schema}\nnativeTaskTools:\n${policy}\n---\nInvestigate.`);
        try {
            write('  swarm-explore:\n    - repo_read\n    - notes/read\n  swarm-task: [repo_write]');
            expect(loadAgentFiles(dir)[0].nativeTaskTools).toEqual({"swarm-explore":["repo_read","notes/read"],"swarm-task":["repo_write"]});
            write('  swarm-explore: [repo_read]',3);expect(loadAgentFiles(dir)).toEqual([]);
            write('  swarm-explore: [repo_read]\n  swarm-explore: [repo_write]');expect(loadAgentFiles(dir)).toEqual([]);
            write('  unknown: [repo_read]');expect(loadAgentFiles(dir)).toEqual([]);
        } finally {rmSync(dir,{recursive:true,force:true});}
    });
});
