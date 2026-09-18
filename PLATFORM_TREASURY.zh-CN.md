# 平台收入使用合约

`src/platform/OursPlatformTreasury.sol` 为新增、独立的部署单元。它不继承项目 FeePool 的提款权，不读取或扣除某个项目的回购、分红预算。这里只管理已经归属于平台的收入。

**尚未部署或审计。股票指链上可转移的股票类 ERC20 Token，不是通过券商直接购买股票。**

## 资金流

```text
项目交易费 → OursFeePool
               ├─ 项目/创建者份额 → 原有三个收益池及收款人
               └─ 平台自己的 claimableIncome
                        ↓ 新合约调用 collectFees
                 OursPlatformTreasury
                        ├─ 50% → burnBalance → 买入平台 Token → 真实 burn
                        ├─ 20% → liquidityBalance → 买入股票/平台 Token → V4 LP
                        ├─ 10% → rewardBalance → 买入平台 Token → 固定奖励分配合约
                        └─ 20% → operatingBalance → 固定平台收款地址
```

例如项目自定义开关打开，交易费 100 的平台收入为 30：新合约把平台所得 30 累计分为 **15 销毁、6 流动性、3 奖励、6 国库**。项目另外的 70 不受影响。若项目关闭自定义、100 全归平台，则按 **50/20/10/20** 分配。

四个比例采用累计金额计算，避免拆分入账改变最终分配。整数尾差先保证策略总额为累计收入的 80%，再归入销毁桶。四个账本不可互借：销毁桶只能买平台 Token 并立即 burn；流动性桶只能买平台/股票 Token 和建 LP；奖励桶只能买平台 Token 并交给构造时固定的奖励分配合约；国库桶只能进入固定国库地址。

## 接入原收益合约

1. 部署新合约，构造指定原 `OursFeePool`、可信 V4 PoolManager、平台 Token、治理钱包、平台固定收款地址、固定奖励分配合约、报价签名者及治理延时。
2. 配置可接收的 fee 资产、股票 Token、单批限额、交换池与 LP 池白名单、操作员。
3. 经明确操作，把 Registry 的 `platformRecipient` 设置为新合约地址。现有项目需要新版本 Policy 生效后，才使用这个新收款地址；旧版本历史收款人不会被改写。
4. 任意地址可触发新合约 `collectFees(asset)`，但 FeePool 始终只向新合约支付它自己的应得收入，触发者不能指定项目或收款人。
5. 历史上已经领取到平台的钱可由治理通过 `depositPlatformFees` 存入，同样按 50/20/10/20 处理。这只是治理存款入口，不会链上证明其历史来源。外部直接转账不会自动增加可用预算。

`claimOperating` 只把 20% 已记账留存付给构造时确定的平台地址。任何触发者都不能把这笔钱改发给自己。

## 回购销毁、股票买入与奖励

- `executeSwap` 需要平台操作员或治理提交有效 EIP-712 报价计划。计划额外绑定 `purpose`：0 销毁回购、1 流动性资产获取、2 奖励资产获取。
- purpose 0 只能花 `burnBalance`、只能输出平台 Token；到账后立即调用 `burn` 并验证本合约余额与 `totalSupply` 同额下降。
- 如果平台收入本身就是平台 Token，可用 `burnPlatformTokens` 从销毁桶直接 burn，无需做无意义兑换。
- purpose 1 只能花 `liquidityBalance`，输出只能是平台 Token 或白名单股票 Token；所得只能继续用于 LP。
- purpose 2 只能花 `rewardBalance`、只能输出平台 Token；只有固定 `rewardDistributor` 合约能调用 `releaseRewards` 领取。
- 退款/部分成交以实际余额变化记账，四个用途账本互不借用。没有任意 router calldata、delegatecall 或常驻 Token 授权。
- 原生 fee 和 ERC20 fee 都支持；费用型、rebase、虚报余额等不可靠资产不属于支持范围。

## LP

通过 V4 PoolManager 的 `initialize`（如需要）与 `modifyLiquidity` 操作。池和区间必须明确配置；合约不自动选择股票、确定初始价格或寻找最佳 LP 区间。

