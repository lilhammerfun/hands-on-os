# CPU 调度

- 写作时间：`2026-03-04 首次提交，2026-03-29 最近修改`
- 当前字符：`18261`

前面几课讲了进程的创建、信号和分组，但有一个问题一直没有回答：当系统中有几百个进程而 CPU 只有几个核心时，内核怎么决定让谁先跑？来看一个日常操作：在终端运行 `sleep 5 &` 然后 `ls`，两个命令似乎在同时执行。但大多数计算机的 CPU 核心数远少于运行中的进程数。一台普通的 Linux 服务器可能有 4 个 CPU 核心，却同时运行着几百个进程。四个核心同一时刻最多只能执行四个进程，其余进程都在等 CPU。

内核中有一个组件负责决定"下一个该让谁用 CPU"，这就是调度器(scheduler)。先从进程的行为模式讲起：进程的执行交替着计算和等待 I/O 两种阶段，这就是 **CPU 执行期与 I/O 等待期**，两者的比例决定了进程的性格，也决定了调度器必须面对的核心矛盾。矛盾的解法是**抢占式调度**——调度器可以强制中断正在运行的进程，不让任何人独占 CPU。抢占需要数据结构来支撑，内核为每个 CPU 核心维护一个**运行队列**，所有就绪进程在其中排队。有了运行队列，还需要一个机制来触发调度：内核用 **TIF_NEED_RESCHED** 标志把"决定要调度"和"真正执行调度"分离开来。最后是调度的执行：**上下文切换**保存旧进程的寄存器、恢复新进程的寄存器，让 CPU 跳到新进程上次被切走的位置继续执行。至于调度器用什么算法选择下一个进程，留给下一课。

## CPU 执行期与 I/O 等待期

CPU 执行期(CPU burst)是进程在 CPU 上连续执行计算的阶段；I/O 等待期(I/O burst)是进程等待 I/O 完成（磁盘读写、网络收发）的阶段。进程的执行就是这两种阶段的交替。

```
Process A (CPU-bound):          Process B (I/O-bound):
┌──────────────────┐            ┌──────┐
│                  │            │ CPU  │
│                  │            └──┬───┘
│  long CPU burst  │               │ I/O wait
│                  │            ┌──┴───┐
│                  │            │ CPU  │
│                  │            └──┬───┘
│                  │               │ I/O wait
└────────┬─────────┘            ┌──┴───┐
         │ short I/O wait       │ CPU  │
┌────────┴─────────┐            └──────┘
│                  │
│                  │
│  long CPU burst  │
│                  │
│                  │
└──────────────────┘
```

根据这两种阶段的比例，进程大致分两类。

**CPU 密集型进程**(CPU-bound process)大部分时间在做计算，CPU 执行期长，I/O 等待期少。编译器、科学计算、视频编码都属于这一类。这类进程希望一直占着 CPU 不被打断，因为每次被打断再恢复都有开销。

**I/O 密集型进程**(I/O-bound process)大部分时间在等 I/O，CPU 执行期短，频繁进出睡眠状态。Web 服务器、数据库、文本编辑器都属于这一类。这类进程每次只用一小段 CPU 就去等 I/O 了，但它们对响应时间很敏感：用户按下键盘，编辑器应该立刻响应，而不是排在一个长计算任务后面等着。

这两类进程的需求是矛盾的。CPU 密集型希望长时间独占 CPU 以提高吞吐量，I/O 密集型希望一旦 I/O 完成就立刻获得 CPU 以降低延迟。调度器必须在这两种需求之间做权衡。

这个分类对程序员有直接的实际意义。当你决定线程池大小时，需要先判断你的工作负载属于哪一类。CPU 密集型任务的线程数通常设为 CPU 核心数，因为即使多创建线程，CPU 执行期内线程之间只是互相抢占，不会加速。而 I/O 密集型任务的线程数可以远多于核心数，因为大部分线程都在等 I/O，真正需要 CPU 的线程在任一时刻很少。一个处理 HTTP 请求的 Web 服务器，大部分时间花在等待网络和数据库响应上，4 核机器开 200 个线程是完全合理的。

## 抢占式调度

