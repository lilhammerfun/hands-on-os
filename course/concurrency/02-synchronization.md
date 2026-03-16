# 同步原语

上一课说到，线程共享地址空间是一把双刃剑：数据共享变得容易，但多个线程同时读写同一个变量，结果就不可预测了。来看一个最直观的例子——两个线程各自对共享计数器执行一百万次 `counter++`，预期结果是两百万。实际会发生什么：

```c
#include <pthread.h>
#include <stdio.h>

int counter = 0;

void *increment(void *arg) {
    for (int i = 0; i < 1000000; i++)
        counter++;
    return NULL;
}

int main() {
    pthread_t t1, t2;
    pthread_create(&t1, NULL, increment, NULL);
    pthread_create(&t2, NULL, increment, NULL);
    pthread_join(t1, NULL);
    pthread_join(t2, NULL);
    printf("counter = %d\n", counter);
}
```

```
$ gcc -O0 -pthread counter.c && ./a.out
counter = 1325017
$ ./a.out
counter = 1481923
$ ./a.out
counter = 1379644
```

counter 的值每次运行都不同，而且都比预期的两百万小。`counter++` 看起来是一条语句，但编译后是三条指令：从内存加载当前值到寄存器、寄存器加一、把结果写回内存。两个线程交错执行这三条指令时，就会丢失更新。

程序的结果取决于两个线程谁先执行、谁后执行，这就是**竞态条件**(race condition)。产生竞态的根源是那段访问共享变量的代码——**临界区**(critical section)。要消除竞态，就要保证同一时刻只有一个线程能执行临界区。但纯软件的互斥算法在现代 CPU 上会被指令重排破坏，所以需要**硬件原子操作**（内存屏障、CAS）来提供正确的底层保证。有了原子操作，就可以构建**自旋锁**(spinlock)——拿不到锁就原地循环等待。但忙等浪费 CPU，等待者应该让出 CPU 去睡眠，这就是**互斥锁**(mutex)的做法。mutex 解决了互斥，但有些场景不是等锁，而是等某个条件成立（比如"缓冲区非空"），这就需要**条件变量**(condition variable)和**信号量**(semaphore)。无论哪种原语，用户态的"检查并睡眠"都面临跨越用户态-内核态边界的原子性问题，Linux 的 **Futex** 系统调用正是为此而生——它是 glibc 中所有 pthread 同步原语的共同基础设施。最后，三个**经典同步问题**把这些原语组合在一起，展示真实并发场景下的设计模式。

## 竞态条件与临界区

竞态条件(race condition)是程序的执行结果依赖于多个线程的相对执行顺序的情况。临界区(critical section)是访问共享资源的代码区域。

回到开篇的 `counter++`。它编译成三条指令：load（读取 counter 到寄存器）、add（寄存器加一）、store（写回 counter）。两个线程交错执行时会出现这样的情况：

| 时刻 | 线程 A | 线程 B | counter（内存） |
|------|--------|--------|----------------|
| 1 | load counter → 寄存器 = 0 | | 0 |
| 2 | | load counter → 寄存器 = 0 | 0 |
| 3 | add → 寄存器 = 1 | | 0 |
| 4 | | add → 寄存器 = 1 | 0 |
| 5 | store → counter = 1 | | 1 |
| 6 | | store → counter = 1 | 1 |

两个线程各自加了一次，counter 应该是 2，实际是 1。线程 B 在时刻 2 读到的是旧值 0，基于旧值计算并写入，覆盖了线程 A 的结果。这就是丢失更新(lost update)。百万次循环中只要发生几次这样的交错，最终结果就会偏小。

要正确保护临界区，需要满足三个要求：

**互斥(mutual exclusion)**：同一时刻最多一个线程执行临界区代码。这是最基本的要求，如果两个线程可以同时在临界区内，竞态条件就没有被消除。

**进展**：如果没有线程在临界区内，且有线程想进入，那么必须在有限时间内让某个线程进入。换句话说，不能出现"所有线程都在门口等、但谁也进不去"的情况。

**有限等待(bounded waiting)**：一个线程请求进入临界区后，其他线程进入临界区的次数有上限。这防止某个线程被永远"插队"而饿死(starvation)。

:::thinking Peterson 算法在现代硬件上能正确工作吗？

在硬件原子指令出现之前，有人尝试用纯软件方式解决临界区问题。Peterson 算法（1981）是最经典的方案，它只用两个共享变量就实现了两个线程之间的互斥。

算法的思路是这样的：每个线程想进临界区之前，先做两件事。第一，在 `flag` 数组中声明自己的意图（"我想进去"）。第二，把 `turn` 设给对方（"你先请"）。然后检查：对方是否也想进来（`flag[对方] == 1`），并且 turn 还给着对方（`turn == 对方`）？如果两个条件都成立，说明对方也想进来且拥有优先权，那就等着。否则自己进入临界区。

```c
int flag[2] = {0, 0};  // flag[i] = 1 表示线程 i 想进入临界区
int turn;               // 当两个线程都想进时，turn 决定谁优先

// 线程 i 的代码（i = 0 或 1）
flag[i] = 1;            // 第一步：声明"我想进临界区"
turn = 1 - i;           // 第二步：把优先权让给对方
while (flag[1-i] && turn == 1-i)
    ;                   // 对方也想进、且 turn 给着对方 → 等待
// —— 临界区 ——
flag[i] = 0;            // 离开：撤销意图
```

