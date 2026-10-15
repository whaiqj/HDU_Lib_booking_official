# 六楼 202 独立 +3 秒首发实验

状态：2026-10-12 已安装并启用一次性定时任务；预检通过，实际预约尚未执行。

## 已确认的实验参数

| 项目 | 值 |
|---|---|
| 测试账号 | 用户指定的独立测试账号，未加入正式账号/任务表 |
| 准备开始 | 2026-10-13 19:57:00，北京时间 |
| 唯一预约请求的目标发起时刻 | 2026-10-13 20:00:03，北京时间 |
| 预约日期与时段 | 2026-10-15 08:00–22:00，50400 秒 |
| 目标 | 六楼（房间 1559）202，预检解析 seatId=63098 |
| 预约请求次数 | 1，无自动重试、无迟到补发 |
| 预约请求总超时 | 15 秒；超时表示结果未知 |
| 成功后的处理 | 真实预约保留，不自动取消 |

用户明确接受同服务器公网 IP 的实验限制：如果存在 IP 级限流，测试可能影响正式任务。独立容器只隔离应用逻辑，不能隔离公网出口。

## 实现和保护

脚本为 [offset3-once.cjs](../scripts/offset3-once.cjs)，单独运行 Node，复用现有镜像中的 CAS 登录工具。它不启动 NestJS、不连接 MySQL/Redis、不加载项目 `.env`，也不注册正式账号和抢座任务。

准备阶段登录测试账号，并最多查询三次座位数据，精确解析房间 1559 的 202 和本账号预约人内部 ID。映射缺失、歧义、认证失败会中止。已完成一次 `--preflight`：登录成功，首轮查询耗时约 887ms，映射确认，无预约提交。

准备后等待目标时刻，若迟到超过 150ms 则中止。发起预约前通过独占创建 `.sent` 标记避免重复提交；重启服务或重复调用脚本不能产生第二个请求。脚本、容器和 systemd 均不配置自动重试。timer 指定唯一日期且 `Persistent=false`，不会在错过日期后补跑。

测试凭证仅保存在服务器 `/root/library-seat-experiments/offset3-2026-10-13/credentials.json`（600，父目录 700），通过标准输入进入独立容器，执行结束后由 runner 删除。项目源码、文档、命令行参数、结果日志均不包含真实密码、Cookie、ticket 或 Api-Token。CAS 工具的敏感日志被抑制，未知响应只保留摘要哈希。

## 远程部署记录

- timer：`library-seat-offset3-20261013.timer`。
- service：`library-seat-offset3-20261013.service`。
- 目录：`/root/library-seat-experiments/offset3-2026-10-13/`。
- 结果：`result.jsonl`；预检：`preflight.jsonl`。
- 提交标记：`state/2026-10-13-202.sent`。
- 容器镜像固定为当前运行镜像 ID；只使用其 Node/CAS 工具，不启动应用入口。
- 脚本本地和远程 SHA256 一致：`30404bef04e8f121201a91f2fb97bf9425b1b9bfde153eb33c5b4cdf8a4590f2`。
- 已确认服务器 `Timezone=Asia/Shanghai`、`NTPSynchronized=yes`。
- 已确认 timer 为 `active`，下次运行 `2026-10-13 19:57:00 CST`；service 尚未启动；测试账号没有待执行/运行中的正式任务。

## 结果读取

在服务器执行：

```sh
systemctl show library-seat-offset3-20261013.timer -p ActiveState -p NextElapseUSecRealtime -p LastTriggerUSec
systemctl show library-seat-offset3-20261013.service -p Result -p ExecMainStatus
cat /root/library-seat-experiments/offset3-2026-10-13/result.jsonl
```

关键事件：`experiment_start`、`authentication_ready`、`mapping_check`、`preparation_ready`、`booking_invoked`、`request_written`、`booking_result`、`experiment_finished`。准备失败/迟到/重复提交会产生 `experiment_aborted`，不能把它解释成“+3 秒被图书馆拒绝”。

`booking_invoked` 记录本地调用时刻和相对 20:00 偏移；`request_written` 记录 Node 写完请求的时刻；响应记录 HTTP 状态、应用码、类别、DNS/TCP/TLS/首响应和总耗时、连接是否复用。客户端写出时间不是服务端收到或处理时间；HTTP Date 不能作为毫秒级开闸时钟。

## 结果解释

| 结果 | 能说明什么 | 不能据此下的结论 |
|---|---|---|
| `success` | 该账号对该座位的 +3 秒请求成功，形成真实预约 | 不能证明准确 +3 秒开闸，也不能证明 +3 秒优于 +5 秒 |
| `window_not_open` | 服务端处理该请求时返回明确未开放文案 | 不能证明所有座位/日期都在相同时刻开放 |
| `seat_unavailable` | 该座位被拒，可能占用/锁定/不可用 | 不能区分竞争失败与具体开闸时刻 |
| `rate_limit` | 本次请求命中频控 | 不能确定频控仅按账号或按 IP |
| `already_booked` | 账号存在预约相关冲突 | 不能把它当作本次目标座位预约成功 |
| `outcome_unknown` | 请求超时或网络异常，是否受理未知 | 不能直接视为确定失败；需要之后核对实际预约 |
| `experiment_aborted` | 实验未按计划完成；具体原因在 reason 字段 | 不能计入首发偏移成败样本 |

这是一个探索性单次实验。账号、座位、连接复用和客户端实现与正式任务不同；它提供一条较早请求的证据，不能构成严格的 A/B 成功率结论。

## 提前停止实验

在准备开始前，在服务器执行：

```sh
systemctl disable --now library-seat-offset3-20261013.timer
```

如果准备进程已启动，还需：

```sh
systemctl stop library-seat-offset3-20261013.service
```

停止进程不能撤销服务端已接受的预约。重复启动服务也不会绕过已产生的提交标记。

## 已执行的检查

`node --test scripts/offset3-once.test.cjs`：7 项通过，覆盖日期/时区/时段/偏移约束、跨房间重号、映射歧义、表单编码、签名顺序和响应分类。另完成本地/远程语法检查、systemd 单元与日期解析检查、镜像模块加载检查及远程无预约预检。

核心方案和调查证据见 [调查指导](../调查结果与抢座优化指导-2026-10-12.md)。本实验不修改核心任务逻辑；用户后续另行授权的核心提速版本已于 10-12 23:35 部署，详见 [部署记录](deployment-2026-10-12-no-confirm.md)。部署后已再次确认本实验 timer 仍启用，日期和参数未变。