支持显式白名单配置 **平台 Token / 股票 Token** 或 **报价资产 / 股票 Token** 等包含股票 Token 的池。**用户尚未确认最终配对；实现没有部署默认池，也没有选择真实资产地址。**

- `addLiquidity`：治理或操作员提交签名计划，指定池、tick 区间、salt、流动性数量、两边最大支出及过期时间。只能用 LP 可用策略库存。
- LP 仓位直接归本合约持有，使用 `(PoolId,tickLower,tickUpper,salt)` 标识。不是可转移的 ERC721 LP NFT；合约不提供把 LP 转给操作员的入口。
- `harvestLiquidityFees`：收取已有 LP 的手续费，实际到账进入策略库存；不会减少仓位，不支付给执行人，不允许出现净支出。
- `removeLiquidity`：治理排队一个完整计划，延时后才能执行；最小回收金额固定，资产只能回到本合约。取消白名单或暂停买入不阻止治理按队列退出已有仓位。
- 合约不提供销毁、流动性或奖励账本向国库提款的入口。LP 退出资产仍回到流动性账本；只有 20% `operatingBalance` 可转入固定国库。

治理地址可以是多签。本合约不自行实现多签或证明某地址确为多签；实际钱包、配对、分配计划和锁定延时需要部署配置。排队后任何人可触发执行，但无法修改目标或拿走资金；谁发交易谁付 Gas。

## 本地验证与复现

```sh
npm ci --ignore-scripts
npm run test:platform
npm run check
```

测试覆盖真实 FeePool → 新合约的 30 → 15/6/3/6 分账、累计舍入、四桶隔离、真实 burn、固定奖励接收方、无策略提款、股票买入、LP 增减和手续费、原生资产部分成交、超额预算、伪造到账、签名/重放、暂停及治理延时。全部只使用本地临时 EVM。

`PlatformManager` 是带余额结算检查的协议替身，没有真实 V4 曲线、集中流动性数学或 Hook。测试通过不等于真实池集成验收，正式使用仍需真实 V4 fork 和独立安全审计。

## 本轮结果

修复后完整回归为 75 项 Node 测试及 1 项部署 CLI 测试全部通过，其中平台模块 19 项。新增覆盖 V4 原生结算、奖励池白名单、治理交接、失败恢复、重入、受限 Token、捐赠隔离和生成式资金守恒。两个部署脚本均完成本地演练。合约运行字节码为 20,099 字节。

## 单独部署脚本

先编译，再准备 JSON 配置，显式运行：

```sh
RPC_URL=... DEPLOYER_KEY=... node scripts/deploy-platform.mjs platform-config.json
```

必要字段：`chainId`、`registry`、`feePool`、`v4PoolManager`、`platformToken`、`governance`、`treasuryRecipient`、`rewardDistributor`、`quoteSigner`、`governanceDelay`、`assets`。`rewardDistributor` 必须是已部署合约。每个 asset 含 `address`、`feeAsset`、`stockAsset`、`batchCap`。可加 `operators`、`pools`（key、swapEnabled、liquidityEnabled）及 `outputFile`。

脚本核对链和 FeePool/Registry 双向绑定，部署后配置并发起两步治理交接。**不会自动修改 Registry 收款人、自动初始化池、买币或加 LP。** 私钥只通过环境变量提供，不应写进配置或仓库。

## 信任与运行限制

- 价格保护来自报价签名者、max/min 和 V4 价格边界，没有独立链上价格预言机。恶意治理/签名者与恶意白名单池可能组合造成不利成交。
- 治理可以改变签名者、操作员、池/资产白名单；延时保护覆盖退出/提取，不意味着所有治理配置都有 timelock。
- 平台固定收款地址、平台 Token、FeePool、PoolManager 与治理延时均不可变，不存在升级或任意资产救援入口。误转的未记账资产不会自动被治理提走。
- 暂停只阻止新增 swap 和 LP 建仓。20% 留存领取、LP 手续费归集和已经授权的延时退出仍可进行。
- LP 中资产数量随价格变化，`positionLiquidity` 是流动性单位，不能当作 Token 数或美元价值；`accountedBalance` 只统计合约内的流动资产。
