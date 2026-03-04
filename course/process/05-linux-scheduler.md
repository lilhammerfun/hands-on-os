# Linux 调度器

上一篇介绍了调度算法的理论。MLFQ 通过观察进程行为自动分类，是最接近实践的设计。但 Linux 内核的调度器不是 MLFQ 的直接实现，它走了一条不同的路。

考虑 MLFQ 的一个问题：队列的数量、每级时间片的大小、提升周期，这些参数怎么设？设错了效果就差。参数和工作负载绑定，一个服务器上效果好的参数，搬到桌面系统上可能就不行了。Linux 内核需要一个在所有场景下都表现足够好的通用调度器，不能靠手动调参数。

Linux 2.6.23（2007 年）引入的 CFS(Completely Fair Scheduler) 用一个优雅的思路解决了这个问题：不设固定的优先级队列和时间片，而是追踪每个进程实际使用了多少 CPU 时间，始终让"用得最少的"那个进程先运行。这个思路后来在 Linux 6.6（2023 年）被 EEVDF 取代，但核心理念不变。

本篇讲 Linux 普通进程调度器的演化。**CFS** 的核心机制：vruntime、红黑树、组调度。**EEVDF** 对 CFS 的改进：为什么需要替换，以及 EEVDF 怎么做得更好。最后是 **多核调度**：当系统有多个 CPU 核心时，调度器面临的额外问题——CPU 亲和性、负载均衡、NUMA 拓扑。

## CFS

CFS(Completely Fair Scheduler，完全公平调度器)是 Linux 2.6.23 到 6.5 的默认普通进程调度器，核心思想是追踪每个进程已消耗的 CPU 时间，始终调度消耗最少的进程。

CFS 的目标是**理想的公平**。假设系统有 $n$ 个进程和 1 个 CPU，理想情况是每个进程在任意时刻都精确获得 $1/n$ 的 CPU 时间。现实中 CPU 不能同时运行多个进程，只能用时间片交替近似。CFS 的做法是：用一个数值精确追踪每个进程"应得的 CPU 时间"和"实际用了多少 CPU 时间"之间的差距，始终让差距最大的进程先运行。

这个数值就是 **vruntime**(virtual runtime，虚拟运行时间)。每个进程有一个 vruntime，记录它已消耗的"加权 CPU 时间"。为什么是"加权"而不是"实际"？因为不同优先级的进程应该获得不同比例的 CPU 时间。

vruntime 的计算公式：

$$
\text{vruntime} += \Delta t \times \frac{\text{NICE\_0\_LOAD}}{\text{weight}}
$$

$\Delta t$ 是进程实际运行的物理时间。weight 是进程的权重，由 nice 值决定。`NICE_0_LOAD` 是 nice 0 的基准权重（1024）。

nice 值到权重的映射不是线性的，而是指数关系。内核用一张预计算的表：

```c
// kernel/sched/core.c (simplified)
static const int sched_prio_to_weight[40] = {
 /* -20 */     88761,     71755,     56483,     46273,     36291,
 /* -15 */     29154,     23254,     18705,     14949,     11916,
 /* -10 */      9548,      7620,      6100,      4904,      3906,
 /*  -5 */      3121,      2501,      1991,      1586,      1277,
 /*   0 */      1024,       820,       655,       526,       423,
 /*   5 */       335,       272,       215,       172,       137,
 /*  10 */       110,        87,        70,        56,        45,
 /*  15 */        36,        29,        23,        18,        15,
};
```

相邻 nice 值之间的权重比大约是 1.25:1。这意味着 nice 值差 1，CPU 时间分配比例大约差 10%。nice -20 的权重是 88761，nice 19 的权重是 15，差了近 6000 倍。

看一个具体的例子。两个进程 A（nice 0，weight=1024）和 B（nice 5，weight=335），运行在 1 个 CPU 上。

进程 A 每运行 1ms，vruntime 增加：

$$
1\text{ms} \times \frac{1024}{1024} = 1\text{ms}
$$

进程 B 每运行 1ms，vruntime 增加：

$$
1\text{ms} \times \frac{1024}{335} \approx 3.06\text{ms}
$$