为什么这能保证互斥？假设线程 0 和线程 1 同时想进入临界区。两个线程都把 `flag` 设为 1，然后分别执行 `turn = 1` 和 `turn = 0`。`turn` 是一个普通整数，两次赋值有先后，最终 `turn` 只会是 0 或 1。假设 `turn` 最终是 1（线程 1 的赋值 `turn = 0` 先执行，然后被线程 0 的 `turn = 1` 覆盖了）。此时线程 0 检查 while 条件：`flag[1] == 1`（真）且 `turn == 1`（真），线程 0 等待。线程 1 检查：`flag[0] == 1`（真）但 `turn == 0`（假，因为 turn 是 1），while 条件不成立，线程 1 进入临界区。无论 turn 最终是什么值，只有一个线程能通过 while 循环。

在顺序一致性(sequential consistency)内存模型下，这个算法是正确的。所谓顺序一致性，就是所有线程看到的内存操作顺序与程序代码中的顺序一致。

但现代 CPU 会重排(reorder)指令来提高性能。只要重排不改变单线程的执行结果，CPU 就认为这种重排是合法的。问题是，对单线程合法的重排，对多线程可能产生灾难性的后果。

具体到 Peterson 算法：`flag[i] = 1` 和 `turn = 1 - i` 是两个独立的 store 操作，CPU 可能把它们重排。如果线程 0 先执行了 `turn = 1`，但还没执行 `flag[0] = 1`，此时线程 1 检查 `flag[0]`，看到 0，认为线程 0 没有意图进入临界区，直接通过 while 循环。与此同时线程 0 也完成了 `flag[0] = 1` 并通过 while 循环（因为 `turn == 0`，不满足等待条件）。两个线程同时进入了临界区，互斥被破坏了。

这不是理论上的问题。在 ARM、RISC-V 等弱内存模型(weak memory model)的架构上，store-store 重排是真实存在的。即使在 x86（TSO 模型，store-store 不重排）上，store-load 重排也可能破坏某些算法的正确性。

结论是：纯软件方案在现代 CPU 上不可靠。要让多线程正确同步，必须使用硬件提供的原子指令和内存屏障。
:::

## 硬件原子操作

原子操作(atomic operation)是硬件保证以不可分割的方式执行的操作，其他线程无法观察到操作的中间状态。

上一节指出 Peterson 算法在现代硬件上失效，原因是 CPU 会重排内存访问。要解决这个问题，需要两样东西：阻止重排的内存屏障，和保证读-改-写不可分割的原子指令。

**内存屏障(memory barrier / memory fence)** 是一条特殊指令，阻止 CPU 跨越屏障重排内存访问。屏障之前的内存操作必须在屏障之后的内存操作之前完成。Linux 内核提供了三种屏障宏：`smp_mb()`（全屏障，阻止任何方向的重排）、`smp_rmb()`（读屏障，阻止读操作重排）、`smp_wmb()`（写屏障，阻止写操作重排）。`smp` 是 SMP(Symmetric Multi-Processing，对称多处理)的缩写，表示这些屏障只在多核系统上生效；单核系统不存在跨核重排问题，这些宏会编译为空操作。不同架构的内存模型强弱不同：x86 使用 TSO(Total Store Order)模型，硬件本身就保证 store-store 和 load-load 不重排，所以 `smp_wmb()`（写屏障，阻止 store-store 重排）在 x86 上编译为空操作，因为硬件已经提供了这个保证。x86 唯一允许的重排是 store-load（先写后读可能被重排为先读后写），所以只有 `smp_mb()`（全屏障）在 x86 上需要生成真正的屏障指令。ARM 和 RISC-V 使用更弱的内存模型，store-store、load-load 都可能重排，所有屏障宏都会生成实际指令，开销也更大。

有了内存屏障可以阻止重排，但还不够。`counter++` 的问题不是重排，而是 load-add-store 三步不是一个整体，中间可以被打断。需要硬件把这三步合并成一条不可分割的指令。

现代 CPU 提供了多种这样的原子指令，其中最基础的两种是 Test-and-Set 和 Compare-and-Swap。它们的共同特点是把"读取旧值 + 写入新值"合并成一条硬件指令，其他核心无法在中间插入操作。我们先看较简单的 TAS，再看更通用的 CAS。

**Test-and-Set(TAS)** 是最简单的一种。假设我们用一个整数变量 `lock` 表示锁的状态，0 表示空闲，1 表示占用。TAS 对这个变量做一件事：原子地读出 `lock` 的当前值，同时把 `lock` 设为 1。下面的伪代码展示了 TAS 的语义，硬件保证这三行作为一个整体执行，中间不会被打断：

```c
// 硬件保证以下操作不可分割
int test_and_set(int *lock) {
    int old = *lock;  // 读出当前值
    *lock = 1;        // 无条件设为 1
    return old;       // 返回之前的值
}
```

如果 `lock` 之前是 0（空闲），TAS 返回 0，同时已经把 `lock` 设为 1（占用），加锁完成。如果 `lock` 之前是 1（已被占用），TAS 返回 1，`lock` 仍然是 1（设 1 为 1，没有变化），加锁失败。整个过程只有一条指令，不存在 load-add-store 之间被打断的窗口。用 TAS 可以构建最朴素的自旋锁：

```c
void spin_lock(int *lock) {
    while (test_and_set(lock) == 1)
        ;  // 锁被占用，反复尝试
}

void spin_unlock(int *lock) {
    *lock = 0;
}
```