抢占式调度(preemptive scheduling)是调度器可以强制中断正在运行的进程、把 CPU 交给另一个进程的调度方式。

内核用 `task_struct` 中的 `__state` 字段记录每个进程的状态。调度决策发生在四个时刻，每个时刻对应一次 `__state` 的变化：

1. **进程从运行变为等待**（主动让出）：进程调用了阻塞操作（如 `read()` 等待磁盘），`__state` 从 `TASK_RUNNING`(0) 变为 `TASK_INTERRUPTIBLE`（可被信号唤醒的睡眠）或 `TASK_UNINTERRUPTIBLE`（不可被信号唤醒的睡眠）。CPU 空出来了，调度器必须选下一个进程。
2. **进程从运行变为就绪**（被动让出）：当前进程的时间片用完了，或者一个更高优先级的进程变为就绪，调度器就会抢占当前进程，把 CPU 交给别人。`__state` 不变，仍然是 `TASK_RUNNING`，因为进程还是可运行的，只是暂时没拿到 CPU。
3. **进程从等待变为就绪**：I/O 完成，进程被唤醒，`__state` 从睡眠态变回 `TASK_RUNNING`。调度器决定是否让它立刻抢占当前运行的进程。
4. **进程终止**：进程调用 `exit()`，`__state` 变为 `TASK_DEAD`，CPU 空出来。

如果调度器只在第 1 和第 4 个时刻做决策，就是**非抢占式调度**(non-preemptive scheduling)：进程一旦获得 CPU 就一直执行到结束或阻塞，不会被强制打断。这种方式简单但有个明显问题：一个死循环进程会永远占着 CPU，其他进程全部饿死。

现代操作系统都使用抢占式调度，在所有四个时刻都能做决策。抢占的触发机制是硬件定时器中断：CPU 每隔固定间隔（通常 1ms 或 4ms）产生一个时钟中断，内核在中断处理中检查当前进程是否该让出 CPU。这就是为什么你的死循环不会冻结系统——即使你写了一个 `while(true) {}`，时钟中断依然会打断它，内核依然能调度其他进程。

具体来说，`read()`、`sleep()`、`pthread_mutex_lock()` 这些函数在条件不满足时（数据没到、时间没到、锁被别人持有）都会触发决策点 1：内核把进程状态设为睡眠，然后让出 CPU 给其他进程。

## 运行队列

运行队列(run queue)是内核为每个 CPU 核心维护的就绪进程集合，所有等待获得 CPU 的进程都在其中排队。

你可能会想：为什么不用一个全局队列让所有核心共享？问题在于，每次调度决策都要从队列中取进程，多个核心同时取就必须加锁。核心越多，锁竞争越激烈，调度本身反而成了瓶颈。所以 Linux 给每个核心各自维护一个队列，让调度决策完全独立，不需要跨核心协调。

运行队列在内核中的实现是 `struct rq`：

```c
// kernel/sched/sched.h (simplified)
struct rq {
    unsigned int        nr_running;     // 当前队列中就绪进程的数量
    struct task_struct  *curr;          // 当前正在这个 CPU 上运行的进程
    struct cfs_rq       cfs;            // CFS 调度器的就绪队列
    struct rt_rq        rt;             // 实时调度器的就绪队列
    struct dl_rq        dl;             // Deadline 调度器的就绪队列
    // ...
};
```

`rq->curr` 指向当前正在运行的进程，其余就绪进程在 `cfs`、`rt`、`dl` 这几个子队列中等待，每个子队列对应一种调度策略，下一课会详细介绍它们的区别。调度器要做的事情就是：从 `rq` 中选一个进程替换 `curr`。

`rq->curr` 指向的是一个 `task_struct`。进程生命周期一课介绍过 `task_struct` 是内核中表示进程/线程的核心结构体，这里来看它与调度相关的字段：

```c
// include/linux/sched.h (simplified)
struct task_struct {
    unsigned int            __state;        // 进程状态：0=RUNNING, 非0=睡眠/停止/死亡
    struct thread_info      thread_info;    // 低层信息，包含 TIF_NEED_RESCHED 标志
    const struct sched_class *sched_class;  // 该进程使用哪个调度器类（CFS/RT/DL）
    int                     prio;           // 动态优先级（调度器实际使用的值）
    struct mm_struct        *mm;            // 地址空间（页表），切换进程时要切换它
    struct thread_struct    thread;         // 被切走时保存的 CPU 寄存器状态
    // ...
};
```

