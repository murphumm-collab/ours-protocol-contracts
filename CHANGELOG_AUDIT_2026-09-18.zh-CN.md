# OURS 合约审查与修复记录

日期：2026-09-18
仓库：`murphumm-collab/ours-protocol-contracts`
分支基线：`codex/contracts`
基线提交：`9b1559611de61f9703b1ace86e15aa88fb2fe3fa`
当前状态：正在 `codex/audit-fixes-2026-09-18` 分支继续扩展测试和修复。

## 一、本次目标

对收益、回购、分红、平台资金和 V4 适配合约进行完整本地测试；发现可复现问题后修改生产代码、补充回归测试，并重新运行全部测试。

## 二、生产合约修改

### 1. 平台手续费规则固定为 50/20/10/20

修改文件：`src/platform/OursPlatformTreasury.sol`

平台实际收到的每种手续费资产，按照累计收入固定记入四个独立账本：

- 50%：`burnBalance`，只能用于买入平台 Token 并真实销毁。
- 20%：`liquidityBalance`，只能用于购买平台 Token、白名单股票 Token 和建立 V4 流动性。
- 10%：`rewardBalance`，只能购买平台 Token，并发送给构造时固定的 `rewardDistributor` 合约。
- 20%：`operatingBalance`，只能发送给构造时固定的 `treasuryRecipient`。

小额整数舍入先保证累计策略资金等于总收入的 80%，不可整除的最小单位归入销毁账本。

### 2. 删除通用策略提款路径

移除内容：

- `retainedPlatformTokens`
- `reservePlatformTokens`
- `withdrawalAction`
- 策略资金和回购 Token 的 `withdraw` 路径

销毁、流动性和奖励资金不能再由治理提到国库。LP 退出后，资产只返回流动性账本。

### 3. 兑换计划绑定资金用途

`SwapPlan` 删除 `retainOutput`，增加 `purpose`：

- `0`：`BurnBuyback`
- `1`：`LiquidityAcquire`
- `2`：`RewardAcquire`

EIP-712 `SWAP_TYPEHASH` 已同步变化。签名服务、SDK 和前端在接入新版本时必须使用新的 typed data，旧签名不兼容。

### 4. 回购后真实销毁

销毁回购完成后，合约同时核验：

- 平台 Treasury 的平台 Token 余额减少量；
- 平台 Token `totalSupply` 减少量。

任一不匹配，整笔交易回滚。若手续费资产本身就是平台 Token，可通过 `burnPlatformTokens` 直接从销毁账本销毁，无需兑换。

### 5. 奖励接收方固定

构造函数新增不可变参数 `rewardDistributor`，并要求该地址已有合约代码。

只有该合约自身能调用 `releaseRewards`，且只能领取 `rewardBalance[platformToken]` 中已经买入的平台 Token。治理、操作员和普通钱包不能改变奖励接收方。

### 6. 修复 V4 原生币结算问题

修改文件：`src/adapters/OursV4Adapter.sol`

旧逻辑只在 ERC20 输入时调用 `manager.sync(assetIn)`。如果 Hook 在 swap 过程中留下其他 ERC20 synced currency，原生币 `settle{value: ...}` 会回滚。

修复后，原生币和 ERC20 两个分支均先执行 `manager.sync(assetIn)`，再进行 transfer/settle。

## 三、部署脚本修改

修改文件：`scripts/deploy-platform.mjs`

- 部署配置新增必填项 `rewardDistributor`。
- 部署前检查 `rewardDistributor` 已有合约代码。
- 构造参数同步增加奖励分配合约地址。
- 部署结果 JSON 增加 `rewardDistributor` 字段。

注意：这是构造函数 ABI 变化，旧平台 Treasury 部署配置不能直接复用。

## 四、测试修改

### 新增

- `test/audit-findings.test.mjs`
  - 验证 Hook 遗留 ERC20 synced currency 后，原生币 V4 结算仍可成功。
- `test/mocks/AuditMocks.sol`
  - 提供可复现 synced-currency 状态的 V4 Manager 测试替身。
- `MockRewardDistributor`
  - 验证奖励只能由固定分配合约领取。

### 更新的平台测试

`test/platform-cases.mjs` 当前覆盖：

- FeePool 平台收入按 50/20/10/20 入账；
- 多批小额入账不会改变累计分配；
- 四个用途账本相互隔离；
- 回购买入后真实销毁；
- 平台 Token 手续费直接销毁；
- 流动性资产购买、建仓、收手续费和延时退出；
- 策略资金没有国库提款路径；
- 奖励只能发送给固定奖励分配合约；
- 原生资产部分成交；
- 签名错误、重放、输出不足、超预算、暂停和 signer 轮换。

部署测试同步验证四个固定比例常量和 `rewardDistributor`。

## 五、最终测试结果

执行命令：

```sh
npm ci --ignore-scripts
npm run check
```

结果：

- Solidity 编译通过；
- 60 项 Node 业务、安全、随机状态和回归测试通过；
- 1 项部署 CLI 测试通过；
- 0 失败；
- 0 跳过；
- `git diff --check` 通过；
- `OursPlatformTreasury` 运行时代码 20,099 bytes，低于 EIP-170 的 24,576 bytes 上限。

Ganache 在当前 Node/macOS 环境回退到纯 JS 实现，属于性能提示，不影响断言结果。

## 六、修改文件清单

### 生产代码与脚本

- `src/platform/OursPlatformTreasury.sol`
- `src/adapters/OursV4Adapter.sol`
- `scripts/deploy-platform.mjs`

### 测试

- `test/platform-cases.mjs`
- `test/deploy-smoke.mjs`
- `test/audit-findings.test.mjs`
- `test/mocks/Mocks.sol`
- `test/mocks/AuditMocks.sol`

### 文档

- `README.md`
- `PLATFORM_TREASURY.zh-CN.md`
- `VALIDATION.md`
- `AUDIT_REPORT.zh-CN.md`
- `CHANGELOG_AUDIT_2026-09-18.zh-CN.md`

## 七、尚未完成和不能冒充完成的部分

当前仓库没有生产版 PONS Factory、BondingCurve、Token、Hook 和毕业迁池实现，因此尚未完成：

- 真实曲线数学和末笔部分成交测试；
- 费用储备与毕业本金隔离测试；
- 毕业失败、重试、恢复和重复迁池测试；
- 真实 Hook 收费及内部交易免重复收费测试；
- Robinhood Chain 正式 PoolManager fork 测试；
- 真实股票 Token 的冻结、准入和转账限制测试；
- 奖励分配合约本身的积分/Merkle 规则测试；
- 公开链部署、源码验证和链上角色配置核对。

这些内容需要补充生产源码、正式地址、RPC 和部署配置后继续测试。

## 八、GitHub 状态

截至本记录生成时：

- 未创建 commit；
- 未 push；
- 未覆盖远端 `codex/contracts`；
- 建议先提交到新的审查修复分支，再发起 PR 合并。
