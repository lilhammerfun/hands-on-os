# Linux 调度器

- 写作时间：`2026-03-04 首次提交，2026-03-27 最近修改`
- 当前字符：`20672`

上一课讲了调度的底层机制：`__schedule()` 的触发路径、`TIF_NEED_RESCHED` 标志、`context_switch()` 的实现。这些是调度的骨架，决定了"何时调度、怎么切换"。但骨架中有一个关键步骤被跳过了：`pick_next_task()`——从运行队列中选择下一个进程。选择的策略就是调度算法。

先从五种**经典调度算法**入手，理解每种算法解决什么问题、引入什么代价。然后看 Linux 的实际选择：**CFS** 用 vruntime 追踪公平性，**EEVDF** 在此基础上用虚拟截止期限改进延迟敏感场景。普通进程追求公平，但有些任务（音频播放、工业控制）要求确定性的响应时间，这就需要**实时调度**。引入优先级后会出现一个经典陷阱：**优先级反转**——高优先级进程被低优先级进程间接阻塞。最后，当系统有多个 CPU 核心时，**多核调度**面临负载均衡和缓存亲和性的额外挑战。

## 调度算法

调度算法(scheduling algorithm)决定了"就绪队列中哪个进程下一个获得 CPU"。不同算法在吞吐量(throughput)、周转时间(turnaround time)、响应时间(response time)、公平性之间做不同的权衡。

评价调度算法的指标：

| 指标 | 定义 | 优化方向 |
|------|------|----------|
| 吞吐量(throughput) | 单位时间内完成的进程数 | 越高越好 |
| 周转时间(turnaround time) | 进程从提交到完成的总时间 | 越短越好 |
| 等待时间(waiting time) | 进程在就绪队列中等待的总时间 | 越短越好 |
| 响应时间(response time) | 进程从提交到首次获得 CPU 的时间 | 越短越好 |

没有一种算法能同时优化所有指标。下面五种算法，每种都是对前一种的改进，解决前一种留下的问题。

**FCFS(First-Come, First-Served，先来先服务)**。按进程到达的顺序分配 CPU，不抢占。最简单的算法，就是一个 FIFO 队列。

```
Arrival order: P1(burst=24ms), P2(burst=3ms), P3(burst=3ms)

Gantt chart:
|-------- P1 --------|-- P2 --|-- P3 --|
0                    24       27       30

Waiting time:  P1=0, P2=24, P3=27
Average waiting time: (0+24+27)/3 = 17ms
```

问题很明显：**护航效应**(convoy effect)。一个长进程排在前面，后面所有短进程都要等它执行完。如果顺序是 P2、P3、P1，平均等待时间降到 (0+3+6)/3 = 3ms。效果完全取决于到达顺序，这太不可控了。

**SJF(Shortest Job First，最短作业优先)**。每次从就绪队列中选 CPU 执行期最短的进程执行。

```
Arrival order: P1(burst=6ms), P2(burst=8ms), P3(burst=7ms), P4(burst=3ms)

SJF order: P4, P1, P3, P2
|-- P4 --|--- P1 ---|--- P3 ---|---- P2 ----|
0        3          9          16           24

Waiting time:  P1=3, P2=16, P3=9, P4=0
Average waiting time: (3+16+9+0)/4 = 7ms
```

可以证明，SJF 在所有非抢占式算法中平均等待时间最短。但它有两个严重问题。第一，进程的下一次 CPU 执行期有多长是未知的，调度器无法预知一个进程接下来要用多少 CPU。实际实现中只能根据历史执行期做指数平均预测，不精确。第二，**饥饿**(starvation)：如果不断有短进程到达，长进程可能永远排不到。

**RR(Round Robin，时间片轮转)**。为就绪队列设定一个固定的时间片(time quantum)，每个进程最多用一个时间片就必须让出 CPU，排到队尾等下一轮。

```
Time quantum = 4ms
Processes: P1(burst=24ms), P2(burst=3ms), P3(burst=3ms)

|P1 |P2 |P3 |P1 |P1 |P1 |P1 |P1 |
0   4   7   10  14  18  22  26  30

P2 finishes at 7,  P3 finishes at 10
P1 gets remaining time in subsequent quanta
```