前面四个调度时刻已经介绍了 `__state` 的取值，这里再补充一点：`__state` 为 0（`TASK_RUNNING`）的进程才会出现在运行队列中，非 0 的进程（睡眠、停止、死亡）不在队列里。`sched_class` 是一个函数指针表，指向该进程使用的调度器类（CFS、RT 或 Deadline），调度器通过这个指针调用具体算法的选择逻辑。`thread_info` 中有一个标志位 `TIF_NEED_RESCHED`，下一节会看到内核如何用它来标记"这个进程该让出 CPU 了"。

把这些拼起来看整体关系：

```
CPU 0                          CPU 1
┌──────────────┐              ┌──────────────┐
│   struct rq  │              │   struct rq  │
│  .curr ──────┼──→ task A    │  .curr ──────┼──→ task C
│  .cfs (tree) │              │  .cfs (tree) │
│    task B    │              │    task D    │
│    task E    │              │              │
└──────────────┘              └──────────────┘
```

每个 CPU 的 `rq` 维护该 CPU 上的就绪进程集合。`rq->curr` 指向正在运行的那个 `task_struct`，其余就绪进程在子队列中等待。调度就是把 `rq->curr` 从一个 `task_struct` 换到另一个，同时切换寄存器和页表。

:::expand load average 的含义

当你在终端运行 `uptime`，会看到三个 load average 数值：

```bash
$ uptime
14:19  up 2 days, 15:40, 12 users, load averages: 1.86 1.89 2.05
```

末尾的三个数字 1.86、1.89、2.05 就是 load average，分别对应过去 1 分钟、5 分钟、15 分钟的平均值。load average 衡量的是系统的 CPU 需求总量：正在 CPU 上运行的进程数 + 在运行队列中等待 CPU 的进程数 + 处于不可中断睡眠(TASK_UNINTERRUPTIBLE)等待 I/O 的进程数。之所以把正在运行的也算进去，是因为 load average 要回答的问题不是"有多少进程在等"，而是"系统总共需要多少个 CPU 才能让所有进程不用等"。

所以判断系统是否过载，要拿 load average 和 CPU 核心数比。如果这台机器有 2 个核心，load average 1.86 意味着平均需要 1.86 个 CPU，2 个核心基本够用。如果 load average 长期超过核心数，说明进程在排队，响应会变慢。

但因为不可中断睡眠也被计入，load average 高不一定是 CPU 不够用，也可能是大量进程在等磁盘 I/O（比如 NFS 卡住）。想区分这两种情况，可以用 `vmstat`：

```bash
$ vmstat 1
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 3  0      0 245612  12345 678900    0    0     0     0  150  300 45 10 45  0  0
 1  5      0 245100  12345 679200    0    0  8000     0  200  400  5  3  2 90  0
```

第一列 `r` 是运行队列中等待 CPU 的进程数，`b` 是处于不可中断睡眠的进程数。最后几列是 CPU 时间的百分比分布：`us`(用户态)、`sy`(内核态)、`id`(空闲)、`wa`(等 I/O)。第一行 `r=3, wa=0` 说明 CPU 确实忙；第二行 `r=1, b=5, wa=90` 说明 CPU 大部分时间在等 I/O，瓶颈在磁盘而不是 CPU。

也可以用 `mpstat -P ALL` 看每个核心各自的利用率，确认是所有核心都忙还是只有个别核心在扛。

:::

## TIF_NEED_RESCHED

`TIF_NEED_RESCHED` 是内核在 `thread_info` 中维护的一个标志位。TIF 前缀是 Thread Info Flag 的缩写，NEED_RESCHED 顾名思义是"需要重新调度"。整个标志的含义是"当前进程需要让出 CPU，在最近的安全时刻执行调度"。

为什么需要这样一个标志？因为"发现该调度了"和"真正执行调度"往往不在同一个时刻。比如时钟中断处理函数发现当前进程的时间片用完了，但中断处理上下文有很多限制（不能睡眠、不能做复杂操作），不适合在这里直接执行调度。所以内核把调度分成两步：先设标志，稍后在安全的时刻（中断返回、系统调用返回）检查标志并执行调度。

