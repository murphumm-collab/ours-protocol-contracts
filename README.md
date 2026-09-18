# OURS protocol contracts

独立私有仓库：`murphumm-collab/ours-protocol-contracts`。由原前端工作区的收益合约与安全测试拆出，本仓库不含前端。

可执行的收益模块实现，配套 Solidity ABI、部署脚本、分红清单生成器及本地 EVM 测试。

完整本地场景见 [测试覆盖矩阵](TEST_COVERAGE_MATRIX.zh-CN.md)。

**尚未部署、未审计；PONS Factory/Curve/Hook 的生产接入和真实 V4 fork 测试尚未完成。**

## 实现范围

| 合约 | 实现 |
|---|---|
| `OursProjectRegistry` | 项目/Curve/报价资产认证；两步 controller 交接；不可变历史策略；延时生效；操作员/报价签名者/审核者分权 |
| `OursFeePool` | 认证源入账；按版本归集；Meme 费用兑换；关闭 100% 平台，开启 30/70；累计分账和尾差保留；自行领取收入 |
| `OursBuybackPool` | 受限签名计划；独立项目预算；真实到账核算；部分成交退款；回购后 burn |
| `OursDividendPool` | 股票 Token 等分红资产购买；按期资金桶；快照登记；多签审核 root；用户自行领取；防重复与总额限制 |
| `OursCurveAdapter` | PONS buy/sell ABI，内盘阶段校验、退款和准确额度授权 |
| `OursV4Adapter` | PoolManager unlock/swap/settle/take；认证回调；项目 canonical pool 校验；分红资产池白名单；单跳 exact-input |
| `OursPlatformTreasury` | 平台实际 fee 固定 50% 回购销毁、20% 股票流动性、10% 奖励、20% 国库；四账本隔离；与项目收益池独立 |
| `OursFeeAccrual` | **抽象接入组件**：交易发生时绑定版本，按版本累计并 sweep；毕业后仍可结算历史费用 |

**分红只有用户 `claim` 的发放路径，没有遍历持有人或批量空投。** 用户支付领取 Gas。执行池由平台 operator 或项目 controller 触发，谁提交交易谁付 Gas；没有从池中报销 Gas 的入口。

### 与 PONS 的界限

这些是新的 OURS 收益合约，不是声称已经完成 PONS 全套 Factory/Curve/Hook 的可部署 fork。Curve/Hook 必须修改费用归集、关闭原版分配和内部回购、正确扣除费用储备，并调用 Registry 注册项目。未改动的原版 PONS 无法直接产生本实现要求的版本化费用入账。

`src/integration/OursFeeAccrual.sol` 是实际可继承组件；详细接入点见 `PONS_INTEGRATION.md`。测试中的 MockFactory/MockCurve/MockV4Manager 是协议替身，不能证明真实曲线数学、V4 Hook 交互或部署字节码正确。

## 构建和测试

需要 Node.js 20+：

```sh
cd ours-protocol-contracts
npm ci --ignore-scripts
npm run compile
npm run check
```

依赖固定：OpenZeppelin 5.4.0、Solidity 0.8.30、ethers 6.17.0、Ganache 7.9.2。编译采用 optimizer + viaIR，EVM target `paris`；V4 PoolManager 自身的目标链 EVM 要求另行核验。

Ganache 的原生 µWS/bigint 扩展在某些 Node/CPU 组合会回退到 JS；测试不依赖原生扩展。实现仅用 ECDSA/IERC1271 所需验证路径，不依赖 OZ 的 Cancun `mcopy` 路径。

## 策略与金额

- 费用只包括进入新策略的 Curve/Hook 交易费，首版集成应将额外 creatorTax 设为零。Gas/发行费/DEX LP 费不自动并入。
- Policy 的三项比例之和必须为 10000，以开启后的项目 70% 为分母。
- 策略写入后不变；延时并对齐全局 `periodLength` 边界生效。取消不会复用版本号。
- 每个项目/版本记录累计分账，平台份额先算，再按项目比例向下取整；至多 2 个最小单位尾差留待后批，不赠予创建者或平台。
- 项目 = 当前链的 Meme 地址，金额均为 token 最小单位。原生资产为零地址。
- 创建者 controller 负责操作；creatorRecipient 收款。换 controller 不夺走旧收款人权益。
- 每版本仅一种非原生分红 Token；首版拒绝精度/转账行为不可靠的资产，包括 fee-on-transfer/rebase。

## 回购及兑换计划

回购执行真实 `burn` 并核对供应减少；本版不实现锁仓模式。股票资产购买使用外部白名单 V4 池，不意味着自动具备公司股息权益。

签名计划 EIP-712 domain：`name` 为 `OURS FeePool` / `OURS BuybackPool` / `OURS DividendPool`，version `1`，实际 chainId 和池地址。完整类型见接口及测试 `types.ExecutionPlan`。

