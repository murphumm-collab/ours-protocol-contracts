import {registerPlatformTests} from './platform-cases.mjs';
import {registerSecurityTests} from './security-cases.mjs';
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import {ethers} from 'ethers';
import {compile} from '../scripts/compile.mjs';
let artifacts,rpc,provider,s,fixture,snap;
const zero=ethers.ZeroAddress, abi=ethers.AbiCoder.defaultAbiCoder();
const types={ExecutionPlan:[['project','address'],['policyVersion','uint64'],['purpose','uint8'],['adapter','address'],['routeHash','bytes32'],['assetIn','address'],['assetOut','address'],['maxAmountIn','uint256'],['minAmountOut','uint256'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
const tx=async p=>(await p).wait();
async function deploy(file,name,args=[]){const a=artifacts[file][name];const c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,s[0]).deploy(...args);await c.waitForDeployment();return c;}
async function now(){return Number((await provider.getBlock('latest')).timestamp);}
async function advance(seconds){await rpc.request({method:'evm_increaseTime',params:[seconds]});await rpc.request({method:'evm_mine',params:[]});}
async function setup(native=false,securityTokens=false){
 const [admin,treasury,creator,other,reviewer,operator,user]=s;
 const signer=ethers.Wallet.createRandom();
 const factory=await deploy('test/mocks/Mocks.sol','MockFactory');
 const reg=await deploy('src/OursProjectRegistry.sol','OursProjectRegistry',[admin.address,factory.target,treasury.address,signer.address,reviewer.address,10,60]);
 const fee=await deploy('src/OursFeePool.sol','OursFeePool',[reg.target]);
 const buy=await deploy('src/OursBuybackPool.sol','OursBuybackPool',[reg.target]);
 const div=await deploy('src/OursDividendPool.sol','OursDividendPool',[reg.target,10]);
 await tx(reg.bindPools(fee.target,buy.target,div.target));
 const tokenFile=securityTokens?'test/mocks/SecurityMocks.sol':'test/mocks/Mocks.sol',tokenName=securityTokens?'SecurityToken':'MockToken';
 const quote=await deploy(tokenFile,tokenName);const meme=await deploy(tokenFile,tokenName);
 const stock=await deploy('test/mocks/Mocks.sol','MockToken');const asset=native?zero:quote.target;
 await tx(reg.setAsset(asset,true,10n**25n));await tx(reg.setAsset(stock.target,true,10n**25n));
 const curve=await deploy('test/mocks/Mocks.sol','MockCurve',[reg.target,meme.target,asset,factory.target]);
 const policy={enabled:true,buybackBps:4000,dividendBps:4000,creatorBps:2000,creatorRecipient:creator.address,dividendAsset:native?stock.target:quote.target,minHolding:100};
 await tx(factory.register(reg.target,meme.target,curve.target,creator.address,policy));await tx(reg.setOperator(operator.address,true));
 const adapter=await deploy('test/mocks/Mocks.sol','MockAdapter');await tx(reg.setAdapter(adapter.target,true));
 const curveAdapter=await deploy('src/adapters/OursCurveAdapter.sol','OursCurveAdapter',[reg.target]);await tx(reg.setAdapter(curveAdapter.target,true));
 await tx(quote.mint(admin.address,1000000000n));await tx(quote.approve(curve.target,ethers.MaxUint256));
 return {admin,treasury,creator,other,reviewer,operator,user,signer,factory,reg,fee,buy,div,quote,meme,stock,asset,curve,policy,adapter,curveAdapter,native};
}
before(async()=>{artifacts=compile();rpc=ganache.provider({logging:{quiet:true},wallet:{totalAccounts:9,defaultBalance:1000},chain:{hardfork:'shanghai'}});provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});provider.pollingInterval=10;s=await Promise.all(Array.from({length:9},(_,i)=>provider.getSigner(i)));fixture=await setup();snap=await rpc.request({method:'evm_snapshot',params:[]});});
beforeEach(async()=>{await rpc.request({method:'evm_revert',params:[snap]});snap=await rpc.request({method:'evm_snapshot',params:[]});});
after(async()=>{await provider?.destroy();await rpc?.disconnect();});
async function collect(f,amount,version=1,distribute=true){
 await tx(f.curve.collect(f.meme.target,f.asset,amount,{value:f.native?amount:0}));
 await tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.asset,version));
 if(distribute)await tx(f.fee.connect(f.creator).distribute(f.meme.target,f.asset,version,{gasLimit:1000000}));
}
async function plan(f,pool,purpose,assetIn,assetOut,amount,out,options={}){
 const route=options.route??abi.encode(['uint256','uint256'],[amount,out]);
 const p={project:f.meme.target,policyVersion:1,purpose,adapter:f.adapter.target,routeHash:ethers.keccak256(route),assetIn,assetOut,maxAmountIn:amount,minAmountOut:out,deadline:await now()+3600,nonce:1,signerEpoch:await f.reg.signerEpoch(),...options.overrides};
 const name=pool.target===f.buy.target?'OURS BuybackPool':pool.target===f.div.target?'OURS DividendPool':'OURS FeePool';
 const domain={name,version:'1',chainId:(await provider.getNetwork()).chainId,verifyingContract:pool.target};
 const signature=await f.signer.signTypedData(domain,types,p);
 assert.equal(await pool.planDigest(p),ethers.TypedDataEncoder.hash(domain,types,p));
 return {p,route,signature};
}
async function fundEpoch(f){
 const timestamp=await now();await advance(60-(timestamp%60)+2);
 const period=Math.floor((await now())/60)-1;
 const blockNum=await provider.getBlockNumber();const block=await provider.getBlock(blockNum-1);
 await tx(f.div.connect(f.reviewer).recordSnapshot(f.meme.target,period,block.number,block.hash));
 const id=await f.div.epochId(f.meme.target,1,period);
 await tx(f.div.connect(f.creator).fundEpoch(f.meme.target,1,period));return id;
}
function hashLeaf(chain,pool,id,account,amount){return ethers.keccak256(ethers.keccak256(abi.encode(['uint256','address','bytes32','address','uint256'],[chain,pool,id,account,amount])));}
function pair(a,b){return ethers.keccak256(ethers.concat([a,b].sort()));}
async function publish(f,id,entries,total){
 const chain=(await provider.getNetwork()).chainId;
 const leaves=entries.map(([a,n])=>hashLeaf(chain,f.div.target,id,a,n));
 const root=leaves.length===1?leaves[0]:pair(...leaves);
 await tx(f.div.connect(f.reviewer).proposeDistribution(id,root,ethers.id('manifest'),total));
 return leaves;
}

