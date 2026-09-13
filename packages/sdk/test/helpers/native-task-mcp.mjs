// Local protocol fixture: no credentials or network services.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const names=['read_note','write_note'];
readline.createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line);if(message.id===undefined)return;
    let result;
    if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'notes',version:'1'}};
    else if(message.method==='tools/list')result={tools:names.map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))};
    else if(message.method==='tools/call'){
        appendFileSync(process.argv[2],message.params.name+'\n');
        result={content:[{type:'text',text:'NOTE_READ_RESULT'}]};
    } else result={};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
});
