import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { mineSuffix } from '../scripts/mine-token-suffix.mjs';

const artifact = (name, mock=false) => JSON.parse(fs.readFileSync(new URL(`../artifacts/${mock?'test/':''}${name}.json`, import.meta.url)));
test('independent token deployer: security and integration boundaries', async t => {
 const rpc=ganache.provider({logging:{quiet:true},chain:{hardfork:'shanghai'}});
 const p=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1}); p.pollingInterval=10;
 const owner=await p.getSigner(0), other=await p.getSigner(1);
 const deploy=async(name,args=[],mock=false)=>{const a=artifact(name,mock);const c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,owner).deploy(...args);await c.waitForDeployment();return c;};
 const tx=async promise=>(await promise).wait();
 try {
  const f=await deploy('LaunchFactoryHarness',[],true);
  const a=artifact('ConstructorTokenHarness',true), code='0x'+a.evm.bytecode.object;
  const d=await deploy('OursTokenDeployer',[f.target,code,2,0x88]);
  const args=ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256'],[owner.address,1000]);
  const hash=ethers.id('canonical launch parameters including recipient and fee policy');
  const config={chainId:String((await p.getNetwork()).chainId),factory:f.target,deployer:d.target,creator:owner.address,launchHash:hash,initCodeHash:await d.initCodeHash(args),suffixDigits:2,suffix:'0x88',attempts:100000};
  const mined=mineSuffix(config);assert.ok(mined);
  await t.test('offline prediction equals onchain prediction and suffix',async()=>{const [pred,ok]=await d.predict(owner.address,hash,mined.nonce,args);assert.equal(pred,mined.address);assert.equal(ok,true);assert.equal(await d.creationCodeHash(),ethers.keccak256(code));});
  await t.test('non-factory callers cannot deploy or steal a searched salt',async()=>{await assert.rejects(d.connect(other).deploy(owner.address,hash,mined.nonce,args));});
  await t.test('wrong suffix is rejected',async()=>{let nonce=ethers.ZeroHash;for(let i=0;(await d.predict(owner.address,hash,nonce,args))[1];i++)nonce=ethers.toBeHex(i+1,32);await assert.rejects(f.launch(d.target,owner.address,hash,nonce,args,false));});
  await t.test('registration failure rolls back token deployment; retry succeeds',async()=>{await assert.rejects(tx(f.launch(d.target,owner.address,hash,mined.nonce,args,true,{gasLimit:4000000})));assert.equal(await p.getCode(mined.address),'0x');await tx(f.launch(d.target,owner.address,hash,mined.nonce,args,false));const token=new ethers.Contract(mined.address,a.abi,p);assert.equal(await token.creator(),owner.address);assert.equal(await token.supply(),1000n);});
  await t.test('duplicate deployment cannot replace token',async()=>{await assert.rejects(tx(f.launch(d.target,owner.address,hash,mined.nonce,args,false,{gasLimit:4000000})));assert.notEqual(await p.getCode(mined.address),'0x');});
  await t.test('creator, launch parameters and constructor arguments change prediction',async()=>{const cases=[[other.address,hash,args],[owner.address,ethers.id('other policy'),args],[owner.address,hash,ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256'],[owner.address,2000])]];for(const [c,h,x] of cases) assert.notEqual((await d.predict(c,h,mined.nonce,x))[0],mined.address);});
  await t.test('invalid configuration and invalid launch inputs rejected',async()=>{for(const params of [[ethers.ZeroAddress,code,2,0x88],[f.target,'0x',2,0x88],[f.target,code,0,0],[f.target,code,9,0],[f.target,code,1,0x88]])await assert.rejects(deploy('OursTokenDeployer',params));await assert.rejects(d.predict(ethers.ZeroAddress,hash,mined.nonce,args));await assert.rejects(d.predict(owner.address,ethers.ZeroHash,mined.nonce,args));await assert.rejects(d.initCodeHash('0x'+'00'.repeat(49152)));});
  await t.test('reverting constructors leave no token or consumed salt',async()=>{const bad=ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256'],[owner.address,0]);const m=mineSuffix({...config,initCodeHash:await d.initCodeHash(bad)});await assert.rejects(tx(f.launch(d.target,owner.address,hash,m.nonce,bad,false,{gasLimit:4000000})));assert.equal(await p.getCode(m.address),'0x');});
  await t.test('empty runtime constructor is rejected',async()=>{const e=await deploy('OursTokenDeployer',[f.target,'0x'+artifact('EmptyRuntimeHarness',true).evm.bytecode.object,1,0]);const m=mineSuffix({...config,deployer:e.target,initCodeHash:await e.initCodeHash('0x'),suffixDigits:1,suffix:0});await assert.rejects(tx(f.launch(e.target,owner.address,hash,m.nonce,'0x',false,{gasLimit:4000000})));assert.equal(await p.getCode(m.address),'0x');});
  await t.test('runtime stays within EIP-170',()=>{assert.ok(artifact('OursTokenDeployer').evm.deployedBytecode.object.length/2<24576);});
 } finally { await rpc.disconnect(); }
});