test('100 fee splits 30 platform / 28 buyback / 28 dividend / 14 creator, with liabilities conserved',async()=>{
 const f=fixture;await collect(f,100n);
 assert.equal(await f.fee.claimableIncome(f.treasury.address,f.asset),30n);assert.equal(await f.fee.claimableIncome(f.creator.address,f.asset),14n);
 assert.equal(await f.buy.budget(f.meme.target,f.asset,1),28n);assert.equal(await f.div.rewardInventory(f.meme.target,1),28n);
 assert.equal(await f.fee.totalLiability(f.asset),44n);assert.equal(await f.quote.balanceOf(f.fee.target),44n);
 await tx(f.fee.connect(f.creator).claimIncome(f.asset));assert.equal(await f.quote.balanceOf(f.creator.address),14n);
 await assert.rejects(tx(f.fee.connect(f.creator).claimIncome(f.asset)));await assert.rejects(tx(f.fee.connect(f.other).claimIncome(f.asset)));
});
test('cumulative allocation is independent of batching, including dust release',async()=>{
 const f=fixture;let sum=0n;
 for(const n of [1n,1n,1n,1n,3n,5n,7n,11n,19n,51n]){
  sum+=n;await collect(f,n);const t=await f.fee.totals(f.meme.target,1);const platform=sum*3000n/10000n,rest=sum-platform;
  assert.equal(t.platform,platform);assert.equal(t.buyback,rest*4000n/10000n);assert.equal(t.dividend,rest*4000n/10000n);assert.equal(t.creator,rest*2000n/10000n);
  assert.equal(t.dust,rest-t.buyback-t.dividend-t.creator);assert.equal(await f.quote.balanceOf(f.fee.target),await f.fee.totalLiability(f.asset));
 }
 assert.equal(sum,100n);
});
test('historical source accrual survives policy change; disabled new version is 100% platform',async()=>{
 const f=fixture;await tx(f.curve.collect(f.meme.target,f.asset,100n));
 await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,{...f.policy,enabled:false}));
 await advance(130);assert.equal(await f.reg.currentVersion(f.meme.target),2n);
 await tx(f.curve.collect(f.meme.target,f.asset,200n));
 await tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.asset,1));await tx(f.fee.connect(f.creator).distribute(f.meme.target,f.asset,1));
 await tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.asset,2));await tx(f.fee.connect(f.creator).distribute(f.meme.target,f.asset,2));
 assert.equal(await f.fee.claimableIncome(f.treasury.address,f.asset),230n);assert.equal(await f.fee.claimableIncome(f.creator.address,f.asset),14n);
});
test('policies reject invalid proportions; cancelled IDs never activate; controller transfer preserves old payee',async()=>{
 const f=fixture;await assert.rejects(tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,{...f.policy,buybackBps:5000})));
 await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,{...f.policy,enabled:false}));await tx(f.reg.connect(f.creator).cancelPendingPolicy(f.meme.target));
 await advance(130);assert.equal(await f.reg.currentVersion(f.meme.target),1n);await assert.rejects(f.reg.policyAt(f.meme.target,2));
 await tx(f.reg.connect(f.creator).proposeController(f.meme.target,f.other.address));await tx(f.reg.connect(f.other).acceptController(f.meme.target));
 await assert.rejects(tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,f.policy)));
 await tx(f.curve.collect(f.meme.target,f.asset,100n));await tx(f.curve.connect(f.other).sweepRevenue(f.meme.target,f.asset,1));
 await tx(f.fee.connect(f.other).distribute(f.meme.target,f.asset,1));assert.equal(await f.fee.claimableIncome(f.creator.address,f.asset),14n);
});
test('unauthorized fee injection, bucket funding, execution and reviewer actions are rejected',async()=>{
 const f=fixture;
 await assert.rejects(tx(f.fee.creditFees(f.meme.target,f.asset,1,100n)));
 await assert.rejects(tx(f.buy.fund(f.meme.target,f.asset,1,100n)));
 await collect(f,100n,1,false);await assert.rejects(tx(f.fee.connect(f.other).distribute(f.meme.target,f.asset,1)));
 await assert.rejects(tx(f.reg.bindPools(f.fee.target,f.buy.target,f.div.target)));
});
test('buyback checks signed destination, actual balance deltas, burns output, and cannot replay',async()=>{
 const f=fixture;await collect(f,10000n);const {p,route,signature}=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);
 await assert.rejects(tx(f.buy.connect(f.other).executeBuyback(p,route,signature)));
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback({...p,assetOut:f.stock.target},route,signature)));
 const supply=await f.meme.totalSupply();await tx(f.buy.connect(f.creator).executeBuyback(p,route,signature));
 assert.equal(await f.buy.budget(f.meme.target,f.asset,1),1800n);assert.equal(await f.meme.balanceOf(f.buy.target),0n);
 assert.equal(await f.meme.totalSupply(),supply);assert.equal(await f.buy.totalLiability(f.meme.target),0n);
 await assert.rejects(tx(f.buy.connect(f.operator).executeBuyback(p,route,signature)));
});
test('minimum output failure rolls back nonce and budget; revoked signature epoch rejects old plans',async()=>{
 const f=fixture;await collect(f,10000n);
 const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n,{route:abi.encode(['uint256','uint256'],[1000n,1n])});
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature)));
 assert.equal(await f.buy.budget(f.meme.target,f.asset,1),2800n);
 const good=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);await tx(f.reg.setQuoteSigner(f.signer.address));
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(good.p,good.route,good.signature)));
});
test('curve adapter handles partial fill refunds, preserves donation, and clears approvals',async()=>{
 const f=fixture;await collect(f,10000n);await tx(f.curve.setFill(5000));await tx(f.quote.mint(f.curveAdapter.target,777n));
 const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,1000n,{route:'0x',overrides:{adapter:f.curveAdapter.target}});
 await tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature));
 assert.equal(await f.buy.budget(f.meme.target,f.asset,1),2300n);assert.equal(await f.quote.balanceOf(f.curveAdapter.target),777n);
 assert.equal(await f.quote.allowance(f.buy.target,f.curveAdapter.target),0n);assert.equal(await f.quote.allowance(f.curveAdapter.target,f.curve.target),0n);
});
test('ready/migrating projects cannot swap; historical fee sweeps remain possible after graduation',async()=>{
 const f=fixture;await collect(f,10000n);const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);
 await tx(f.curve.setState(false,true));await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature)));
 await tx(f.curve.collect(f.meme.target,f.asset,100n));await tx(f.curve.setState(true,false));
 await tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.asset,1));assert.equal(await f.fee.pendingFees(f.meme.target,f.asset,1),100n);
});
test('raw Hook-style meme fees normalize before distribution and retain version',async()=>{
 const f=fixture;await tx(f.meme.mint(f.admin.address,100n));await tx(f.meme.approve(f.curve.target,100n));
 await tx(f.curve.collect(f.meme.target,f.meme.target,100n));await tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.meme.target,1));
 const x=await plan(f,f.fee,0,f.meme.target,f.asset,100n,50n);await tx(f.fee.connect(f.operator).normalizeFees(x.p,x.route,x.signature));
 await tx(f.fee.connect(f.creator).distribute(f.meme.target,f.asset,1));assert.equal(await f.fee.claimableIncome(f.treasury.address,f.asset),15n);
});
test('pull dividend claims bind beneficiary, epoch and pool, require review delay, and reject duplicate claims',async()=>{
 const f=fixture;await collect(f,10000n);const id=await fundEpoch(f);
 const entries=[[f.user.address,1800n],[f.creator.address,1000n]];const leaves=await publish(f,id,entries,2800n);
 await assert.rejects(tx(f.div.activateEpoch(id)));await assert.rejects(tx(f.div.connect(f.user).claim(id,1800n,[leaves[1]])));
 await advance(11);await tx(f.div.connect(f.other).activateEpoch(id));
 await assert.rejects(tx(f.div.connect(f.other).claim(id,1800n,[leaves[1]])));
 await tx(f.div.connect(f.user).claim(id,1800n,[leaves[1]]));await tx(f.div.connect(f.creator).claim(id,1000n,[leaves[0]]));
 assert.equal(await f.quote.balanceOf(f.user.address),1800n);assert.equal((await f.div.epoch(id)).claimedAmount,2800n);
 await assert.rejects(tx(f.div.connect(f.user).claim(id,1800n,[leaves[1]])));assert.equal(await f.div.totalLiability(f.asset),0n);
 await assert.rejects(tx(f.div.connect(f.reviewer).cancelDistribution(id)));
});
test('no holder iteration: independent claims; blocked recipient cannot consume another holder reserve',async()=>{
 const f=fixture;await collect(f,10000n);const id=await fundEpoch(f);const leaves=await publish(f,id,[[f.user.address,1800n],[f.creator.address,1000n]],2800n);
 await advance(11);await tx(f.div.activateEpoch(id));await tx(f.quote.setBlocked(f.user.address,true));
 await assert.rejects(tx(f.div.connect(f.user).claim(id,1800n,[leaves[1]])));
 assert.equal(await f.div.claimed(id,f.user.address),0n);await tx(f.div.connect(f.creator).claim(id,1000n,[leaves[0]]));
 assert.equal(await f.div.totalLiability(f.asset),1800n);
});
test('reviewer cannot publish beyond funding, creator cannot author a root, and aggregate claim cap is enforced',async()=>{
 const f=fixture;await collect(f,10000n);const id=await fundEpoch(f);
 await assert.rejects(tx(f.div.connect(f.creator).proposeDistribution(id,ethers.id('x'),ethers.id('m'),2800n)));
 await assert.rejects(tx(f.div.connect(f.reviewer).proposeDistribution(id,ethers.id('x'),ethers.id('m'),2801n)));
 const leaves=await publish(f,id,[[f.user.address,2000n],[f.creator.address,2000n]],2800n);await advance(11);await tx(f.div.activateEpoch(id));
 await tx(f.div.connect(f.user).claim(id,2000n,[leaves[1]]));await assert.rejects(tx(f.div.connect(f.creator).claim(id,2000n,[leaves[0]])));
});
test('empty epoch rolls back only to same project inventory; review cancellation permits correction with renewed delay',async()=>{
 const f=fixture;await collect(f,10000n);const id=await fundEpoch(f);await publish(f,id,[[f.user.address,2800n]],2800n);
 await tx(f.div.connect(f.reviewer).cancelDistribution(id));await tx(f.div.connect(f.reviewer).rollEmptyEpoch(id,ethers.id('empty-proof')));
 assert.equal(await f.div.rewardInventory(f.meme.target,1),2800n);assert.equal((await f.div.epoch(id)).status,4n);
 assert.equal(await f.div.totalLiability(f.asset),2800n);await assert.rejects(tx(f.div.connect(f.creator).rollEmptyEpoch(id,ethers.id('x'))));
});
test('native fees/refunds and separate stock reward conversion work',async()=>{
 const f=await setup(true);await collect(f,10000n);
 const x=await plan(f,f.div,2,zero,f.stock.target,1000n,2000n,{route:abi.encode(['uint256','uint256'],[500n,2000n])});
 await tx(f.div.connect(f.operator).acquireReward(x.p,x.route,x.signature));assert.equal(await f.div.budget(f.meme.target,zero,1),2300n);
 assert.equal(await f.div.rewardInventory(f.meme.target,1),2000n);
 const id=await fundEpoch(f);await publish(f,id,[[f.user.address,2000n]],2000n);await advance(11);await tx(f.div.activateEpoch(id));
 await tx(f.div.connect(f.user).claim(id,2000n,[]));assert.equal(await f.stock.balanceOf(f.user.address),2000n);
 const before=await provider.getBalance(f.treasury.address);const receipt=await tx(f.fee.connect(f.treasury).claimIncome(zero));
 assert.equal((await provider.getBalance(f.treasury.address))-before+receipt.fee,3000n);
});
test('V4 adapter authenticates callback/canonical pool, settles actual deltas, and refunds partial input',async()=>{
 const f=fixture;await collect(f,10000n);
 const manager=await deploy('test/mocks/Mocks.sol','MockV4Manager');
 const adapter=await deploy('src/adapters/OursV4Adapter.sol','OursV4Adapter',[f.reg.target,manager.target,f.admin.address]);
 await tx(f.reg.setAdapter(adapter.target,true));await tx(manager.setFill(5000));
 const currencies=[f.asset,f.meme.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
 const key={currency0:currencies[0],currency1:currencies[1],fee:3000,tickSpacing:60,hooks:f.curve.target};
 const keyType='tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
 const id=ethers.keccak256(abi.encode([keyType],[key]));await tx(f.curve.setState(true,false));await tx(f.factory.bind(f.reg.target,f.meme.target,id,f.curve.target));
 const route=abi.encode([keyType,'uint160'],[key,1n]);const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,1000n,{route,overrides:{adapter:adapter.target}});
 await assert.rejects(tx(adapter.unlockCallback('0x')));await tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature));
 assert.equal(await f.buy.budget(f.meme.target,f.asset,1),2300n);
 const badRoute=abi.encode([keyType,'uint160'],[{...key,fee:500},1n]);const bad=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,1000n,{route:badRoute,overrides:{adapter:adapter.target,nonce:2}});
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(bad.p,bad.route,bad.signature)));
});
test('ERC1271 quote signer support and pause do not prevent existing income claims',async()=>{
 const f=fixture;await collect(f,10000n);const signer=await deploy('test/mocks/Mocks.sol','Mock1271');await tx(f.reg.setQuoteSigner(signer.target));
 const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);await tx(signer.set(await f.buy.planDigest(x.p)));
 await tx(f.reg.setExecutionPaused(f.meme.target,true));await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,'0x')));
 await tx(f.fee.connect(f.creator).claimIncome(f.asset));await tx(f.reg.setExecutionPaused(f.meme.target,false));
 await tx(f.buy.connect(f.operator).executeBuyback(x.p,x.route,'0x'));
});
test('fee-on-transfer deposits revert without consuming source accrual',async()=>{
 const f=fixture;await tx(f.curve.collect(f.meme.target,f.asset,100n));await tx(f.quote.setTaxed(true));
 await assert.rejects(tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.asset,1)));
 assert.equal(await f.curve.accruedRevenue(f.meme.target,f.asset,1),100n);assert.equal(await f.fee.totalLiability(f.asset),0n);
});

