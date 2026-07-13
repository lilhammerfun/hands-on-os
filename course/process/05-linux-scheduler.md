# Linux 调度器

- 写作时间：`2026-03-04 首次提交，2026-07-13 最近修改`
- 当前字符：`8136`

[CPU 调度](/process/04-scheduling)已经建立了通用问题：任务何时变为可运行，调度器依据什么指标选择，以及上下文切换要保存什么状态。Linux 还要把这些规则落实到数十甚至数百个逻辑 CPU 上，并同时支持普通分时任务、固定优先级实时任务和截止期限任务。

一次实际调度需要回答两个相连的问题：当前 CPU 应从哪类任务中选择，以及某个新唤醒任务应该进入哪个 CPU 的队列。前者由调度器类和具体选择算法处理，后者还要考虑 CPU 负载、缓存共享与 NUMA 距离。

本课先用**调度框架**连接每 CPU 运行队列、调度器类、重新调度标志与上下文切换；再回顾 **CFS** 的虚拟运行时间，理解当前 **EEVDF** 怎样加入合格性与虚拟截止期限。随后用**组调度**解释任务组权重怎样进入公平计算，最后通过**多核调度**分析任务放置、亲和性、负载均衡、调度域与 NUMA。

## 调度框架

调度框架(scheduler framework)是 Linux 连接任务状态、每 CPU 运行队列、调度器类和上下文切换的一组公共机制。

Linux 为每个逻辑 CPU 维护一个 `struct rq`，简称 runqueue。一个可运行任务在任一时刻通常归属于某个 CPU 的运行队列；`rq->curr` 指向该 CPU 当前正在执行的任务，其他任务按调度器类进入相应子队列。

```c
/* kernel/sched/sched.h, selected fields */
struct rq {
    unsigned int nr_running;
    struct task_struct *curr;
    struct cfs_rq cfs;
    struct rt_rq rt;
    struct dl_rq dl;
    /* ... */
};
```

每 CPU 队列让本地选择不必争用一个全局队列锁，但它也带来新的问题：任务可能集中在少数 CPU 上，所以内核还需要跨队列负载均衡。本地选择与跨队列调整必须配合，不能只实现其中一项。

调度器类(scheduler class)为不同策略提供统一回调，例如把任务入队、出队、检查唤醒抢占和选择下一个任务。内核按类优先级从高到低寻找第一个有可运行任务的类。常见主线可以概括为：

| 调度器类 | 主要用途 |
|----------|----------|
| stop class | CPU 停机、迁移等内部高优先级工作 |
| deadline class | `SCHED_DEADLINE` |
| real-time class | `SCHED_FIFO`、`SCHED_RR` |
| fair class | 默认的 `SCHED_NORMAL`、`SCHED_BATCH` 等公平策略 |
| idle class | 没有其他任务可运行时的 idle 任务 |

调度器类的优先级先决定“从哪一类选”，类内部算法再决定“选该类中的谁”。nice 是普通任务向 fair class 提供的优先级提示，它只影响该类内部的相对权重；无论某个任务的 nice 权重多大，它都不能压过可运行的实时任务。

:::expand sched_ext
`sched_ext` 是 Linux 可由 BPF 程序定义行为的可扩展调度器类。BPF 是一种受内核验证、可以安全加载到内核执行环境中的指令格式。启用 sched_ext 后，BPF 调度器可以实现自己的 CPU 选择和分派队列策略；程序退出、停滞或触发错误时，内核会退回内置 fair class，避免调度器扩展让系统永久失去进展。

sched_ext 适合调度研究和特定数据中心策略，但理解内置 fair class 仍是主线，因为未加载 BPF 调度器时普通任务继续由内置实现管理。
:::

当运行任务阻塞时，它主动调用调度路径；当运行额度到期或更应优先的任务被唤醒时，内核会给当前任务设置 `TIF_NEED_RESCHED`，表示需要在最近的可调度位置重新选择。可调度位置包括返回用户态前和允许内核抢占的位置，并不局限于某一种中断返回路径。

