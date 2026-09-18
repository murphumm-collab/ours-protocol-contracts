# OURS Protocol Contracts 独立安全审查报告

- 审查及修复日期：2026-09-17—2026-09-18
- 仓库：`murphumm-collab/ours-protocol-contracts`
- 分支：`codex/contracts`
- 审查基线：`9b1559611de61f9703b1ace86e15aa88fb2fe3fa`
- 当前状态：本地审计副本已修复 F-01、F-02 并加入回归测试；尚未推送 GitHub。完整 PONS/Robinhood V4 生产接入仍是上线阻断项。

## 1. 这些合约是做什么的

### 角色

- Registry owner / governance：绑定三类资金池，管理 operator、资产、adapter、报价签名者、审核者和暂停状态。
- Launch Factory：注册项目并在毕业后绑定 V4 Pool/Hook。
- Project controller：设置项目收益策略、触发分账/回购/分红资产购买、转交控制权。
- Quote signer：为每次兑换签 EIP-712 执行计划，决定资产、数量、最低输出、路由和期限。
- Distribution reviewer：登记快照、发布或取消 Merkle 分红 root、声明空期。
- Platform Treasury owner/operator：执行平台 50% 销毁回购、20% 流动性和 10% 奖励资产转换；不能把这三类资金提到国库。
- 用户：自行领取创建者/平台收入或 Merkle 分红。

### 资金流

1. 修改后的 Curve/Hook 应在交易时按策略版本累计费用。
2. 费用 sweep 到 `OursFeePool`；项目币费用先兑换成 quote asset。
3. 自定义策略关闭时，费用 100% 记给平台；开启时固定 30% 平台、70% 按创建者配置拆为项目回购、股票类 Token 分红和创建者收入。
4. 项目回购进入 `OursBuybackPool`，兑换成 Meme 后验证真实 `totalSupply` 减少。
5. 分红预算进入 `OursDividendPool`，转换为奖励资产，按周期快照和 Merkle root 由用户领取。
6. 平台收入若收款人为 `OursPlatformTreasury`，固定拆为 50% 回购销毁、20% 股票流动性、10% 奖励和 20% 国库。

## 2. 审查与测试结果

- Solidity 0.8.30、optimizer 200、viaIR、EVM Paris 编译通过。
- 原仓库基线：58 项业务/安全/平台测试通过，1 项部署 CLI 测试通过。
- 本次先复现 V4 原生币 synced-currency 问题，再修复并将其保留为成功回归用例。
- 修复后完整复跑：60 项 Node 测试（含 V4 回归与固定分账测试）与 1 项部署测试全部通过，0 失败、0 跳过。
- 最大运行时代码：`OursPlatformTreasury` 20,099 bytes，低于 EIP-170 24,576 bytes。
- `npm audit`：33 项工具链依赖告警（Critical 5 / High 22 / Moderate 5 / Low 1），主要来自 Ganache 的传递依赖；不是 33 个 Solidity 漏洞。

覆盖了分账守恒、历史版本、跨项目隔离、权限、EIP-712、重放、过期、滑点、部分成交、退款、授权清零、重入、错误 burn、恶意 adapter、Merkle 重复领取、原生/ERC20、税费币拒绝、随机状态机、V4 callback、LP 增减/收手续费及部署脚本。

未覆盖真实 PONS Factory/Curve/Hook、真实 Robinhood Chain V4、真实股票 Token、链外索引器/审核服务、公开链配置与代理/部署地址，因为仓库中没有这些生产实现或环境。

## 3. 发现汇总

| ID | 等级 | 结论 |
|---|---|---|
| F-01 | High | **已修复**：50% 销毁 / 20% 股票 LP / 10% 奖励 / 20% 国库改为四个不可混用账本，删除策略提款 |
| F-02 | Medium | **已修复**：V4 原生币输入统一先 `sync(address(0))`，攻击复现已转为通过的回归测试 |
| F-03 | High / Release blocker | 仓库没有完整 PONS Factory、Curve、Hook 与毕业实现，无法证明发行、曲线、手续费和迁池安全 |
| F-04 | High (privileged) | owner 可即时换 signer/operator/资产/池；签名价格没有链上独立价格边界，治理失陷可低价处置资金 |
| F-05 | Medium | 分红周期按“转换/入库时间”而非“交易产生费用时间”归属，执行者可延迟操作改变获奖快照 |
| F-06 | Medium (trust) | reviewer 可为周期选择任意历史块，并可单方声明空期，链上不能证明名单完整、公平或期末对应关系 |
| F-07 | Medium / Release blocker | 未做真实 Robinhood Chain V4 fork、Hook、股票 Token 与 EVM 兼容测试 |
| F-08 | Medium (deployment) | 平台 Treasury 部署后仍需手工切换 Registry 收款地址并完成两步治理接管，错误顺序会让收入进入旧地址 |
| F-09 | Low (tooling) | Ganache 传递依赖存在 33 项安全告警，不应进入在线签名、RPC 或生产服务 |