B 的 vruntime 增长速度是 A 的三倍。CFS 总是选 vruntime 最小的进程运行。A 运行 3ms 后 vruntime = 3，B 运行 1ms 后 vruntime ≈ 3.06。两者的 vruntime 大致相等，交替进行。结果就是 A 获得大约 75% 的 CPU 时间（3/(3+1)），B 获得大约 25%（1/(3+1)），比例恰好等于它们的权重比 1024:335 ≈ 3:1。

:::thinking

> vruntime 的设计为什么比固定时间片更好？

MLFQ 给不同队列分配不同的固定时间片（比如 Queue 0 = 8ms，Queue 1 = 16ms）。问题是：队列数量、时间片大小都是参数，调好很难。

CFS 没有固定时间片。它有一个**调度周期**(scheduling period)的概念：所有就绪进程各运行一次的总时间。CFS 把调度周期按权重比例分配给每个进程。如果调度周期是 6ms，A（weight=1024）和 B（weight=335）：

- A 的份额 = 6ms × 1024/(1024+335) ≈ 4.52ms
- B 的份额 = 6ms × 335/(1024+335) ≈ 1.48ms

进程数量变了，份额自动调整，不需要手动配置。调度周期本身也是动态的：进程少时短一些（低延迟），进程多时长一些（减少切换开销）。默认值通过 `sched_min_granularity`（每个进程最少运行时间，防止切换太频繁）和就绪进程数计算。

vruntime 把"谁先运行"和"运行多久"统一到了一个值里。不需要多级队列、不需要时间片参数、不需要提升周期。参数少，适应性强。

:::

CFS 需要快速找到 vruntime 最小的进程。遍历所有就绪进程是 $O(n)$，进程数多了就慢了。CFS 使用**红黑树**(red-black tree)来组织就绪进程，以 vruntime 为排序键。红黑树是一种自平衡二叉搜索树，查找最小值是 $O(\log n)$，插入和删除也是 $O(\log n)$。实际上 CFS 会缓存最左节点，取最小值是 $O(1)$。

```
                     vruntime=50 (root)
                    /                \
            vruntime=30            vruntime=70
            /        \             /        \
     vruntime=20  vruntime=40  vruntime=60  vruntime=80
     ↑
   leftmost = next to run
```

红黑树中只有**就绪态**的进程。进程开始运行时从树中取出，运行结束后（时间片用完、被抢占、主动让出）更新 vruntime 再插回树中。睡眠的进程不在树中。

进程从睡眠唤醒时怎么处理 vruntime？如果一个进程睡了 10 秒，醒来时它的 vruntime 远远落后于其他进程，如果不做调整，它会在接下来的很长时间内独占 CPU 追赶 vruntime，其他进程饿死。CFS 的做法是：唤醒时把 vruntime 设为红黑树当前最小 vruntime 减去一个小量（`sysctl_sched_latency` 的一半）。这样唤醒的进程会很快被调度（vruntime 小），但不会获得不合理的长 CPU 时间。

CFS 中没有传统意义上的"固定时间片"。但仍然需要决定一个进程最多运行多久才必须让出 CPU。CFS 用两个参数控制：

- `sched_latency`（调度延迟）：目标调度周期，默认 6ms（在进程数 ≤ 8 时）。所有就绪进程在这个时间内各运行一次。
- `sched_min_granularity`（最小粒度）：每个进程每次至少运行的时间，默认 0.75ms。防止进程太多时切换过于频繁。

当就绪进程数量 $n$ × `sched_min_granularity` > `sched_latency` 时，调度周期自动扩大为 $n$ × `sched_min_granularity`。

CFS 还支持**组调度**(group scheduling)，解决一个公平性问题。假设用户 A 运行了 1 个进程，用户 B 运行了 9 个进程，共 10 个进程。没有组调度时，CFS 对 10 个进程平等分配 CPU，用户 A 获得 10%，用户 B 获得 90%。这对单个进程是公平的，但对用户不公平。

组调度在进程之上增加了一层：先在组之间公平分配 CPU，再在组内进程之间公平分配。Linux 的 cgroup CPU 控制器（前面 Cgroups 一课的 `cpu.weight`）就是通过 CFS 组调度实现的。每个 cgroup 是一个调度组，组有自己的 vruntime 和权重。调度器先选权重最高（vruntime 最小）的组，再从组内选 vruntime 最小的进程。两级调度，每级各自公平。

