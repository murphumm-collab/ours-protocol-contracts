import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';
const abi=ethers.AbiCoder.defaultAbiCoder();
function uint(value,label){
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error(`${label}: use decimal strings for large integers`);
 if(!['string','number','bigint'].includes(typeof value)||!/^\d+$/.test(String(value)))throw Error(`${label}: invalid unsigned integer`);
 const result=BigInt(value);if(result>ethers.MaxUint256)throw Error(`${label}: uint256 overflow`);return result;
}
const hashPair=(a,b)=>ethers.keccak256(ethers.concat([a,b].sort()));
/**
 * Offline, reviewable entitlement builder. The holder list MUST be complete and
 * balances verified at the epoch's recorded block by the indexer/reviewer.
 * A Merkle proof cannot establish completeness or holdings on its own.
 */
export function buildManifest(input){
 const {chainId,pool,epochId,project,snapshotBlock,snapshotBlockHash}=input;
 if(!ethers.isHexString(epochId,32)||!ethers.isHexString(snapshotBlockHash,32))throw Error('Invalid epoch/block hash');
 const funded=uint(input.fundedAmount,"fundedAmount"),minimum=uint(input.minHolding,"minHolding");
 uint(chainId,"chainId");uint(snapshotBlock,"snapshotBlock");
 if(ethers.getAddress(pool)===ethers.ZeroAddress||ethers.getAddress(project)===ethers.ZeroAddress)throw Error("Zero contract address");
 if(funded<=0n||minimum<0n)throw Error('Invalid amounts');
 const exclusions=new Set([ethers.ZeroAddress,...input.excludedAddresses.map(a=>ethers.getAddress(a))]);
 const seen=new Set();const eligible=[];
 for(const row of input.holders){const account=ethers.getAddress(row.account),balance=uint(row.balance,"holder balance");
  if(seen.has(account)||balance<0n)throw Error('Duplicate holder or negative balance');seen.add(account);
  if(balance>0n&&balance>=minimum&&!exclusions.has(account))eligible.push({account,balance});
 }
 eligible.sort((a,b)=>a.account.toLowerCase().localeCompare(b.account.toLowerCase()));
 const denominator=eligible.reduce((a,h)=>a+h.balance,0n);
 const claims=eligible.map(h=>({...h,amount:funded*h.balance/denominator})).filter(h=>h.amount>0n);
 const leaf=h=>ethers.keccak256(ethers.keccak256(abi.encode(['uint256','address','bytes32','address','uint256'],[chainId,pool,epochId,h.account,h.amount])));
 const levels=[claims.map(leaf)];
 while(levels.at(-1).length>1){const prev=levels.at(-1),next=[];for(let i=0;i<prev.length;i+=2)next.push(i+1<prev.length?hashPair(prev[i],prev[i+1]):prev[i]);levels.push(next);}
 const total=claims.reduce((a,h)=>a+h.amount,0n);
 return {schemaVersion:1,status:claims.length?'review-required':'empty',chainId:String(chainId),pool:ethers.getAddress(pool),project:ethers.getAddress(project),epochId,
  snapshotBlock:String(snapshotBlock),snapshotBlockHash,fundedAmount:String(funded),minHolding:String(minimum),eligibleWeight:String(denominator),
  excludedAddresses:[...exclusions].sort(),totalEntitlement:String(total),unallocated:String(funded-total),merkleRoot:levels.at(-1)[0]??ethers.ZeroHash,
  claims:claims.map((h,index)=>{const proof=[];let cursor=index;for(let i=0;i<levels.length-1;i++){const sibling=cursor^1;if(sibling<levels[i].length)proof.push(levels[i][sibling]);cursor=Math.floor(cursor/2);}return{account:h.account,balance:String(h.balance),entitlement:String(h.amount),proof};})};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [source,out]=process.argv.slice(2);if(!source||!out)throw Error('Usage: node scripts/dividend-manifest.mjs INPUT.json OUTPUT.json');
 const result=buildManifest(JSON.parse(fs.readFileSync(source,'utf8')));const exact=JSON.stringify(result,null,2)+'\n';fs.writeFileSync(out,exact);
 console.log(JSON.stringify({merkleRoot:result.merkleRoot,manifestHash:ethers.keccak256(ethers.toUtf8Bytes(exact)),totalEntitlement:result.totalEntitlement,status:result.status},null,2));
}
