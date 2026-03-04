# CPU 调度

当我们在终端运行 `sleep 5 &` 然后 `ls`，两个命令似乎在同时执行。但大多数计算机的 CPU 核心数远少于运行中的进程数。一台普通的 Linux 服务器可能有 4 个 CPU 核心，却同时运行着几百个进程。四个核心同一时刻最多只能执行四个进程，其余的进程在等什么？

答案是：它们在等 CPU。内核中有一个组件负责决定"下一个该让谁用 CPU"，这就是调度器(scheduler)。调度器的工作是在所有就绪进程之间分配 CPU 时间，让每个进程都有机会执行。

本篇讲 CPU 调度的核心问题。**调度的基本概念**：CPU 密集与 I/O 密集进程的行为差异，以及调度的四个决策点。**上下文切换**：内核把 CPU 从一个进程交给另一个进程的具体过程。**调度算法**：五种经典算法（FCFS、SJF、RR、优先级、MLFQ），每种解决什么问题、引入什么代价。**实时调度**：Linux 的三种实时调度策略。最后是 **优先级反转**：高优先级进程被低优先级进程间接阻塞的经典问题。

## 调度的基本概念

CPU 调度(CPU scheduling)是操作系统从就绪进程中选择一个分配 CPU 的决策过程。

进程的执行可以分解为两种交替出现的阶段：**CPU 突发**(CPU burst)和 **I/O 突发**(I/O burst)。CPU 突发是进程在 CPU 上连续执行计算的阶段；I/O 突发是进程等待 I/O 完成（磁盘读写、网络收发）的阶段。在 I/O 突发期间，进程不需要 CPU，处于睡眠状态。

```
Process A (CPU-bound):          Process B (I/O-bound):
┌──────────────────┐            ┌──────┐
│   long CPU burst │            │ CPU  │
│                  │            └──┬───┘
│                  │               │ I/O wait (sleeping)
│                  │            ┌──┴───┐
│                  │            │ CPU  │
│                  │            └──┬───┘
│                  │               │ I/O wait (sleeping)
└────────┬─────────┘            ┌──┴───┐
         │ short I/O            │ CPU  │
┌────────┴─────────┐            └──────┘
│   long CPU burst │
└──────────────────┘
```

根据 CPU 突发和 I/O 突发的比例，进程大致分两类：

**CPU 密集型进程**(CPU-bound process)大部分时间在做计算，CPU 突发长，I/O 突发少。编译器、科学计算、视频编码都是典型例子。这类进程希望一直占着 CPU 不被打断。

**I/O 密集型进程**(I/O-bound process)大部分时间在等 I/O，CPU 突发短，频繁进出睡眠状态。Web 服务器、数据库、文本编辑器都是典型例子。这类进程每次用一小段 CPU 就去等 I/O 了，但它们对响应时间很敏感：用户按下键盘，编辑器应该立刻响应，而不是排在一个长计算任务后面等着。

这两类进程的需求是矛盾的。CPU 密集型希望长时间独占 CPU 以提高吞吐量。I/O 密集型希望一旦 I/O 完成就立刻获得 CPU 以降低延迟。调度器必须在这两种需求之间做权衡。

调度决策发生在四个时刻：

1. **进程从运行变为等待**（主动让出）：进程调用了阻塞操作（如 `read()` 等待磁盘），进入睡眠。CPU 空出来了，调度器必须选下一个进程。
2. **进程从运行变为就绪**（被动让出）：时间片用完，或者一个更高优先级的进程变为就绪。调度器可以抢占当前进程。
3. **进程从等待变为就绪**：I/O 完成，进程被唤醒。调度器决定是否让它立刻抢占当前运行的进程。
4. **进程终止**：进程调用 `exit()`，CPU 空出来。

如果调度器只在第 1 和第 4 个时刻做决策（进程主动让出 CPU），叫**非抢占式调度**(non-preemptive scheduling)。进程一旦获得 CPU 就一直执行到结束或阻塞，不会被强制打断。这种方式简单但有个明显问题：一个死循环进程会永远占着 CPU，其他进程全部饿死。