所有触发调度的路径最终都汇聚到 `kernel/sched/core.c` 中的 `__schedule()` 函数：

```c
// kernel/sched/core.c (simplified, v6.12)
static void __schedule(unsigned int sched_mode)
{
    struct task_struct *prev, *next;
    struct rq *rq;

    rq = this_rq();           // 取当前 CPU 的运行队列
    prev = rq->curr;          // 当前正在运行的进程

    // 1. 如果当前进程不再是可运行状态（比如调了 read() 进入睡眠），
    //    把它从运行队列移除
    if (prev->__state) {
        deactivate_task(rq, prev, DEQUEUE_SLEEP);
    }

    // 2. 从运行队列中选择下一个进程
    next = pick_next_task(rq, prev);

    // 3. 如果选出来的不是当前进程，执行上下文切换
    if (likely(prev != next)) {
        rq = context_switch(rq, prev, next);
    }
}
```

三步：移除旧进程（如果它不再就绪）、选择新进程、切换。`prev->__state` 非 0 说明进程已经不是 RUNNING 状态（比如调用 `read()` 后被设为睡眠），需要从运行队列中摘掉。`pick_next_task()` 通过 `sched_class` 调用具体调度算法（CFS 的 vruntime 最小者、RT 的最高优先级等），这部分逻辑下一课展开。

`__schedule()` 不会凭空执行，必须有人调用它。前面提到的四个调度时刻，每个时刻在内核中对应一条不同的代码路径。

**主动让出**。进程调用了阻塞操作（比如读管道时还没有数据），内核把进程状态设为睡眠，然后直接调用 `schedule()`。`schedule()` 是 `__schedule()` 的包装函数。

来看一个具体的例子。进程生命周期一课讲过，fd 指向内核中的文件对象，不同类型的文件对象（管道、磁盘文件、socket）各自有不同的读写函数。当进程对管道 fd 调用 `read()` 时，内核最终会调用管道的 `pipe_read()`。如果管道中还没有数据，`pipe_read()` 会这样做：

```c
// fs/pipe.c (simplified)
static ssize_t pipe_read(struct kiocb *iocb, struct iov_iter *to)
{
    DEFINE_WAIT(wait);                           // 在栈上创建一个等待项
    // ...
    for (;;) {
        // 检查管道里有没有数据
        if (pipe_buf_cnt(pipe))
            break;                               // 有数据了，跳出循环去读

        // 没有数据，准备睡眠
        prepare_to_wait(&pipe->rd_wait, &wait,
                        TASK_INTERRUPTIBLE);      // 把自己加入管道的等待队列，
                                                  // 同时把 __state 设为 TASK_INTERRUPTIBLE
        schedule();                               // 让出 CPU，进程在这里睡眠
        // 被唤醒后回到循环开头，重新检查管道
    }
    finish_wait(&pipe->rd_wait, &wait);           // 离开等待队列
    // ... 读取数据并返回给用户 ...
}
```

从调度器的视角看，这段代码做了两件事：把进程加入管道的等待队列(wait queue) `pipe->rd_wait`，同时把 `__state` 设为 `TASK_INTERRUPTIBLE`。随后 `schedule()` 调用 `__schedule()`，因为 `prev->__state` 非零，进程会被从运行队列移除。此时进程不在运行队列里，也不占用 CPU，它在等待队列中等待数据到达。当管道写端写入数据时，内核会唤醒 `pipe->rd_wait` 上睡眠的进程，把它的 `__state` 改回 `TASK_RUNNING` 并放回运行队列。简单说：没数据就睡，有数据就醒。

运行队列决定"谁在 CPU 上运行"，等待队列决定"事件发生时唤醒谁"。

:::expand 等待队列

等待队列在内核中是一个具体的数据结构，由两个结构体组成：

```c
// include/linux/wait.h (simplified)
struct wait_queue_head {
    spinlock_t           lock;
    struct list_head     head;    // 双向链表头，串联所有等待项
};

struct wait_queue_entry {
    struct task_struct  *private;  // 指向等待的进程
    int (*func)(...);             // 唤醒回调函数
    struct list_head     entry;   // 链表节点，挂在 wait_queue_head.head 上
};
```