test('new-period rewards cannot block funding the previous period',async()=>{
 const f=fixture;await collect(f,10000n);const oldPeriod=Math.floor((await now())/60);
 const timestamp=await now();await advance(60-timestamp%60+2);
 await collect(f,100n); // New arrivals must stay in the next period.
 const block=await provider.getBlock((await provider.getBlockNumber())-1);
 await tx(f.div.connect(f.reviewer).recordSnapshot(f.meme.target,oldPeriod,block.number,block.hash));
 const id=await f.div.epochId(f.meme.target,1,oldPeriod);await tx(f.div.connect(f.creator).fundEpoch(f.meme.target,1,oldPeriod));
 assert.equal((await f.div.epoch(id)).fundedAmount,2800n);assert.equal(await f.div.rewardInventory(f.meme.target,1),28n);
 assert.equal(await f.div.totalLiability(f.asset),2828n);
});
test('another project controller cannot spend or distribute this project balances',async()=>{
 const f=fixture;const meme2=await deploy('test/mocks/Mocks.sol','MockToken');
 const curve2=await deploy('test/mocks/Mocks.sol','MockCurve',[f.reg.target,meme2.target,f.asset,f.factory.target]);
 await tx(f.factory.register(f.reg.target,meme2.target,curve2.target,f.other.address,{...f.policy,creatorRecipient:f.other.address}));
 await collect(f,10000n);const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);
 await assert.rejects(tx(f.buy.connect(f.other).executeBuyback(x.p,x.route,x.signature)));
 await assert.rejects(tx(f.fee.connect(f.other).distribute(f.meme.target,f.asset,1)));
 assert.equal(await f.buy.budget(meme2.target,f.asset,1),0n);
});
test('zero creator share cannot collect rounding dust; disabled mode cannot fund either action pool',async()=>{
 const f=fixture;await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,{...f.policy,buybackBps:5000,dividendBps:5000,creatorBps:0}));await advance(130);
 for(const n of [1n,1n,1n,1n,1n,1n])await collect(f,n,2);
 const t=await f.fee.totals(f.meme.target,2);assert.equal(t.creator,0n);assert.equal(await f.fee.claimableIncome(f.creator.address,f.asset),0n);
 assert.equal(t.platform+t.buyback+t.dividend+t.dust,6n);
});
test('signed plans fail on expiry, altered routes, overspend and another verifying pool',async()=>{
 const f=fixture;await collect(f,10000n);
 const expired=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n,{overrides:{deadline:await now()-1}});
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(expired.p,expired.route,expired.signature)));
 const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,abi.encode(['uint256','uint256'],[1n,999n]),x.signature)));
 const over=await plan(f,f.buy,1,f.asset,f.meme.target,2801n,5602n);await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(over.p,over.route,over.signature)));
 await assert.rejects(tx(f.div.connect(f.creator).acquireReward(x.p,x.route,x.signature)));
 assert.equal(await f.buy.budget(f.meme.target,f.asset,1),2800n);
});
test('real dividend manifest enforces configured minimum off-chain and its proofs redeem on-chain',async()=>{
 const {buildManifest}=await import('../scripts/dividend-manifest.mjs');
 const f=fixture;await collect(f,10000n);const id=await fundEpoch(f);const e=await f.div.epoch(id);
 const manifest=buildManifest({chainId:(await provider.getNetwork()).chainId,pool:f.div.target,project:f.meme.target,epochId:id,snapshotBlock:e.snapshotBlock,snapshotBlockHash:e.snapshotBlockHash,fundedAmount:e.fundedAmount,minHolding:e.minHolding,excludedAddresses:[f.curve.target],holders:[{account:f.curve.target,balance:'9999999'},{account:f.other.address,balance:'99'},{account:f.user.address,balance:'100'},{account:f.creator.address,balance:'300'}]});
 assert.equal(manifest.claims.length,2);assert.equal(manifest.totalEntitlement,'2800');
 await tx(f.div.connect(f.reviewer).proposeDistribution(id,manifest.merkleRoot,ethers.id(JSON.stringify(manifest)),manifest.totalEntitlement));await advance(11);await tx(f.div.activateEpoch(id));
 const claim=manifest.claims.find(c=>c.account===f.user.address);
 await tx(f.div.connect(f.user).claim(id,claim.entitlement,claim.proof));assert.equal(await f.quote.balanceOf(f.user.address),700n);
});
test('native income recipient reentrancy cannot claim twice or take other liabilities',async()=>{
 const f=await setup(true);const receiver=await deploy('test/mocks/Mocks.sol','ReenteringRecipient',[f.fee.target]);
 await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,{...f.policy,creatorRecipient:receiver.target}));await advance(130);await collect(f,10000n,2);
 await tx(receiver.claim());assert.equal(await receiver.nestedSucceeded(),false);assert.equal(await receiver.calls(),1n);
 assert.equal(await provider.getBalance(receiver.target),1400n);assert.equal(await f.fee.claimableIncome(f.treasury.address,zero),3000n);
});