但 TAS 只能把值设为 1，不够灵活。

**Compare-and-Swap(CAS)** 更强大：原子地比较一个内存位置的当前值与期望值，如果相等就替换为新值，返回操作是否成功。x86 上对应的指令是 `CMPXCHG`。

```c
// 硬件保证以下操作不可分割
bool compare_and_swap(int *addr, int expected, int new_val) {
    if (*addr == expected) {
        *addr = new_val;
        return true;
    }
    return false;
}
```

CAS 比 TAS 更通用。TAS 只能设为固定值，CAS 可以基于当前值计算新值。比如用 CAS 实现原子的 `counter++`：反复读取当前值，尝试用 CAS 把它替换为当前值加一。如果在你读取和替换之间有其他线程修改了 counter，CAS 会失败，你重新读取再试。这种"读-计算-CAS"的循环叫做 CAS 循环(CAS loop)，是无锁(lock-free)编程的基础模式。

Linux 内核用 `atomic_t` 类型和一组原子操作函数封装了这些硬件指令。`atomic_t` 是一个包含单个整数的结构体，内核提供 `atomic_cmpxchg()`（CAS）、`atomic_inc()`（原子加一）、`atomic_set()`（原子赋值）、`atomic_exchange()`（原子交换）等函数来操作它：

```c
// include/linux/types.h
typedef struct {
    int counter;
} atomic_t;

// include/linux/atomic/atomic-instrumented.h (simplified)
// 内核对外 API：调用 arch_ 前缀的架构实现
static inline int atomic_cmpxchg(atomic_t *v, int old, int new) {
    return arch_atomic_cmpxchg(v, old, new);
}

// arch/x86/include/asm/atomic.h (simplified)
// x86 架构实现：编译为 CMPXCHG 指令
static inline int arch_atomic_cmpxchg(atomic_t *v, int old, int new) {
    return arch_cmpxchg(&v->counter, old, new);
}

// x86 架构实现：lock 前缀 + incl 指令
static inline void arch_atomic_inc(atomic_t *v) {
    asm volatile("lock incl %0" : "+m" (v->counter));
}
```

`atomic_cmpxchg()` 是内核对外的 API，它调用 `arch_atomic_cmpxchg()`，各架构在自己的 `arch/*/include/asm/atomic.h` 中提供实现。编译时根据目标架构选择对应的头文件，`atomic_cmpxchg()` 就被内联展开为该架构的原子指令。`lock` 前缀是 x86 特有的机制，它锁住内存总线（现代 CPU 是锁缓存行），保证后面的指令原子执行。`lock incl` 把 load-add-store 合成了一条不可分割的操作，直接解决了开篇 `counter++` 的问题。


## 自旋锁与互斥锁

自旋锁(spinlock)是等待线程反复检查锁变量直到可用的锁。互斥锁(mutex)是等待线程被操作系统挂起、锁可用时被唤醒的锁。

自旋锁的实现直接基于上一节的原子操作。Linux 内核的 `spin_lock` 简化逻辑如下：

```c
// include/asm-generic/spinlock.h (simplified)
typedef struct {
    atomic_t lock;  // 0 = unlocked, 1 = locked
} spinlock_t;

static inline void spin_lock(spinlock_t *s) {
    while (atomic_cmpxchg(&s->lock, 0, 1) != 0)
        cpu_relax();  // 暂停指令，降低功耗和总线压力
}

static inline void spin_unlock(spinlock_t *s) {
    atomic_set(&s->lock, 0);
}
```

`cpu_relax()` 在 x86 上编译为 `PAUSE` 指令，它告诉 CPU"当前在自旋等待"，CPU 会降低功耗并减少对内存总线的争用。没有这条指令，自旋锁的忙等会产生大量无用的缓存一致性流量。

自旋锁的优势是没有上下文切换的开销。线程拿不到锁就原地循环，一旦锁释放就能立刻获取，响应延迟低。这在内核中尤为重要：内核的很多临界区非常短（几条指令），进入睡眠再被唤醒的上下文切换开销远大于自旋几次的开销。而且内核中有些上下文（比如中断处理程序）根本不允许睡眠，只能用自旋锁。

但自旋锁有一个根本问题：忙等。线程拿不到锁时占着 CPU 空转，这段 CPU 时间完全浪费了。如果临界区很长（比如涉及磁盘 I/O），等待者可能自旋整个时间片。用户态线程是可被抢占的，假设线程 A 持有自旋锁后被调度器抢占，线程 B 尝试获取锁，它会自旋整个时间片都拿不到锁（因为线程 A 被挂起了，无法释放锁）。这种浪费在用户态是不可接受的。

长临界区需要一种不同的策略：拿不到锁就去睡觉，等锁的持有者释放时再把你叫醒。这就是互斥锁(mutex)。

互斥锁由两部分组成：一个锁变量和一个等待队列。加锁时检查锁变量，如果锁空闲就获取，如果锁被占用就把当前线程加入等待队列并让它睡眠。解锁时释放锁变量，从等待队列中取出一个等待者并唤醒它。