核心流程位于 `__schedule()`。内核先取得 `rq->curr` 指向的当前任务；若它已经不再可运行，就把它从相应队列移出。随后 `pick_next_task()` 按调度器类选择任务；若选择结果发生变化，`context_switch()` 处理地址空间与体系结构相关状态，再由底层切换代码恢复下一任务。框架只规定调用关系，fair、rt 与 deadline 子队列可以各自演化而不必复制整套上下文切换机制。

## CFS

完全公平调度器(Completely Fair Scheduler, CFS)是 Linux 从 2.6.23 开始采用的 fair class 设计，其核心是用虚拟运行时间计量普通任务已经获得的加权 CPU 服务。

CFS 假设一个理想处理器可以让 $n$ 个同权重任务同时各以 $1/n$ 的速度前进。真实 CPU 一次只能运行一个任务，因此内核用时间片近似该结果，并记录每个调度实体的虚拟运行时间(virtual runtime, vruntime)。调度实体(scheduling entity)可以代表单个任务，也可以代表一组任务。

对单个普通任务，vruntime 的基本更新关系是：

$$
\text{vruntime} \mathrel{+}= \Delta t \times
\frac{\text{NICE\_0\_LOAD}}{\text{weight}}
$$

$\Delta t$ 是实际执行时间，weight 是由 nice 值映射出的权重。nice 0 使用基准权重；权重越大，同样执行时间增加的 vruntime 越少，任务在长期内就能获得更大 CPU 份额。Linux 普通任务的 nice 范围是 -20 到 19，相邻 nice 值的权重比约为 1.25。

假设单个 CPU 上只有 A 与 B 两个持续可运行任务，A 的权重为 1024，B 的权重为 335。A 每运行 1 ms，vruntime 大约增加 1 ms；B 每运行 1 ms，vruntime 大约增加 $1024/335 \approx 3.06$ ms。为了让两者的 vruntime 以接近速度前进，A 长期获得的实际 CPU 时间约为 B 的三倍，与权重比例一致。

CFS 时代的 fair runqueue 使用红黑树(red-black tree)组织可运行实体，并维护最小 vruntime 作为公平进度基准。红黑树是保持高度有界的二叉搜索树，插入和删除为 $O(\log n)$；缓存最左节点后，取得最早实体可以避免每次遍历全部任务。

公平不等于每次运行完全相同长度。调度器要根据可运行实体数量和权重计算目标份额，同时保留最小执行粒度，避免任务很多时切换过于频繁。具体参数、缩放规则和默认值会随内核版本及配置变化，因此本课不把某个毫秒值当作 Linux 接口保证。

较早的 CFS 资料常用 `sched_latency_ns` 和 `sched_min_granularity_ns` 解释目标调度周期与最小粒度。这些内部参数不是稳定 ABI，不能据此假定所有现行内核都暴露同名接口。当前内核文档把启用 `CONFIG_SCHED_DEBUG` 时位于 debugfs 的 `/sys/kernel/debug/sched/base_slice_ns` 列为调节 fair class 批处理与响应取舍的核心粒度参数；当前任务选择还会把任务请求的执行片长度纳入虚拟截止期限。实际可见文件和算法细节仍要按内核版本与配置核对。

CFS 这个名称也常被用来泛指 Linux 的 fair class 历史设计。当前 fair class 的任务选择已经逐步转向合格性和虚拟截止期限，但 nice 权重、vruntime 计账和分层调度实体等基础仍然延续。

## EEVDF

最早合格虚拟截止期限优先(Earliest Eligible Virtual Deadline First, EEVDF)是 Linux fair class 从 6.6 开始逐步采用的选择算法，它在公平计账上增加 lag、合格性和虚拟截止期限。

EEVDF 中的“截止期限”不是现实时间中的硬实时 deadline。它是 fair class 内部排序用的虚拟值，不承诺任务会在某个墙上时钟时刻前完成；需要实时保证的任务仍应使用 deadline 或实时调度类。

理解 EEVDF 需要两个量：

**Lag** 表示调度实体按权重应得的 CPU 服务与实际已得服务之差。正 lag 表示实体仍被欠 CPU 时间，负 lag 表示它已经超出当前公平份额。