RR 解决了 FCFS 的护航效应和 SJF 的饥饿问题。每个进程都会在有限时间内获得 CPU，不会有进程被永远跳过。响应时间好（最坏情况下等待 (n-1) × quantum）。但代价是周转时间通常比 SJF 差，而且引入了频繁的上下文切换开销。

时间片的选择很关键。太大（比如 100ms），退化成 FCFS，响应时间差。太小（比如 10μs），上下文切换的开销占比过高，大量 CPU 时间浪费在切换上。Linux 的默认时间片随调度器演化而变化，典型值在 1ms 到 10ms 之间。

**优先级调度(Priority Scheduling)**。每个进程有一个优先级数值，调度器总是选优先级最高的进程执行。SJF 可以看作优先级调度的特例，优先级 = 预估执行期的倒数。

优先级调度的核心问题还是**饥饿**：低优先级进程可能永远无法执行。解决方案是 **老化**(aging)：随着进程等待时间的增长，逐渐提高它的优先级。等得够久，优先级自然升到能被调度。

Linux 中的进程优先级范围：

```
Priority value:  0 ──────────────── 99    100 ───────────── 139
                 └── real-time ──┘        └── normal ────┘
                 (higher number =          (nice -20 to 19)
                  higher priority)
```

实时进程的优先级范围是 0-99，数值越大优先级越高。普通进程的优先级范围是 100-139，通过 nice 值（-20 到 19）调整，nice 值越低优先级越高。实时进程的优先级永远高于普通进程。

**MLFQ(Multi-Level Feedback Queue，多级反馈队列)**。MLFQ 综合了以上算法的优点，是现代操作系统调度器的理论基础。

MLFQ 维护多个优先级队列。核心规则：

1. 新进程进入最高优先级队列
2. 高优先级队列优先于低优先级队列被调度
3. 同一队列内使用 RR
4. 如果一个进程用完了它在当前队列的时间片（说明它是 CPU 密集型），降到下一级队列
5. 如果一个进程在时间片内主动让出 CPU（说明它是 I/O 密集型），留在当前队列

```
Queue 0 (highest priority, quantum=8ms):   [new processes arrive here]
Queue 1 (medium priority,  quantum=16ms):  [demoted from Queue 0]
Queue 2 (lowest priority,  quantum=32ms):  [demoted from Queue 1, uses FCFS]
```

为什么用完时间片要降级？因为用完时间片说明这个进程需要大量连续的 CPU 时间（CPU 密集型），它不需要快速响应，给它更长的时间片反而更好——每次运行时间更长，上下文切换更少，吞吐量更高。代价是响应延迟变大，但它不在乎。而 I/O 密集型进程（比如编辑器等用户输入）需要快速响应，留在高优先级队列优先被调度。

这个设计的精妙之处在于：**调度器不需要预先知道进程是 CPU 密集还是 I/O 密集，它通过观察进程的行为自动分类。**

:::thinking MLFQ 能不能被恶意利用？
上面的规则 4 只看"单次时间片是否用完"。一个狡猾的进程可以在时间片快用完时故意做一次无意义的 I/O 操作（比如读一个字节），主动让出 CPU。这样它每次都"没用完时间片"，永远留在高优先级队列，同时获得大量 CPU 时间。

因此现代 MLFQ 增加了**时间配额**(time accounting)规则：不看单次时间片是否用完，而是累计一个进程在某一级队列中使用的总 CPU 时间。累计时间超过阈值就降级，不管它中间让出过多少次 CPU。

类似地，早期 MLFQ 还有一个问题：低优先级队列的进程可能饥饿。现代 MLFQ 引入了**定期提升**(priority boost)：每隔固定时间（比如 1 秒），把所有进程移回最高优先级队列，重新开始。这样低优先级进程至少能定期获得一些 CPU 时间。

MLFQ 不是一个固定的算法，而是一个不断迭代的设计。上面五条基础规则加上时间配额和定期提升，构成了现代 MLFQ 的完整规则集。
:::