如果调度器在所有四个时刻都能做决策（包括强制中断正在运行的进程），叫**抢占式调度**(preemptive scheduling)。现代操作系统都使用抢占式调度。抢占的触发机制是硬件定时器中断：CPU 每隔固定间隔（比如 1 毫秒）产生一个时钟中断，内核在中断处理中检查当前进程是否用完了时间片，如果用完了就触发调度。

## 上下文切换

上下文切换(context switch)是内核将 CPU 从一个进程交给另一个进程的操作：保存当前进程的 CPU 状态，恢复下一个进程之前保存的 CPU 状态。

CPU 在任意时刻的状态由一组寄存器决定：程序计数器(PC)记录下一条要执行的指令地址，栈指针(SP)指向当前栈顶，通用寄存器存放计算的中间结果。如果不保存这些寄存器的值就切换到另一个进程，当前进程的执行状态就丢失了，下次切回来时无法从断点继续。

上下文切换的过程：

```
Process A running                           Process B running
     │                                           │
     ▼                                           │
 timer interrupt fires                           │
     │                                           │
     ▼                                           │
 enter kernel mode                               │
     │                                           │
     ▼                                           │
 save A's registers                              │
 to A's task_struct.thread                       │
     │                                           │
     ▼                                           │
 scheduler picks B                               │
     │                                           │
     ▼                                           │
 restore B's registers                           │
 from B's task_struct.thread                     │
     │                                           │
     ▼                                           │
 return to user mode ─────────────────────────→  ▼
                                            B continues
```

每个进程的 `task_struct` 中有一个 `thread_struct` 字段，专门用来保存该进程被切走时的寄存器状态（进程生命周期一课中介绍的 `task_struct` 简化版里的 `thread` 字段）。内核在切换时做两件事：把当前 CPU 寄存器的值写入旧进程的 `thread_struct`，然后从新进程的 `thread_struct` 中读出之前保存的值并加载到 CPU 寄存器中。

除了寄存器，还需要切换地址空间。每个进程有独立的页表（进程生命周期一课中讲的虚拟地址映射）。切换进程意味着切换页表，让 MMU 使用新进程的地址映射。这通过写 CPU 的页表基地址寄存器（x86 上是 CR3）来完成。

上下文切换的开销不只是保存和恢复寄存器本身（这只需要几十条指令）。切换页表后，CPU 的 TLB(Translation Lookaside Buffer)缓存全部失效。TLB 是 MMU 用来加速虚拟地址到物理地址翻译的缓存，每次切换进程后，新进程的地址翻译全部要从页表重新查找，直到 TLB 被重新填充。这个"冷启动"期间每次内存访问都变慢。此外，CPU 的指令缓存和数据缓存中存放的是旧进程的数据，新进程的数据还在内存里没有被加载进来，也会导致大量缓存未命中(cache miss)。

:::thinking

> 上下文切换的开销具体有多大？

Linux 上，上下文切换本身（保存/恢复寄存器 + 切换页表）大约需要 1-5 微秒。但间接开销（TLB 失效 + 缓存冷启动）可能导致后续几十微秒到几百微秒的性能下降。

可以用 `perf stat` 观察系统的上下文切换次数：

```bash
perf stat -e context-switches,cpu-migrations sleep 5
```

也可以从 `/proc/[pid]/status` 中读取单个进程的上下文切换统计：

```bash
grep ctxt /proc/self/status
voluntary_ctxt_switches:        10
nonvoluntary_ctxt_switches:     3
```

`voluntary` 是进程主动让出 CPU（如调用 `read()` 阻塞），`nonvoluntary` 是被调度器强制抢占（时间片用完）。

:::

上下文切换的频率取决于调度算法。时间片越短，切换越频繁，进程的响应延迟越低，但切换开销占比越高。时间片越长，切换越少，吞吐量越高，但进程的等待时间越长。这是调度器设计的核心权衡。