## 4. 详细发现

### F-01 — 50/20/10/20 规则没有链上强制

修复状态：**已修复。** `_allocate` 按累计收入写入 burn/liquidity/reward/operating 四个账本；`SwapPlan` 强制绑定用途；销毁回购验证余额和总供应下降；奖励只能进入固定合约；销毁、流动性和奖励账本没有国库提款路径。新增平台回归测试已通过。

审查基线中的 `OursPlatformTreasury` 只固定 `STRATEGY_BPS = 8000`。这 80% 全部进入一个通用 `strategyBalance`；没有 50% burn 子账本、20% 股票 LP 子账本或 10% 空投/贡献奖励子账本。买回的平台 Token 只进入 `retainedPlatformTokens`，没有销毁。owner 还可排队后调用 `withdraw`，把普通策略余额或 retained 平台 Token 发往固定国库地址。原测试也明确证明 retained Token 可被延时提走；这些路径已在本次修复中移除。

基线影响：网站或融资材料若声称上述比例“持续执行、不会更改”，旧合约无法支撑该承诺。治理原本可将全部 80% 用于单一策略，或延时后全部提出；修复版已关闭这些路径。

修复：在入账时直接累计四个不可混用的负债桶（总费用 50/20/10/20）；50% 只能经受限回购买入平台 Token 后真实 burn，并核对余额与总供应；20% 只能进入已批准股票池的 LP；10% 只能进入独立贡献奖励分配器；20% 才能进入国库。删除策略桶和 burn/奖励桶的通用提款路径。若确需紧急恢复，使用更长 timelock、公开事件和限定目的地，而不是任意策略提款。

### F-02 — 原生币 V4 结算可被 synced-currency 状态拒绝服务

修复状态：**已修复。** `OursV4Adapter` 在原生币和 ERC20 两个分支前统一调用 `manager.sync(assetIn)`；原 PoC 改为回归测试后已成功完成回购。

审查基线的 `OursV4Adapter.unlockCallback` 在 ERC20 输入时先 `manager.sync(assetIn)`，但原生币输入直接 `settle{value: owed}()`。真实 Uniswap V4 明确要求原生币结算也先 `sync`，以清除可能由 Hook 留下的 synced currency；否则 `settle` 会把当前 synced ERC20 作为结算币并因携带原生币而回滚。

新增 `PoisonedSyncV4Manager` 安全用例模拟 Hook 在 swap 中调用 `sync(ERC20)`：旧版会回滚；修复版会先清除状态并成功完成兑换，预算与 nonce 正确更新。

修复：结算两个分支之前统一执行 `manager.sync(assetIn)`，包括 `assetIn == address(0)`；然后在 Robinhood Chain 的真实 PoolManager + 实际 Hook 上做双方向 fork 测试。

### F-03 — 完整发行协议缺失

仓库只有收益池、适配器、抽象 `OursFeeAccrual` 和 mock。没有生产版 LaunchFactory、BondingCurve、Token、Hook、毕业状态机和迁池逻辑。因此无法验证：曲线定价、末笔部分成交、费用是否从储备正确扣除、毕业是否误搬费用、是否重复收费、CREATE2 身份、LP 锁定、失败重试与恢复。

修复：固定一套内部一致且可编译的 PONS 源码 commit，完成 Factory/Curve/Hook 接入后，再做单元、fuzz、invariant 和 Robinhood Chain fork；当前仓库不能作为完整发射平台合约交付。

### F-04 — 价格与治理权限边界过强

所有兑换只验证签名中的 `minAmountOut` 和 V4 `sqrtPriceLimitX96`，没有 TWAP/oracle/初始价格偏差上限。Registry 与 Platform Treasury 的 owner 都能即时更换 signer、operator、资产和 adapter/pool；平台 owner 本身又是 executor。平台 owner 失陷时，可批准低价值“股票 Token”及池、自己签极低保护价格，并即时用策略资金兑换，无需等待提款 timelock。

