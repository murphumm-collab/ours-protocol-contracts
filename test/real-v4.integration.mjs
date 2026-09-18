import {test,before,after,beforeEach} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {ethers} from 'ethers';import {root} from '../scripts/compile.mjs';import {compileV4} from '../scripts/compile-v4.mjs';
const require=createRequire(import.meta.url);const hre=require('hardhat');
const abi=ethers.AbiCoder.defaultAbiCoder(),zero=ethers.ZeroAddress,keyType='tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',Q=2n**96n,LOW=4295128740n,HIGH=1461446703485210103287273052203988822378723970341n,E=10n**18n;
let provider,rpc,admin,other,signer,contracts,f,snapshot;
const tx=async p=>(await p).wait();
const swapTypes={SwapPlan:[['poolId','bytes32'],['assetIn','address'],['maxAmountIn','uint256'],['minAmountOut','uint256'],['sqrtPriceLimitX96','uint160'],['retainOutput','bool'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
const lpTypes={LiquidityPlan:[['poolId','bytes32'],['tickLower','int24'],['tickUpper','int24'],['salt','bytes32'],['liquidity','uint128'],['maxAmount0','uint256'],['maxAmount1','uint256'],['minAmount0','uint256'],['minAmount1','uint256'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
async function deploy(name,args=[],officialFile){const artifact=officialFile?contracts[officialFile][name]:JSON.parse(fs.readFileSync(path.join(root,'artifacts',name+'.json'),'utf8'));const c=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,admin).deploy(...args);await c.waitForDeployment();return c;}
async function time(){return Number((await provider.getBlock('latest')).timestamp);}
async function jump(seconds){await rpc.request({method:'evm_increaseTime',params:[seconds]});await rpc.request({method:'evm_mine',params:[]});}
async function signed(p,types){return signer.signTypedData({name:'OURS PlatformTreasury',version:'1',chainId:31337,verifyingContract:f.vault.target},types,p);}
async function swap(pool,assetIn,amount=10n**15n,nonce=1,options={}){const p={poolId:pool.id,assetIn,maxAmountIn:amount,minAmountOut:1,sqrtPriceLimitX96:assetIn===pool.key.currency0?LOW:HIGH,retainOutput:true,deadline:await time()+3600,nonce,signerEpoch:1,...options};return {p,sig:await signed(p,swapTypes)};}
async function lp(remove=false,options={}){const p={poolId:f.lp.id,tickLower:-600,tickUpper:600,salt:ethers.id('real position'),liquidity:10n**16n,maxAmount0:remove?0:5n*10n**14n,maxAmount1:remove?0:5n*10n**14n,minAmount0:remove?1:0,minAmount1:remove?1:0,deadline:await time()+3600,nonce:20,signerEpoch:1,...options};return{p,sig:await signed(p,lpTypes)};}
async function deposit(asset,amount=E){await tx(f.vault.depositPlatformFees(asset,amount,{value:asset===zero?amount:0}));}
async function balance(asset,who){return asset===zero?provider.getBalance(who):new ethers.Contract(asset,['function balanceOf(address) view returns(uint256)'],provider).balanceOf(who);}
async function solvent(){for(const asset of [zero,f.low.target,f.token.target,f.stock.target])assert.equal(await balance(asset,f.vault.target),await f.vault.accountedBalance(asset));}
before(async()=>{
 contracts=compileV4();rpc=hre.network.provider;provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});provider.pollingInterval=10;admin=await provider.getSigner(0);other=await provider.getSigner(1);signer=ethers.Wallet.createRandom();
 const tokens=await Promise.all([deploy('test/MockToken'),deploy('test/MockToken'),deploy('test/MockToken')]);tokens.sort((a,b)=>BigInt(a.target)<BigInt(b.target)?-1:1);const [low,token,stock]=tokens;
 const manager=await deploy('PoolManager',[admin.address],'@uniswap/v4-core/src/PoolManager.sol');const router=await deploy('V4Harness',[manager.target],'test/real-v4/V4Harness.sol');
 const hook='0x0000000000000000000000000000000000010040';await rpc.request({method:'hardhat_setCode',params:[hook,'0x'+contracts['test/real-v4/V4Harness.sol'].SyncAfterSwapHook.evm.deployedBytecode.object]});
 for(const t of tokens){await tx(t.mint(admin.address,1000n*E));await tx(t.approve(router.target,ethers.MaxUint256));}
 async function pool(a,b,h=zero){const currencies=[a,b].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),key={currency0:currencies[0],currency1:currencies[1],fee:3000,tickSpacing:60,hooks:h},id=ethers.keccak256(abi.encode([keyType],[key]));await tx(manager.initialize(key,Q));await tx(router.seed(key,E,{value:currencies[0]===zero?E:0}));return{key,id};}
 const buy=await pool(low.target,token.target),lpPool=await pool(token.target,stock.target),native=await pool(zero,token.target),hookPool=await pool(zero,stock.target,hook);
 const factory=await deploy('test/MockFactory'),reg=await deploy('OursProjectRegistry',[admin.address,factory.target,other.address,signer.address,admin.address,10,60]);const fee=await deploy('OursFeePool',[reg.target]),buyback=await deploy('OursBuybackPool',[reg.target]),div=await deploy('OursDividendPool',[reg.target,10]);await tx(reg.bindPools(fee.target,buyback.target,div.target));await tx(reg.setAsset(zero,true,100n*E));await tx(reg.setAsset(stock.target,true,100n*E));
 const curve=await deploy('test/MockCurve',[reg.target,token.target,zero,factory.target]);await tx(factory.register(reg.target,token.target,curve.target,admin.address,{enabled:true,buybackBps:4000,dividendBps:4000,creatorBps:2000,creatorRecipient:admin.address,dividendAsset:stock.target,minHolding:0}));
 const vault=await deploy('OursPlatformTreasury',[admin.address,fee.target,manager.target,token.target,other.address,signer.address,20]);
 for(const asset of [zero,low.target,stock.target])await tx(vault.configureAsset(asset,true,asset===stock.target,100n*E));
 for(const t of tokens)await tx(t.approve(vault.target,ethers.MaxUint256));for(const p of [buy,lpPool,native,hookPool])await tx(vault.configurePool(p.key,true,p===lpPool));
 f={low,token,stock,manager,router,buy,lp:lpPool,native,hookPool,vault,reg,fee,buyback,div,curve};snapshot=await rpc.request({method:'evm_snapshot',params:[]});
});
beforeEach(async()=>{await rpc.request({method:'evm_revert',params:[snapshot]});snapshot=await rpc.request({method:'evm_snapshot',params:[]});});
after(async()=>{await provider?.destroy();});
for(const direction of ['zeroForOne','oneForZero','native'])test(`real-v4: ${direction} swap settles real AMM deltas and isolates operating reserve`,async()=>{
 const pool=direction==='zeroForOne'?f.buy:direction==='oneForZero'?f.lp:f.native,asset=direction==='zeroForOne'?f.low.target:direction==='oneForZero'?f.stock.target:zero;
 await deposit(asset);const x=await swap(pool,asset);await tx(f.vault.executeSwap(x.p,x.sig));const received=await f.vault.retainedPlatformTokens();assert(received>0n&&received<x.p.maxAmountIn);assert.equal(await f.vault.strategyBalance(asset),E*8n/10n-x.p.maxAmountIn);assert.equal(await f.vault.operatingBalance(asset),E/5n);await solvent();
});
test('real-v4: price-bound partial fill charges only real input, while impossible minimum output rolls back',async()=>{
 await deposit(f.low.target);const x=await swap(f.buy,f.low.target,10n**16n,1,{sqrtPriceLimitX96:Q*9999n/10000n});await tx(f.vault.executeSwap(x.p,x.sig));const spent=E*8n/10n-await f.vault.strategyBalance(f.low.target);assert(spent>0n&&spent<x.p.maxAmountIn);await solvent();
 const bad=await swap(f.buy,f.low.target,10n**15n,2,{minAmountOut:E});const before=await f.vault.strategyBalance(f.low.target);await assert.rejects(tx(f.vault.executeSwap(bad.p,bad.sig,{gasLimit:2000000})));assert.equal(await f.vault.strategyBalance(f.low.target),before);await solvent();
});
test('real-v4: contract owns real liquidity, harvests real fees, and removes it only after delay',async()=>{
 await deposit(f.low.target);await deposit(f.stock.target);const x=await swap(f.buy,f.low.target,10n**15n,1,{retainOutput:false});await tx(f.vault.executeSwap(x.p,x.sig));const add=await lp();await tx(f.vault.addLiquidity(add.p,add.sig));
 assert.equal(await f.router.liquidityOf(f.lp.key,f.vault.target,-600,600,add.p.salt),add.p.liquidity);await solvent();
 await tx(f.router.trade(f.lp.key,true,10n**15n,LOW));const b0=await f.vault.strategyBalance(f.token.target),b1=await f.vault.strategyBalance(f.stock.target);
 await tx(f.vault.harvestLiquidityFees(f.lp.id,-600,600,add.p.salt));assert((await f.vault.strategyBalance(f.token.target))>b0||(await f.vault.strategyBalance(f.stock.target))>b1);await solvent();
 const remove=await lp(true);await tx(f.vault.queueAction(await f.vault.removalAction(remove.p)));await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));await jump(21);await tx(f.vault.connect(other).removeLiquidity(remove.p));assert.equal(await f.router.liquidityOf(f.lp.key,f.vault.target,-600,600,add.p.salt),0n);await solvent();
});
test('real-v4: native platform swap survives hook synchronization of another currency',async()=>{
 await deposit(zero);const x=await swap(f.hookPool,zero,10n**15n,1,{retainOutput:false});await tx(f.vault.executeSwap(x.p,x.sig));assert((await f.vault.strategyBalance(f.stock.target))>0n);await solvent();
});
test('real-v4 regression: native revenue adapter clears currency synchronized by swap hook',async()=>{
 const adapter=await deploy('OursV4Adapter',[f.reg.target,f.manager.target,admin.address]);await tx(f.reg.setAdapter(adapter.target,true));await tx(adapter.setRewardPool(f.hookPool.key,true));
 await tx(f.curve.collect(f.token.target,zero,E,{value:E}));await tx(f.curve.sweepRevenue(f.token.target,zero,1));await tx(f.fee.distribute(f.token.target,zero,1));
 const route=abi.encode([keyType,'uint160'],[f.hookPool.key,LOW]);const p={project:f.token.target,policyVersion:1,purpose:2,adapter:adapter.target,routeHash:ethers.keccak256(route),assetIn:zero,assetOut:f.stock.target,maxAmountIn:10n**15n,minAmountOut:1,deadline:await time()+3600,nonce:1,signerEpoch:1};
 const types={ExecutionPlan:[['project','address'],['policyVersion','uint64'],['purpose','uint8'],['adapter','address'],['routeHash','bytes32'],['assetIn','address'],['assetOut','address'],['maxAmountIn','uint256'],['minAmountOut','uint256'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
 const sig=await signer.signTypedData({name:'OURS DividendPool',version:'1',chainId:31337,verifyingContract:f.div.target},types,p);
 await tx(f.div.acquireReward(p,route,sig));assert((await f.div.rewardInventory(f.token.target,1))>0n);assert.equal(await f.div.budget(f.token.target,zero,1),28n*E/100n-p.maxAmountIn);
});
test('custody regression: governance cannot be renounced because retained assets and LP exits require it',async()=>{
 await deposit(f.low.target);await assert.rejects(tx(f.vault.renounceOwnership()));assert.equal(await f.vault.owner(),admin.address);
});
test('real-v4: failed LP minimum restores queued action, position and balances; valid retry succeeds',async()=>{
 await deposit(f.low.target);await deposit(f.stock.target);
 const x=await swap(f.buy,f.low.target,10n**15n,1,{retainOutput:false});await tx(f.vault.executeSwap(x.p,x.sig));
 const add=await lp();await tx(f.vault.addLiquidity(add.p,add.sig));
 const bad=await lp(true,{minAmount0:E,minAmount1:E});const action=await f.vault.removalAction(bad.p);
 await tx(f.vault.queueAction(action));await jump(21);
 const queued=await f.vault.queuedAt(action),b0=await f.vault.strategyBalance(f.token.target),b1=await f.vault.strategyBalance(f.stock.target);
 await assert.rejects(tx(f.vault.connect(other).removeLiquidity(bad.p,{gasLimit:2000000})));
 assert.equal(await f.vault.queuedAt(action),queued);assert.equal(await f.vault.completedActions(action),false);
 assert.equal(await f.router.liquidityOf(f.lp.key,f.vault.target,-600,600,add.p.salt),add.p.liquidity);
 assert.equal(await f.vault.strategyBalance(f.token.target),b0);assert.equal(await f.vault.strategyBalance(f.stock.target),b1);await solvent();
 await tx(f.vault.cancelAction(action));const good=await lp(true);await tx(f.vault.queueAction(await f.vault.removalAction(good.p)));await jump(21);
 await tx(f.vault.connect(other).removeLiquidity(good.p));assert.equal(await f.router.liquidityOf(f.lp.key,f.vault.target,-600,600,add.p.salt),0n);await solvent();
});
test('real-v4: another caller cannot remove the treasury position through the public liquidity harness',async()=>{
 await deposit(f.low.target);await deposit(f.stock.target);const x=await swap(f.buy,f.low.target,10n**15n,1,{retainOutput:false});await tx(f.vault.executeSwap(x.p,x.sig));const add=await lp();await tx(f.vault.addLiquidity(add.p,add.sig));
 const before0=await f.token.balanceOf(other.address),before1=await f.stock.balanceOf(other.address);
 // V4 keys positions by msg.sender as well as ticks/salt. Harness owns only salt zero.
 await assert.rejects(tx(f.router.connect(other).remove(f.lp.key,add.p.liquidity,add.p.salt,{gasLimit:2000000})));
 assert.equal(await f.router.liquidityOf(f.lp.key,f.vault.target,-600,600,add.p.salt),add.p.liquidity);
 assert.equal(await f.token.balanceOf(other.address),before0);assert.equal(await f.stock.balanceOf(other.address),before1);await solvent();
});