```
              CFS run queue
             /             \
    Group A (weight=100)   Group B (weight=100)
         |                   |    |    |   ... |
     Process A1           B1   B2   B3  ...  B9

Without groups:  A1 gets 10%, each Bi gets 10%
With groups:     A1 gets 50%, each Bi gets ~5.6%  (50%/9)
```

## EEVDF

EEVDF(Earliest Eligible Virtual Deadline First，最早合格虚拟截止期限优先)从 Linux 6.6 起取代 CFS 成为默认普通进程调度器。

CFS 用了 16 年，它有什么问题？

CFS 的核心规则是"vruntime 最小的先运行"。这在大多数情况下工作得很好，但有一个场景处理不好：**延迟敏感型进程**(latency-sensitive process)和 CPU 密集型进程共存。

考虑一个桌面系统。用户在编辑器里打字（I/O 密集，频繁短 CPU 突发），后台在编译代码（CPU 密集，长 CPU 突发）。编辑器进程经常睡眠（等键盘输入），醒来时 vruntime 落后，会被优先调度。到这里还好。

问题是：CFS 唤醒进程时给它的 vruntime 补偿是固定的（`sched_latency` 的一半）。这个补偿量不区分进程是睡了 1ms 还是睡了 1 秒。短暂睡眠的交互式进程和长时间睡眠的后台进程获得相同的补偿，对交互式进程不够公平。

CFS 为了弥补这个问题，逐渐加入了各种启发式补丁(heuristic)：唤醒抢占逻辑、睡眠者的 vruntime 补偿策略、各种可调参数。这些补丁互相作用，行为变得难以预测。同一个 `sched_wakeup_granularity` 参数在不同工作负载下需要不同的值。

EEVDF 的设计思路是：**用明确的算法替代启发式补丁。** 它保留了 CFS 的 vruntime 机制（公平性追踪），但改变了选择下一个进程的规则。

CFS 选 vruntime 最小的进程。EEVDF 为每个进程计算一个**虚拟截止期限**(virtual deadline)，选截止期限最早的**合格**(eligible)进程。

虚拟截止期限的计算：

$$
\text{deadline} = \text{vruntime} + \frac{\text{request}}{\text{weight}} \times \text{total\_weight}
$$

`request` 是进程请求的时间片长度。权重大（优先级高）的进程，除以的 weight 大，deadline 更近，更容易被选中。"合格"(eligible)的条件是进程的 vruntime 不超过整体的虚拟时间进度。一个 vruntime 远超平均值的进程（已经用了太多 CPU）即使 deadline 最早也不合格，必须等其他进程追上来。

:::thinking

> EEVDF 相比 CFS 具体好在哪？

CFS 的问题可以用一个具体场景说明。假设有两个进程：

- A：每 10ms 醒一次，每次用 1ms CPU（交互式）
- B：一直在跑，不睡眠（CPU 密集型）

在 CFS 下，A 睡了 9ms 醒来，vruntime 落后于 B。CFS 让 A 先跑（vruntime 小）。但 A 只需要 1ms，跑完又睡了。问题是，如果系统中还有 C、D、E 等大量进程，A 醒来时的 vruntime 补偿可能不够精确，A 可能需要等一段时间才能被调度。唤醒延迟不稳定。

EEVDF 下，A 的请求时间短（request 小），计算出的 deadline 很近。一旦 A 变为合格（vruntime 追上），它会因为 deadline 最早而被立即选中。EEVDF 不需要启发式的唤醒补偿，deadline 机制自然地给短请求进程更快的响应。

结果是：CFS 的唤醒延迟取决于启发式参数的调节，EEVDF 的唤醒延迟由进程自身的 request 大小决定。后者更可预测，也更公平。

:::

EEVDF 在内核实现上改动不大。红黑树的排序键从 vruntime 变成了 deadline。调度入口还是 `pick_next_task_fair()`，只是内部的选择逻辑变了。vruntime 的计算方式、权重表、组调度的层次结构都保持不变。CFS 的经验和调优知识大部分仍然适用。