这里需要先区分两个东西：**内核 mutex** 和**用户态 mutex**。内核有自己的互斥锁实现（`struct mutex`，定义在 `kernel/locking/mutex.c`），供内核代码内部使用。驱动程序、文件系统、内核子系统之间需要同步时，调用 `mutex_lock()`/`mutex_unlock()`，整个加锁解锁过程都发生在内核空间。用户程序不会直接调用它。用户程序用的是 `pthread_mutex_lock()`，这是 glibc 提供的用户态实现，底层基于 futex（后面会讲）。两者的原理相同（CAS 快速路径 + 睡眠慢速路径），但实现完全不同。

我们先看内核 mutex 的实现来理解原理，然后再看用户态 mutex 面临的额外困难。

```c
// kernel/locking/mutex.c (simplified)
struct mutex {
    atomic_t        owner;      // 锁的持有者
    struct list_head wait_list;  // 等待队列
};

void mutex_lock(struct mutex *lock) {
    if (atomic_cmpxchg(&lock->owner, 0, current) == 0)
        return;  // 快速路径：锁空闲，直接获取
    // 慢速路径：加入等待队列，睡眠
    list_add_tail(&waiter.list, &lock->wait_list);
    schedule();  // 让出 CPU
}

void mutex_unlock(struct mutex *lock) {
    atomic_set(&lock->owner, 0);
    if (!list_empty(&lock->wait_list)) {
        waiter = list_first_entry(&lock->wait_list, ...);
        wake_up_process(waiter->task);
    }
}
```

但这段简化代码有一个致命的问题：`mutex_lock` 中先检查锁状态（`atomic_cmpxchg` 返回非零），然后加入等待队列并睡眠（`schedule()`）。在这两步之间，锁的持有者可能已经释放了锁并调用了 `wake_up_process()`。但此时你还没有加入等待队列，唤醒信号发给了空队列，被丢弃了。等你加入等待队列并调用 `schedule()` 后，再也没有人来唤醒你了。这就是丢失唤醒(lost wakeup)问题。

丢失唤醒的根因是"检查锁状态"和"加入等待队列并睡眠"这两步不是原子的。中间有窗口，唤醒信号可以从这个窗口中溜走。解决方案必须保证 check-and-sleep 的原子性。内核 mutex 的真正实现比上面的简化版复杂，它用 spinlock 保护了"检查状态 + 加入等待队列 + 设置线程状态"这一整段操作，在持有 spinlock 的情况下完成入队，释放 spinlock 之后才调用 `schedule()` 让出 CPU。因为 `mutex_unlock` 端也要先获取同一把 spinlock 才能唤醒等待者，所以 check-and-sleep 与 wake 被序列化了，不会丢失唤醒。

内核 mutex 能这样做，是因为 `mutex_lock()` 本身就运行在内核空间，可以直接操作内核的 spinlock、等待队列和调度器。但用户态的 `pthread_mutex_lock()` 没有这些条件：用户态代码无法直接操作内核的等待队列，也无法在用户态获取内核的 spinlock。用户态做了 CAS（check）之后，如果需要睡眠，就必须通过系统调用进入内核。在这次系统调用的边界上，同样存在丢失唤醒的窗口。Futex 正是为解决这个跨边界的 check-and-sleep 原子性问题而设计的。

:::thinking 自旋还是睡眠？

自旋锁不让出 CPU，互斥锁让出 CPU 但有上下文切换的开销。选哪个取决于临界区耗时 $T_{cs}$ 和上下文切换开销 $T_{ctx}$ 的关系。

如果 $T_{cs} < T_{ctx}$，自旋比切换更快。线程原地等几个时钟周期就能拿到锁，比切换到另一个线程再切换回来划算。

如果 $T_{cs} > T_{ctx}$，睡眠比自旋更高效。自旋浪费的 CPU 时间可以让给其他线程干有用的工作。

在现代 x86 CPU 上，一次完整的上下文切换大约需要几微秒（包括保存/恢复寄存器、刷新流水线、可能的 TLB 失效）。所以如果临界区在几微秒内就能完成，自旋更划算；如果临界区可能持续数十微秒或更长，应该用互斥锁。

实际上，Linux 内核的 mutex 实现了一种混合策略叫做 optimistic spinning（乐观自旋）：如果锁的持有者正在 CPU 上运行（还没有被调度器切走），等待者就不进入睡眠，而是自旋等待。理由是：锁的持有者正在 CPU 上执行，很可能马上就会释放锁。进入睡眠再被唤醒的开销比自旋几圈更大。只有当持有者也被调度走了（不在任何 CPU 上运行），等待者才放弃自旋，进入睡眠。

```c
// kernel/locking/mutex.c — optimistic spinning
if (mutex_optimistic_spin(lock, ...)) {
    // 持有者正在运行，自旋等到锁释放
    return;
}
// 持有者不在 CPU 上，进入慢速路径：睡眠
```

这种策略在实践中非常有效：大多数 mutex 的持有时间很短，持有者大概率还在 CPU 上，等待者自旋几圈就能拿到锁，避免了不必要的上下文切换。
:::

## 信号量与条件变量

信号量(semaphore)是维护一个整数计数器的同步原语，支持 wait（计数器减一，为零则阻塞）和 signal（计数器加一，唤醒一个阻塞者）操作。条件变量(condition variable)是让线程等待特定条件成立的同步原语，与互斥锁配合使用。

互斥锁解决了互斥问题，但有些场景需要的不止是互斥。信号量是 Dijkstra 在 1965 年提出的，他定义了两个操作：P(proberen，荷兰语"尝试")和 V(verhogen，"增加")。

