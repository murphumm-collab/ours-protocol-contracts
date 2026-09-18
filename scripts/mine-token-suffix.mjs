import { ethers } from 'ethers';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function mineSuffix(c) {
  const digits = Number(c.suffixDigits);
  if (!Number.isInteger(digits) || digits < 1 || digits > 8) throw Error('suffixDigits must be 1..8');
  const suffix = BigInt(c.suffix), mask = (1n << BigInt(digits * 4)) - 1n;
  if (suffix < 0n || suffix > mask) throw Error('Suffix does not fit');
  const limit = BigInt(c.attempts ?? '1000000'), start = BigInt(c.start ?? '0');
  if (limit <= 0n || start < 0n || start + limit > (1n << 256n)) throw Error('Invalid search range');
  if (ethers.getAddress(c.creator) === ethers.ZeroAddress || c.launchHash === ethers.ZeroHash) throw Error('Invalid launch');
  const abi = ethers.AbiCoder.defaultAbiCoder();
  for (let i = start; i < start + limit; i++) {
    const nonce = ethers.toBeHex(i, 32);
    const salt = ethers.keccak256(abi.encode(['uint256','address','address','bytes32','bytes32'], [c.chainId,c.factory,c.creator,c.launchHash,nonce]));
    const address = ethers.getCreate2Address(c.deployer, salt, c.initCodeHash);
    if ((BigInt(address) & mask) === suffix) return { nonce, salt, address, attempts: String(i-start+1n) };
  }
  return null;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = mineSuffix(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  if (!result) { console.error('No match in search range; increase start/attempts.'); process.exitCode = 1; }
  else console.log(JSON.stringify(result, null, 2));
}