从用户视角看，EEVDF 减少了需要调节的参数。CFS 时代的 `sched_wakeup_granularity` 在 EEVDF 中被删除了。EEVDF 还引入了一个新特性：进程可以通过 `sched_setattr()` 设置自己的 `sched_runtime` 来声明时间片偏好。设置短 runtime 的进程获得更快的响应但更频繁的上下文切换，设置长 runtime 的进程减少切换开销但延迟更高。这让应用程序可以在延迟和吞吐量之间做显式选择，而不是依赖内核的启发式猜测。

## 多核调度

多核调度(multiprocessor scheduling)处理多个 CPU 核心同时存在时的调度问题：进程放在哪个核心上运行，什么时候在核心之间迁移，如何保持各核心的负载均衡。

到目前为止，讨论的都是单核调度：一个 CPU，一个就绪队列，调度器从中选一个进程运行。现代服务器通常有几十甚至几百个核心。多核带来三个新问题。

第一个问题：**每个核心一个队列，还是全局一个队列？**

全局队列(global queue)只有一个就绪队列，所有核心从同一个队列取任务。优点是天然负载均衡：慢的核心取得少，快的核心取得多。问题是队列需要加锁，核心越多锁竞争越严重，成为瓶颈。

每核队列(per-CPU queue)每个核心维护自己的就绪队列，互不干扰，没有锁竞争。但需要额外的负载均衡机制，否则可能出现一些核心忙到排满队列，另一些核心空闲无事可做。

Linux 使用每核队列。每个 CPU 核心有一个 `struct rq`(run queue)，包含自己的 CFS 红黑树、实时进程队列和 deadline 进程队列。

```
CPU 0                   CPU 1                   CPU 2
┌──────────┐           ┌──────────┐           ┌──────────┐
│  rq[0]   │           │  rq[1]   │           │  rq[2]   │
│ ┌──────┐ │           │ ┌──────┐ │           │ ┌──────┐ │
│ │ CFS  │ │           │ │ CFS  │ │           │ │ CFS  │ │
│ │ tree │ │           │ │ tree │ │           │ │ tree │ │
│ └──────┘ │           │ └──────┘ │           │ └──────┘ │
│ ┌──────┐ │           │ ┌──────┐ │           │ ┌──────┐ │
│ │  RT  │ │           │ │  RT  │ │           │ │  RT  │ │
│ └──────┘ │           │ └──────┘ │           │ └──────┘ │
└──────────┘           └──────────┘           └──────────┘
      ↕                      ↕                      ↕
   load balancer periodically moves tasks between queues
```

第二个问题：**CPU 亲和性**(CPU affinity)。

进程在一个核心上运行时，它的数据会被加载到该核心的 L1/L2 缓存中。如果下次调度把它迁移到另一个核心，新核心的缓存中没有它的数据，要重新从内存（或 L3 缓存）加载，性能下降。这叫**缓存亲和性**(cache affinity)：进程倾向于留在之前运行过的核心上。

Linux 调度器默认会尽量让进程留在同一个核心上（软亲和性），但在负载不均衡时允许迁移。用户也可以通过 `sched_setaffinity()` 或 `taskset` 命令显式绑定进程到特定核心（硬亲和性）：

```bash
# bind process to CPU 0 and 1 only
taskset -c 0,1 ./my_program

# move existing process (PID 1234) to CPU 2
taskset -cp 2 1234
```

硬亲和性在性能优化中常见：数据库、网络服务器等经常把关键线程绑定到特定核心，避免缓存抖动。

第三个问题：**负载均衡**(load balancing)。

每核队列意味着各核心的负载可能不均。一个核心的就绪队列排了 10 个进程，另一个核心空闲。空闲核心浪费了计算能力，忙碌核心上的进程延迟增加。调度器需要定期检查各核心的负载，把进程从忙碌核心迁移到空闲核心。

Linux 的负载均衡器按照 CPU 的物理拓扑分层工作。同一个物理核心上的超线程(SMT)共享 L1/L2 缓存，迁移代价最低。同一个 CPU 插槽上的核心共享 L3 缓存，迁移代价中等。不同插槽的核心之间没有共享缓存，迁移代价最高。负载均衡器优先在共享缓存的核心之间迁移进程，减少缓存失效的开销。