```c
// kernel/locking/semaphore.c (simplified)
struct semaphore {
    unsigned int    count;       // 计数器
    struct list_head wait_list;  // 等待队列
};

// P 操作（wait / down）
void down(struct semaphore *sem) {
    if (sem->count > 0) {
        sem->count--;       // 有资源，获取
    } else {
        // 加入等待队列，睡眠
        list_add_tail(&waiter.list, &sem->wait_list);
        schedule();
    }
}

// V 操作（signal / up）
void up(struct semaphore *sem) {
    if (list_empty(&sem->wait_list)) {
        sem->count++;       // 没有等待者，增加计数
    } else {
        waiter = list_first_entry(&sem->wait_list, ...);
        wake_up_process(waiter->task);  // 有等待者，唤醒一个
    }
}
```

当计数器初始值为 1 时，信号量退化为二元信号量(binary semaphore)，行为类似互斥锁：一次只有一个线程能通过 `down()`。当初始值为 N 时，最多允许 N 个线程同时通过，适用于有限资源池（比如数据库连接池限制最多 10 个并发连接）。

现代 Linux 内核更偏向使用 mutex 而非信号量。原因是 mutex 有所有权(ownership)的概念：谁加的锁谁来解。内核可以基于所有权实现优先级继承(priority inheritance)：如果高优先级线程在等一个低优先级线程持有的 mutex，内核临时提升低优先级线程的优先级，让它尽快完成临界区并释放锁。信号量没有所有权约束（一个线程 `down()`，另一个线程可以 `up()`），无法做优先级继承。

互斥锁和信号量都是等锁：资源被占就等，资源释放就获取。但有些场景需要等的不是锁本身，而是某个条件成立。

想象生产者-消费者场景：生产者往有界缓冲区写数据，消费者从缓冲区读数据。消费者获取了保护缓冲区的 mutex，发现缓冲区是空的。接下来怎么办？如果持锁自旋等待，生产者也需要这把 mutex 才能写入数据，消费者持锁自旋就阻塞了生产者，形成死锁。消费者必须释放 mutex，让生产者能够写入，然后等缓冲区非空时再去获取 mutex 重新检查。

这正是条件变量(condition variable)做的事情。`pthread_cond_wait()` 的语义是：原子地释放关联的 mutex 并让当前线程进入阻塞，直到被其他线程调用 `pthread_cond_signal()` 唤醒。唤醒后自动重新获取 mutex，然后从 `pthread_cond_wait()` 返回。"原子地释放并阻塞"是关键：如果释放和阻塞不是原子的，中间就可能丢失唤醒信号（和 mutex 的 check-and-sleep 问题一样）。

条件变量有一个重要的细节：`pthread_cond_wait()` 可能在没有人调用 `signal()` 的情况下返回，这叫做虚假唤醒(spurious wakeup)。原因有多种：底层实现可能使用 futex，内核唤醒可能误中；某些架构的内存模型允许这种行为。所以 `pthread_cond_wait()` 必须在 while 循环中调用，不能用 if：

```c
pthread_mutex_lock(&mutex);
while (buffer_empty)                   // 用 while，不用 if
    pthread_cond_wait(&cond, &mutex);  // 可能虚假唤醒，所以回到 while 重新检查
// 此时 buffer 非空，且持有 mutex
consume(buffer);
pthread_mutex_unlock(&mutex);
```

如果用 if 而不是 while，虚假唤醒后线程不会重新检查条件，直接执行 `consume(buffer)`，此时缓冲区可能仍然是空的。

:::expand 读写锁(Reader-Writer Lock)

互斥锁的策略是"一次只有一个线程"。但有些共享数据被频繁读取、偶尔修改。如果用互斥锁保护，多个读者之间也会互斥，而读者之间实际上不需要互斥，因为读操作不修改数据。

读写锁(reader-writer lock, rwlock)放宽了限制：允许多个读者同时持有锁，但写者必须独占。两条规则：如果有线程在读，其他线程可以读但不能写；如果有线程在写，其他线程既不能读也不能写。

```c
// include/linux/rwlock_types.h (simplified)
typedef struct {
    atomic_t reader_count;  // 当前读者数量
    spinlock_t write_lock;  // 写者独占锁
} rwlock_t;
```

读写锁的一个经典问题是写者饥饿(writer starvation)：如果不断有新的读者到来，写者可能永远等不到所有读者离开。解决方案之一是写者优先(writer-preference)：当写者在等待时，不再允许新的读者进入，只等现有读者离开。但这又可能导致读者饥饿。在实际系统中往往需要在读者优先和写者优先之间权衡。
:::

## Futex

Futex(Fast Userspace Mutex)是 Linux 提供的系统调用，它的核心能力是：让用户态线程可以在一个用户态内存地址上原子地等待和唤醒。

注意 futex 不是锁，不是互斥锁，也不是任何一种同步原语。它是一个通用的底层机制，只做两件事：

- **按地址等待**：如果某个用户态地址上的值等于期望值，就让当前线程睡眠
- **按地址唤醒**：唤醒在某个用户态地址上等待的线程

glibc 的 `pthread_mutex_lock()`、`pthread_cond_wait()`、`sem_wait()`、`pthread_rwlock_rdlock()` 在底层全部基于 futex 实现。futex 是用户态同步原语的**共同基础设施**，而不是其中的一种。