MLFQ 通过观察进程行为自动分类，是最接近实践的设计。但它有一个问题：队列的数量、每级时间片的大小、提升周期，这些参数怎么设？设错了效果就差。参数和工作负载绑定，一个服务器上效果好的参数，搬到桌面系统上可能就不行了。Linux 需要一个在所有场景下都表现足够好的通用调度器，不能靠手动调参数。

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

:::thinking vruntime 的设计为什么比固定时间片更好？
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

考虑一个桌面系统。用户在编辑器里打字（I/O 密集，频繁短 CPU 执行期），后台在编译代码（CPU 密集，长 CPU 执行期）。编辑器进程经常睡眠（等键盘输入），醒来时 vruntime 落后，会被优先调度。到这里还好。

问题是：CFS 唤醒进程时给它的 vruntime 补偿是固定的（`sched_latency` 的一半）。这个补偿量不区分进程是睡了 1ms 还是睡了 1 秒。短暂睡眠的交互式进程和长时间睡眠的后台进程获得相同的补偿，对交互式进程不够公平。

CFS 为了弥补这个问题，逐渐加入了各种启发式补丁(heuristic)：唤醒抢占逻辑、睡眠者的 vruntime 补偿策略、各种可调参数。这些补丁互相作用，行为变得难以预测。同一个 `sched_wakeup_granularity` 参数在不同工作负载下需要不同的值。

EEVDF 的设计思路是：**用明确的算法替代启发式补丁。** 它保留了 CFS 的 vruntime 机制（公平性追踪），但改变了选择下一个进程的规则。

CFS 选 vruntime 最小的进程。EEVDF 为每个进程计算一个**虚拟截止期限**(virtual deadline)，选截止期限最早的**合格**(eligible)进程。

虚拟截止期限的计算：

$$
\text{deadline} = \text{vruntime} + \frac{\text{request}}{\text{weight}} \times \text{total\_weight}
$$

`request` 是进程请求的时间片长度。权重大（优先级高）的进程，除以的 weight 大，deadline 更近，更容易被选中。"合格"(eligible)的条件是进程的 vruntime 不超过整体的虚拟时间进度。一个 vruntime 远超平均值的进程（已经用了太多 CPU）即使 deadline 最早也不合格，必须等其他进程追上来。

:::thinking EEVDF 相比 CFS 具体好在哪？
CFS 的问题可以用一个具体场景说明。假设有两个进程：

- A：每 10ms 醒一次，每次用 1ms CPU（交互式）
- B：一直在跑，不睡眠（CPU 密集型）

在 CFS 下，A 睡了 9ms 醒来，vruntime 落后于 B。CFS 让 A 先跑（vruntime 小）。但 A 只需要 1ms，跑完又睡了。问题是，如果系统中还有 C、D、E 等大量进程，A 醒来时的 vruntime 补偿可能不够精确，A 可能需要等一段时间才能被调度。唤醒延迟不稳定。

EEVDF 下，A 的请求时间短（request 小），计算出的 deadline 很近。一旦 A 变为合格（vruntime 追上），它会因为 deadline 最早而被立即选中。EEVDF 不需要启发式的唤醒补偿，deadline 机制自然地给短请求进程更快的响应。

结果是：CFS 的唤醒延迟取决于启发式参数的调节，EEVDF 的唤醒延迟由进程自身的 request 大小决定。后者更可预测，也更公平。

:::

EEVDF 在内核实现上改动不大。红黑树的排序键从 vruntime 变成了 deadline。调度入口还是 `pick_next_task_fair()`，只是内部的选择逻辑变了。vruntime 的计算方式、权重表、组调度的层次结构都保持不变。CFS 的经验和调优知识大部分仍然适用。

从用户视角看，EEVDF 减少了需要调节的参数。CFS 时代的 `sched_wakeup_granularity` 在 EEVDF 中被删除了。EEVDF 还引入了一个新特性：进程可以通过 `sched_setattr()` 设置自己的 `sched_runtime` 来声明时间片偏好。设置短 runtime 的进程获得更快的响应但更频繁的上下文切换，设置长 runtime 的进程减少切换开销但延迟更高。这让应用程序可以在延迟和吞吐量之间做显式选择，而不是依赖内核的启发式猜测。