修复：资产/adapter/pool/signer 变更全部 timelock；operator 与 signer 使用不同多签；链上校验 TWAP/oracle 或相对可信报价的最大偏差；新资产设置冷却期与累计/每日限额；紧急暂停人与执行人分离。

### F-05 — 分红周期可被执行时机改变

交易时只保存 project / asset / policyVersion，不保存奖励周期。`DividendPool._addInventory` 在费用被分配或奖励资产被买入时，以当时 `block.timestamp` 决定 `rewardByPeriod`。controller/operator 可延迟 sweep、distribute 或 acquireReward，将本应属于旧周期的费用移动到新周期，从而改变使用哪个持仓快照分红。

修复：在交易费用产生时记录不可变 accrual period；后续 sweep、normalize、distribute、acquire 全程携带并校验原周期。若业务明确按到账周期分配，应在规则文档中明确，并避免称为“该交易周期贡献”。

### F-06 — 分红审核者是单点公平性信任

`recordSnapshot` 只验证块在过去、近期 blockhash 匹配，不验证该块是否为该 period 的期末块。超过 256 块后连链上 blockhash 也无法核验。reviewer 还能在尚未发布 root 时单方 `rollEmptyEpoch`，无需链上证明无人合格。

修复：保存每周期确定的截止区块/时间映射；使用独立索引器复算、多人多签和公开 challenge window；manifest 包含完整地址集合承诺、排除地址及数据源；空期也经过相同延时和可挑战流程。

### F-07 — 真实链与真实资产边界未验证

Mock Manager 不能证明真实 `BalanceDelta`、Hook flags/hookData、PoolManager 地址、Stock Token 转账限制、原生币、费用归集和 EVM opcode 均兼容 Robinhood Chain。当前编译目标还是 Paris，测试链为 Ganache Shanghai。

修复：取得 Robinhood Chain 官方 RPC、Chain ID 4663 的正式 PoolManager/Stock Token Registry 地址和字节码，固定区块执行 fork 测试；对每个股票 Token 验证 freeze/allowlist/transfer 规则；核验目标链 EVM 版本后再确定编译 target。

### F-08 — 部署流程有人工断点

`deploy-platform.mjs` 只部署和配置 Treasury，不会自动把 Registry 的新 `platformRecipient` 切到 Treasury；Registry 的历史 policy 又冻结旧收款人。两个部署脚本还把治理接管留在 `acceptOwnership` 待办状态。

修复：部署清单中增加可机器校验的 post-deploy assertions：owner/pendingOwner、Registry platformRecipient、下一策略版本生效时间、FeePool claimable 收款人、所有白名单和 codehash；未全部通过则部署状态不得标为 ready。

### F-09 — 测试工具链依赖告警

33 项告警均来自 Ganache 或传递依赖，当前仅影响本地隔离测试，但其中含密码学与构建工具告警。

修复：迁移到维护中的本地 EVM/fork 工具（例如 Foundry Anvil 或已修复版本），锁定依赖并在 CI 中执行 `npm audit`/SBOM；测试私钥永不复用到生产。

## 5. 正向控制

当前代码中未复现普通外部攻击者直接盗取现有模块资金。以下控制实现较好：按项目/版本隔离、实际余额差记账、精确授权后归零、nonReentrant、EIP-712 域与 signer epoch、nonce 重放保护、历史策略冻结、买回后验证真实 burn、Merkle claim 绑定领取人、无持有人遍历、三类池不可逆身份绑定，以及 LP 退出动作 hash 与延时。

这些正向项不能抵消 F-03/F-04 的上线阻断，也不能替代真实 PONS/V4 fork 与独立第三方审计。

## 6. 上线门槛

1. F-01、F-02 已修复；下一步处理 F-04，并先确认 F-05 应按交易周期还是到账周期定义。
2. 补齐并固定完整 Factory/Curve/Hook/Token/毕业代码，进行全协议审计。
3. 在 Robinhood Chain 固定区块做真实 V4/Hook/股票 Token fork 集成测试。
4. 使用治理多签、独立 signer/reviewer、timelock 和监控；发布所有角色与可变参数。
5. 完成测试覆盖率、fuzz/invariant、静态分析、部署配置复核和小额公开链演练。
6. 修复后重新审计；本报告仅对应上述 commit，后续变更不自动继承结论。