内核中每个可等待的资源都内嵌一个 `wait_queue_head`。管道有 `pipe->rd_wait` 和 `pipe->wr_wait`，socket 有 `sock->wq`，每个块设备 I/O 请求也有自己的等待队列。`prepare_to_wait()` 把当前进程包装成一个 `wait_queue_entry`，挂到目标资源的 `wait_queue_head` 链表上。

这意味着一个进程如果想同时等待多个资源（比如同时监听多个 socket），就需要把自己挂到多个 `wait_queue_head` 上。这个思路正是 `epoll` 等 I/O 多路复用机制的基础，后续事件驱动章节会展开。
:::

**时间片用完**。这条路径比较间接，涉及一个尚未正式介绍的概念：中断(interrupt)。这里只需要理解一个事实：硬件定时器每隔固定间隔（通常几毫秒）向 CPU 发出一个电信号，CPU 收到信号后会暂停正在执行的用户程序，强制跳转到内核预先注册的处理函数。这就是时钟中断(timer interrupt)。内核在时钟中断的处理函数中调用 `scheduler_tick()`：

```c
// kernel/sched/core.c (simplified)
void scheduler_tick(void)
{
    struct rq *rq = this_rq();
    struct task_struct *curr = rq->curr;

    curr->sched_class->task_tick(rq, curr, 0);
    // CFS 的 task_tick_fair() 会检查 vruntime，
    // 如果当前进程该让出了，就调用 resched_curr()
}
```

`scheduler_tick()` 本身不调用 `__schedule()`。它只做一件事：检查当前进程是否用完了时间片，如果用完了就调用 `resched_curr()` 在当前进程上设置 `TIF_NEED_RESCHED` 标志。`resched_curr()` 的实现很简单，就是往 `thread_info.flags` 里写一个标志位：

```c
// kernel/sched/core.c (simplified)
void resched_curr(struct rq *rq)
{
    set_tsk_need_resched(rq->curr);
    // 在 rq->curr->thread_info.flags 中设置 TIF_NEED_RESCHED
}
```

真正的调度发生在中断处理完毕之后。时钟中断处理函数执行完 `scheduler_tick()` 后，CPU 并不会立刻回到用户程序。在返回用户态之前，内核会检查当前进程的 `TIF_NEED_RESCHED` 标志。如果标志被设置了，内核就在这里调用 `schedule()` 执行调度，把 CPU 切换给另一个进程：

```c
// 中断返回用户态前的检查（简化）
if (test_thread_flag(TIF_NEED_RESCHED))
    schedule();   // 标志被设置了，切换到另一个进程
// 然后才返回用户态，继续执行用户程序
```

**唤醒抢占**。一个进程被唤醒（比如它等的 I/O 完成了），内核调用 `try_to_wake_up()` 把它放回运行队列。如果被唤醒的进程优先级高于当前正在运行的进程，内核会在当前进程上设 `TIF_NEED_RESCHED`，让它在下一次中断返回用户态前被抢占：

```c
// kernel/sched/core.c (simplified)
static int try_to_wake_up(struct task_struct *p, ...)
{
    // 把进程 p 的 __state 设回 RUNNING，放回运行队列
    activate_task(rq, p, ...);

    // 检查被唤醒的进程 p 是否应该抢占 rq->curr
    check_preempt_curr(rq, p, ...);
    // 如果 p 的优先级更高，对 rq->curr 调用 resched_curr()
}
```

**进程终止**。进程调用 `exit()` 后，内核执行 `do_exit()` 做清理工作，最后调用 `do_task_dead()`。这个函数把 `__state` 设为 `TASK_DEAD`，然后调用 `__schedule()` 切走，永不返回：

```c
// kernel/sched/core.c
void __noreturn do_task_dead(void)
{
    set_special_state(TASK_DEAD);
    __schedule(SM_NONE);            // 切走，永不返回
    BUG();                          // 如果走到这里说明内核有 bug
}
```

四条路径汇总：