**虚拟截止期限(virtual deadline)** 由实体的虚拟开始位置、请求的执行片长度和权重共同得到。请求越短或权重越大，虚拟截止期限通常越近。

选择分两步进行：

1. 只考虑 lag 不小于 0 的合格(eligible)实体，避免已经超额使用 CPU 的实体继续抢占公平份额
2. 在合格实体中选择虚拟截止期限最早者，兼顾份额公平和短请求响应

```text
Task A: positive lag, virtual deadline 40  -> eligible
Task B: negative lag, virtual deadline 30  -> not eligible yet
Task C: positive lag, virtual deadline 35  -> selected
```

这与“始终选择最小 vruntime”相比多了一层约束。lag 回答实体当前是否还应获得服务，虚拟截止期限则在应得服务的实体之间表达延迟偏好。短执行片可以得到更近的虚拟截止期限，但长期 CPU 份额仍受权重和 lag 约束。

Linux 没有简单地把红黑树排序键从 vruntime 改成 deadline。当前实现继续维护虚拟时间相关的树结构，并用子树增强信息跳过不合格区域，再比较候选实体的虚拟截止期限。这样的实现细节很重要，因为“选择条件改变”不必意味着“底层数据结构只换一个排序字段”。

睡眠任务还带来一个公平性边界：任务离开运行队列时仍可能带有正或负 lag。当前 EEVDF 使用延迟出队(deferred dequeue)与 lag 衰减机制，避免任务通过短暂睡眠直接清除已经超用的份额，同时也让长期不活跃任务逐步回到合理起点。

## 组调度

组调度(group scheduling)是把一组任务表示成上层调度实体，先在组之间分配 CPU，再在每个组内部继续分配的分层公平机制。

如果 10 个同权重任务直接竞争一个 CPU，每个任务大约获得十分之一。假设用户 A 只有 1 个任务，用户 B 有 9 个任务，按任务公平会让 B 总计获得九成 CPU。若策略希望两个用户组先平分 CPU，就需要在任务之上增加一层组实体：

```text
Root fair runqueue
├── Group A, weight=100
│   └── A1
└── Group B, weight=100
    ├── B1
    ├── ...
    └── B9
```

当两个组都持续有可运行任务时，根层先让 A 与 B 各获得约一半 CPU；B 的一半再在 9 个任务之间分配。A1 因而约得二分之一，每个 B 任务约得十八分之一。某个组没有可运行任务时，调度器不会为它保留空闲份额，剩余组可以使用 CPU，这叫工作保持(work-conserving)。

控制组(control group, cgroup)是 Linux 按层级组织进程并控制资源的机制。cgroup v2 的 CPU 控制器通过 `cpu.weight` 给同一父 cgroup 下的活跃子组设置相对权重，范围为 1 到 10000，默认值为 100。权重只表达相对份额，不是使用上限；`cpu.max` 才用“配额/周期”限制一组任务在每个周期最多消耗的 CPU 时间，配额用尽后该组会被暂时节流(throttling)。

因此 nice 与 `cpu.weight` 作用在不同层级：nice 调整任务在所属公平队列中的权重，`cpu.weight` 调整兄弟 cgroup 之间的权重。[cgroups](/process/07-cgroup)会继续分析这些文件接口和限额语义。

## 多核调度

多核调度(multiprocessor scheduling)是同时决定可运行任务应在哪个 CPU 上排队，以及每个 CPU 下一步执行哪个任务的机制。

每 CPU 运行队列降低了本地锁竞争，却可能产生负载不均。Linux 在多个时机调整任务位置：任务唤醒时选择目标 CPU；CPU 空闲时可以从较忙队列拉取任务；周期性均衡也会把任务从忙 CPU 迁到较空 CPU。把任务从忙队列移出常称为 push，把任务拉到空闲 CPU 常称为 pull。

迁移并非越多越好。任务刚在某个 CPU 执行过时，相关指令和数据可能仍在该 CPU 私有缓存或附近共享缓存中。继续留在原 CPU 叫缓存亲和性(cache affinity)；迁移到另一个 CPU 可能增加缓存未命中，但影响大小取决于两个 CPU 是否共享末级缓存和任务访问模式。

