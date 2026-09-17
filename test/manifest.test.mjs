import {test} from 'node:test';import assert from 'node:assert/strict';import {ethers} from 'ethers';import {buildManifest} from '../scripts/dividend-manifest.mjs';
const addresses=Array.from({length:8},(_,i)=>ethers.getAddress('0x'+BigInt(i+1).toString(16).padStart(40,'0')));
const base={chainId:4663,pool:addresses[0],project:addresses[1],epochId:ethers.id('epoch'),snapshotBlock:100,snapshotBlockHash:ethers.id('block'),fundedAmount:'1000',minHolding:'100',excludedAddresses:[addresses[0]],holders:[{account:addresses[0],balance:'999999'},{account:addresses[2],balance:'99'},{account:addresses[3],balance:'100'},{account:addresses[4],balance:'300'},{account:addresses[5],balance:'600'}]};
const abi=ethers.AbiCoder.defaultAbiCoder();
test('holder threshold includes equality; exclusions and proof paths match Solidity double-hash leaves',()=>{const r=buildManifest(base);assert.equal(r.eligibleWeight,'1000');assert.equal(r.totalEntitlement,'1000');assert.equal(r.claims.length,3);
 for(const h of r.claims){let hash=ethers.keccak256(ethers.keccak256(abi.encode(['uint256','address','bytes32','address','uint256'],[r.chainId,r.pool,r.epochId,h.account,h.entitlement])));for(const p of h.proof)hash=ethers.keccak256(ethers.concat([hash,p].sort()));assert.equal(hash,r.merkleRoot);}
});
test('empty eligibility produces no claim root, retaining all funding',()=>{const r=buildManifest({...base,minHolding:'100000000'});assert.equal(r.status,'empty');assert.equal(r.unallocated,'1000');assert.equal(r.merkleRoot,ethers.ZeroHash);});
test('manifest rejects duplicate holders and negatives, truncates only rounding dust',()=>{assert.throws(()=>buildManifest({...base,holders:[base.holders[2],base.holders[2]]}));assert.throws(()=>buildManifest({...base,holders:[{account:addresses[2],balance:'-1'}]}));const r=buildManifest({...base,fundedAmount:'7'});assert.equal(r.totalEntitlement,'6');assert.equal(r.unallocated,'1');});
test('regression: reject unsafe JavaScript numbers before token amounts lose precision',()=>{
 assert.throws(()=>buildManifest({...base,fundedAmount:9007199254740993}));
 assert.throws(()=>buildManifest({...base,holders:[{account:addresses[2],balance:9007199254740993}]}));
});
test('manifest validates uint256 boundaries and excludes the zero address',()=>{
 for(const value of ['1e18','0x10','1.2','-1','',null,true,(ethers.MaxUint256+1n).toString()])assert.throws(()=>buildManifest({...base,fundedAmount:value}));
 assert.throws(()=>buildManifest({...base,chainId:Number.MAX_SAFE_INTEGER+1}));
 assert.throws(()=>buildManifest({...base,pool:ethers.ZeroAddress}));
 const r=buildManifest({...base,holders:[{account:ethers.ZeroAddress,balance:'10000'},...base.holders]});assert.equal(r.totalEntitlement,'1000');assert(!r.claims.some(h=>h.account===ethers.ZeroAddress));
 assert.equal(buildManifest({...base,fundedAmount:ethers.MaxUint256.toString()}).fundedAmount,ethers.MaxUint256.toString());
});
test('deterministic generated portfolios conserve funds and verify every proof for odd/even trees',()=>{
 let seed=7351;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let count=1;count<=65;count++){
  const holders=Array.from({length:count},(_,i)=>({account:ethers.getAddress('0x'+BigInt(i+100).toString(16).padStart(40,'0')),balance:String(random()%10000+1)}));
  const r=buildManifest({...base,fundedAmount:String(random()+100000),minHolding:'0',holders});
  assert.equal(BigInt(r.totalEntitlement)+BigInt(r.unallocated),BigInt(r.fundedAmount));assert(BigInt(r.unallocated)<BigInt(count));
  assert.equal(buildManifest({...base,fundedAmount:r.fundedAmount,minHolding:'0',holders:holders.toReversed()}).merkleRoot,r.merkleRoot);
  for(const h of r.claims){let hash=ethers.keccak256(ethers.keccak256(abi.encode(['uint256','address','bytes32','address','uint256'],[r.chainId,r.pool,r.epochId,h.account,h.entitlement])));for(const p of h.proof)hash=ethers.keccak256(ethers.concat([hash,p].sort()));assert.equal(hash,r.merkleRoot);}
 }
});
