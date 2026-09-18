import fs from 'node:fs';import path from 'node:path';import solc from 'solc-v4';import {root} from './compile.mjs';
export function compileV4(){
 const sources={};for(const file of ['@uniswap/v4-core/src/PoolManager.sol','test/real-v4/V4Harness.sol'])sources[file]={content:fs.readFileSync(path.join(root,file.startsWith('@')?'node_modules':'',file),'utf8')};
 const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
 const out=JSON.parse(solc.compile(JSON.stringify(input),{import:file=>{const candidates=[path.join(root,'node_modules',file),path.join(root,'node_modules/@uniswap/v4-core/lib',file)];for(const p of candidates)if(fs.existsSync(p))return{contents:fs.readFileSync(p,'utf8')};return{error:'Missing '+file};}}));
 const errors=(out.errors??[]).filter(e=>e.severity==='error');if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
 return out.contracts;
}