## 实时调度

实时调度(real-time scheduling)保证任务在确定的时间限制内完成，用于对延迟有严格要求的场景。

前面的算法（FCFS、SJF、RR、MLFQ、CFS、EEVDF）追求的是"平均性能好"。但有些任务不关心平均值，它们需要**保证**：这个任务必须在 10 毫秒内完成，一次都不能超。工业控制系统、音频处理、机器人控制都有这样的需求。

Linux 提供了三种实时调度策略，都属于 POSIX 定义的实时调度接口。实时进程的优先级（0-99）永远高于普通进程（100-139），只要有实时进程就绪，普通进程就得不到 CPU。

**SCHED_FIFO（先进先出）**。一旦 SCHED_FIFO 进程获得 CPU，它会一直运行直到以下三种情况之一发生：自己主动阻塞（I/O 等待）、自己主动让出（调用 `sched_yield()`）、被更高优先级的实时进程抢占。没有时间片的概念。同一优先级的 SCHED_FIFO 进程按到达顺序排列，不轮转。

**SCHED_RR（实时轮转）**。和 SCHED_FIFO 几乎一样，唯一区别是同一优先级的进程之间使用时间片轮转。高优先级仍然能抢占低优先级。这防止了同一优先级的多个实时进程中某一个独占 CPU。

```
SCHED_FIFO (priority 50):   A runs until it blocks, no time limit
SCHED_RR   (priority 50):   A → B → C → A → B → ... (round-robin within same priority)
```

**SCHED_DEADLINE（截止期限调度）**。最先进的实时调度策略（Linux 3.14+），不基于优先级，而是基于三个参数：

- **runtime**：每个周期内需要的 CPU 时间
- **deadline**：必须在此时间内完成当前周期的计算
- **period**：任务的周期

```
Parameters: runtime=2ms, deadline=5ms, period=10ms

|--run--|          idle          |--run--|          idle          |
0  2    5                   10  12   15                      20
   └ must finish by here              └ must finish by here
```

内核保证在每个 period 内，进程至少获得 runtime 的 CPU 时间，且在 deadline 之前完成。如果系统无法满足这个保证（CPU 时间不够），`sched_setattr()` 设置 SCHED_DEADLINE 时会返回错误，在任务开始前就拒绝。这叫**准入控制**(admission control)：与其在运行时错过截止期限，不如在设置时就告诉你"做不到"。

SCHED_DEADLINE 的优先级高于 SCHED_FIFO 和 SCHED_RR。调度策略的优先级顺序：

```
SCHED_DEADLINE  >  SCHED_FIFO / SCHED_RR  >  SCHED_OTHER (CFS/EEVDF)
```

:::expand 实时调度的实际应用

实时调度在用户态应用中比较少见。大多数 Linux 服务器上的进程都使用默认的 SCHED_OTHER（CFS/EEVDF）。实时调度主要用于：

- **音频处理**：JACK 音频服务器使用 SCHED_FIFO 确保音频缓冲区及时填充，避免爆音
- **工业控制**：PLC 控制程序需要在确定时间内完成计算并输出控制信号
- **虚拟化**：QEMU/KVM 的 vCPU 线程有时使用 SCHED_FIFO 减少虚拟机延迟

设置实时调度需要 `CAP_SYS_NICE` capability（或 root 权限），因为实时进程可以饿死所有普通进程。一个有 bug 的 SCHED_FIFO 进程进入死循环，会独占 CPU，连 SSH 登录都无法响应。Linux 的安全措施是 **RT throttling**：默认限制实时进程在每 1 秒的周期内最多使用 0.95 秒的 CPU 时间（`/proc/sys/kernel/sched_rt_runtime_us = 950000`），留 50ms 给普通进程保命。

:::

## 优先级反转