test('regression: independent dividend asset conversion remains usable during meme migration',async()=>{
 const f=await setup(true);await collect(f,10000n);await tx(f.curve.setState(true,false));
 const x=await plan(f,f.div,2,zero,f.stock.target,1000n,2000n);
 await tx(f.div.connect(f.creator).acquireReward(x.p,x.route,x.signature));
 assert.equal(await f.div.rewardInventory(f.meme.target,1),2000n);
});
test('regression: irreversible pool binding rejects another registry and swapped pool roles',async()=>{
 const f=fixture;const r=await deploy('src/OursProjectRegistry.sol','OursProjectRegistry',[f.admin.address,f.factory.target,f.treasury.address,f.signer.address,f.reviewer.address,10,60]);
 await assert.rejects(tx(r.bindPools(f.fee.target,f.buy.target,f.div.target)));
 const fee=await deploy('src/OursFeePool.sol','OursFeePool',[r.target]);const buy=await deploy('src/OursBuybackPool.sol','OursBuybackPool',[r.target]);const div=await deploy('src/OursDividendPool.sol','OursDividendPool',[r.target,10]);
 await assert.rejects(tx(r.bindPools(buy.target,fee.target,div.target)));
 await tx(r.bindPools(fee.target,buy.target,div.target));assert.equal(await r.feePool(),fee.target);
});

