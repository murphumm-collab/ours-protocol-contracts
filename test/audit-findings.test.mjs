import {test} from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import {ethers} from 'ethers';
import {compile} from '../scripts/compile.mjs';

const zero=ethers.ZeroAddress;
const abi=ethers.AbiCoder.defaultAbiCoder();
const keyType='tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const planTypes={ExecutionPlan:[
 ['project','address'],['policyVersion','uint64'],['purpose','uint8'],['adapter','address'],
 ['routeHash','bytes32'],['assetIn','address'],['assetOut','address'],['maxAmountIn','uint256'],
 ['minAmountOut','uint256'],['deadline','uint64'],['nonce','uint256'],['signerEpoch','uint64']
].map(([name,type])=>({name,type}))};

test('regression: V4 native-input settlement clears a synced ERC20 left by a hook',async()=>{
 const artifacts=compile();
 const rpc=ganache.provider({logging:{quiet:true},wallet:{totalAccounts:5,defaultBalance:1000},chain:{hardfork:'shanghai'}});
 const provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});
 const signers=await Promise.all(Array.from({length:5},(_,i)=>provider.getSigner(i)));
 const [admin,treasury,creator,reviewer]=signers;
 const quoteSigner=ethers.Wallet.createRandom();
 const deploy=async(file,name,args=[])=>{
  const a=artifacts[file][name];
  const c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,admin).deploy(...args);
  await c.waitForDeployment();return c;
 };
 const tx=async p=>(await p).wait();
 try{
  const factory=await deploy('test/mocks/Mocks.sol','MockFactory');
  const registry=await deploy('src/OursProjectRegistry.sol','OursProjectRegistry',
   [admin.address,factory.target,treasury.address,quoteSigner.address,reviewer.address,10,60]);
  const fee=await deploy('src/OursFeePool.sol','OursFeePool',[registry.target]);
  const buyback=await deploy('src/OursBuybackPool.sol','OursBuybackPool',[registry.target]);
  const dividend=await deploy('src/OursDividendPool.sol','OursDividendPool',[registry.target,10]);
  await tx(registry.bindPools(fee.target,buyback.target,dividend.target));
  await tx(registry.setAsset(zero,true,10n**18n));
  const meme=await deploy('test/mocks/Mocks.sol','MockToken');
  const curve=await deploy('test/mocks/Mocks.sol','MockCurve',[registry.target,meme.target,zero,factory.target]);
  const policy={enabled:true,buybackBps:10000,dividendBps:0,creatorBps:0,
   creatorRecipient:creator.address,dividendAsset:zero,minHolding:0};
  await tx(factory.register(registry.target,meme.target,curve.target,creator.address,policy));

  await tx(curve.collect(meme.target,zero,1000n,{value:1000n}));
  await tx(curve.connect(creator).sweepRevenue(meme.target,zero,1));
  await tx(fee.connect(creator).distribute(meme.target,zero,1));

  const manager=await deploy('test/mocks/AuditMocks.sol','PoisonedSyncV4Manager');
  const adapter=await deploy('src/adapters/OursV4Adapter.sol','OursV4Adapter',[registry.target,manager.target,admin.address]);
  await tx(registry.setAdapter(adapter.target,true));
  await tx(curve.setState(true,false));
  const currencies=[zero,meme.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
  const key={currency0:currencies[0],currency1:currencies[1],fee:3000,tickSpacing:60,hooks:curve.target};
  const poolId=ethers.keccak256(abi.encode([keyType],[key]));
  await tx(factory.bind(registry.target,meme.target,poolId,curve.target));
  const route=abi.encode([keyType,'uint160'],[key,1n]);
  const block=await provider.getBlock('latest');
  const plan={project:meme.target,policyVersion:1,purpose:1,adapter:adapter.target,
   routeHash:ethers.keccak256(route),assetIn:zero,assetOut:meme.target,maxAmountIn:100n,
   minAmountOut:200n,deadline:block.timestamp+3600,nonce:77,signerEpoch:1};
  const domain={name:'OURS BuybackPool',version:'1',chainId:(await provider.getNetwork()).chainId,
   verifyingContract:buyback.target};
  const signature=await quoteSigner.signTypedData(domain,planTypes,plan);
  await tx(buyback.connect(creator).executeBuyback(plan,route,signature,{gasLimit:1500000}));
  assert.equal(await buyback.budget(meme.target,zero,1),600n);
  assert.equal(await buyback.usedNonces(ethers.keccak256(abi.encode(['address','uint256','uint64'],[meme.target,77,1]))),true);
 }finally{
  await provider.destroy();await rpc.disconnect();
 }
});