优先级反转(priority inversion)是指高优先级进程因等待低优先级进程持有的资源而被间接阻塞，而中优先级进程却在运行的反常现象。

这个问题需要三个进程才会发生。考虑三个进程：H（高优先级）、M（中优先级）、L（低优先级），以及一个它们共享的互斥锁(mutex)。

```
Time →
L:  ┌─run──┐ lock(mutex) ┌─run─ ·····················──┐ unlock ┌─run─┐
M:  │      │              │     ┌─────── M runs ───────┐│        │     │
H:  │      │              │     │                      ││        │     │
    │      │              │     │                      ││        │     │
    ▼      ▼              ▼     ▼                      ▼▼        ▼     ▼

1. L starts running, acquires mutex
2. H becomes ready, preempts L (H has higher priority)
3. H tries to lock(mutex), blocked — L holds it
4. M becomes ready, preempts L (M has higher priority than L)
5. M runs to completion — H is still waiting!
6. M finishes, L resumes, finishes critical section, releases mutex
7. H finally acquires mutex and runs
```

问题出在第 4-5 步。H 等着 L 释放锁，但 M（优先级比 L 高但比 H 低）抢占了 L，导致 L 无法执行，锁一直不释放，H 就一直等着。高优先级的 H 被中优先级的 M 间接阻塞了。如果有多个中优先级进程轮流运行，H 可以被无限期阻塞。

:::expand 火星探路者号事件

优先级反转最著名的案例发生在 1997 年的火星探路者号(Mars Pathfinder)。飞船着陆火星后频繁重启，任务几乎失败。

原因是三个任务之间的优先级反转：高优先级的总线管理任务(bus management task)、低优先级的气象数据采集任务(meteorological task)、以及几个中优先级的通信任务。气象任务持有信息总线的互斥锁时被抢占，总线管理任务等不到锁，超时后触发了看门狗(watchdog)重启。

JPL 工程师通过远程上传补丁，在 VxWorks 实时操作系统的互斥锁上启用了优先级继承，解决了问题。这个诊断和修复过程全部通过远距离遥测完成，信号往返延迟约 20 分钟。

:::

两种经典解决方案：

**优先级继承**(priority inheritance)。当高优先级进程 H 阻塞在低优先级进程 L 持有的锁上时，内核临时把 L 的优先级提升到 H 的水平。L 暂时拥有和 H 一样的优先级，M 无法抢占它，L 尽快完成临界区、释放锁，H 立刻获得锁开始执行。锁释放后，L 的优先级恢复原值。

**优先级天花板**(priority ceiling)。每个互斥锁关联一个"天花板优先级"，等于所有可能使用该锁的进程中最高的那个优先级。进程获得锁时，优先级立刻提升到天花板值。这比优先级继承更激进：不等到实际发生阻塞就提前提升，避免了反转发生的可能性。代价是锁的持有者即使没有被更高优先级进程等待，也会以高优先级运行。

Linux 内核中的 rt_mutex（实时互斥锁）实现了优先级继承。用户态可以通过 `pthread_mutexattr_setprotocol()` 设置 `PTHREAD_PRIO_INHERIT` 来启用。

## 多核调度

多核调度(multiprocessor scheduling)处理多个 CPU 核心同时存在时的调度问题：进程放在哪个核心上运行，什么时候在核心之间迁移，如何保持各核心的负载均衡。

到目前为止，讨论的都是单核调度：一个 CPU，一个就绪队列，调度器从中选一个进程运行。现代服务器通常有几十甚至几百个核心。多核带来三个新问题。

第一个问题：**每个核心一个队列，还是全局一个队列？**

全局队列(global queue)只有一个就绪队列，所有核心从同一个队列取任务。优点是天然负载均衡：慢的核心取得少，快的核心取得多。问题是队列需要加锁，核心越多锁竞争越严重，成为瓶颈。

每核队列(per-CPU queue)每个核心维护自己的就绪队列，互不干扰，没有锁竞争。但需要额外的负载均衡机制，否则可能出现一些核心忙到排满队列，另一些核心空闲无事可做。