test('ten thousand eligible holders need only a logarithmic proof and one user claim',async t=>{
 const {buildManifest}=await import('../scripts/dividend-manifest.mjs');const f=fixture;await collect(f,1000000n);const id=await fundEpoch(f);const e=await f.div.epoch(id);
 const holders=Array.from({length:9999},(_,i)=>({account:ethers.getAddress('0x'+BigInt(i+10000).toString(16).padStart(40,'0')),balance:'100'}));holders.push({account:f.user.address,balance:'100'});
 const manifest=buildManifest({chainId:(await provider.getNetwork()).chainId,pool:f.div.target,project:f.meme.target,epochId:id,snapshotBlock:e.snapshotBlock,snapshotBlockHash:e.snapshotBlockHash,fundedAmount:e.fundedAmount,minHolding:e.minHolding,excludedAddresses:[],holders});
 assert.equal(manifest.claims.length,10000);assert.equal(manifest.totalEntitlement,'280000');
 await tx(f.div.connect(f.reviewer).proposeDistribution(id,manifest.merkleRoot,ethers.id(JSON.stringify(manifest)),manifest.totalEntitlement));await advance(11);await tx(f.div.activateEpoch(id));
 const h=manifest.claims.find(h=>h.account===f.user.address);assert(h.proof.length<=14);
 const receipt=await tx(f.div.connect(f.user).claim(id,h.entitlement,h.proof));assert.equal(await f.quote.balanceOf(f.user.address),28n);assert(receipt.gasUsed<200000n);
 t.diagnostic(`holders=10000 proofLength=${h.proof.length} claimGas=${receipt.gasUsed}`);
});
test('failed output slippage restores nonce, token balances and allowance, allowing a fresh signed retry',async()=>{
 const f=fixture;await collect(f,10000n);const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n,{route:abi.encode(['uint256','uint256'],[1000n,1n])});
 await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature,{gasLimit:1000000})));
 const key=ethers.keccak256(abi.encode(['address','uint256','uint64'],[f.meme.target,1,1]));assert.equal(await f.buy.usedNonces(key),false);assert.equal(await f.quote.balanceOf(f.buy.target),2800n);assert.equal(await f.quote.allowance(f.buy.target,f.adapter.target),0n);
 const good=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);await tx(f.buy.connect(f.operator).executeBuyback(good.p,good.route,good.signature));assert.equal(await f.buy.usedNonces(key),true);
});
test('adapter revocation, asset revocation and per-batch limit block swaps without consuming funds',async()=>{
 const f=fixture;await collect(f,10000n);const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);
 await tx(f.reg.setAdapter(f.adapter.target,false));await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature)));
 await tx(f.reg.setAdapter(f.adapter.target,true));await tx(f.reg.setAsset(f.asset,false,0));await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature)));
 await tx(f.reg.setAsset(f.asset,true,999));await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature)));
 await tx(f.reg.setAsset(f.asset,true,1000));await tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature));assert.equal(await f.buy.budget(f.meme.target,f.asset,1),1800n);
});
test('historical treasury is frozen in each version even when governance changes recipient',async()=>{
 const f=fixture;await tx(f.curve.collect(f.meme.target,f.asset,100n));await tx(f.reg.setPlatformRecipient(f.other.address));
 await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,f.policy));await advance(130);
 await tx(f.curve.connect(f.creator).sweepRevenue(f.meme.target,f.asset,1));await tx(f.fee.connect(f.creator).distribute(f.meme.target,f.asset,1));await collect(f,100n,2);
 assert.equal(await f.fee.claimableIncome(f.treasury.address,f.asset),30n);assert.equal(await f.fee.claimableIncome(f.other.address,f.asset),30n);
});
test('direct donations do not become claimable fees, budgets or reward inventory',async()=>{
 const f=fixture;for(const pool of [f.fee,f.buy,f.div])await tx(f.quote.mint(pool.target,777n));await collect(f,100n);
 for(const pool of [f.fee,f.buy,f.div])assert.equal(await f.quote.balanceOf(pool.target)-await pool.totalLiability(f.asset),777n);
 assert.equal(await f.div.rewardInventory(f.meme.target,1),28n);assert.equal(await f.buy.budget(f.meme.target,f.asset,1),28n);
});
test('snapshot rejects wrong recent block hash and duplicate records; epoch funding cannot repeat',async()=>{
 const f=fixture;await collect(f,10000n);await advance(130);const period=Math.floor((await now())/60)-2;const b=await provider.getBlock((await provider.getBlockNumber())-1);
 await assert.rejects(tx(f.div.connect(f.other).recordSnapshot(f.meme.target,period,b.number,b.hash)));
 await assert.rejects(tx(f.div.connect(f.reviewer).recordSnapshot(f.meme.target,period,b.number,ethers.id('wrong'))));
 await tx(f.div.connect(f.reviewer).recordSnapshot(f.meme.target,period,b.number,b.hash));
 await assert.rejects(tx(f.div.connect(f.reviewer).recordSnapshot(f.meme.target,period,b.number,b.hash)));
 // Locate the funded period explicitly rather than relying on wall-clock alignment.
 const logs=await f.div.queryFilter(f.div.filters.BudgetReceived());const receiptBlock=await provider.getBlock(logs[0].blockNumber);const fundedPeriod=Math.floor(receiptBlock.timestamp/60);
 if(fundedPeriod!==period)await tx(f.div.connect(f.reviewer).recordSnapshot(f.meme.target,fundedPeriod,b.number,b.hash));
 await tx(f.div.connect(f.creator).fundEpoch(f.meme.target,1,fundedPeriod));await assert.rejects(tx(f.div.connect(f.creator).fundEpoch(f.meme.target,1,fundedPeriod)));
});
test('review cancellation resets the waiting period; an active root and outstanding claims are immutable',async()=>{
 const f=fixture;await collect(f,10000n);const id=await fundEpoch(f);await publish(f,id,[[f.user.address,2800n]],2800n);const first=(await f.div.epoch(id)).claimableAt;
 await advance(3);await tx(f.div.connect(f.reviewer).cancelDistribution(id));await publish(f,id,[[f.creator.address,2800n]],2800n);assert((await f.div.epoch(id)).claimableAt>first);
 await advance(11);await tx(f.div.activateEpoch(id));await assert.rejects(tx(f.div.connect(f.reviewer).rollEmptyEpoch(id,ethers.id('bad'))));await assert.rejects(tx(f.div.connect(f.reviewer).proposeDistribution(id,ethers.id('bad'),ethers.id('bad'),2800n)));
 await tx(f.reg.setExecutionPaused(f.meme.target,true));await tx(f.div.connect(f.creator).claim(id,2800n,[]));
});
test('extreme and generated allocation ratios conserve liabilities across historical versions',async()=>{
 const f=fixture;const ratios=[[10000,0,0],[0,10000,0],[0,0,10000],[3333,3333,3334],[1,9998,1],[7219,1781,1000]];
 let version=1;for(const [buybackBps,dividendBps,creatorBps] of ratios){
  await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,{...f.policy,buybackBps,dividendBps,creatorBps}));await advance(130);version++;
  let gross=0n;for(const amount of [1n,7n,23n,101n]){await collect(f,amount,version);gross+=amount;const a=await f.fee.totals(f.meme.target,version),rest=gross-gross*3000n/10000n;
   assert.equal(a.platform,gross*3000n/10000n);assert.equal(a.buyback,rest*BigInt(buybackBps)/10000n);assert.equal(a.dividend,rest*BigInt(dividendBps)/10000n);assert.equal(a.creator,rest*BigInt(creatorBps)/10000n);assert.equal(a.platform+a.buyback+a.dividend+a.creator+a.dust,gross);assert(a.dust<=2n);
   for(const pool of [f.fee,f.buy,f.div])assert.equal(await f.quote.balanceOf(pool.target),await pool.totalLiability(f.asset));
  }
 }
});

registerSecurityTests({test,assert,ethers,abi,tx,deploy,setup,collect,plan,advance,fundEpoch,publish,getFixture:()=>fixture});

registerPlatformTests({test,assert,ethers,abi,tx,deploy,setup,collect,advance,now,getFixture:()=>fixture,getProvider:()=>provider});
