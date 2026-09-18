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
                        ├─ 80% → strategyBalance（策略预算）
                        │          ├─ 买入平台 Token → 保留桶，或 LP 可用库存
                        │          ├─ 买入股票 Token → LP 可用库存
                        │          └─ 添加 V4 流动性 → 合约持有的 LP 仓位
                        └─ 20% → operatingBalance → 固定平台收款地址
```

例如项目自定义开关打开，交易费 100 的平台收入为 30：新合约拿这 30 再分成 **24 策略预算 + 6 平台留存**。项目另外的 70 不受影响。若项目关闭自定义、100 全归平台，则这 100 中的 80 进入策略、20 留存。80% 是固定常量，不能被管理员改成其他比例。

使用累计金额计算 80%，避免通过拆分入账改变最终分配；小额整数舍入按累计策略份额向下取整处理。80% 内部用于回购、股票和 LP 的金额没有硬编码，按平台批准的签名计划执行。LP 手续费全部留在策略预算内，不再次切走 20%。`batchCap` 限制兑换输入；LP 建仓另受签名的两边最大支出和现有策略库存限制。

## 接入原收益合约

1. 部署新合约，构造指定原 `OursFeePool`、可信 V4 PoolManager、平台 Token、治理钱包、平台固定收款地址、报价签名者及治理延时。
2. 配置可接收的 fee 资产、股票 Token、单批限额、交换池与 LP 池白名单、操作员。
3. 经明确操作，把 Registry 的 `platformRecipient` 设置为新合约地址。现有项目需要新版本 Policy 生效后，才使用这个新收款地址；旧版本历史收款人不会被改写。
4. 任意地址可触发新合约 `collectFees(asset)`，但 FeePool 始终只向新合约支付它自己的应得收入，触发者不能指定项目或收款人。
5. 历史上已经领取到平台的钱可由治理通过 `depositPlatformFees` 存入，同样按 80/20 处理。这只是治理存款入口，不会链上证明其历史来源。外部直接转账不会自动增加可用预算。

`claimOperating` 只把 20% 已记账留存付给构造时确定的平台地址。任何触发者都不能把这笔钱改发给自己。

## 回购、保留与股票买入

- `executeSwap` 需要平台操作员或治理提交有效 EIP-712 报价计划。绑定合约地址、链 ID、PoolId、输入上限、输出下限、价格限制、是否保留、期限、nonce 和签名者版本。
- 只用 strategyBalance 中可用的 fee 资产买入平台 Token 或白名单股票 Token；输出接收方固定为本合约。
- `retainOutput=true` 只适用于买回的平台 Token，进入 `retainedPlatformTokens`。没有销毁；这里与原项目 Meme 回购 burn 的策略不同。
- LP 准备库存可通过 `reservePlatformTokens(amount)` 移入保留桶。保留桶不能参与普通 swap 或 LP 建仓；释放必须经过治理队列和延时提款。
- 退款/部分成交以实际余额变化记账，平台 20% 和保留桶不会被兑换预算借用。没有任意 router calldata、delegatecall 或常驻 Token 授权。
- 原生 fee 和 ERC20 fee 都支持；费用型、rebase、虚报余额等不可靠资产不属于支持范围。

## LP

股票流动性由平台手动创建和管理：平台决定配对、初始价格、投入金额和价格区间，再通过治理钱包或授权操作员发起对应交易。费用入账不会自动创建池或添加流动性；部署脚本也不会自动建仓。

**LP 不销毁，也不转入黑洞地址。** 当前实现由平台 Treasury 合约持有 V4 仓位，平台通过权限受限的入口管理；不是把 LP 发到操作员个人钱包。手续费可单独领取到策略库存。这里“不销毁”不表示永久锁死流动性：平台仍可按下述治理延时流程减少或退出仓位，回收资产回到 Treasury。

通过 V4 PoolManager 的 `initialize`（如需要）与 `modifyLiquidity` 操作。池和区间必须明确配置；合约不自动选择股票、确定初始价格或寻找最佳 LP 区间。

支持显式白名单配置 **平台 Token / 股票 Token** 或 **报价资产 / 股票 Token** 等包含股票 Token 的池。**用户尚未确认最终配对；实现没有部署默认池，也没有选择真实资产地址。**

- `addLiquidity`：治理或操作员提交签名计划，指定池、tick 区间、salt、流动性数量、两边最大支出及过期时间。只能用 LP 可用策略库存。
- LP 仓位直接归本合约持有，使用 `(PoolId,tickLower,tickUpper,salt)` 标识。不是可转移的 ERC721 LP NFT；合约不提供把 LP 转给操作员的入口。
- `harvestLiquidityFees`：收取已有 LP 的手续费，实际到账进入策略库存；不会减少仓位，不支付给执行人，不允许出现净支出。
- `removeLiquidity`：治理排队一个完整计划，延时后才能执行；最小回收金额固定，资产只能回到本合约。取消白名单或暂停买入不阻止治理按队列退出已有仓位。
- `withdraw`：策略库存或保留 Token 的提取也必须由治理排队，等待构造时固定的延时；币种、金额、所属桶、salt 全部绑定。接收方只能是固定平台收款地址。

治理地址可以是多签。本合约不自行实现多签或证明某地址确为多签；实际钱包、配对、分配计划和锁定延时需要部署配置。排队后任何人可触发执行，但无法修改目标或拿走资金；谁发交易谁付 Gas。

## 本地验证与复现

```sh
npm ci --ignore-scripts
npm run test:platform
npm run check
```

新增测试覆盖真实 FeePool → 新合约的 30 → 24/6 分账、累计舍入、外部误转、回购保留、股票买入、LP 增减和手续费、原生资产部分成交、超额预算、伪造到账、签名/重放、暂停、治理延时、取消和错误提款参数。全部只使用本地临时 EVM。

`PlatformManager` 是带余额结算检查的协议替身，没有真实 V4 曲线、集中流动性数学或 Hook。测试通过不等于真实池集成验收，正式使用仍需真实 V4 fork 和独立安全审计。

## 历史结果（2026-09-17）

完整 `npm run check` 退出码 0，59 项全部通过，其中新平台模块 9 项。两个部署脚本均完成本地演练；完整输出见 [platform-check-2026-09-17.log](reports/platform-check-2026-09-17.log)。合约运行字节码为 18,065 字节。

最新的复现、修复与完整回归见 [DEEP_VALIDATION.md](DEEP_VALIDATION.md)。新增测试使用官方 V4 核心在本地验证实际兑换、LP 及受控 Hook 结算，不是目标链 fork。

执行加仓时现会重新核验股票资产资格，撤销资格会阻止继续加仓。平台合约禁止 `renounceOwnership`，以保留资产退出所需的治理权限；正常更换治理仍使用两步所有权交接。

## 单独部署脚本

先编译，再准备 JSON 配置，显式运行：

```sh
RPC_URL=... DEPLOYER_KEY=... node scripts/deploy-platform.mjs platform-config.json
```

必要字段：`chainId`、`registry`、`feePool`、`v4PoolManager`、`platformToken`、`governance`、`treasuryRecipient`、`quoteSigner`、`governanceDelay`、`assets`。每个 asset 含 `address`、`feeAsset`、`stockAsset`、`batchCap`。可加 `operators`、`pools`（key、swapEnabled、liquidityEnabled）及 `outputFile`。

脚本核对链和 FeePool/Registry 双向绑定，部署后配置并发起两步治理交接。**不会自动修改 Registry 收款人、自动初始化池、买币或加 LP。** 私钥只通过环境变量提供，不应写进配置或仓库。

## 信任与运行限制

- 价格保护来自报价签名者、max/min 和 V4 价格边界，没有独立链上价格预言机。恶意治理/签名者与恶意白名单池可能组合造成不利成交。
- 治理可以改变签名者、操作员、池/资产白名单；延时保护覆盖退出/提取，不意味着所有治理配置都有 timelock。
- 平台固定收款地址、平台 Token、FeePool、PoolManager 与治理延时均不可变，不存在升级或任意资产救援入口。误转的未记账资产不会自动被治理提走。
- 暂停只阻止新增 swap 和 LP 建仓。20% 留存领取、LP 手续费归集和已经授权的延时退出仍可进行。
- LP 中资产数量随价格变化，`positionLiquidity` 是流动性单位，不能当作 Token 数或美元价值；`accountedBalance` 只统计合约内的流动资产。
