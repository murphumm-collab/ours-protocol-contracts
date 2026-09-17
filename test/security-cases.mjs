// Shared fixture runner keeps security cases in the same isolated EVM snapshots.
export function registerSecurityTests(c){
 const {test,assert,ethers,abi,tx,deploy,setup,collect,plan,advance,fundEpoch,publish,getFixture}=c;
 const route=(mode,receiver,target=ethers.ZeroAddress,data='0x')=>abi.encode(['uint8','address','address','bytes'],[mode,receiver,target,data]);
 async function state(f){return Promise.all([f.quote.balanceOf(f.buy.target),f.quote.balanceOf(f.other.address),f.buy.totalLiability(f.asset),f.buy.budget(f.meme.target,f.asset,1),f.meme.totalSupply()]);}
 for(const [mode,label] of [[0,'fabricated output'],[1,'spending beyond exact approval']])test(`security: ${label} reverts actual transaction and preserves funds`,async()=>{
  const f=getFixture();await collect(f,10000n);const adapter=await deploy('test/mocks/SecurityMocks.sol','SecurityAdapter');await tx(f.reg.setAdapter(adapter.target,true));
  const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n,{route:route(mode,f.other.address),overrides:{adapter:adapter.target}});const before=await state(f);
  await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature,{gasLimit:1500000})));
  assert.deepEqual(await state(f),before);assert.equal(await f.quote.allowance(f.buy.target,adapter.target),0n);
  const good=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);await tx(f.buy.connect(f.creator).executeBuyback(good.p,good.route,good.signature));
  assert.equal(await f.buy.budget(f.meme.target,f.asset,1),1800n);
 });
 test('security: adapter reentry fails even when it is an authorized operator; residual approval cannot drain',async()=>{
  const f=getFixture();await collect(f,10000n);const adapter=await deploy('test/mocks/SecurityMocks.sol','SecurityAdapter');await tx(f.reg.setAdapter(adapter.target,true));await tx(f.reg.setOperator(adapter.target,true));
  const inner=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n,{overrides:{nonce:9}});
  const data=f.buy.interface.encodeFunctionData('executeBuyback',[inner.p,inner.route,inner.signature]);
  const outer=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n,{route:route(2,adapter.target,f.buy.target,data),overrides:{adapter:adapter.target}});
  await tx(f.buy.connect(f.creator).executeBuyback(outer.p,outer.route,outer.signature));assert.equal(await adapter.attempts(),1n);assert.equal(await adapter.nestedSucceeded(),false);
  assert.equal(await f.buy.budget(f.meme.target,f.asset,1),1800n);const before=await state(f);
  await assert.rejects(tx(adapter.drain(f.asset,f.buy.target,f.other.address,1,{gasLimit:300000})));assert.deepEqual(await state(f),before);
  await tx(f.buy.connect(f.creator).executeBuyback(inner.p,inner.route,inner.signature));assert.equal(await f.buy.budget(f.meme.target,f.asset,1),800n);
 });
 test('security: token callback cannot reenter dividend claim or consume another holder reserve',async()=>{
  const f=await setup(false,true);const receiver=await deploy('test/mocks/SecurityMocks.sol','SecurityRecipient');await collect(f,10000n);const id=await fundEpoch(f);
  const leaves=await publish(f,id,[[receiver.target,1800n],[f.user.address,1000n]],2800n);await advance(11);await tx(f.div.activateEpoch(id));
  await tx(receiver.configure(f.div.target,f.div.interface.encodeFunctionData('claim',[id,1800n,[leaves[1]]])));await tx(f.quote.configure(receiver.target,false));
  await tx(receiver.run());assert.equal(await receiver.attempts(),1n);assert.equal(await receiver.nestedSucceeded(),false);assert.equal(await f.quote.balanceOf(receiver.target),1800n);assert.equal(await f.div.totalLiability(f.asset),1000n);
  await tx(f.quote.configure(ethers.ZeroAddress,false));await tx(f.div.connect(f.user).claim(id,1000n,[leaves[0]]));assert.equal(await f.quote.balanceOf(f.user.address),1000n);
 });
 test('security: a no-op burn rolls back the entire buyback and does not spend quote',async()=>{
  const f=await setup(false,true);await collect(f,10000n);await tx(f.meme.configure(ethers.ZeroAddress,true));const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);const before=await state(f);
  await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature,{gasLimit:1500000})));assert.deepEqual(await state(f),before);
  await tx(f.meme.configure(ethers.ZeroAddress,false));await tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature));assert.equal(await f.buy.budget(f.meme.target,f.asset,1),1800n);
 });
 test('security: attacker signature and mutated project cannot spend a funded victim bucket',async()=>{
  const f=getFixture();await collect(f,10000n);const x=await plan(f,f.buy,1,f.asset,f.meme.target,1000n,2000n);const before=await state(f);
  for(const p of [x.p,{...x.p,project:f.stock.target},{...x.p,policyVersion:2},{...x.p,nonce:2}]){
   await assert.rejects(tx(f.buy.connect(f.creator).executeBuyback(p,x.route,p===x.p?ethers.Wallet.createRandom().signingKey.sign(await f.buy.planDigest(p)).serialized:x.signature,{gasLimit:1500000})));
   assert.deepEqual(await state(f),before);
  }
  await tx(f.buy.connect(f.creator).executeBuyback(x.p,x.route,x.signature));
 });
 for(const seed of [7351,42017,99173])test(`security: seeded state machine conserves funds across projects and versions (seed ${seed})`,async t=>{
  const f=getFixture();const meme=await deploy('test/mocks/Mocks.sol','MockToken');const curve=await deploy('test/mocks/Mocks.sol','MockCurve',[f.reg.target,meme.target,f.asset,f.factory.target]);await tx(f.factory.register(f.reg.target,meme.target,curve.target,f.other.address,{...f.policy,creatorRecipient:f.other.address}));await tx(f.quote.approve(curve.target,ethers.MaxUint256));
  const projects=[f,{...f,meme,curve,creator:f.other}];let rng=seed;const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng;};
  const versions=[1,1],models=[new Map([[1,{gross:0n,spent:0n,policy:f.policy}]]),new Map([[1,{gross:0n,spent:0n,policy:f.policy}]])];let input=0n,claimed=0n,spent=0n,nonce=100n;const actions=[0,0,0,0,0];
  for(let i=0;i<2;i++){await collect(projects[i],10000n);models[i].get(1).gross=10000n;input+=10000n;}
  for(let step=0;step<48;step++){
   const index=random()%2,p=projects[index],action=(random()>>>8)%5;actions[action]++;const v=versions[index],m=models[index].get(v);
   if(action===0){const n=BigInt(random()%1000+1);await collect(p,n,v);input+=n;m.gross+=n;}
   else if(action===1){const recipient=[f.creator,f.other,f.treasury][random()%3],n=await f.fee.claimableIncome(recipient.address,f.asset);if(n){await tx(f.fee.connect(recipient).claimIncome(f.asset));claimed+=n;}}
   else if(action===2){const n=await f.buy.budget(p.meme.target,f.asset,v);if(n){const amount=n>17n?17n:n;const x=await plan(p,f.buy,1,f.asset,p.meme.target,amount,amount*2n,{overrides:{policyVersion:v,nonce:nonce++}});await tx(f.buy.connect(p.creator).executeBuyback(x.p,x.route,x.signature));m.spent+=amount;spent+=amount;}}
   else if(action===3){const buybackBps=random()%10001,dividendBps=random()%(10001-buybackBps),policy={...p.policy,enabled:random()%4!==0,buybackBps,dividendBps,creatorBps:10000-buybackBps-dividendBps,creatorRecipient:p.creator.address};await tx(f.reg.connect(p.creator).schedulePolicy(p.meme.target,policy));await advance(130);versions[index]++;models[index].set(versions[index],{gross:0n,spent:0n,policy});}
   else{const attacker=index===0?f.other:f.creator,before=await f.quote.balanceOf(attacker.address);await assert.rejects(tx(f.fee.connect(attacker).distribute(p.meme.target,f.asset,v,{gasLimit:300000})));assert.equal(await f.quote.balanceOf(attacker.address),before);}
   let feeExpected=0n,buyExpected=0n,divExpected=0n;
   for(let i=0;i<2;i++)for(const [version,m]of models[i]){const platform=m.policy.enabled?m.gross*3000n/10000n:m.gross,rest=m.gross-platform;const b=rest*BigInt(m.policy.buybackBps)/10000n,d=rest*BigInt(m.policy.dividendBps)/10000n,cr=rest*BigInt(m.policy.creatorBps)/10000n,dust=rest-b-d-cr;const totals=await f.fee.totals(projects[i].meme.target,version);
    assert.deepEqual([...totals],[m.gross,platform,b,d,cr,dust]);assert.equal(await f.buy.budget(projects[i].meme.target,f.asset,version),b-m.spent);assert.equal(await f.div.rewardInventory(projects[i].meme.target,version),d);feeExpected+=platform+cr+dust;buyExpected+=b-m.spent;divExpected+=d;
   }
   feeExpected-=claimed;for(const [pool,expected]of [[f.fee,feeExpected],[f.buy,buyExpected],[f.div,divExpected]]){assert.equal(await pool.totalLiability(f.asset),expected);assert.equal(await f.quote.balanceOf(pool.target),expected);}
   assert.equal(input,feeExpected+buyExpected+divExpected+claimed+spent);assert.equal(await f.quote.balanceOf(f.adapter.target),spent);
  }
  assert(actions.every(n=>n>0));assert(spent>0n);assert(claimed>0n);t.diagnostic(`seed=${seed} actions=${actions.join(',')} steps=48`);
 });
}