那为什么用户态同步原语需要 futex？前面互斥锁一节讲到，内核 mutex 用 spinlock 保护 check-and-sleep，解决了丢失唤醒。但用户态代码无法直接操作内核的 spinlock 和等待队列，从"用户态 CAS 失败"到"进入内核睡眠"之间跨越了系统调用边界，存在丢失唤醒的窗口。不只是互斥锁有这个问题。条件变量的 `pthread_cond_wait()` 需要"检查条件 + 释放 mutex + 睡眠"原子完成；信号量的 `sem_wait()` 需要"检查计数器 + 睡眠"原子完成。**任何**用户态同步原语，只要涉及"检查某个条件，不满足就睡眠"，都面临同样的跨边界原子性问题。Futex 就是 Linux 为这一类问题提供的统一解决方案。

Futex 的解法很巧妙：既然用户态的检查和内核的睡眠之间有窗口，那就让内核**进来之后再检查一次**。`futex()` 系统调用的签名是 `futex(int *addr, int op, int val, ...)`，第一个参数是用户态变量的地址，第二个参数是操作类型。关键的操作有两个：

- `futex(addr, FUTEX_WAIT, expected_val, ...)`：进入内核后，**再次检查 `*addr` 是否仍等于 `expected_val`**。如果是，说明条件没有变化，把当前线程加入等待队列并睡眠。如果不是（说明在进内核之前条件已经改变了），立即返回，不睡眠。
- `futex(addr, FUTEX_WAKE, n, ...)`：唤醒在该地址上等待的 n 个线程。

这里的 `addr` 和 `*addr` 到底是什么？用互斥锁举一个具体的例子。用户程序声明了一个 `pthread_mutex_t my_mutex`，glibc 内部把它表示为一个结构体，其中有一个整数字段记录锁状态，这个整数有三个取值：0 表示无锁，1 表示有锁但没有等待者，2 表示有锁且有等待者。`addr` 就是这个整数字段在内存中的地址，`*addr` 就是这个整数的当前值。

```
用户程序                   内存布局
                           地址 0x7fff1000
pthread_mutex_t my_mutex → ┌──────────────┐
                           │ lock_state: 2│ ← *addr = 2（有锁，有等待者）
                           │ ...          │
                           └──────────────┘
                                 ↑
                           addr = 0x7fff1000
```

当线程 A 调用 `pthread_mutex_lock(&my_mutex)` 时，glibc 先在用户态对 `addr`（即 `0x7fff1000`）做 CAS，尝试把 `*addr` 从 0 改为 1。如果 `*addr` 已经是 2（被占用），CAS 失败，glibc 调用 `futex(0x7fff1000, FUTEX_WAIT, 2, ...)`。内核收到后，去读 `0x7fff1000` 这个地址上的整数值。如果还是 2，说明锁确实还被占用，线程 A 进入睡眠。这里的"检查值"和"加入等待队列"是原子的（后面会讲内核怎么保证），不可能出现"检查时是 2，但加入队列之前其他线程把值改成了 0 并发起唤醒"的情况，所以不会丢失唤醒。如果不是 2（比如变成了 0，说明锁在用户态 CAS 失败到进入内核这段时间里已经被释放了），内核立即返回，线程 A 回到用户态重试 CAS。

所以 futex 并不关心 `addr` 上存的是"锁状态"还是"信号量计数器"还是"条件变量的序列号"。它只做一件事：**读一个用户态地址上的整数值，跟你给的期望值比较，相等就睡眠，不等就返回**。至于这个整数代表什么含义，由上层的同步原语自己定义。

glibc 把这两个操作封装成了更简洁的函数，下面的代码中会用到：

- `futex_wait(addr, expected_val)` → `futex(addr, FUTEX_WAIT, expected_val, ...)`
- `futex_wake(addr, n)` → `futex(addr, FUTEX_WAKE, n, ...)`

下面以用户态互斥锁为例，看 futex 是如何被使用的。有了 futex，用户态 mutex 可以安全地拆成快慢两条路径：

**快速路径（无竞争）**：用户态做一次 CAS。如果锁空闲（值为 0），CAS 成功把它设为 1，加锁完成，不进内核。解锁同理：CAS 把值从 1 改回 0，没有等待者，解锁完成。整个过程只需一条原子指令，和内核 mutex 的 CAS 快速路径本质相同。

**慢速路径（有竞争）**：CAS 失败，调用 `futex_wait(addr, expected_val)` 进入内核。内核重新检查值，如果锁仍被占用就睡眠，否则立即返回。丢失唤醒不会发生。

那么 `FUTEX_WAIT` 在内核中具体是怎么保证"重新检查 + 入队 + 睡眠"这一整段操作的原子性的？

答案不是靠硬件原子指令，而是靠内核中的 spinlock。内核为 futex 维护了一张全局哈希表(futex hash table)，数据结构如下：

```c
// kernel/futex/futex.h (simplified)
struct futex_hash_bucket {
    spinlock_t       lock;       // 保护这个桶的自旋锁
    struct list_head chain;      // 等待队列：挂着所有在这个桶上等待的线程
};

// 全局哈希表，共 256 个桶（2^8）
static struct futex_hash_bucket futex_queues[256];
```

哈希表的作用是把用户态锁变量的地址映射到一个桶。当用户态调用 `futex_wait(addr, 2)` 时，内核对 `addr` 做哈希运算，找到对应的桶。同一个 `addr` 永远落在同一个桶里，所以同一把用户态锁上的所有 wait 和 wake 操作都竞争同一个 `bucket->lock`。