| 调度时刻 | 触发方式 | 关键函数 |
|---------|---------|---------|
| 主动让出（阻塞） | 进程直接调用 `schedule()` | `schedule()` → `__schedule()` |
| 时间片用完 | 时钟中断 → 设 `TIF_NEED_RESCHED` → 中断返回时调度 | `scheduler_tick()` → `resched_curr()` |
| 唤醒抢占 | 唤醒进程 → 比较优先级 → 设 `TIF_NEED_RESCHED` | `try_to_wake_up()` → `check_preempt_curr()` |
| 进程终止 | `do_exit()` → 切走不返回 | `do_task_dead()` → `__schedule()` |

其中两条路径（时间片用完、唤醒抢占）使用了 `TIF_NEED_RESCHED` 做间接调度。这个设计把"决定要调度"和"真正执行调度"分离开了：设标志的地方可以是任何上下文（中断处理、系统调用），而真正的调度只发生在安全的时刻（中断返回、系统调用返回）。

你可以从 `/proc/[pid]/status` 中读取单个进程的上下文切换统计，观察这四条路径的效果：

```bash
grep ctxt /proc/self/status
voluntary_ctxt_switches:        10
nonvoluntary_ctxt_switches:     3
```

`voluntary`（自愿切换）对应主动让出和进程终止——进程自己调用了 `schedule()`。`nonvoluntary`（非自愿切换）对应时间片用完和唤醒抢占——进程被 `TIF_NEED_RESCHED` 标志强制切走。一个 CPU 密集型进程会累积大量 nonvoluntary 切换（它从不主动让出，全靠时钟中断打断），而一个 I/O 密集型进程会累积大量 voluntary 切换（它频繁调用 `read()` 等阻塞操作，每次都主动让出 CPU）。

## 上下文切换

上下文切换(context switch)是内核将 CPU 从一个进程交给另一个进程的操作：保存当前进程的 CPU 状态，恢复下一个进程之前保存的 CPU 状态。

每个 `task_struct` 中有一个 `thread_struct`，专门存放进程被切走时的 CPU 状态。在 x86-64 上：

```c
// arch/x86/include/asm/processor.h (simplified)
struct thread_struct {
    unsigned long       sp;     // 内核栈指针（RSP）
    unsigned long       ip;     // 指令指针，保存被切走时执行到哪里
    unsigned long       fs;     // FS 段寄存器（TLS 基址，线程一课讲过）
    unsigned long       cr2;    // 最近一次缺页异常的地址
    struct fpu          fpu;    // 浮点/SIMD 寄存器状态
    // ...
};
```

`sp` 和 `ip` 是上下文切换的核心。`ip` 就是大名鼎鼎的程序计数器(program counter, PC)，记录 CPU 下一条要执行的指令地址。x86 架构把它叫做 `ip`（64 位下是 `rip`），ARM 等其他架构则直接叫 `pc`，指的是同一个东西。当调度器决定从进程 A 切换到进程 B 时，内核把 A 的栈指针和程序计数器存进 A 的 `thread_struct`，再从 B 的 `thread_struct` 中恢复之前保存的值，CPU 就跳到 B 上次被切走的位置继续执行了。

:::expand 栈指针(stack pointer)

要理解栈指针，先看进程的内存地址空间是怎么布局的。操作系统给每个进程分配一个虚拟地址空间，从低地址到高地址划分为几个区域：

```
高地址
┌─────────────────────────┐
│       内核空间            │  ← 用户进程不能直接访问
├─────────────────────────┤
│          ↓ 栈            │  ← 向低地址增长
│                         │
│      （未映射的间隙）      │
│                         │
│          ↑ 堆            │  ← 向高地址增长
├─────────────────────────┤
│        .bss             │  ← 未初始化的全局变量（清零）
├─────────────────────────┤
│        .data            │  ← 已初始化的全局变量
├─────────────────────────┤
│        .text            │  ← 编译后的机器指令
└─────────────────────────┘
低地址
```

`.text` 存放程序的机器指令，`.data` 和 `.bss` 存放全局变量。堆(heap)和栈(stack)从两端相向增长，共享中间的可用空间。两者的区别不是硬件层面的，它们都在 RAM 中，区别在于管理策略。

