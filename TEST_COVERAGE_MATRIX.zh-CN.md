# OURS 合约测试覆盖矩阵

本文件保留合并前审查分支的覆盖说明；合并后的实际计数、尾差回归及官方 V4 测试见 [MERGE_VALIDATION.zh-CN.md](MERGE_VALIDATION.zh-CN.md)。

日期：2026-09-18

## 结论

本地完整回归为 75 项 Node 测试和 1 项部署 CLI 测试，0 失败、0 跳过。测试使用临时 Ganache EVM 和专用异常模拟合约，不会攻击外部系统。

## 功能与上线后场景

| 模块 | 已验证行为 | 异常/上线后场景 |
|---|---|---|
| Registry | 项目注册、池绑定、策略延时、controller/owner 两步交接、operator/reviewer/signer/adapter/asset 管理 | 替换待接受 controller、旧 owner/reviewer/signer 失效、重复或互换绑定、跨项目越权、暂停与毕业状态 |
| FeePool | Curve/Hook 收入归一化、30/70 分配、收益领取、历史策略 | 批次舍入、受限接收方恢复、重入、非授权注入、直接捐赠、毕业后历史 sweep |
| BuybackPool | 签名执行、实际到账、真实销毁、部分成交退款 | 重放、过期、篡改路由/项目/数量、超支、滑点回滚、伪造输出、空销毁、adapter/asset 撤销 |
| DividendPool | 奖励资产买入、快照、审核延时、Merkle 分发、用户领取、空期回滚 | 重复领取、错误 proof、超预算 root、reviewer 轮换、取消重发、新旧周期隔离、Token 回调重入 |
| CurveAdapter | 授权、部分成交、退款、余额差额、授权清零 | 伪报、超额扣款、残留授权抽走、税费 Token |
| V4Adapter | canonical 毕业池、奖励池白名单、callback 认证、ERC20/原生 ETH 结算、owner 交接 | Hook 遗留 synced currency、错误 pool key、非 manager callback、白名单撤销、旧 owner 失效 |
| PlatformTreasury | 50/20/10/20 累计分账、回购销毁、股票/平台 Token 购买、LP 建立/收费/退出、奖励释放、运营费领取 | 小额多批次、24 批生成式入账、四账本隔离、无策略提款、伪销毁、重入、受限 Token 恢复、LP 撤销/重排队、下架/暂停后退池、捐赠隔离 |
| 长期守恒 | 多项目、多策略版本、三个固定种子的 144 步状态机 | 每步校验余额、总负债、项目预算与已领资金守恒 |
| 规模 | 10,000 名合格持有者 Merkle 树及单用户链上领取 | 合约不遍历全体用户，proof 长度按对数增长 |
| 部署 | 收益合约与独立 Treasury 本地部署脚本 | 错误 Chain ID、必填配置、合约代码检查、待治理权限接受状态 |

## 当前无法完成的生产验证

- 生产版 PONS Factory、BondingCurve、Token、Hook 和毕业迁池源码；
- Robinhood Chain 正式 PoolManager、Hook、股票 Token Registry 地址和可用 RPC；
- 真实股票 Token 的 freeze、allowlist、transfer 限制；
- 积分/邀请/交易量/毕业统计及奖励分配合约的生产实现；
- 公开链小额演练、源码验证、多签/时锁/签名服务和监控告警。

当前结论是“已有源码的本地功能、安全回归和部署脚本全部通过”，不是“已具备公开链上线条件”。