## 调度算法

调度算法(scheduling algorithm)决定了"就绪队列中哪个进程下一个获得 CPU"。不同算法在吞吐量(throughput)、周转时间(turnaround time)、响应时间(response time)、公平性(fairness)之间做不同的权衡。

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

**SJF(Shortest Job First，最短作业优先)**。每次从就绪队列中选 CPU 突发时间最短的进程执行。

```
Arrival order: P1(burst=6ms), P2(burst=8ms), P3(burst=7ms), P4(burst=3ms)

SJF order: P4, P1, P3, P2
|-- P4 --|--- P1 ---|--- P3 ---|---- P2 ----|
0        3          9          16           24

Waiting time:  P1=3, P2=16, P3=9, P4=0
Average waiting time: (3+16+9+0)/4 = 7ms
```

可以证明，SJF 在所有非抢占式算法中平均等待时间最短。但它有两个严重问题。第一，进程的下一次 CPU 突发时间是未知的，调度器无法预知一个进程接下来要用多少 CPU。实际实现中只能根据历史突发时间做指数平均预测，不精确。第二，**饥饿**(starvation)：如果不断有短进程到达，长进程可能永远排不到。

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

**优先级调度(Priority Scheduling)**。每个进程有一个优先级数值，调度器总是选优先级最高的进程执行。SJF 可以看作优先级调度的特例，优先级 = 预估突发时间的倒数。

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

这个设计的精妙之处在于：**调度器不需要预先知道进程是 CPU 密集还是 I/O 密集，它通过观察进程的行为自动分类。** 频繁做 I/O 的进程总是很快让出 CPU，保持在高优先级队列，获得快速响应。CPU 密集型进程用完时间片被降级，得到更长的时间片但更低的优先级，减少上下文切换次数。

:::thinking

> MLFQ 有没有可能被游戏？

有。一个狡猾的进程可以在时间片快用完时故意做一次无意义的 I/O 操作（比如读一个字节），这样它就不会被降级，永远留在高优先级队列，同时获得大量 CPU 时间。

解决方案是**时间配额**(time accounting)：不看单次时间片是否用完，而是累计一个进程在某一级队列中使用的总 CPU 时间。累计时间超过阈值就降级，不管它中间让出过多少次 CPU。

另一个问题是低优先级队列的进程可能饥饿。解决方案是定期提升(priority boost)：每隔固定时间（比如 1 秒），把所有进程移回最高优先级队列，重新开始。这样低优先级进程至少能定期获得一些 CPU 时间。

:::

## 实时调度

实时调度(real-time scheduling)保证任务在确定的时间限制内完成，用于对延迟有严格要求的场景。