```
用户态                              内核
                                    futex_hash_bucket[256]
pthread_mutex_t lock_a  ──hash──→  [bucket 42] { spinlock, wait_list }
pthread_mutex_t lock_b  ──hash──→  [bucket 17] { spinlock, wait_list }
pthread_mutex_t lock_c  ──hash──→  [bucket 42] { spinlock, wait_list }
                                    (lock_a 和 lock_c 碰巧落在同一个桶)
```

有了这个数据结构，再来看 `FUTEX_WAIT` 和 `FUTEX_WAKE` 的实现：

```c
// kernel/futex/core.c (simplified)
// FUTEX_WAIT：检查值 + 加入等待队列
int futex_wait(int *addr, int expected_val) {
    bucket = hash(addr);               // 根据地址找到哈希桶
    spin_lock(&bucket->lock);          // 获取桶的 spinlock
    if (*addr != expected_val) {       // 持有 spinlock 时检查值
        spin_unlock(&bucket->lock);
        return -EAGAIN;                // 值已变，不睡眠
    }
    list_add(&current->wait_entry, &bucket->wait_list);  // 加入等待队列
    spin_unlock(&bucket->lock);
    schedule();                        // 让出 CPU，进入睡眠
    return 0;
}

// FUTEX_WAKE：从等待队列中唤醒
int futex_wake(int *addr, int n) {
    bucket = hash(addr);               // 同一个地址 → 同一个桶
    spin_lock(&bucket->lock);          // 获取同一把 spinlock
    // 从 wait_list 中取出最多 n 个等待者并唤醒
    list_for_each(waiter, &bucket->wait_list, n)
        wake_up_process(waiter->task);
    spin_unlock(&bucket->lock);
    return n;
}
```

关键在于 `FUTEX_WAIT` 的"检查值"和"加入等待队列"这两步都在 `bucket->lock` 的保护下完成。`FUTEX_WAKE` 也要先获取同一把 `bucket->lock` 才能唤醒等待者。所以只有两种可能的执行顺序：

1. **wait 先拿到 spinlock**：检查值仍然等于 `expected_val`，线程加入等待队列，释放 spinlock。之后 wake 拿到 spinlock，从队列中找到这个线程并唤醒。唤醒没有丢失。
2. **wake 先拿到 spinlock**：wake 遍历等待队列，此时等待者还没入队，队列为空，唤醒是空操作，释放 spinlock。之后 wait 拿到 spinlock，检查值，发现 `*addr` 已经被释放锁的线程改过了（不等于 `expected_val`），返回 `EAGAIN`，不睡眠。线程回到用户态重新尝试 CAS，这次成功获取锁。

无论哪种顺序，线程都不会陷入"永远睡眠"的状态。这就是 futex 解决丢失唤醒的机制：不是用硬件把 check-and-sleep 变成一条不可分割的指令，而是用 spinlock 把 wait 端和 wake 端序列化，保证检查和入队在逻辑上不可被唤醒操作插入。

glibc 的 `pthread_mutex_lock()` 正是基于 futex 实现的。来看 `nptl/lowlevellock.h` 中的实现是如何把快速路径和慢速路径组合在一起的：

```c
// glibc — nptl/lowlevellock.h (simplified)
// 锁状态: 0 = unlocked, 1 = locked (no waiters), 2 = locked (has waiters)
void lll_lock(int *futex) {
    if (atomic_cmpxchg(futex, 0, 1) == 0)
        return;  // 快速路径：无竞争，一条 CAS 搞定

    // 慢速路径：有竞争
    while (atomic_exchange(futex, 2) != 0)      // 设为 2 表示有等待者
        futex_wait(futex, 2);                    // 进内核睡眠
}

void lll_unlock(int *futex) {
    if (atomic_exchange(futex, 0) == 2)          // 之前状态是 2，说明有等待者
        futex_wake(futex, 1);                    // 进内核唤醒一个
}
```

注意代码中的参数名 `int *futex` 就是前面一直讨论的 `addr`——用户态锁变量那个整数的内存地址。名字碰巧和 `futex()` 系统调用相同，容易混淆，但它只是一个普通的整数指针。对照代码可以看到，`*addr` 值的每一次修改都是用户态代码通过原子操作完成的：`atomic_cmpxchg(futex, 0, 1)` 把 0 改为 1（加锁），`atomic_exchange(futex, 2)` 设为 2（标记有等待者），`atomic_exchange(futex, 0)` 设为 0（解锁）。`futex_wait()` 和 `futex_wake()` 不修改这个值，它们只负责"读值、比较、决定睡眠或返回"和"唤醒等待者"。

锁有三个状态：0（无锁）、1（有锁无等待者）、2（有锁且有等待者）。解锁时只有旧值为 2 才需要进内核唤醒等待者。旧值为 1 时解锁也不需要系统调用。这样在无竞争和低竞争的场景下，加锁和解锁都在用户态完成，性能接近一条原子指令。

这就是 futex 名字里"Fast"的含义：无竞争时不进内核（快），有竞争时进内核但不会丢失唤醒（正确）。

这里只展示了互斥锁的实现，但 futex 的作用远不止于此。glibc 中几乎所有的 pthread 同步原语都建立在 futex 之上：`pthread_cond_wait()` 用 futex 实现"释放 mutex + 睡眠"的原子操作；`sem_wait()` 用 futex 实现"检查计数器 + 睡眠"的原子操作；`pthread_rwlock_rdlock()` 用 futex 实现"检查写者状态 + 睡眠"的原子操作。模式是相同的：用户态先检查共享变量，如果需要等待就调用 `futex_wait()` 进内核，内核重新检查后决定是否睡眠。Futex 是用户态同步的基础设施层，各种同步原语是建立在它之上的应用层。