**堆**用于存放需要跨越函数生命周期的数据。程序通过 `malloc()` 申请空间、`free()` 释放空间，由内存分配器管理。

**栈**用于函数调用。函数调用天然符合后进先出(LIFO)的模式：`main()` 调用 `add()`，`add()` 必须先返回 `main()` 才能继续。所以栈只需要一个指针来管理，不需要复杂的分配和搜索。

但是，编译器在编译时只能确定每个函数需要多少栈空间（局部变量、返回地址等），却不知道这些空间的起始地址在哪里。因为运行时的调用深度无法预测——`main()` 会不会调用 `add()`、`add()` 会不会再调用 `multiply()`，这取决于运行时的输入和分支条件。所以需要一个指针在运行时动态标记"栈顶在哪"。有了栈顶位置，函数的栈空间就是从栈顶开始、向下延伸函数所需大小的那一段。

这个指针就是栈指针(stack pointer, SP)，它是一个寄存器，保存着当前栈"顶部"的地址。当函数被调用时，栈指针向低地址移动，腾出空间存放局部变量和返回地址，这块空间叫做栈帧(stack frame)；当函数返回时，栈指针向高地址移回，栈帧就被释放了。

```
高地址
┌──────────────────┐
│  main() 的栈帧    │  ← 先调用，在上面
├──────────────────┤
│  add() 的栈帧     │  ← 后调用，在下面
├──────────────────┤
│                  │  ← SP 指向这里（栈顶）
│   （未使用空间）   │
└──────────────────┘
低地址
```

所谓"栈向下增长"，意思是栈指针的值在变小。比如栈指针在地址 1000，函数需要 32 字节，栈指针就移到 968。编译器在编译时就确定了每个函数需要多少栈空间，生成对应的指令来移动栈指针。比如在 RISC-V 上，函数开头的 `addi sp, sp, -32` 把栈指针下移 32 字节来预留空间，函数结尾的 `addi sp, sp, 32` 再移回来。

每个线程都有自己的栈，也就有自己的栈指针。理解了这一点，就能理解上下文切换为什么要保存 `sp`：切换栈指针就等于切换了整个调用栈，新进程恢复的不仅是一个寄存器的值，而是它之前所有函数调用的完整现场。
:::

`__schedule()` 在选出下一个进程后调用 `context_switch()` 执行切换：

```c
// kernel/sched/core.c (simplified)
static struct rq *context_switch(struct rq *rq,
                                  struct task_struct *prev,
                                  struct task_struct *next)
{
    // 1. 切换地址空间（页表）
    if (!next->mm) {
        // next 是内核线程，没有用户地址空间，借用 prev 的
        next->active_mm = prev->active_mm;
    } else {
        switch_mm_irqs_off(prev->active_mm, next->mm, next);
        // 写 CR3 寄存器，加载 next 的页表
    }

    // 2. 切换寄存器状态
    switch_to(prev, next, prev);
    // 保存 prev 的寄存器到 prev->thread（sp, ip 等）
    // 恢复 next 的寄存器从 next->thread
    // 包括栈指针 RSP 和指令指针 RIP

    return rq;
}
```

`context_switch()` 分两步完成切换。第一步，`switch_mm_irqs_off()` 切换内存映射。每个进程都有自己的虚拟地址空间，相同的虚拟地址在不同进程中指向不同的物理内存。切换进程时，内核需要告诉 CPU "从现在开始使用 B 的地址映射"，这样 B 访问自己的代码和数据时才能找到正确的物理内存。虚拟地址空间和内存映射的具体机制会在内存管理章节详细介绍。第二步，`switch_to()` 切换寄存器状态：把 A 的寄存器（包括栈指针和程序计数器）保存到 A 的 `thread_struct`，再从 B 的 `thread_struct` 中恢复。两步完成后，CPU 使用的是 B 的地址映射和 B 的寄存器状态：程序计数器指向 B 上次被切走的那条指令，CPU 从那里继续执行；栈指针指向 B 的栈顶，后续的函数调用会在 B 的栈上分配栈帧。

:::thinking 上下文切换的开销具体有多大？

上下文切换本身（保存/恢复寄存器 + 切换页表）大约需要 1-5 微秒。但间接开销（TLB 失效 + 缓存冷启动）可能导致后续几十微秒到几百微秒的性能下降，这个间接开销才是上下文切换真正昂贵的地方。