前面的算法（FCFS、SJF、RR、MLFQ）追求的是"平均性能好"。但有些任务不关心平均值，它们需要**保证**：这个任务必须在 10 毫秒内完成，一次都不能超。工业控制系统、音频处理、机器人控制都有这样的需求。

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
SCHED_DEADLINE  >  SCHED_FIFO / SCHED_RR  >  SCHED_OTHER (CFS)
```

`SCHED_OTHER` 是普通进程使用的调度策略，下一篇会详细讲。

:::expand 实时调度的实际应用

实时调度在用户态应用中比较少见。大多数 Linux 服务器上的进程都使用默认的 SCHED_OTHER（CFS）。实时调度主要用于：

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

## 小结

| 概念 | 说明 |
|------|------|
| CPU 调度(CPU Scheduling) | 操作系统从就绪进程中选择一个分配 CPU 的决策过程 |
| CPU 突发 / I/O 突发 | 进程交替执行计算和等待 I/O 的两个阶段 |
| 抢占式调度(Preemptive) | 调度器可以强制中断正在运行的进程 |
| 上下文切换(Context Switch) | 保存旧进程的 CPU 状态，恢复新进程的状态 |
| FCFS | 先来先服务，有护航效应 |
| SJF | 最短作业优先，最优平均等待时间但可能饥饿 |
| RR | 时间片轮转，公平但周转时间较差 |
| 优先级调度 | 按优先级选择，可能饥饿，需要老化机制 |
| MLFQ | 多级反馈队列，通过观察行为自动分类进程 |
| SCHED_FIFO | 实时先进先出，无时间片 |
| SCHED_RR | 实时轮转，同优先级内有时间片 |
| SCHED_DEADLINE | 基于截止期限的实时调度，有准入控制 |
| 优先级反转(Priority Inversion) | 高优先级进程被低优先级进程间接阻塞 |
| 优先级继承(Priority Inheritance) | 临时提升锁持有者的优先级以解决反转 |

**核心洞察**：没有完美的调度算法。FCFS 简单但不公平，SJF 最优但需要预知未来，RR 公平但增加切换开销。MLFQ 通过观察行为来适应，是实践中最有效的思路。所有调度算法本质上都在做同一个权衡：吞吐量（少切换、长时间片）和响应时间（多切换、短时间片）之间的取舍。

---

**Linux 源码入口**：
- [`kernel/sched/core.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/core.c) — `__schedule()`：调度器的核心入口，上下文切换发生在这里
- [`kernel/sched/rt.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/rt.c) — SCHED_FIFO 和 SCHED_RR 的实现
- [`kernel/sched/deadline.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/deadline.c) — SCHED_DEADLINE 的实现
- [`kernel/locking/rtmutex.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/rtmutex.c) — 优先级继承的实现
- [`arch/x86/kernel/process_64.c`](https://elixir.bootlin.com/linux/latest/source/arch/x86/kernel/process_64.c) — `__switch_to()`：x86_64 上下文切换的底层实现

---

## 动手做一做

本课是理论课，没有 zish 代码要写。但可以通过以下观察实验加深理解。

**1. 观察调度策略**

查看当前系统中各进程的调度策略和优先级：

```bash
# show scheduling policy and priority for all processes
ps -eo pid,cls,pri,ni,comm | head -20
```

`CLS` 列显示调度策略：`TS` 是 SCHED_OTHER（普通进程），`FF` 是 SCHED_FIFO，`RR` 是 SCHED_RR，`DLN` 是 SCHED_DEADLINE。`PRI` 是优先级，`NI` 是 nice 值。

**2. 观察上下文切换**

运行一个 CPU 密集型进程和一个 I/O 密集型进程，对比它们的上下文切换次数：

```bash
# CPU-bound: count to a billion
perf stat -e context-switches -- bash -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i+1)); done'

# I/O-bound: read a file repeatedly
perf stat -e context-switches -- bash -c 'for i in $(seq 100); do cat /dev/null; done'
```

CPU 密集型进程的上下文切换以非自愿切换(nonvoluntary)为主（被时间片打断），I/O 密集型进程以自愿切换(voluntary)为主（主动等 I/O）。

**3. 体验 nice 值**

启动两个 CPU 密集型进程，一个默认优先级，一个 nice 19（最低优先级），观察 CPU 分配比例：

```bash
# terminal 1: default priority
dd if=/dev/zero of=/dev/null bs=1M &

# terminal 2: lowest priority
nice -n 19 dd if=/dev/zero of=/dev/null bs=1M &

# observe CPU usage
top
```

两个进程都在做无意义的数据搬运，但 nice 19 的那个会获得明显更少的 CPU 时间。按 `q` 退出 top 后，用 `kill %1 %2` 停掉两个后台进程。

**4. 观察实时调度**

用 `chrt` 命令以 SCHED_FIFO 策略运行一个进程（需要 root）：

```bash
sudo chrt -f 50 sleep 5
# -f = SCHED_FIFO, priority 50

# verify
ps -eo pid,cls,pri,comm | grep sleep
```

注意：不要用 SCHED_FIFO 运行 CPU 密集型进程，它会独占 CPU 直到 RT throttling 介入。

---

<!-- 下一篇：Linux 调度器 -->
