export function registerPlatformTests(c){
 const {test,assert,ethers,abi,tx,deploy,setup,collect,advance,getFixture,getProvider,now}=c;
 const zero=ethers.ZeroAddress;
 const keyType='tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
 const swapTypes={SwapPlan:[['poolId','bytes32'],['assetIn','address'],['maxAmountIn','uint256'],['minAmountOut','uint256'],['sqrtPriceLimitX96','uint160'],['purpose','uint8'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
 const lpTypes={LiquidityPlan:[['poolId','bytes32'],['tickLower','int24'],['tickUpper','int24'],['salt','bytes32'],['liquidity','uint128'],['maxAmount0','uint256'],['maxAmount1','uint256'],['minAmount0','uint256'],['minAmount1','uint256'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
 async function domain(v){return{name:'OURS PlatformTreasury',version:'1',chainId:(await getProvider().getNetwork()).chainId,verifyingContract:v.target};}
 async function make(native=false,securityToken=false,reentrantRewards=false){
  const f=native?await setup(true):getFixture();
  const token=securityToken?await deploy('test/mocks/SecurityMocks.sol','SecurityToken'):await deploy('test/mocks/Mocks.sol','MockToken');
  const manager=await deploy('test/mocks/PlatformManager.sol','PlatformManager');
  const rewards=reentrantRewards?await deploy('test/mocks/SecurityMocks.sol','SecurityRecipient'):await deploy('test/mocks/Mocks.sol','MockRewardDistributor');
  const vault=await deploy('src/platform/OursPlatformTreasury.sol','OursPlatformTreasury',[f.admin.address,f.fee.target,manager.target,token.target,f.treasury.address,rewards.target,f.signer.address,20]);
  await tx(vault.configureAsset(f.asset,true,false,1000000));await tx(vault.configureAsset(f.stock.target,false,true,1000000));await tx(vault.setOperator(f.operator.address,true));
  for(const t of [f.quote,f.stock,token])await tx(t.mint(manager.target,10000000));
  await tx(f.admin.sendTransaction({to:manager.target,value:1000000}));await tx(f.quote.approve(vault.target,ethers.MaxUint256));
  async function pool(a,b,lp=false){const currencies=[a,b].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),key={currency0:currencies[0],currency1:currencies[1],fee:3000,tickSpacing:60,hooks:zero};const id=ethers.keccak256(abi.encode([keyType],[key]));await tx(vault.configurePool(key,!lp,lp));await tx(vault.initializePool(id,2n**96n));return{id,key};}
  const buy=await pool(f.asset,token.target),stock=await pool(f.asset,f.stock.target),lp=await pool(token.target,f.stock.target,true);
  return{...f,token,manager,rewards,vault,buyPool:buy,stockPool:stock,lp};
 }
 async function deposit(f,n=1000n){await tx(f.vault.depositPlatformFees(f.asset,n,{value:f.native?n:0}));}
 async function swap(f,pool,amount,out,purpose=0,nonce=1,overrides={}){
  const p={poolId:pool.id,assetIn:f.asset,maxAmountIn:amount,minAmountOut:out,sqrtPriceLimitX96:1,purpose,deadline:await now()+3600,nonce,signerEpoch:await f.vault.signerEpoch(),...overrides};
  const d=await domain(f.vault),signature=await f.signer.signTypedData(d,swapTypes,p);assert.equal(await f.vault.swapDigest(p),ethers.TypedDataEncoder.hash(d,swapTypes,p));return{p,signature};
 }
 async function lpPlan(f,remove=false,overrides={}){
  const p={poolId:f.lp.id,tickLower:-60,tickUpper:60,salt:ethers.id('platform position'),liquidity:100,maxAmount0:remove?0:100,maxAmount1:remove?0:100,minAmount0:remove?100:0,minAmount1:remove?100:0,deadline:await now()+3600,nonce:10,signerEpoch:await f.vault.signerEpoch(),...overrides};
  const d=await domain(f.vault),signature=await f.signer.signTypedData(d,lpTypes,p);assert.equal(await f.vault.liquidityDigest(p),ethers.TypedDataEncoder.hash(d,lpTypes,p));return{p,signature};
 }
 async function execute(f,x){return tx(f.vault.connect(f.operator).executeSwap(x.p,x.signature));}
 async function acquireLPAssets(f){await deposit(f);await execute(f,await swap(f,f.buyPool,100n,200n,1,1));await execute(f,await swap(f,f.stockPool,100n,200n,1,2));}
 async function solvent(f){for(const asset of [f.asset,f.token.target,f.stock.target]){const balance=asset===zero?await getProvider().getBalance(f.vault.target):await new ethers.Contract(asset,['function balanceOf(address) view returns(uint256)'],getProvider()).balanceOf(f.vault.target);assert.equal(balance,await f.vault.accountedBalance(asset));}}
 test('platform: real FeePool income splits 30 platform fees into 24 strategy and 6 operating; project funds stay isolated',async()=>{
  const f=await make();await tx(f.reg.setPlatformRecipient(f.vault.target));await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,f.policy));await advance(130);await collect(f,100n,2);
  assert.equal(await f.fee.claimableIncome(f.vault.target,f.asset),30n);await tx(f.vault.connect(f.other).collectFees(f.asset));
  assert.equal(await f.vault.strategyBalance(f.asset),24n);assert.equal(await f.vault.operatingBalance(f.asset),6n);assert.equal(await f.quote.balanceOf(f.other.address),0n);
  assert.equal(await f.vault.burnBalance(f.asset),15n);assert.equal(await f.vault.liquidityBalance(f.asset),6n);assert.equal(await f.vault.rewardBalance(f.asset),3n);
  assert.equal(await f.buy.budget(f.meme.target,f.asset,2),28n);assert.equal(await f.div.rewardInventory(f.meme.target,2),28n);assert.equal(await f.fee.claimableIncome(f.creator.address,f.asset),14n);
  await tx(f.vault.connect(f.other).claimOperating(f.asset));assert.equal(await f.quote.balanceOf(f.treasury.address),6n);await solvent(f);
 });
 test('platform: cumulative 80/20 allocation has no batch rounding exploit; unsolicited transfers are not budget',async()=>{
  const f=await make();let total=0n;for(const n of [1n,1n,1n,2n,7n,19n]){await deposit(f,n);total+=n;assert.equal(await f.vault.strategyBalance(f.asset),total*8n/10n);assert.equal(await f.vault.operatingBalance(f.asset),total-total*8n/10n);await solvent(f);}
  await tx(f.quote.mint(f.vault.target,100));assert.equal(await f.vault.accountedBalance(f.asset),total);
  await assert.rejects(tx(f.vault.connect(f.other).depositPlatformFees(f.asset,1)));await tx(f.quote.setTaxed(true));await assert.rejects(tx(f.vault.depositPlatformFees(f.asset,100)));assert.equal(await f.vault.grossPlatformFees(f.asset),total);
 });
 test('platform: fixed 50/20/10/20 buckets burn buybacks and isolate liquidity inventory',async()=>{
  const f=await make();await deposit(f);const supply=await f.token.totalSupply();
  await execute(f,await swap(f,f.buyPool,200n,400n,0,1));await execute(f,await swap(f,f.stockPool,100n,200n,1,2));
  assert.equal(await f.token.totalSupply(),supply-400n);assert.equal(await f.token.balanceOf(f.vault.target),0n);
  assert.equal(await f.vault.burnBalance(f.asset),300n);assert.equal(await f.vault.liquidityBalance(f.asset),100n);
  assert.equal(await f.vault.liquidityBalance(f.stock.target),200n);assert.equal(await f.vault.rewardBalance(f.asset),100n);
  assert.equal(await f.vault.operatingBalance(f.asset),200n);await solvent(f);
  const p=await lpPlan(f);await assert.rejects(tx(f.vault.addLiquidity(p.p,p.signature)));await solvent(f);
 });
 test('platform: platform-token fees can burn directly without a swap route',async()=>{
  const f=await make();await tx(f.vault.configureAsset(f.token.target,true,false,1000000));
  await tx(f.token.mint(f.admin.address,100));await tx(f.token.approve(f.vault.target,100));await tx(f.vault.depositPlatformFees(f.token.target,100));
  const supply=await f.token.totalSupply();await tx(f.vault.connect(f.operator).burnPlatformTokens(50));
  assert.equal(await f.token.totalSupply(),supply-50n);assert.equal(await f.vault.burnBalance(f.token.target),0n);
  assert.equal(await f.vault.liquidityBalance(f.token.target),20n);assert.equal(await f.vault.rewardBalance(f.token.target),10n);assert.equal(await f.vault.operatingBalance(f.token.target),20n);await solvent(f);
 });
 test('platform: fake platform-token burn rolls back spend, nonce and balances',async()=>{
  const f=await make(false,true);await deposit(f);await tx(f.token.configure(zero,true));const x=await swap(f,f.buyPool,200n,400n,0,41);
  const supply=await f.token.totalSupply();await assert.rejects(tx(f.vault.connect(f.operator).executeSwap(x.p,x.signature,{gasLimit:1500000})));
  assert.equal(await f.vault.burnBalance(f.asset),500n);assert.equal(await f.vault.usedNonces(ethers.keccak256(abi.encode(['uint64','uint256'],[1,41]))),false);
  assert.equal(await f.token.totalSupply(),supply);assert.equal(await f.token.balanceOf(f.vault.target),0n);await solvent(f);
  await tx(f.token.configure(zero,false));await execute(f,x);assert.equal(await f.token.totalSupply(),supply-400n);await solvent(f);
 });
 test('platform: add LP and delayed removal never pay the executor or treasury',async()=>{
  const f=await make();await acquireLPAssets(f);const add=await lpPlan(f);await tx(f.vault.connect(f.operator).addLiquidity(add.p,add.signature));
  const id=await f.vault.positionId(add.p.poolId,add.p.tickLower,add.p.tickUpper,add.p.salt);assert.equal(await f.vault.positionLiquidity(id),100n);assert.equal(await f.vault.liquidityBalance(f.token.target),100n);await solvent(f);
  const remove=await lpPlan(f,true),action=await f.vault.removalAction(remove.p);await assert.rejects(tx(f.vault.connect(f.other).queueAction(action)));await tx(f.vault.queueAction(action));await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));
  await advance(21);await tx(f.vault.connect(f.other).removeLiquidity(remove.p));assert.equal(await f.vault.positionLiquidity(id),0n);assert.equal(await f.token.balanceOf(f.other.address),0n);await solvent(f);
  assert.equal(await f.token.balanceOf(f.treasury.address),0n);await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));await solvent(f);
 });
 test('platform: bad signatures, insufficient outputs, oversized budgets and replay preserve the 20% reserve',async()=>{
  const f=await make();await deposit(f);const x=await swap(f,f.buyPool,200n,400n);
  await assert.rejects(tx(f.vault.connect(f.other).executeSwap(x.p,x.signature)));await assert.rejects(tx(f.vault.executeSwap({...x.p,nonce:2},x.signature)));
  const over=await swap(f,f.buyPool,501n,1002n);await assert.rejects(tx(f.vault.executeSwap(over.p,over.signature)));
  await tx(f.manager.setOmitOutput(true));await assert.rejects(tx(f.vault.executeSwap(x.p,x.signature,{gasLimit:1500000})));assert.equal(await f.vault.strategyBalance(f.asset),800n);assert.equal(await f.vault.operatingBalance(f.asset),200n);await solvent(f);
  await tx(f.manager.setOmitOutput(false));await execute(f,x);await assert.rejects(execute(f,x));await solvent(f);
 });
 test('platform: native input partial fills reconcile actual spend and cannot consume operating income',async()=>{
  const f=await make(true);await deposit(f);await tx(f.manager.setFill(5000));await execute(f,await swap(f,f.buyPool,200n,200n,0));
  assert.equal(await f.vault.strategyBalance(zero),700n);assert.equal(await f.vault.operatingBalance(zero),200n);assert.equal(await f.token.balanceOf(f.vault.target),0n);await solvent(f);
 });
 test('platform: strategy buckets have no treasury withdrawal and rewards only reach the fixed distributor',async()=>{
  const f=await make();await deposit(f);await execute(f,await swap(f,f.buyPool,50n,100n,2,9));
  await assert.rejects(tx(f.vault.releaseRewards(100n)));await tx(f.rewards.pull(f.vault.target,100n));
  assert.equal(await f.token.balanceOf(f.rewards.target),100n);assert.equal(await f.vault.rewardBalance(f.token.target),0n);
  assert.equal(await f.quote.balanceOf(f.treasury.address),0n);assert.equal(await f.vault.operatingBalance(f.asset),200n);await solvent(f);
 });
 test('platform: reward-token callback cannot reenter release or duplicate rewards',async()=>{
  const f=await make(false,true,true);await deposit(f);await execute(f,await swap(f,f.buyPool,50n,100n,2,51));
  const payload=f.vault.interface.encodeFunctionData('releaseRewards',[100n]);await tx(f.rewards.configure(f.vault.target,payload));await tx(f.token.configure(f.rewards.target,false));
  await tx(f.rewards.run());assert.equal(await f.rewards.attempts(),1n);assert.equal(await f.rewards.nestedSucceeded(),false);
  assert.equal(await f.token.balanceOf(f.rewards.target),100n);assert.equal(await f.vault.rewardBalance(f.token.target),0n);await solvent(f);
 });
 test('platform: blocked reward delivery rolls back accounting and succeeds after recovery',async()=>{
  const f=await make(false,true);await deposit(f);await execute(f,await swap(f,f.buyPool,50n,100n,2,52));await tx(f.token.setBlocked(f.rewards.target,true));
  await assert.rejects(tx(f.rewards.pull(f.vault.target,100n)));assert.equal(await f.vault.rewardBalance(f.token.target),100n);assert.equal(await f.token.balanceOf(f.vault.target),100n);
  await tx(f.token.setBlocked(f.rewards.target,false));await tx(f.rewards.pull(f.vault.target,100n));assert.equal(await f.vault.rewardBalance(f.token.target),0n);await solvent(f);
 });
 test('platform: generated deposits preserve cumulative 50/20/10/20 allocation and solvency',async()=>{
  const f=await make();let gross=0n;let state=0x9e3779b9;
  for(let i=0;i<24;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;const n=BigInt(state%97+1);await deposit(f,n);gross+=n;
   const strategy=gross*8000n/10000n,liquidity=gross*2000n/10000n,reward=gross*1000n/10000n,burn=strategy-liquidity-reward;
   assert.equal(await f.vault.burnBalance(f.asset),burn);assert.equal(await f.vault.liquidityBalance(f.asset),liquidity);assert.equal(await f.vault.rewardBalance(f.asset),reward);assert.equal(await f.vault.operatingBalance(f.asset),gross-strategy);await solvent(f);
  }
 });
 test('platform: two-step ownership handover removes old governance authority without changing immutable recipients',async()=>{
  const f=await make();await tx(f.vault.transferOwnership(f.other.address));await assert.rejects(tx(f.vault.connect(f.creator).acceptOwnership()));await tx(f.vault.connect(f.other).acceptOwnership());
  await assert.rejects(tx(f.vault.setPaused(true)));await tx(f.vault.connect(f.other).setPaused(true));
  assert.equal(await f.vault.owner(),f.other.address);assert.equal(await f.vault.treasuryRecipient(),f.treasury.address);assert.equal(await f.vault.rewardDistributor(),f.rewards.target);
 });
 test('platform: delisted and paused pools can still exit an existing LP position after the queued delay',async()=>{
  const f=await make();await acquireLPAssets(f);const add=await lpPlan(f);await tx(f.vault.addLiquidity(add.p,add.signature));
  const remove=await lpPlan(f,true,{nonce:77,deadline:await now()+3600});const action=await f.vault.removalAction(remove.p);await tx(f.vault.queueAction(action));
  await tx(f.vault.configurePool(f.lp.key,false,false));await tx(f.vault.configureAsset(f.stock.target,false,false,0));await tx(f.vault.setPaused(true));await advance(21);
  await tx(f.vault.connect(f.other).removeLiquidity(remove.p));const id=await f.vault.positionId(remove.p.poolId,remove.p.tickLower,remove.p.tickUpper,remove.p.salt);assert.equal(await f.vault.positionLiquidity(id),0n);await solvent(f);
 });
 test('platform: cancelled LP exits cannot execute; requeued action binds every removal parameter',async()=>{
  const f=await make();await acquireLPAssets(f);const add=await lpPlan(f);await tx(f.vault.addLiquidity(add.p,add.signature));const remove=await lpPlan(f,true,{nonce:88});const action=await f.vault.removalAction(remove.p);
  await tx(f.vault.queueAction(action));await tx(f.vault.cancelAction(action));await advance(21);await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));
  await tx(f.vault.queueAction(action));await advance(21);await assert.rejects(tx(f.vault.removeLiquidity({...remove.p,minAmount0:101n})));
  await tx(f.vault.removeLiquidity(remove.p));await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));await solvent(f);
 });
 test('platform: fee-on-transfer swap output cannot create false burn or consume a budget',async()=>{
  const f=await make(false,true);await deposit(f);await tx(f.token.setTaxed(true));const x=await swap(f,f.buyPool,200n,400n,0,61);
  const supply=await f.token.totalSupply();await assert.rejects(tx(f.vault.executeSwap(x.p,x.signature,{gasLimit:1500000})));
  assert.equal(await f.vault.burnBalance(f.asset),500n);assert.equal(await f.token.totalSupply(),supply);assert.equal(await f.token.balanceOf(f.vault.target),0n);await solvent(f);
 });
 test('platform: unsolicited token and native donations never become spendable strategy balances',async()=>{
  const f=await make();await tx(f.quote.mint(f.vault.target,333n));await tx(f.admin.sendTransaction({to:f.vault.target,value:444n}));
  assert.equal(await f.vault.accountedBalance(f.asset),0n);assert.equal((await f.quote.balanceOf(f.vault.target))-await f.vault.accountedBalance(f.asset),333n);
  assert.equal((await getProvider().getBalance(f.vault.target))-await f.vault.accountedBalance(zero),444n);
 });
 test('platform: callback authentication, revocation, pause and signer rotation all fail closed',async()=>{
  const f=await make();await deposit(f);const x=await swap(f,f.buyPool,200n,400n);await assert.rejects(tx(f.vault.unlockCallback('0x')));
  await tx(f.vault.setPaused(true));await assert.rejects(execute(f,x));await tx(f.vault.claimOperating(f.asset));await tx(f.vault.setPaused(false));
  await tx(f.vault.configurePool(f.buyPool.key,false,false));await assert.rejects(execute(f,x));await tx(f.vault.configurePool(f.buyPool.key,true,false));
  await tx(f.vault.setQuoteSigner(f.signer.address));await assert.rejects(execute(f,x));await execute(f,await swap(f,f.buyPool,200n,400n));await solvent(f);
 });
 test('platform: LP fee harvest preserves liquidity and credits only actual receipts to the strategy',async()=>{
  const f=await make();await acquireLPAssets(f);const add=await lpPlan(f);await tx(f.vault.addLiquidity(add.p,add.signature));
  const id=await f.vault.positionId(add.p.poolId,add.p.tickLower,add.p.tickUpper,add.p.salt),a=f.lp.key.currency0,b=f.lp.key.currency1;
  const before0=await f.vault.strategyBalance(a),before1=await f.vault.strategyBalance(b);await tx(f.manager.setFees(7,11));
  await assert.rejects(tx(f.vault.connect(f.other).harvestLiquidityFees(add.p.poolId,-60,60,add.p.salt)));
  await tx(f.vault.connect(f.operator).harvestLiquidityFees(add.p.poolId,-60,60,add.p.salt));assert.equal(await f.vault.positionLiquidity(id),100n);
  assert.equal(await f.vault.strategyBalance(a),before0+7n);assert.equal(await f.vault.strategyBalance(b),before1+11n);await solvent(f);
  await tx(f.manager.setFees(-1,11));await assert.rejects(tx(f.vault.harvestLiquidityFees(add.p.poolId,-60,60,add.p.salt,{gasLimit:1500000})));await solvent(f);
 });

}