可以用 `perf stat` 观察系统的上下文切换次数：

```bash
perf stat -e context-switches,cpu-migrations sleep 5
```

`context-switches` 统计观测期间发生的上下文切换总次数，`cpu-migrations` 统计进程从一个 CPU 核心迁移到另一个核心的次数（迁移意味着新核心上的缓存全是冷的，开销更大）。

这是上下文切换频率在实际架构选型中的一个典型影响：线程池(thread pool)模式为什么通常优于每请求一线程(thread-per-request)模式？如果一个 Web 服务器为每个请求创建一个线程，高并发时可能同时存在数千个线程，调度器在它们之间频繁切换，TLB 和缓存反复失效。而线程池只维护固定数量的工作线程（通常等于或略多于 CPU 核心数），大量请求排队由少数线程依次处理，上下文切换次数大幅减少，CPU 缓存的命中率也更高。

:::

上下文切换的频率取决于调度算法。时间片越短，切换越频繁，进程的响应延迟越低，但切换开销占比越高。时间片越长，切换越少，吞吐量越高，但进程的等待时间越长。这是调度器设计的核心权衡，下一课的调度算法就在这个权衡上做文章。

## 小结

| 概念 | 说明 |
|------|------|
| CPU 执行期 / I/O 等待期 | 进程交替执行计算和等待 I/O 的两个阶段 |
| CPU 密集型 / I/O 密集型 | 根据两种阶段的比例划分进程类型，影响调度策略和线程池设计 |
| 抢占式调度(Preemptive) | 调度器可以强制中断正在运行的进程，由定时器中断触发 |
| 运行队列(Run Queue) | 每个 CPU 核心一个 `struct rq`，`curr` 指向当前运行的进程 |
| `TIF_NEED_RESCHED` | 延迟调度标志，把"决定要调度"和"执行调度"分离 |
| `__schedule()` | 调度的核心入口：移除旧进程、选择新进程、上下文切换 |
| 上下文切换(Context Switch) | `context_switch()` → 切换页表(CR3) + 切换寄存器(`switch_to`) |

回过头来看，CPU 调度做的事情其实很简单：每个 CPU 核心维护一个运行队列 `rq`，`rq->curr` 指向当前正在运行的进程，其余就绪进程在子队列中等待。调度器的全部工作就是不断地更换 `curr` 所指向的进程，决定谁获得当前的时间片。

这里有一个容易混淆的地方：`__state` 为 `TASK_RUNNING` 的进程不一定正在 CPU 上运行，它只是"可以运行"。运行队列中可能有很多 `TASK_RUNNING` 的进程，但每个 CPU 核心同一时刻只有一个 `curr`。只有 `curr` 才是真正占用 CPU 时间片的进程，其余 `TASK_RUNNING` 的进程都在子队列里等待被调度算法选中。唤醒一个睡眠进程，也只是把它的 `__state` 改回 `TASK_RUNNING` 放回子队列，让它重新获得被选中的资格，而不是让它立刻上 CPU。不过，如果被唤醒的进程优先级高于当前 `curr`，内核会设 `TIF_NEED_RESCHED`，让 `curr` 在下一个安全时刻被抢占，所以高优先级进程被唤醒后可能很快就成为新的 `curr`。

本课讲的是 `curr` 的更换何时触发、如何执行（四条路径和上下文切换）。至于调度算法如何从子队列中选出下一个进程，是下一课的内容。

---

**Linux 源码入口**：
- [`kernel/sched/core.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/core.c) — `__schedule()`、`schedule()`、`scheduler_tick()`、`try_to_wake_up()`、`context_switch()`
- [`kernel/sched/sched.h`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/sched.h) — `struct rq` 定义
- [`arch/x86/kernel/process_64.c`](https://elixir.bootlin.com/linux/latest/source/arch/x86/kernel/process_64.c) — `__switch_to()`：x86-64 上下文切换的底层实现
- [`arch/x86/include/asm/processor.h`](https://elixir.bootlin.com/linux/latest/source/arch/x86/include/asm/processor.h) — `struct thread_struct` 定义
