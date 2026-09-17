import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ganache from 'ganache';
import {ethers} from 'ethers';
import {root} from '../scripts/compile.mjs';
const run=promisify(execFile);
test('deployment CLI configures six contracts and leaves governance acceptance pending on local EVM',async()=>{
 const server=ganache.server({logging:{quiet:true},chain:{chainId:4663},wallet:{totalAccounts:6}});const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ours-deploy-test-'));let provider;
 try{
  await server.listen(0,'127.0.0.1');const url=`http://127.0.0.1:${server.address().port}`;provider=new ethers.JsonRpcProvider(url,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
  const accounts=Object.entries(server.provider.getInitialAccounts());const wallet=new ethers.Wallet(accounts[0][1].secretKey,provider);
  // One-byte STOP runtime: factory/manager code-presence checks only. No live protocol impersonation.
  const r=await (await wallet.sendTransaction({data:'0x6001600c60003960016000f300'})).wait();const noop=r.contractAddress;
  const [admin,governance,treasury,reviewer,operator,quoteSigner]=accounts.map(([a])=>ethers.getAddress(a));
  const out=path.join(dir,'deployment.json'),config=path.join(dir,'config.json');
  await fs.writeFile(config,JSON.stringify({chainId:4663,governance,factory:noop,treasury,quoteSigner,reviewer,policyDelay:10,periodLength:60,reviewDelay:10,assets:[{address:ethers.ZeroAddress,maxBatchInput:'100000'}],operators:[operator],v4PoolManager:noop,outputFile:out}));
  await run(process.execPath,['scripts/deploy.mjs',config],{cwd:root,env:{...process.env,RPC_URL:url,DEPLOYER_KEY:accounts[0][1].secretKey},timeout:90000});
  const d=JSON.parse(await fs.readFile(out,'utf8'));
  async function contract(name){const a=JSON.parse(await fs.readFile(path.join(root,'artifacts',name+'.json'),'utf8'));assert.notEqual(await provider.getCode(d[name]),'0x');return new ethers.Contract(d[name],a.abi,provider);}
  const registry=await contract('OursProjectRegistry');const fee=await contract('OursFeePool');const buy=await contract('OursBuybackPool');const div=await contract('OursDividendPool');const curve=await contract('OursCurveAdapter');const v4=await contract('OursV4Adapter');
  assert.equal(await registry.owner(),admin);assert.equal(await registry.pendingOwner(),governance);assert.equal(await v4.pendingOwner(),governance);
  assert.equal(await registry.feePool(),fee.target);assert.equal(await registry.buybackPool(),buy.target);assert.equal(await registry.dividendPool(),div.target);
  assert.equal(await registry.allowedAssets(ethers.ZeroAddress),true);assert.equal(await registry.maxBatchInput(ethers.ZeroAddress),100000n);assert.equal(await registry.operators(operator),true);
  for(const adapter of [curve,v4])assert.equal(await registry.allowedAdapters(adapter.target),true);
  assert(!JSON.stringify(d).includes(accounts[0][1].secretKey));
  const before=await provider.getTransactionCount(admin,'latest');
  const wrong=JSON.parse(await fs.readFile(config,'utf8'));wrong.chainId=4664;await fs.writeFile(config,JSON.stringify(wrong));
  await assert.rejects(run(process.execPath,['scripts/deploy.mjs',config],{cwd:root,env:{...process.env,RPC_URL:url,DEPLOYER_KEY:accounts[0][1].secretKey},timeout:10000}),/Wrong chain/);
  assert.equal(await provider.getTransactionCount(admin,'latest'),before);
 } finally{await provider?.destroy();await server.close();await fs.rm(dir,{recursive:true,force:true});}
});
