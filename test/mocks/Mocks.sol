// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OursProjectRegistry} from "../../src/OursProjectRegistry.sol";
import {OursFeeAccrual} from "../../src/integration/OursFeeAccrual.sol";
import {OursRevenueTypes as T, IOursSwapAdapter} from "../../src/interfaces/IOursRevenue.sol";
import {IV4Manager} from "../../src/adapters/OursV4Adapter.sol";

contract MockToken is ERC20, ERC20Burnable {
    bool public taxed; mapping(address=>bool) public blocked;
    constructor() ERC20("Mock","M") {}
    function mint(address to,uint256 n) external {_mint(to,n);}
    function setTaxed(bool v) external {taxed=v;}
    function setBlocked(address a,bool v) external {blocked[a]=v;}
    function _update(address from,address to,uint256 n) internal virtual override {
        require(!blocked[from]&&!blocked[to],"blocked");
        if(taxed&&from!=address(0)&&to!=address(0)&&n>0){super._update(from,address(0),1);super._update(from,to,n-1);}
        else super._update(from,to,n);
    }
}
contract MockFactory {
    function register(OursProjectRegistry r,address token,address curve,address controller,T.Policy calldata p) external {
        r.registerProject(token,curve,controller,p);
    }
    function bind(OursProjectRegistry r,address token,bytes32 id,address hook) external {r.bindGraduatedPool(token,id,hook);}
}
contract MockCurve is OursFeeAccrual {
    address public immutable token; address public immutable pairToken; address public immutable factory;
    bool public graduated; bool public readyToGraduate; uint256 public fillBps=10000;
    constructor(OursProjectRegistry r,address t,address q,address f) OursFeeAccrual(r){token=t;pairToken=q;factory=f;}
    receive() external payable {}
    function setState(bool g,bool ready) external {graduated=g;readyToGraduate=ready;}
    function setFill(uint256 bps) external {fillBps=bps;}
    function collect(address project,address asset,uint256 n) external payable {
        if(asset==address(0))require(msg.value==n);else require(IERC20(asset).transferFrom(msg.sender,address(this),n));
        _accrueRevenue(project,asset,n);
    }
    function _beforeRevenueSweep(address,uint256) internal override {}
    function buy(uint256 amount,uint256 minOut,address to) external payable returns(uint256 out){
        require(!graduated&&!readyToGraduate);
        if(pairToken==address(0))require(msg.value==amount);else {require(msg.value==0);IERC20(pairToken).transferFrom(msg.sender,address(this),amount);}
        uint256 spent=amount*fillBps/10000;out=spent*2;require(out*amount>=minOut*spent);
        MockToken(token).mint(to,out);_send(pairToken,msg.sender,amount-spent);
    }
    function sell(uint256 amount,uint256 minOut,address to) external returns(uint256 out){
        require(!graduated&&!readyToGraduate);IERC20(token).transferFrom(msg.sender,address(this),amount);
        out=amount/2;require(out>=minOut);_send(pairToken,to,out);
    }
    function _send(address asset,address to,uint256 n) private {if(n==0)return;if(asset==address(0)){(bool ok,)=to.call{value:n}("");require(ok);}else IERC20(asset).transfer(to,n);}
}
contract MockAdapter is IOursSwapAdapter {
    receive() external payable {}
    function execute(address,address a,address b,uint256 max,uint256,bytes calldata route) external payable returns(T.ExecutionResult memory){
        (uint256 spent,uint256 out)=abi.decode(route,(uint256,uint256));
        if(a==address(0)){require(msg.value==max);if(max>spent){(bool ok,)=msg.sender.call{value:max-spent}("");require(ok);}}
        else {require(msg.value==0);IERC20(a).transferFrom(msg.sender,address(this),spent);}
        if(b==address(0)){(bool ok,)=msg.sender.call{value:out}("");require(ok);}else MockToken(b).mint(msg.sender,out);
        // Deliberately lie; pools must ignore these amounts.
        return T.ExecutionResult(0,0);
    }
}
interface IUnlock {function unlockCallback(bytes calldata) external returns(bytes memory);}
contract MockV4Manager is IV4Manager {
    bool private unlocked; address private synced; uint256 private beforeBal;
    uint256 public fillBps=10000;
    receive() external payable {}
    function setFill(uint256 bps) external {fillBps=bps;}
    function unlock(bytes calldata d) external returns(bytes memory r){require(!unlocked);unlocked=true;r=IUnlock(msg.sender).unlockCallback(d);unlocked=false;}
    function swap(PoolKey calldata,SwapParams calldata p,bytes calldata) external view returns(int256 packed){
        require(unlocked&&p.amountSpecified<0);
        int128 spent=int128(int256(uint256(-p.amountSpecified)*fillBps/10000));int128 out=spent*2;
        int128 a=p.zeroForOne?-spent:out;int128 b=p.zeroForOne?out:-spent;
        packed=(int256(a)<<128)|int256(uint256(uint128(b)));
    }
    function sync(address a) external {synced=a;beforeBal=IERC20(a).balanceOf(address(this));}
    function settle() external payable returns(uint256 n){if(msg.value>0)return msg.value;n=IERC20(synced).balanceOf(address(this))-beforeBal;synced=address(0);}
    function take(address a,address to,uint256 n) external {require(unlocked);if(a==address(0)){(bool ok,)=to.call{value:n}("");require(ok);}else MockToken(a).mint(to,n);}
}
contract Mock1271 {
    bytes32 public accepted;
    function set(bytes32 h) external {accepted=h;}
    function isValidSignature(bytes32 h,bytes calldata) external view returns(bytes4){return h==accepted?bytes4(0x1626ba7e):bytes4(0xffffffff);}
}
interface IIncomePool {function claimIncome(address asset) external returns(uint256);}
contract ReenteringRecipient {
    IIncomePool public pool; bool public nestedSucceeded; uint256 public calls;
    constructor(IIncomePool p){pool=p;}
    function claim() external {pool.claimIncome(address(0));}
    receive() external payable {
        ++calls;
        (nestedSucceeded,)=address(pool).call(abi.encodeCall(IIncomePool.claimIncome,(address(0))));
    }
}
