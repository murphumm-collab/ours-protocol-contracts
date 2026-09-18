# 固定尾号独立部署器

新增 src/launch/OursTokenDeployer.sol 与 scripts/mine-token-suffix.mjs。当前仓库没有生产发行工厂，尚未完成正式接入，不能声称已降低现有生产工厂体积。

部署器构造参数为：已经部署的工厂地址、Token 创建字节码、尾号位数（1–8）、尾号数值。正式尾号尚待确认，测试值不作为默认生产规则。创建字节码保存一次，不可替换；仅绑定工厂可部署。没有更换工厂、提款或绕过尾号入口。

## 工厂接入步骤

1. 先部署工厂，保持发行关闭；在外部部署脚本中部署 TokenDeployer。
2. 工厂由部署管理者一次性绑定部署器，核验 factory、creationCodeHash 和尾号参数，禁止公众初始化或重复绑定。
3. 工厂删除内嵌 new Token，改为 deployer.deploy(creator, launchHash, nonce, abi.encode(正式构造参数))。不要在工厂运行时代码中 new TokenDeployer，避免把部署代码重新嵌回工厂。
4. 工厂自行核验创建者身份和完整参数；代发时验证创建者签名、nonce 和 deadline。launchHash 应由工厂计算并包括收款人、费用策略和曲线参数，不能只相信前端。
5. 部署 Token、初始化曲线、登记收益策略及可选首购必须在同一笔交易完成，失败全部回滚。部署器不接收 ETH、不向构造函数转 ETH，初始买入由工厂另行执行。
6. 检查 Token 构造中的 msg.sender：现在它是部署器，不能意外把所有权或供应分配给部署器；需明确传入工厂/曲线/接收人。
7. 若 Token 与 Curve 的构造地址相互依赖，须先确定地址预测或原子初始化方式，再接入。当前 harness 不代表正式 Token 构造接口。

Token 创建字节码存储在部署器 storage，不占用发行工厂的运行时代码。代价是初次存储和每次读取的 Gas；实际金额需正式字节码实测。部署器本轮编译运行时代码为 1,916 bytes，原 Treasury 仍为 20,285 bytes。生产工厂拆分前后体积尚不能测量。

## 搜索与身份

salt 绑定 chainId、factory、creator、launchHash 和 nonce。CREATE2 地址还绑定部署器地址及包含构造参数的 initCodeHash；修改任意相关输入应重新搜索。

读取部署器参数，并用 initCodeHash(构造参数) 获得实际哈希。配置 JSON 字段：chainId、factory、deployer、creator、launchHash、initCodeHash、suffixDigits、suffix、start、attempts。运行 node scripts/mine-token-suffix.mjs config.json；工具返回 nonce、salt、address。搜索耗尽可调整 start 继续。提交前再次调用 predict 验证。

尾号匹配只用于识别，不证明官方身份；还必须查询正式工厂登记。盐绑定不能替代工厂的调用身份验证。

## 验证与边界

npm run compile 后执行 node --test test/token-deployer.test.mjs。覆盖预测一致性、权限、错误尾号、重复部署、参数绑定、登记失败回滚/重试、非法配置、构造失败、空运行时代码和 EIP-170 上限。

拿到正式发行工厂和 Token 源码后，仍需测量工厂 runtime/initcode、Token initcode、发行 Gas，并验证权限/供应归属、Curve 地址依赖和完整发行流程。当前没有部署公开链，也没有修改现有收益合约。

本轮结果：编译通过；10 个具体场景通过，Node TAP 另计父测试，共显示 11 pass / 0 fail。日志位于 reports/token-deployer-tests-2026-09-18.log。本轮未重新运行此前 105 项全套收益测试，新增代码未改动原收益模块。