## 经典同步问题

经典同步问题是对并发编程中反复出现的模式的抽象，既是教学工具也是设计模板。

**生产者-消费者(Producer-Consumer)**。一个有界缓冲区，生产者往里面放数据，消费者从里面取数据。缓冲区满时生产者等待，缓冲区空时消费者等待。需要一把 mutex 保护缓冲区，两个条件变量分别通知"非满"和"非空"：

```c
#define BUF_SIZE 10
int buffer[BUF_SIZE];
int count = 0;

pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t not_full  = PTHREAD_COND_INITIALIZER;
pthread_cond_t not_empty = PTHREAD_COND_INITIALIZER;

void *producer(void *arg) {
    for (int i = 0; i < 100; i++) {
        pthread_mutex_lock(&mutex);
        while (count == BUF_SIZE)
            pthread_cond_wait(&not_full, &mutex);   // 满了，等非满
        buffer[count++] = i;
        pthread_cond_signal(&not_empty);             // 通知消费者：非空了
        pthread_mutex_unlock(&mutex);
    }
    return NULL;
}

void *consumer(void *arg) {
    for (int i = 0; i < 100; i++) {
        pthread_mutex_lock(&mutex);
        while (count == 0)
            pthread_cond_wait(&not_empty, &mutex);  // 空了，等非空
        int item = buffer[--count];
        pthread_cond_signal(&not_full);              // 通知生产者：非满了
        pthread_mutex_unlock(&mutex);
    }
    return NULL;
}
```

注意两个 `while` 循环：前面讲过条件变量可能虚假唤醒，while 保证唤醒后重新检查条件。

**读者-写者(Readers-Writers)**。多个读者可以并发读，写者必须独占。用信号量的一种解法：读者计数器 `read_count` 记录当前有多少读者，一把 mutex 保护计数器，一个信号量 `rw_sem` 控制对数据的访问。第一个读者到来时对 `rw_sem` 执行 `down()`（阻止写者），最后一个读者离开时执行 `up()`（允许写者）。写者直接对 `rw_sem` 做 `down()/up()`。这是读者优先的方案，写者可能饥饿，与前面讨论的读写锁写者饥饿问题相同。

**哲学家就餐(Dining Philosophers)**。五个哲学家围坐在圆桌旁，两两之间放一根筷子（共五根）。每个哲学家交替思考和吃饭。吃饭需要同时拿起左右两根筷子。

朴素的方案是：每个哲学家先拿左边的筷子，再拿右边的筷子。但如果五个哲学家同时拿起了左边的筷子，所有人都在等右边的筷子，而右边的筷子被右边的哲学家当作左边的筷子拿走了。谁也不愿意放下，所有人都在等，形成循环等待，程序永远不会推进。这就是死锁(deadlock)。

一个简单的解法是打破对称性：前四个哲学家先拿左边再拿右边，第五个哲学家先拿右边再拿左边。这样至少有一个哲学家的获取顺序不同，打破了循环等待的条件。

哲学家就餐的死锁揭示了一个更一般的现象：多个线程按不同顺序获取多个锁时，可能产生循环等待。下一课「死锁」深入分析这个问题。

## 小结

| 概念 | 说明 |
|------|------|
| 竞态条件(race condition) | 程序结果依赖于线程的相对执行顺序 |
| 临界区(critical section) | 访问共享资源的代码区域，需要互斥保护 |
| 内存屏障(memory barrier) | 阻止 CPU 跨越屏障重排内存访问 |
| Test-and-Set / CAS | 硬件原子指令，保证读-改-写不可分割 |
| 自旋锁(spinlock) | 等待者忙等，适用于短临界区和不可睡眠上下文 |
| 互斥锁(mutex) | 等待者睡眠，适用于用户态和长临界区 |
| 信号量(semaphore) | 计数器 + 等待队列，P/V 操作，控制并发数量 |
| 条件变量(condition variable) | 等待特定条件成立，与 mutex 配合，必须在 while 中调用 |
| 读写锁(rwlock) | 多个读者并发 OR 一个写者独占 |
| Futex | 系统调用，提供"按地址等待/唤醒"能力，是用户态所有同步原语的基础设施 |

同步原语构成一条从硬件到用户态的垂直链：CPU 提供原子指令（CAS/TAS）和内存屏障，内核在此之上实现 futex（原子的 check-and-sleep），用户态库在 futex 之上封装 mutex、semaphore、condition variable。理解这条链，就理解了为什么每一层存在、每一层解决什么问题。

---

**Linux 源码入口**：
- [`kernel/futex/`](https://elixir.bootlin.com/linux/latest/source/kernel/futex) — futex 系统调用实现
- [`kernel/locking/mutex.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/mutex.c) — 内核 mutex 实现，包含 optimistic spinning
- [`include/linux/atomic.h`](https://elixir.bootlin.com/linux/latest/source/include/linux/atomic.h) — 内核原子操作接口
- [`nptl/lowlevellock.h`](https://sourceware.org/git/?p=glibc.git;a=blob;f=nptl/lowlevellock.h) — glibc 基于 futex 的底层锁实现
