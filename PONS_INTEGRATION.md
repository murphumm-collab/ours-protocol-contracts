# PONS V2 接入约定

本目录实现新的收益合约，**不包含已完成接入的 PONS Factory/Curve/Hook fork**。以下是必须落到选定、完整一致 PONS 版本中的代码接入点。`OursFeeAccrual` 本身已实现并通过协议替身测试，但不能代替修改真实 source 的储备数学。

## 前置条件

- 选择完整、可编译版本并固定 commit、依赖与编译设置。已参考的 `162310fbd1217717e2f5e4cde794d6a11322b469` 中 Factory/Deployer 的 salt 字段、Curve 的 snipe exemption 接口不一致，不应直接拿这个树部署。
- 自有工厂预先部署，Registry 构造指定该 factory，池构造固定 Registry，治理一次性 bindPools。Factory 的 Registry 绑定只允许初始化一次且只有部署管理者可做，对外开放发行前封闭初始化权限。
- 项目 quote、token、Curve 为认证地址，Chain ID 不是前端字符串决定。

## Factory

1. 沿用发行 token、curve 并 initialize 的现有步骤。
2. 在任何首购之前调用 `registry.registerProject(token,curve,originalDeployer,initialPolicy)`。Registry 会检查 curve.token()/factory()/pairToken()；因此这些 getter 必须可用。
3. 完成真实 V4 建池、锁仓、Hook 注册之后调用 `bindGraduatedPool(token, keccak256(abi.encode(poolKey)), hook)`。必须在同一成功事务中完成，避免尚未可交易就标为已毕业。
4. 维持原生/ERC-20、LP 锁定、partial-fill、毕业预检等原有保护。
5. 新发行 disable 原来的 creatorTax（本版建议）和 PONS 内置 buyback-and-lock 路径，防止与新 FeePool 重复扣费/支付。

## Curve 费用与储备（必须联合修改）

继承 `OursFeeAccrual`，构造传 Registry；与原有 ReentrancyGuard 使用相同 OZ 实现。

- 实际买卖收取基础费时调用 `_accrueRevenue(token, pairToken, fee)`；此时绑定 currentVersion。
- 用 `reservedRevenue[pairToken]` 替换原来混合的 quoteFeeBalance/creatorTaxBalance 归集概念，但必须对应调整全部 getReserves、realQuoteReserve、buy、sell 和毕业计算。
- 例如余额模型为 trackedQuote 包含未分配费用，则有效真实储备 = trackedQuote − reservedRevenue[quote]；不得既扣旧余额又扣新余额。
- 覆盖 `_beforeRevenueSweep(asset,amount)`，从 trackedQuote 扣减真正将离开 Curve 的费用；共享 Hook 如不使用同一 trackedQuote 模型可 no-op。
- **毕业不得将 reservedRevenue 当本金迁走**。只转移可交易储备，旧期费留在 Curve，允许毕业后按版本 sweepRevenue。
- 旧 sweepFees/_sweepFees 不能继续同时向原 Escrow/BuybackVault 付款；关闭原路径或改成显式转接新版本接口。
- 不在 graduate 中遍历所有策略版本；历史费用可后续分批结算。

## V4 Hook

- Hook 的认证 PoolKey/PoolId 查得项目 token；原始 feeCurrency 可能为 Meme 或 quote，两者分别记账。
- `_afterSwap` 收取真实费用后调用 `_accrueRevenue(project,feeCurrency,feeAmount)`。
- 去掉原本直接协议/创建者支付与项目回购分支。sweepRevenue 只把已收到的真实资产搬到 FeePool，不做兑换；归一化走 FeePool.normalizeFees 的受限计划。
- Hook 多项目共享时，不要把一个币种 aggregate reservedRevenue 当某个项目余额；项目/版本明细用 accruedRevenue。
- 内部回购/归一化的手续费豁免若启用，必须只允许认证 adapter 且输出返回绑定 pool，不能凭任意 hookData 声称免税。当前两个 adapter 不传任意 hookData。
- 正常用户 swap 不依赖平台 keeper 是否在线，费用可累计而不自动触发回购或分红。

## 兑换适配器

- Curve adapter 使用 `buy(uint256,uint256,address)` 和 `sell(uint256,uint256,address)`，必须核验目标 ABI、返回/退款规则。
- V4 adapter 使用 PoolManager 单跳 exact-input + unlockCallback，校验 canonical project pool。股票奖励可以用单独 reward pool 白名单。
- 对目标 manager 实际部署验证函数签名、BalanceDelta packing、hook 行为、原生资产、费用、价格边界；本地 MockV4Manager 只证明适配器控制流，不能替代真实 core fork。
- 若没有直接的 quote→reward 流动性，本版拒绝交易，不能自动退化到任意聚合器。多跳应新增明确的 typed adapter。

## 真实接入验收

- 首笔买入、普通买卖、末笔部分成交和退款。
- 策略变更前后费用分桶，原生和多种 decimals 资产一致。
- 费用未结清仍能毕业，留存费用毕业后能支付且不影响 LP。
- 两阶段毕业失败恢复，无重复建池与挪用其他发行储备。
- V4 两个 swap 方向、手续费币种、内部归一化/回购及价格保护。
- 平台与创建者都能执行受保护批次，未经授权者不能触发或改变参数。
- 分红仅 claim，不空投；持有人证明与审计清单完整对应。
