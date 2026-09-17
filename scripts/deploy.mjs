import fs from 'node:fs';
import path from 'node:path';
import {ethers} from 'ethers';
import {root} from './compile.mjs';
// No transactions unless an explicit command is run with a complete deployment config.
const configPath=process.argv[2];if(!configPath)throw Error('Usage: RPC_URL=... DEPLOYER_KEY=... node scripts/deploy.mjs CONFIG.json');
const c=JSON.parse(fs.readFileSync(configPath,'utf8'));
for(const k of ['chainId','governance','factory','treasury','quoteSigner','reviewer','policyDelay','periodLength','reviewDelay','assets'])if(c[k]===undefined)throw Error('Missing '+k);
if(!process.env.RPC_URL||!process.env.DEPLOYER_KEY)throw Error("RPC_URL and DEPLOYER_KEY are required");
const provider=new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet=new ethers.Wallet(process.env.DEPLOYER_KEY,provider);
// Consecutive mined transactions can otherwise reuse a cached RPC nonce.
const signer=new ethers.NonceManager(wallet);
if((await provider.getNetwork()).chainId!==BigInt(c.chainId))throw Error('Wrong chain');
if(await provider.getCode(c.factory)==='0x')throw Error('Factory must already be deployed and support OURS revenue integration');
const deployed={chainId:String(c.chainId),deployer:wallet.address,governance:c.governance,factory:c.factory};
const out=path.resolve(c.outputFile??`deployment-${c.chainId}-${Date.now()}.json`);
const persist=()=>fs.writeFileSync(out,JSON.stringify(deployed,null,2)+'\n',{mode:0o600});
async function deploy(name,args){const a=JSON.parse(fs.readFileSync(path.join(root,'artifacts',name+'.json')));const contract=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,signer).deploy(...args);await contract.waitForDeployment();deployed[name]=contract.target;persist();return contract;}
const wait=async p=>(await p).wait();
const registry=await deploy('OursProjectRegistry',[wallet.address,c.factory,c.treasury,c.quoteSigner,c.reviewer,c.policyDelay,c.periodLength]);
const fee=await deploy('OursFeePool',[registry.target]);const buy=await deploy('OursBuybackPool',[registry.target]);const div=await deploy('OursDividendPool',[registry.target,c.reviewDelay]);
await wait(registry.bindPools(fee.target,buy.target,div.target));
for(const a of c.assets)await wait(registry.setAsset(a.address,true,BigInt(a.maxBatchInput)));
for(const operator of c.operators??[])await wait(registry.setOperator(operator,true));
const curve=await deploy('OursCurveAdapter',[registry.target]);await wait(registry.setAdapter(curve.target,true));
if(c.v4PoolManager){const adapter=await deploy('OursV4Adapter',[registry.target,c.v4PoolManager,wallet.address]);await wait(registry.setAdapter(adapter.target,true));for(const key of c.rewardPools??[])await wait(adapter.setRewardPool(key,true));if(c.governance.toLowerCase()!==wallet.address.toLowerCase())await wait(adapter.transferOwnership(c.governance));}
if(c.governance.toLowerCase()!==wallet.address.toLowerCase())await wait(registry.transferOwnership(c.governance));
deployed.status='deployed; factory wiring, governance acceptance and bytecode verification required before use';persist();
console.log(JSON.stringify(deployed,null,2));await provider.destroy();