```
NUMA Node 0 (Socket 0)          NUMA Node 1 (Socket 1)
┌───────────────────────┐       ┌───────────────────────┐
│  Core 0    Core 1     │       │  Core 4    Core 5     │
│  [L1/L2]   [L1/L2]   │       │  [L1/L2]   [L1/L2]   │
│        L3 cache       │       │        L3 cache       │
│       local memory    │       │       local memory    │
└───────────┬───────────┘       └───────────┬───────────┘
            │          interconnect          │
            └───────────────┬───────────────┘
                            │
             migration cost increases with distance
```

负载均衡器会定期触发（忙碌核心每隔几毫秒，空闲核心更频繁）。当一个核心完全空闲时，它会主动从最忙的核心拉取(pull)进程，不等定时器。这叫**空闲均衡**(idle balancing)，能快速响应负载变化。

Linux 把 CPU 组织成**调度域**(scheduling domain)层级。每一层对应物理拓扑的一级（SMT → 核心 → 插槽 → NUMA 节点）。负载均衡在每一层独立进行，底层频繁、顶层稀疏。这样既保证了局部性（优先在共享缓存的核心间迁移），又保证了全局均衡（长时间不平衡时跨插槽迁移）。

**NUMA**(Non-Uniform Memory Access，非统一内存访问)是多插槽系统中的内存架构。每个 CPU 插槽有自己的本地内存。CPU 访问本地内存快，访问远端插槽的内存慢（经过互联总线，延迟可能高 2-3 倍）。

```
CPU 0 ←── fast ──→ Memory 0
  ↕                    ↕
  slow (interconnect)  slow
  ↕                    ↕
CPU 1 ←── fast ──→ Memory 1
```

NUMA 对调度器的影响：把进程迁移到远端 NUMA 节点后，它之前分配的内存页还在原来节点的内存中，每次访问都要跨节点。性能下降可能非常大。Linux 的 NUMA 感知调度策略尽量让进程和它的内存待在同一个 NUMA 节点上。内核还有一个 NUMA balancing 机制（`numa_balancing`），会自动检测进程的内存访问模式，在进程和内存之间做最优匹配：要么把进程迁移到数据所在的节点，要么把数据页迁移到进程所在的节点。

可以用 `numactl` 控制进程的 NUMA 策略：

```bash
# run program on NUMA node 0, use node 0's memory
numactl --cpunodebind=0 --membind=0 ./my_program

# show NUMA topology
numactl --hardware
```

:::expand 调度器类

Linux 内核用**调度器类**(scheduler class)的设计统一管理不同的调度策略。进程生命周期一课中 `task_struct` 的 `sched_class` 字段就是指向调度器类的指针。每个调度器类实现一组回调函数：

```c
// kernel/sched/sched.h (simplified)
struct sched_class {
    void (*enqueue_task)(struct rq *rq, struct task_struct *p, int flags);
    void (*dequeue_task)(struct rq *rq, struct task_struct *p, int flags);
    struct task_struct *(*pick_next_task)(struct rq *rq);
    void (*task_tick)(struct rq *rq, struct task_struct *p, int queued);
    // ...
};
```

Linux 有五个调度器类，按优先级从高到低：

| 调度器类 | 对应调度策略 | 文件 |
|----------|-------------|------|
| `stop_sched_class` | 内核内部使用（CPU hotplug、迁移） | `kernel/sched/stop_task.c` |
| `dl_sched_class` | SCHED_DEADLINE | `kernel/sched/deadline.c` |
| `rt_sched_class` | SCHED_FIFO / SCHED_RR | `kernel/sched/rt.c` |
| `fair_sched_class` | SCHED_OTHER (CFS/EEVDF) | `kernel/sched/fair.c` |
| `idle_sched_class` | 空闲时运行的 idle 任务 | `kernel/sched/idle.c` |

`__schedule()` 函数按优先级从高到低依次查询每个调度器类的 `pick_next_task()`，第一个返回非 NULL 的就是下一个要运行的进程。SCHED_DEADLINE 进程存在时一定先运行，然后是实时进程，最后才是普通进程。

这个设计让不同调度策略可以独立演化。CFS 换成 EEVDF 只需要修改 `fair_sched_class` 的实现，不影响实时调度器的代码。新增一种调度策略也只需要实现一个新的 `sched_class` 并注册到优先级链中。

:::

## 小结