Linux 使用每核队列。上一课介绍的 `struct rq` 就是每个 CPU 核心的运行队列，包含自己的 CFS 红黑树、实时进程队列和 deadline 进程队列。

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

Linux 内核用**调度器类**(scheduler class)的设计统一管理不同的调度策略。上一课介绍的 `task_struct->sched_class` 字段就是指向调度器类的指针。每个调度器类实现一组回调函数：

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

上一课介绍的 `__schedule()` 中的 `pick_next_task()` 就是按优先级从高到低依次查询每个调度器类的 `pick_next_task()` 回调，第一个返回非 NULL 的就是下一个要运行的进程。SCHED_DEADLINE 进程存在时一定先运行，然后是实时进程，最后才是普通进程。

这个设计让不同调度策略可以独立演化。CFS 换成 EEVDF 只需要修改 `fair_sched_class` 的实现，不影响实时调度器的代码。新增一种调度策略也只需要实现一个新的 `sched_class` 并注册到优先级链中。

:::

## 小结

| 概念 | 说明 |
|------|------|
| FCFS | 先来先服务，有护航效应 |
| SJF | 最短作业优先，最优平均等待时间但可能饥饿 |
| RR | 时间片轮转，公平但周转时间较差 |
| 优先级调度 | 按优先级选择，可能饥饿，需要老化机制 |
| MLFQ | 多级反馈队列，通过观察行为自动分类进程 |
| CFS(Completely Fair Scheduler) | 追踪 vruntime，始终调度虚拟运行时间最少的进程 |
| vruntime(虚拟运行时间) | 进程已消耗的加权 CPU 时间，权重由 nice 值决定 |
| 红黑树(Red-Black Tree) | CFS 用来组织就绪进程的数据结构，按 vruntime 排序 |
| 组调度(Group Scheduling) | 先在组间公平，再在组内公平，配合 cgroup CPU 控制器 |
| EEVDF | CFS 的后继，用虚拟截止期限替代纯 vruntime 选择 |
| SCHED_FIFO / SCHED_RR | 实时调度策略，优先级永远高于普通进程 |
| SCHED_DEADLINE | 基于截止期限的实时调度，有准入控制 |
| 优先级反转(Priority Inversion) | 高优先级进程被低优先级进程间接阻塞 |
| 优先级继承(Priority Inheritance) | 临时提升锁持有者的优先级以解决反转 |
| 每核队列(Per-CPU Run Queue) | 每个核心独立的就绪队列，避免全局锁竞争 |
| CPU 亲和性(CPU Affinity) | 进程倾向于留在同一核心，保持缓存热度 |
| 负载均衡(Load Balancing) | 调度器在核心之间迁移进程以均衡负载 |
| NUMA | 非统一内存访问，CPU 访问本地内存快、远端内存慢 |

调度算法本质上都在做同一个权衡：吞吐量（少切换、长时间片）和响应时间（多切换、短时间片）之间的取舍。经典算法从 FCFS 到 MLFQ，每一步都是在解决前一步留下的问题。CFS/EEVDF 把这个权衡转化为一个记账问题：追踪每个进程用了多少 CPU，始终让用得最少的先运行，不需要手动分级和调参。实时调度则跳出了这个权衡，用确定性保证取代公平性追求。多核调度在此基础上增加了空间维度：不仅要决定"下一个运行谁"，还要决定"在哪个核心上运行"。

---

**Linux 源码入口**：
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c) — `pick_eevdf()`、`update_curr()`：EEVDF 选择逻辑和 vruntime 更新
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c) — `place_entity()`：进程入队时的 vruntime 放置
- [`kernel/sched/rt.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/rt.c) — SCHED_FIFO 和 SCHED_RR 的实现
- [`kernel/sched/deadline.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/deadline.c) — SCHED_DEADLINE 的实现
- [`kernel/locking/rtmutex.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/rtmutex.c) — 优先级继承的实现
- [`kernel/sched/topology.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/topology.c) — 调度域的构建
- [`kernel/sched/fair.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/fair.c) — `load_balance()`：负载均衡的核心逻辑
