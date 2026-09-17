import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import {fileURLToPath} from 'node:url';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function compile(){
 const sources={};
 function walk(dir){for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const f=dir+'/'+e.name;if(e.isDirectory())walk(f);else if(f.endsWith('.sol'))sources[f]={content:fs.readFileSync(path.join(root,f),'utf8')};}}
 walk('src');walk('test/mocks');
 const r=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}}),{import:f=>{try{return{contents:fs.readFileSync(path.join(root,'node_modules',f),'utf8')}}catch{return{error:'Missing import '+f}}}}));
 const errors=(r.errors||[]).filter(e=>e.severity==='error');if(errors.length)throw new Error(errors.map(e=>e.formattedMessage).join('\n'));
 for(const e of r.errors||[])console.warn(e.formattedMessage);
 return r.contracts;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const contracts=compile();fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
 for(const [file,entries] of Object.entries(contracts)){if(!file.startsWith('src/'))continue;for(const [name,a]of Object.entries(entries)){
 const size=a.evm.deployedBytecode.object.length/2;if(size>24576)throw new Error(`${name} exceeds EIP-170: ${size}`);
 fs.writeFileSync(path.join(root,'artifacts',name+'.json'),JSON.stringify(a,null,2));if(size)console.log(`${name}: ${size} bytes`);
 }}
}