| 概念 | 说明 |
|------|------|
| CFS(Completely Fair Scheduler) | 追踪 vruntime，始终调度虚拟运行时间最少的进程 |
| vruntime(虚拟运行时间) | 进程已消耗的加权 CPU 时间，权重由 nice 值决定 |
| 红黑树(Red-Black Tree) | CFS 用来组织就绪进程的数据结构，按 vruntime 排序 |
| 组调度(Group Scheduling) | 先在组间公平，再在组内公平，配合 cgroup CPU 控制器 |
| EEVDF | CFS 的后继，用虚拟截止期限替代纯 vruntime 选择 |
| 每核队列(Per-CPU Run Queue) | 每个核心独立的就绪队列，避免全局锁竞争 |
| CPU 亲和性(CPU Affinity) | 进程倾向于留在同一核心，保持缓存热度 |
| 负载均衡(Load Balancing) | 调度器在核心之间迁移进程以均衡负载 |
| 调度域(Scheduling Domain) | 按 CPU 物理拓扑分层组织负载均衡 |
| NUMA | 非统一内存访问，CPU 访问本地内存快、远端内存慢 |

**核心洞察**：CFS/EEVDF 的核心思路是把调度问题转化为"追踪每个进程已经用了多少 CPU"的记账问题。不需要猜测进程的未来行为，不需要手动分级，不需要调参数。vruntime 像一个自动平衡的天秤：用得多的那一边自然上升，用得少的自然下沉，调度器只需要总是选最轻的那一边。多核调度在此基础上增加了一个空间维度：不仅要决定"下一个运行谁"，还要决定"在哪个核心上运行"。

---

**Linux 源码入口**：
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c) — `pick_eevdf()`、`update_curr()`：EEVDF 选择逻辑和 vruntime 更新
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c) — `place_entity()`：进程入队时的 vruntime 放置
- [`kernel/sched/core.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/core.c) — `__schedule()`：调度入口，遍历调度器类
- [`kernel/sched/topology.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/topology.c) — 调度域的构建
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c) — `load_balance()`：负载均衡的核心逻辑

---

## 动手做一做

本课是理论课，没有 zish 代码要写。以下观察实验帮助理解 Linux 调度器的行为。

**1. 观察 vruntime**

通过 `/proc/[pid]/sched` 查看进程的调度统计。这个文件包含 vruntime、运行次数、等待时间等信息：

```bash
# start a background process
sleep 100 &
cat /proc/$!/sched | head -10
```

`se.vruntime` 显示当前的虚拟运行时间。启动两个不同 nice 值的 CPU 密集型进程，观察它们的 vruntime 增长速率：

```bash
dd if=/dev/zero of=/dev/null &
PID1=$!
nice -n 10 dd if=/dev/zero of=/dev/null &
PID2=$!

sleep 5
echo "PID $PID1 (nice 0):"
grep vruntime /proc/$PID1/sched
echo "PID $PID2 (nice 10):"
grep vruntime /proc/$PID2/sched

kill $PID1 $PID2
```

nice 10 的进程 vruntime 增长更快（因为权重低，加权系数大）。

**2. 查看调度域**

Linux 的调度域拓扑可以从 `/proc/schedstat` 或 `/sys/kernel/debug/sched/` 中读取：

```bash
# show scheduling domain topology (requires root)
cat /proc/schedstat | head -5

# or use lstopo (from hwloc package) to visualize CPU topology
lstopo --no-io
```

**3. 观察负载均衡**

启动多个 CPU 密集型进程，观察调度器如何分布它们：

```bash
# start 4 CPU-bound processes
for i in $(seq 4); do dd if=/dev/zero of=/dev/null & done

# watch which CPU each process runs on
watch -n 1 'ps -eo pid,psr,comm | grep dd'
```

`PSR` 列显示进程当前运行在哪个 CPU 核心上。调度器应该把 4 个进程分布在不同核心上。如果核心数 ≥ 4，每个进程独占一个核心。

完成后用 `killall dd` 清理。

**4. 测试 CPU 亲和性**

用 `taskset` 绑定进程到特定核心，观察效果：

```bash
# bind dd to CPU 0 only
taskset -c 0 dd if=/dev/zero of=/dev/null &
PID=$!

# verify
ps -o pid,psr,comm -p $PID
# PSR should always show 0

kill $PID
```

---

<!-- 下一篇：命名空间 -->
