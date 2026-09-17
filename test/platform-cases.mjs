export function registerPlatformTests(c){
 const {test,assert,ethers,abi,tx,deploy,setup,collect,advance,getFixture,getProvider,now}=c;
 const zero=ethers.ZeroAddress;
 const keyType='tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
 const swapTypes={SwapPlan:[['poolId','bytes32'],['assetIn','address'],['maxAmountIn','uint256'],['minAmountOut','uint256'],['sqrtPriceLimitX96','uint160'],['retainOutput','bool'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
 const lpTypes={LiquidityPlan:[['poolId','bytes32'],['tickLower','int24'],['tickUpper','int24'],['salt','bytes32'],['liquidity','uint128'],['maxAmount0','uint256'],['maxAmount1','uint256'],['minAmount0','uint256'],['minAmount1','uint256'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']].map(([name,type])=>({name,type}))};
 async function domain(v){return{name:'OURS PlatformTreasury',version:'1',chainId:(await getProvider().getNetwork()).chainId,verifyingContract:v.target};}
 async function make(native=false){
  const f=native?await setup(true):getFixture(),token=await deploy('test/mocks/Mocks.sol','MockToken'),manager=await deploy('test/mocks/PlatformManager.sol','PlatformManager');
  const vault=await deploy('src/platform/OursPlatformTreasury.sol','OursPlatformTreasury',[f.admin.address,f.fee.target,manager.target,token.target,f.treasury.address,f.signer.address,20]);
  await tx(vault.configureAsset(f.asset,true,false,1000000));await tx(vault.configureAsset(f.stock.target,false,true,1000000));await tx(vault.setOperator(f.operator.address,true));
  for(const t of [f.quote,f.stock,token])await tx(t.mint(manager.target,10000000));
  await tx(f.admin.sendTransaction({to:manager.target,value:1000000}));await tx(f.quote.approve(vault.target,ethers.MaxUint256));
  async function pool(a,b,lp=false){const currencies=[a,b].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),key={currency0:currencies[0],currency1:currencies[1],fee:3000,tickSpacing:60,hooks:zero};const id=ethers.keccak256(abi.encode([keyType],[key]));await tx(vault.configurePool(key,!lp,lp));await tx(vault.initializePool(id,2n**96n));return{id,key};}
  const buy=await pool(f.asset,token.target),stock=await pool(f.asset,f.stock.target),lp=await pool(token.target,f.stock.target,true);
  return{...f,token,manager,vault,buyPool:buy,stockPool:stock,lp};
 }
 async function deposit(f,n=1000n){await tx(f.vault.depositPlatformFees(f.asset,n,{value:f.native?n:0}));}
 async function swap(f,pool,amount,out,retain=false,nonce=1,overrides={}){
  const p={poolId:pool.id,assetIn:f.asset,maxAmountIn:amount,minAmountOut:out,sqrtPriceLimitX96:1,retainOutput:retain,deadline:await now()+3600,nonce,signerEpoch:await f.vault.signerEpoch(),...overrides};
  const d=await domain(f.vault),signature=await f.signer.signTypedData(d,swapTypes,p);assert.equal(await f.vault.swapDigest(p),ethers.TypedDataEncoder.hash(d,swapTypes,p));return{p,signature};
 }
 async function lpPlan(f,remove=false,overrides={}){
  const p={poolId:f.lp.id,tickLower:-60,tickUpper:60,salt:ethers.id('platform position'),liquidity:100,maxAmount0:remove?0:100,maxAmount1:remove?0:100,minAmount0:remove?100:0,minAmount1:remove?100:0,deadline:await now()+3600,nonce:10,signerEpoch:await f.vault.signerEpoch(),...overrides};
  const d=await domain(f.vault),signature=await f.signer.signTypedData(d,lpTypes,p);assert.equal(await f.vault.liquidityDigest(p),ethers.TypedDataEncoder.hash(d,lpTypes,p));return{p,signature};
 }
 async function execute(f,x){return tx(f.vault.connect(f.operator).executeSwap(x.p,x.signature));}
 async function acquireLPAssets(f){await deposit(f);await execute(f,await swap(f,f.buyPool,200n,400n,false,1));await execute(f,await swap(f,f.stockPool,100n,200n,false,2));}
 async function solvent(f){for(const asset of [f.asset,f.token.target,f.stock.target]){const balance=asset===zero?await getProvider().getBalance(f.vault.target):await new ethers.Contract(asset,['function balanceOf(address) view returns(uint256)'],getProvider()).balanceOf(f.vault.target);assert.equal(balance,await f.vault.accountedBalance(asset));}}
 test('platform: real FeePool income splits 30 platform fees into 24 strategy and 6 operating; project funds stay isolated',async()=>{
  const f=await make();await tx(f.reg.setPlatformRecipient(f.vault.target));await tx(f.reg.connect(f.creator).schedulePolicy(f.meme.target,f.policy));await advance(130);await collect(f,100n,2);
  assert.equal(await f.fee.claimableIncome(f.vault.target,f.asset),30n);await tx(f.vault.connect(f.other).collectFees(f.asset));
  assert.equal(await f.vault.strategyBalance(f.asset),24n);assert.equal(await f.vault.operatingBalance(f.asset),6n);assert.equal(await f.quote.balanceOf(f.other.address),0n);
  assert.equal(await f.buy.budget(f.meme.target,f.asset,2),28n);assert.equal(await f.div.rewardInventory(f.meme.target,2),28n);assert.equal(await f.fee.claimableIncome(f.creator.address,f.asset),14n);
  await tx(f.vault.connect(f.other).claimOperating(f.asset));assert.equal(await f.quote.balanceOf(f.treasury.address),6n);await solvent(f);
 });
 test('platform: cumulative 80/20 allocation has no batch rounding exploit; unsolicited transfers are not budget',async()=>{
  const f=await make();let total=0n;for(const n of [1n,1n,1n,2n,7n,19n]){await deposit(f,n);total+=n;assert.equal(await f.vault.strategyBalance(f.asset),total*8n/10n);assert.equal(await f.vault.operatingBalance(f.asset),total-total*8n/10n);await solvent(f);}
  await tx(f.quote.mint(f.vault.target,100));assert.equal(await f.vault.accountedBalance(f.asset),total);
  await assert.rejects(tx(f.vault.connect(f.other).depositPlatformFees(f.asset,1)));await tx(f.quote.setTaxed(true));await assert.rejects(tx(f.vault.depositPlatformFees(f.asset,100)));assert.equal(await f.vault.grossPlatformFees(f.asset),total);
 });
 test('platform: buyback retains actual platform tokens and stock purchase stays in its own strategy ledger',async()=>{
  const f=await make();await deposit(f);await execute(f,await swap(f,f.buyPool,200n,400n,true,1));await execute(f,await swap(f,f.stockPool,100n,200n,false,2));
  assert.equal(await f.vault.retainedPlatformTokens(),400n);assert.equal(await f.vault.strategyBalance(f.token.target),0n);assert.equal(await f.vault.strategyBalance(f.stock.target),200n);assert.equal(await f.vault.strategyBalance(f.asset),500n);assert.equal(await f.vault.operatingBalance(f.asset),200n);await solvent(f);
  const p=await lpPlan(f);await assert.rejects(tx(f.vault.addLiquidity(p.p,p.signature)));await solvent(f);
 });
 test('platform: add LP, retain tokens, delayed removal and delayed withdrawal never pay the executor',async()=>{
  const f=await make();await acquireLPAssets(f);await tx(f.vault.connect(f.operator).reservePlatformTokens(100));const add=await lpPlan(f);await tx(f.vault.connect(f.operator).addLiquidity(add.p,add.signature));
  const id=await f.vault.positionId(add.p.poolId,add.p.tickLower,add.p.tickUpper,add.p.salt);assert.equal(await f.vault.positionLiquidity(id),100n);assert.equal(await f.vault.retainedPlatformTokens(),100n);assert.equal(await f.vault.strategyBalance(f.token.target),200n);await solvent(f);
  const remove=await lpPlan(f,true),action=await f.vault.removalAction(remove.p);await assert.rejects(tx(f.vault.connect(f.other).queueAction(action)));await tx(f.vault.queueAction(action));await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));
  await advance(21);await tx(f.vault.connect(f.other).removeLiquidity(remove.p));assert.equal(await f.vault.positionLiquidity(id),0n);assert.equal(await f.token.balanceOf(f.other.address),0n);await solvent(f);
  const salt=ethers.id('retained withdrawal'),withdraw=await f.vault.withdrawalAction(f.token.target,100,true,salt);await tx(f.vault.queueAction(withdraw));await assert.rejects(tx(f.vault.withdraw(f.token.target,100,true,salt)));await advance(21);
  await tx(f.vault.connect(f.other).withdraw(f.token.target,100,true,salt));assert.equal(await f.token.balanceOf(f.treasury.address),100n);assert.equal(await f.token.balanceOf(f.other.address),0n);assert.equal(await f.vault.retainedPlatformTokens(),0n);
  await assert.rejects(tx(f.vault.withdraw(f.token.target,100,true,salt)));await assert.rejects(tx(f.vault.removeLiquidity(remove.p)));await solvent(f);
 });
 test('platform: bad signatures, insufficient outputs, oversized budgets and replay preserve the 20% reserve',async()=>{
  const f=await make();await deposit(f);const x=await swap(f,f.buyPool,200n,400n);
  await assert.rejects(tx(f.vault.connect(f.other).executeSwap(x.p,x.signature)));await assert.rejects(tx(f.vault.executeSwap({...x.p,nonce:2},x.signature)));
  const over=await swap(f,f.buyPool,801n,1602n);await assert.rejects(tx(f.vault.executeSwap(over.p,over.signature)));
  await tx(f.manager.setOmitOutput(true));await assert.rejects(tx(f.vault.executeSwap(x.p,x.signature,{gasLimit:1500000})));assert.equal(await f.vault.strategyBalance(f.asset),800n);assert.equal(await f.vault.operatingBalance(f.asset),200n);await solvent(f);
  await tx(f.manager.setOmitOutput(false));await execute(f,x);await assert.rejects(execute(f,x));await solvent(f);
 });
 test('platform: native input partial fills reconcile actual spend and cannot consume operating income',async()=>{
  const f=await make(true);await deposit(f);await tx(f.manager.setFill(5000));await execute(f,await swap(f,f.buyPool,200n,200n,true));
  assert.equal(await f.vault.strategyBalance(zero),700n);assert.equal(await f.vault.operatingBalance(zero),200n);assert.equal(await f.vault.retainedPlatformTokens(),200n);await solvent(f);
 });
 test('platform: cancellation and exact withdrawal hashes prevent early, altered or operating-reserve withdrawals',async()=>{
  const f=await make();await deposit(f);const salt=ethers.id('withdraw'),action=await f.vault.withdrawalAction(f.asset,801,false,salt);await tx(f.vault.queueAction(action));await advance(21);
  await assert.rejects(tx(f.vault.withdraw(f.asset,801,false,salt,{gasLimit:300000})));assert.equal(await f.vault.completedActions(action),false);await solvent(f);await tx(f.vault.cancelAction(action));
  const good=await f.vault.withdrawalAction(f.asset,100,false,salt);await tx(f.vault.queueAction(good));await advance(21);await assert.rejects(tx(f.vault.withdraw(f.asset,101,false,salt)));await tx(f.vault.withdraw(f.asset,100,false,salt));assert.equal(await f.vault.operatingBalance(f.asset),200n);await solvent(f);
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