CPU 亲和性(CPU affinity)是任务允许在哪些 CPU 上运行的掩码。调度器在允许集合内通常偏向之前运行的 CPU，这是一种放置倾向；应用还可以用 `sched_setaffinity()` 或 cpuset cgroup 缩小允许集合，形成硬约束。硬约束能够改善隔离与局部性，也可能让部分 CPU 过载而其他 CPU 空闲，负载均衡不能越过这个集合。

Linux 用调度域(scheduling domain)描述需要共同均衡的 CPU 层级。具体层级取决于平台拓扑，可能反映 SMT 线程、共享缓存、处理器封装和 NUMA 节点。较近层级迁移成本通常更低，可以更频繁地检查；跨封装或跨 NUMA 节点的迁移成本更高，调度器会更谨慎。

```text
NUMA node 0                    NUMA node 1
├── CPU 0 rq                   ├── CPU 4 rq
├── CPU 1 rq                   ├── CPU 5 rq
└── local memory               └── local memory

near balance: shared-cache CPUs
far balance:  cross-node CPUs and memory locality
```

NUMA 表示 CPU 访问本节点内存通常比远端节点内存成本低。任务跨节点迁移后，原有物理页可能仍在旧节点；把 CPU 时间分得更均匀，反而可能增加远端内存访问。Linux 的 NUMA 感知调度与自动 NUMA balancing 会根据访问采样在“迁移任务靠近内存”和“迁移页面靠近任务”之间选择，但采样有成本，结果也受亲和性、cpuset 和内存策略限制。

由此，多核公平不是简单比较各队列的任务数量。调度器还要考虑任务权重、CPU 容量、缓存共享、允许 CPU 集合和内存位置，在利用率与局部性之间持续调整。

## 小结

| 概念 | 说明 |
|------|------|
| 调度框架 | 连接每 CPU 运行队列、调度器类和上下文切换的公共机制 |
| `struct rq` | 每个逻辑 CPU 的运行队列与当前任务状态 |
| 调度器类 | 为 fair、real-time、deadline 等策略提供统一回调和优先级顺序 |
| `TIF_NEED_RESCHED` | 请求当前任务在最近可调度位置重新选择的标志 |
| CFS | 用 nice 权重与 vruntime 计量公平 CPU 服务的历史 fair class 设计 |
| `base_slice_ns` | 当前调度文档中的 fair class 基础粒度调节项，是否可见取决于内核配置 |
| EEVDF | 在公平计账上按 lag 过滤合格实体，再选择最早虚拟截止期限 |
| 组调度 | 先在任务组之间分配 CPU，再在组内分配的层级机制 |
| `cpu.weight` | 活跃兄弟 cgroup 之间的相对 CPU 权重 |
| CPU 亲和性 | 限制任务可运行 CPU 的掩码 |
| 负载均衡 | 在每 CPU 队列之间迁移任务以减少不均衡 |
| 调度域 | 按硬件拓扑组织负载均衡范围的层级结构 |
| NUMA 感知 | 联合考虑任务 CPU 位置和物理页节点的调度策略 |

Linux 调度器先用类优先级确定策略范围，再在类内计算公平或截止期限，最后把任务放到满足亲和性与拓扑约束的 CPU；理解这三层决策，才能把单核算法与多核实现连接起来。

---

**Linux 内核入口**：
- [`kernel/sched/core.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/core.c)：`__schedule()`、`try_to_wake_up()` 与上下文切换框架
- [`kernel/sched/sched.h`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/sched.h)：`struct rq` 与调度内部结构
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c)：vruntime、`pick_eevdf()`、组调度与负载均衡
- [CFS Scheduler](https://docs.kernel.org/scheduler/sched-design-CFS.html)：CFS 的理想公平模型
- [EEVDF Scheduler](https://docs.kernel.org/scheduler/sched-eevdf.html)：lag、合格性、虚拟截止期限与延迟出队
- [Scheduler Domains](https://docs.kernel.org/scheduler/sched-domains.html)：调度域与跨 CPU 负载均衡
- [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)：`cpu.weight` 与 `cpu.max`
- [sched_ext](https://docs.kernel.org/scheduler/sched-ext.html)：BPF 可扩展调度器类