- purpose：0 normalize、1 buyback、2 acquireDividend。
- 接收方固定调用池；签名包含 adapter、routeHash、输入上限、输出下限、过期时间、版本和 nonce。
- nonce 按执行池 + project + signerEpoch 隔离，成功只能使用一次；更新 signer 会撤销旧 epoch 的所有未执行计划。
- 签名者可以是 EOA 或 ERC1271 钱包。报价签名者是价格判断的信任边界；生产必须有独立价格检查和预算控制，签名有效不等于价格合理。
- 链上对白名单报价资产执行 `maxBatchInput` 限额；Meme 原始费用归一化受签名上限和现存预算约束，未额外实现每日总限额。
- Curve route 为 `0x`；V4 route 为 `abi.encode(PoolKey,uint160 sqrtPriceLimitX96)`，hookData 固定为空。没有任意 calldata router。
- 若指定 V4 Hook 要求额外 hookData，本版不支持，必须单独加 typed adapter 并测试。

## 分红是 pull-only

1. 预算到达后兑换/直接成为 reward；按到账的 period 分桶。新周期资金不会阻塞旧周期。
2. 审核者登记结束期的区块快照；最近 256 个块可核对 `blockhash`，更早块和最终性依赖审核者。**合约无法从一个旧块哈希自行证明持有人清单完整、余额或最低持仓资格。**
3. platform/controller 为已结束期 `fundEpoch`。每个 project/version/period 只能一次，不能从未来预算给过去的快照分配。
4. 审核多签发布 root、清单哈希与总权益；公开审核延时后激活。Active root 永久不可更换。
5. 用户调用 `claim(epochId,entitlement,proof)`，只能领给自己。没有空投方法、代领方法和用户枚举循环。
6. 未领取资金不没收；整期无人合格时审核者可将未发布权益的 Funded 期滚回同项目/版本库存，进入当前期。Active 期中的舍入尾差保留，不做管理员回收。

`minHolding` 保存于每期，清单工具执行 `balance >= minHolding`。创建者同规则参与；生成器自动排除零地址，其他系统地址必须显式排除。没有最低持有时长或平均持仓实现，不能将快照分红包装成长期持仓奖励。

### 清单生成

```sh
node scripts/dividend-manifest.mjs holders.json manifest.json
```

输入结构：

```json
{
  "chainId": "目标链 ID",
  "pool": "DividendPool 地址",
  "project": "Meme 地址",
  "epochId": "合约 epochId",
  "snapshotBlock": "期次快照高度",
  "snapshotBlockHash": "期次快照哈希",
  "fundedAmount": "最小单位整数",
  "minHolding": "最小单位整数",
  "excludedAddresses": ["Curve/PoolManager/Locker/资金池等地址"],
  "holders": [{"account": "钱包地址", "balance": "快照持仓最小单位"}]
}
```

所有大整数应使用十进制字符串；生成器拒绝不安全的 JS Number、负数和超出 uint256 的值。

生成器不从 RPC 自动证明输入，候选地址完整性、指定区块余额及排除规则由索引/审核服务验证。它输出可复核清单、Merkle root、每人 proof、总额、尾差；输出文件的原始字节 keccak256 用于 manifestHash。用户不需要向创建者交付私钥或集中领取。

## 部署脚本

先 compile，提供部署配置及 RPC_URL/DEPLOYER_KEY 环境变量，再显式运行 `node scripts/deploy.mjs config.json`。仅在本地 Ganache 完成部署脚本演练，未向公开链部署。

配置须含 chainId、governance、已经适配 OURS 的 factory、treasury、quoteSigner、reviewer、policyDelay、periodLength、reviewDelay、assets；可加 operators、v4PoolManager、rewardPools。

脚本用 NonceManager 顺序管理部署交易，核对链 ID 和 factory 代码，部署并一次绑定三池（同时核对各池 Registry 和类型），配置白名单，发起两步治理权交接。治理多签须 `acceptOwnership`，Factory 也须完成 Registry 的一次绑定并验证初始化顺序。部署后必须核验地址、源码、字节码、角色及资产权限，不将部署成功当作可收真实资金。

## 已知实现限制

- 不提供 PONS 原版不一致源码的自动修复或上线部署；真实 Factory/Curve/Hook 集成及真实 V4 fork 仍需完成。
- 审核者能发布不公平但合法的 Merkle root；金额上限防超支，不消除审核信任。Root 只在延时前可撤销，激活后不能回收用户权益。
- 股权类资产可能有冻结/准入限制，白名单需人工核验；合约不绕过限制。
- 暂停兑换不暂停已经归属的领取；没有管理员提款/任意调用/升级入口。未知误转资产会留在合约，避免错误救援侵占义务余额。
- 首版无自动 Gatekeeper 代付、外部 keeper 奖励或每日总交易限额；应由受限操作服务另外控制。

完整测试结果与剩余边界见 [VALIDATION.md](VALIDATION.md)。

安全测试补充见 [SECURITY_TESTS.md](SECURITY_TESTS.md)，可用 `npm run test:security` 独立执行。

平台 80% 收益模块详见 [PLATFORM_TREASURY.zh-CN.md](PLATFORM_TREASURY.zh-CN.md)。原有部署脚本保持收益池范围；新模块使用独立的 `scripts/deploy-platform.mjs`。
