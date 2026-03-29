# 内核同步机制

- 写作时间：`2026-03-04 首次提交，2026-03-29 最近修改`
- 当前字符：`18861`

事件驱动一课展示了一种避免并发复杂度的思路：用单线程消除共享状态。但内核本身不能选择单线程。内核在所有 CPU 上同时运行，随时被硬件中断打断，管理着全系统共享的数据结构。同步原语一课讲过的 spinlock 和 mutex 是起点，但内核面对的约束远比用户态复杂。

来看一个具体场景。一个内核开发者写了一个设备驱动，用 `spin_lock()` 保护一个共享计数器。测试环境中一切正常。但在生产环境中，一个硬件中断在持锁期间触发了。中断处理函数也需要访问这个计数器，于是调用 `spin_lock()` 尝试获取同一把锁。问题来了：锁的持有者是被中断打断的那段代码，它在中断返回之前不可能恢复执行；中断处理函数在拿到锁之前也不会返回。在单个 CPU 上，没有其他线程参与，死锁就这样发生了。

```c
#include <linux/spinlock.h>
#include <linux/interrupt.h>

static DEFINE_SPINLOCK(counter_lock);
static int counter = 0;

// 中断处理函数
static irqreturn_t my_irq_handler(int irq, void *dev) {
    spin_lock(&counter_lock);     // 尝试获取锁，但锁已被下面的代码持有
    counter++;                     // 永远执行不到
    spin_unlock(&counter_lock);
    return IRQ_HANDLED;
}

// 进程上下文代码
void update_counter(void) {
    spin_lock(&counter_lock);     // 获取锁
    counter++;                     // ← 此时中断触发，CPU 跳转到 my_irq_handler
    spin_unlock(&counter_lock);   // 永远执行不到
}
```

这个场景揭示了内核并发的特殊约束。当中断上下文参与时，加锁必须同时控制中断，这就是 **内核自旋锁** 家族。对于可以睡眠的进程上下文代码，**内核互斥量** 提供了更好的选择。对于读远多于写的数据，**顺序锁** 让读者完全不阻塞写者。进一步地，**RCU** 让读的开销降到近零，靠延迟内存回收实现。当共享可以完全消除时，**Per-CPU 变量与完成变量** 从根本上绕过了同步问题。

## 内核自旋锁

内核自旋锁(kernel spinlock)是 Linux 内核中最基础的锁原语，等待者原地自旋直到锁可用，同时可以选择性地关闭中断或下半部来防止中断上下文导致的死锁。

同步原语一课讲过 spinlock 的基本原理：CAS + 自旋 + `cpu_relax()`。内核 spinlock 在此基础上增加了一个维度：中断控制。

回到开篇的死锁场景。`update_counter()` 持有 `counter_lock` 时被中断打断，`my_irq_handler()` 在同一个 CPU 上尝试获取同一把锁。这不是死锁一课分析过的 ABBA 死锁（多线程交叉锁序），而是单 CPU 上的自死锁：一个执行流持有锁，另一个执行流在同一个 CPU 上尝试获取同一把锁，而前者在后者返回之前不可能恢复执行。

关键在于理解两种执行上下文。进程上下文(process context)是内核代表某个用户进程执行代码时的状态，比如系统调用处理、内核线程执行。进程上下文可以调用 `schedule()` 让出 CPU，也可以被中断打断。中断上下文(interrupt context)是 CPU 响应硬件中断后执行中断处理函数时的状态。中断上下文有两个硬性约束：不能调用 `schedule()`（因为没有进程上下文可以切换回来），并且不能被同类型或更低优先级的中断打断（在同一个 CPU 上）。

理解了这两种上下文，就能看清为什么纯 `spin_lock()` 在开篇场景中会死锁：`spin_lock()` 只做自旋，不控制中断。进程上下文代码持有锁时，中断照常触发，中断处理函数试图获取同一把锁，自旋永远等不到释放。

Linux 内核提供了四个 spinlock 变体来应对不同的中断场景：

```c
// 变体 1：不控制中断，仅自旋
spin_lock(&lock);
spin_unlock(&lock);

// 变体 2：关闭本地 CPU 的所有硬件中断 + 自旋
spin_lock_irq(&lock);
spin_unlock_irq(&lock);

// 变体 3：保存当前中断状态，关闭中断 + 自旋（解锁时恢复原状态）
unsigned long flags;
spin_lock_irqsave(&lock, flags);
spin_unlock_irqrestore(&lock, flags);

// 变体 4：关闭本地 CPU 的软中断（下半部）+ 自旋
spin_lock_bh(&lock);
spin_unlock_bh(&lock);
```

这四个变体的选择取决于临界区可能被什么打断。如果临界区只在进程上下文中使用，不涉及任何中断处理函数，用 `spin_lock()` 就够了。如果临界区的数据同时被硬件中断处理函数访问，就需要 `spin_lock_irq()` 或 `spin_lock_irqsave()` 在加锁的同时关闭中断。两者的区别是：`spin_lock_irq()` 假设加锁前中断是开启的，解锁时无条件开启中断；`spin_lock_irqsave()` 先保存当前的中断状态（中断可能已经被更外层的代码关闭了），解锁时恢复到保存的状态。如果不确定加锁时中断是否已经被关闭，用 `spin_lock_irqsave()` 更安全。如果临界区的数据被软中断(softirq，Linux 内核中用于延迟执行中断处理中不紧急工作的下半部(bottom half)机制)访问，用 `spin_lock_bh()`，它只关闭软中断，不关闭硬件中断。

用 `spin_lock_irqsave()` 修复开篇的死锁代码：

```c
void update_counter(void) {
    unsigned long flags;
    spin_lock_irqsave(&counter_lock, flags);  // 关闭中断 + 获取锁
    counter++;
    spin_unlock_irqrestore(&counter_lock, flags);  // 释放锁 + 恢复中断状态
}
```

加锁时中断被关闭了，`my_irq_handler()` 在锁持有期间不会在这个 CPU 上触发，死锁消失了。中断会在 `spin_unlock_irqrestore()` 恢复中断后才被响应。

死锁一课介绍了 lockdep 的核心机制：锁类、依赖图和环检测。lockdep 还有一个重要能力：中断上下文的安全性验证。lockdep 跟踪每个锁类在哪些上下文中被使用过。如果一个锁在进程上下文中用 `spin_lock()` 获取（不关中断），又在硬件中断上下文中被获取，lockdep 会立刻报告一个锁序违规，即使死锁在测试中从未真正发生。

```
=================================
WARNING: inconsistent lock state
---------------------------------
inconsistent {HARDIRQ-ON-W} -> {IN-HARDIRQ-W} usage.
swapper/1 took:
 (&counter_lock){....}, at: my_irq_handler+0x10/0x30
{HARDIRQ-ON-W} state was registered at:
 lock_acquire+0x80/0x100
 update_counter+0x20/0x50
```

这条告警的含义是：`counter_lock` 曾经在硬件中断开启的状态下被获取（`HARDIRQ-ON-W`），现在又在硬件中断处理函数内被获取（`IN-HARDIRQ-W`）。lockdep 检测到这两种使用模式组合起来就可能导致开篇演示的那种死锁。不需要死锁真正发生，不需要特定的线程交错，只要锁的使用模式不一致，lockdep 就能提前报警。这就是死锁一课提到的"lockdep 实现细节"在中断维度上的体现：lockdep 不仅跟踪锁之间的获取顺序（环检测），还跟踪每个锁类的中断上下文注解，确保同一把锁不会在"中断开启的进程上下文"和"中断上下文"中同时使用。

:::thinking 为什么中断上下文不能睡眠？

中断打断了某个正在运行的进程（或内核线程），CPU 从进程上下文切换到中断上下文。此时被打断的进程仍然处于 `TASK_RUNNING` 状态，它的上下文（寄存器、栈指针）保存在栈上，等待中断返回后恢复执行。

如果中断处理函数调用了 `schedule()`，调度器会选择另一个进程来运行。但被打断的进程还在等中断返回才能恢复执行，而中断处理函数已经让出了 CPU，不会继续执行到返回。被打断的进程就永远卡住了。

更根本的原因是：`schedule()` 切换的是进程上下文。中断上下文不属于任何进程，它没有自己的 `task_struct` 可以被调度器管理。让一个不属于任何进程的执行流去调用"切换到另一个进程"的函数，在语义上就不成立。

这就是为什么中断上下文只能使用 spinlock 而不能使用 mutex。mutex 在拿不到锁时会调用 `schedule()` 让当前进程睡眠，而中断上下文不能睡眠。spinlock 拿不到锁时只是自旋（在原地循环），不涉及进程切换，所以在中断上下文中是安全的。
:::

:::expand ticket spinlock 与 queued spinlock

同步原语一课展示的 spinlock 实现是最简单的 test-and-set 模型：所有等待者不断对同一个变量做 CAS。这个模型有一个公平性问题：哪个核心先 CAS 成功完全靠运气，后来的等待者可能比先到的更早拿到锁，产生饥饿。

ticket spinlock 引入了排队机制。锁内部维护两个计数器：`next`（下一个待发号码）和 `owner`（当前叫到的号码）。加锁时原子地取一个号（`ticket = atomic_fetch_add(&lock->next, 1)`），然后自旋等待 `lock->owner == ticket`。解锁时把 `owner` 加一，叫下一个号。这保证了严格的 FIFO 顺序。

```c
// ticket spinlock (simplified)
typedef struct {
    atomic_t next;   // 待发号码
    atomic_t owner;  // 当前叫到的号码
} ticket_spinlock_t;

void ticket_spin_lock(ticket_spinlock_t *lock) {
    int ticket = atomic_fetch_add(&lock->next, 1);
    while (atomic_read(&lock->owner) != ticket)
        cpu_relax();
}

void ticket_spin_unlock(ticket_spinlock_t *lock) {
    atomic_inc(&lock->owner);
}
```

ticket spinlock 解决了公平性问题，但在多核系统上有缓存行争用的问题：所有核心都在自旋读同一个 `owner` 变量，这个变量每次解锁都会被修改，导致所有核心的缓存行同时失效，产生大量缓存一致性流量（线程一课讲过的 MESI 协议中的 Invalid 状态迁移）。核心越多，争用越严重。

Linux 从 4.2 版本开始使用 queued spinlock（基于 MCS 锁的变体）。MCS 锁的核心思想是：每个等待者自旋在自己的局部变量上，而不是共享变量上。每个核心有一个本地节点，节点通过链表连起来。解锁时只修改下一个等待者的局部变量，不会导致所有核心的缓存行失效。这把缓存一致性流量从 O(n) 降低到了 O(1)。

queued spinlock 的实现在 `kernel/locking/qspinlock.c`，它在 MCS 锁的基础上做了进一步优化，把整个锁压缩到一个 32 位整数中（`locked` + `pending` + `tail` 三个字段），减少了内存开销。
:::

:::expand 内核抢占(Kernel Preemption)

内核抢占(kernel preemption)是指内核态执行的代码可以被调度器打断，让另一个更高优先级的进程运行。在不可抢占的内核中，一旦 CPU 进入内核态（比如执行系统调用），只有内核代码主动调用 `schedule()` 或者从系统调用返回用户态时，调度器才有机会切换进程。

但 Linux 是可抢占的内核。`CONFIG_PREEMPT` 编译选项开启后，内核代码在几乎任何地方都可以被抢占（除了持有 spinlock 或禁用了抢占的区间）。`spin_lock()` 在可抢占内核上会隐式禁用抢占，因为持有 spinlock 期间如果被抢占，其他 CPU 上的线程尝试获取同一把锁时就会长时间自旋。

抢占计数器 `preempt_count` 记录在每个线程的 `thread_info` 结构中，是一个整数。`preempt_disable()` 使计数器加一，`preempt_enable()` 减一。只有计数器为零时，调度器才允许抢占。spinlock 的加锁和解锁也会修改这个计数器。
:::

## 内核互斥量

内核互斥量(kernel mutex)是 Linux 内核中的睡眠锁，等待者在获取不到锁时让出 CPU 进入睡眠，锁释放时被唤醒，只能在进程上下文中使用。

同步原语一课讲过 mutex 的基本结构：锁变量 + 等待队列 + CAS 快速路径 + 睡眠慢速路径。内核 mutex 在此基础上做了一个重要的优化：在快速路径和慢速路径之间插入了一条中间路径。

内核 `struct mutex` 的获取有三条路径：

```c
// kernel/locking/mutex.c (simplified)
void __sched mutex_lock(struct mutex *lock) {
    // 路径 1：快速路径 — 一次 CAS
    if (atomic_try_cmpxchg(&lock->owner, 0, current))
        return;  // 锁空闲，直接获取

    // 路径 2：中间路径 — optimistic spinning
    if (mutex_optimistic_spin(lock))
        return;  // 自旋等到了锁

    // 路径 3：慢速路径 — 加入等待队列，睡眠
    list_add_tail(&waiter.list, &lock->wait_list);
    set_current_state(TASK_UNINTERRUPTIBLE);
    schedule();
}
```

路径 1 是无竞争的快速路径，和同步原语一课介绍的完全相同：一次 CAS 尝试，成功则返回。路径 3 是有竞争的慢速路径：把当前线程加入等待队列并调用 `schedule()` 让出 CPU。路径 2 是同步原语一课提到过的 optimistic spinning（乐观自旋）的具体实现。它的判断逻辑是：如果锁的当前持有者正在某个 CPU 上运行（通过 `owner->on_cpu` 字段判断），等待者就不睡眠，而是自旋等待。理由是持有者正在执行，很可能马上就会释放锁，自旋几圈的开销比 `schedule()` 的上下文切换开销更低。只有当持有者被调度走了（不在任何 CPU 上运行），等待者才放弃自旋，进入睡眠。

mutex 和 spinlock 的选择取决于两个因素。第一是执行上下文：中断上下文不能使用 mutex（因为 mutex 会调用 `schedule()`），只能用 spinlock。第二是临界区长度：如果临界区很短（几条指令），spinlock 的自旋开销比 mutex 的上下文切换开销更低；如果临界区较长（涉及内存分配、文件操作等可能阻塞的操作），spinlock 会让等待者长时间空转浪费 CPU，应该用 mutex。一个简单的判断标准是：如果临界区内的代码可能睡眠（调用任何可能阻塞的函数），必须用 mutex，因为 spinlock 持有期间不允许睡眠。

```c
// 使用 mutex 的典型场景：进程上下文，临界区可能阻塞
struct mutex my_mutex;
mutex_init(&my_mutex);

void my_function(void) {
    mutex_lock(&my_mutex);
    buffer = kmalloc(PAGE_SIZE, GFP_KERNEL);  // 可能睡眠
    // ... 操作 buffer ...
    kfree(buffer);
    mutex_unlock(&my_mutex);
}
```

`kmalloc()` 带 `GFP_KERNEL` 标志时可能触发内存回收而睡眠，所以这个临界区不能用 spinlock 保护。

:::thinking 内核 mutex 的 optimistic spinning 是怎么工作的？

optimistic spinning 面临一个实际问题：多个等待者同时自旋在同一个 mutex 上时，它们都在不断检查 `lock->owner` 是否释放，这和 ticket spinlock 面临的缓存行争用问题一样。

Linux 内核的 mutex 使用了 OSQ(Optimistic Spin Queue)来解决这个问题，OSQ 本质上是 MCS 锁的一个变体。每个等待者在一个 per-CPU 的节点上自旋，而不是在共享的 `lock->owner` 上自旋。等待者们排成一个队列，只有队列头部的等待者监视锁的持有者状态，其余等待者自旋在自己的局部节点上。

```c
// kernel/locking/osq_lock.c (simplified)
bool osq_lock(struct optimistic_spin_queue *lock) {
    node = this_cpu_ptr(&osq_node);
    prev = atomic_xchg(&lock->tail, node);
    if (prev == NULL)
        return true;  // 队列为空，直接获取

    prev->next = node;
    while (!node->locked)  // 自旋在自己的局部节点上
        cpu_relax();
    return true;
}
```

当锁被释放时，只有队列头部的等待者的节点被标记为 `locked`，它获取锁后修改下一个节点的状态。整个过程中，每个核心只自旋在自己的缓存行上，解锁时只影响一个核心的缓存行，避免了"所有核心同时失效"的问题。

这就是为什么同步原语一课说 optimistic spinning"非常有效"：它不是简单地在 `lock->owner` 上忙等，而是通过 MCS 队列把缓存行争用降到了最低。
:::

:::thinking 为什么内核不用 futex？

同步原语一课详细讲过 futex：它让用户态线程可以在一个用户态内存地址上原子地等待和唤醒。glibc 的 `pthread_mutex_lock()`、`pthread_cond_wait()` 等同步原语都建立在 futex 之上。那内核自己为什么不用 futex？

futex 解决的核心问题是跨越用户态-内核态边界的原子性：用户态做了 CAS（check），如果需要睡眠就通过系统调用进入内核（sleep），futex 保证这两步之间不会丢失唤醒。但内核代码本身已经运行在内核态了，不存在跨边界的问题。内核 mutex 直接用 spinlock 保护 check-and-sleep 的原子性（同步原语一课分析过这个机制），不需要 futex 作为中间层。

futex 的另一个核心特性是"快速路径不进内核"。无竞争时一次 CAS 就完成加锁，不需要系统调用。但内核代码调用 `mutex_lock()` 时已经在内核态了，"进不进内核"这个区分没有意义。内核 mutex 的快速路径也是一次 CAS，和 futex 的快速路径在性能上没有差别。

所以 futex 是专门为用户态设计的基础设施：解决用户态特有的跨边界原子性问题，并优化用户态特有的"避免系统调用"诉求。内核自己不需要这两样东西，直接用更简单的 spinlock + 等待队列组合就够了。
:::

## 顺序锁

顺序锁(seqlock, sequential lock)是一种读写锁变体，写者永远不被阻塞，读者通过检测序列计数器来判断读取是否被写者干扰，如果被干扰则重试。

同步原语一课的读写锁让多个读者并发、写者独占。但读写锁有一个问题：如果读者持续存在，写者可能一直等不到所有读者离开，产生写者饥饿。顺序锁的思路相反：写者优先级最高，写者随时可以修改数据，读者负责检测并重试。

顺序锁的核心是一个序列计数器(sequence counter)。写者在修改数据前把计数器加一（变成奇数），修改完成后再加一（变回偶数）。读者在读取前记录计数器的值，读取完成后再次检查：如果计数器的值变了，或者是奇数（表示写者正在修改），就说明读到的数据可能不一致，必须重试。

```c
// include/linux/seqlock.h (simplified)
typedef struct {
    unsigned sequence;       // 序列计数器
    spinlock_t lock;         // 保护写者之间的互斥
} seqlock_t;

// 写者
void write_seqlock(seqlock_t *sl) {
    spin_lock(&sl->lock);           // 写者之间互斥
    sl->sequence++;                  // 计数器变为奇数：写入开始
    smp_wmb();                       // 写屏障：保证计数器递增在数据修改之前可见
}

void write_sequnlock(seqlock_t *sl) {
    smp_wmb();                       // 写屏障：保证数据修改在计数器递增之前可见
    sl->sequence++;                  // 计数器变为偶数：写入结束
    spin_unlock(&sl->lock);
}

// 读者
unsigned read_seqbegin(const seqlock_t *sl) {
    unsigned seq;
    do {
        seq = READ_ONCE(sl->sequence);
    } while (seq & 1);              // 奇数表示写者正在写，等待
    smp_rmb();                       // 读屏障
    return seq;
}

int read_seqretry(const seqlock_t *sl, unsigned start) {
    smp_rmb();                       // 读屏障
    return sl->sequence != start;   // 计数器变了，说明中间有写者修改过
}
```

读者的使用模式是一个 do-while 循环：

```c
unsigned seq;
do {
    seq = read_seqbegin(&my_seqlock);
    // 读取共享数据到局部变量
    local_copy = shared_data;
} while (read_seqretry(&my_seqlock, seq));
// 使用 local_copy（此时保证一致性）
```

Linux 内核中顺序锁的典型使用场景是时间保持(timekeeping)子系统。内核的 `timekeeper` 结构体维护当前墙钟时间和单调时间，由 seqcount（序列计数器，seqlock 中只包含计数器不包含 spinlock 的变体）保护。时钟中断处理函数作为写者更新时间，频率固定（通常 100-1000 Hz）。系统中大量代码需要读取当前时间，读者远多于写者。用 mutex 或 rwlock 保护会让读者之间互相阻塞或阻塞写者，而 seqcount 让读者完全不阻塞写者，写者也不需要等待任何读者。

顺序锁有一个重要的限制：读者不能在重试循环中对共享数据做解引用。如果共享数据包含指针，读者在读取指针后、解引用之前，写者可能已经释放了指针指向的内存。读者拿着一个悬垂指针(dangling pointer)去解引用，就会访问已释放的内存。所以 seqlock 只适合保护简单的值类型数据（整数、时间戳、坐标等），不适合保护包含指针的数据结构。

## RCU

RCU(Read-Copy-Update)是一种同步机制，允许读者在完全无锁、无原子操作、无内存屏障的情况下访问共享数据，写者通过复制旧数据、修改副本、替换指针的方式更新数据，并在所有读者完成读取后才回收旧数据。

从 spinlock 到读写锁再到 seqlock，每一步都在降低读端的代价。spinlock 让读写都付出自旋的代价。同步原语一课介绍的读写锁让读者之间不互斥，但读者仍然需要原子操作来修改读者计数器。seqlock 让读者完全不阻塞写者，但读者仍然需要读取序列计数器和执行内存屏障。RCU 把读的开销降到了极致：读者只需要调用 `rcu_read_lock()` 和 `rcu_read_unlock()`，它们在非抢占式内核上编译为空操作，在可抢占内核上仅仅是禁用和启用抢占。没有锁获取，没有原子操作，没有内存屏障。

RCU 的核心思想可以分解为三个部分：发布-订阅(publish-subscribe)、读侧临界区和宽限期。这里的"发布-订阅"借用了消息传递的术语，用来描述指针更新的可见性保证，和消息队列的 pub-sub 模式无关。

**发布-订阅**。写者更新一个共享指针时，必须保证读者要么看到旧指针，要么看到新指针，不能看到一个"半更新"的指针值。`rcu_assign_pointer()` 是写者的发布操作，它包含写屏障语义（现代内核中实现为 `smp_store_release()`），保证新数据结构的所有字段在指针更新之前对其他 CPU 可见。`rcu_dereference()` 是读者的订阅操作，保证通过指针访问的数据不会被编译器或 CPU 重排到指针读取之前。在几乎所有主流架构上（包括 x86 和 ARM），`rcu_dereference()` 编译为 `READ_ONCE()`，没有额外的屏障指令开销——因为这些架构天然尊重数据依赖。

```c
// 写者：发布新数据
struct my_data *new = kmalloc(sizeof(*new), GFP_KERNEL);
new->value = 42;
rcu_assign_pointer(global_ptr, new);  // 包含 smp_store_release()

// 读者：订阅
rcu_read_lock();
struct my_data *p = rcu_dereference(global_ptr);  // 大多数架构上编译为 READ_ONCE()
if (p)
    use(p->value);  // 保证看到 value = 42
rcu_read_unlock();
```

**读侧临界区**。`rcu_read_lock()` 和 `rcu_read_unlock()` 标记了 RCU 读侧临界区(RCU read-side critical section)的边界。在这个区间内，读者持有对共享数据的引用，写者不能回收旧数据。读侧临界区内不能睡眠。原因是：睡眠会导致 CPU 发生上下文切换，RCU 子系统会误认为该 CPU 已经经过了静止状态，从而过早结束宽限期——宽限期不是被延长，而是被错误地缩短。

**宽限期**。写者替换了指针之后，旧数据不能立刻释放，因为可能还有读者在 `rcu_read_lock()` 和 `rcu_read_unlock()` 之间持有旧指针。宽限期(grace period)是指从写者替换指针开始，到所有在替换之前进入读侧临界区的读者都退出为止的这段时间。宽限期结束后，不可能再有读者持有旧指针，旧数据可以安全释放。

写者有两种方式等待宽限期。`synchronize_rcu()` 是同步方式：阻塞当前进程直到宽限期结束，然后返回，写者接着释放旧数据。`call_rcu()` 是异步方式：注册一个回调函数，宽限期结束后由 RCU 子系统调用这个回调来释放旧数据，写者不需要等待。

下面是 RCU 保护链表的完整示例。链表是 RCU 最常见的使用场景，Linux 内核中有大量用 RCU 保护的链表（路由表、进程列表、文件系统挂载点列表等）：

```c
struct my_entry {
    int data;
    struct list_head list;
    struct rcu_head rcu;     // 用于 call_rcu 的回调
};

static LIST_HEAD(my_list);
static DEFINE_SPINLOCK(my_list_lock);  // 保护写者之间的互斥

// 读者：遍历链表，无锁
void reader(void) {
    struct my_entry *entry;
    rcu_read_lock();
    list_for_each_entry_rcu(entry, &my_list, list) {
        process(entry->data);
    }
    rcu_read_unlock();
}

// 写者：添加节点
void add_entry(int data) {
    struct my_entry *new = kmalloc(sizeof(*new), GFP_KERNEL);
    new->data = data;
    spin_lock(&my_list_lock);
    list_add_rcu(&new->list, &my_list);    // 包含 rcu_assign_pointer
    spin_unlock(&my_list_lock);
}

// 回调函数：宽限期结束后释放旧节点
static void free_entry_rcu(struct rcu_head *rcu) {
    struct my_entry *entry = container_of(rcu, struct my_entry, rcu);
    kfree(entry);
}

// 写者：删除节点
void remove_entry(struct my_entry *entry) {
    spin_lock(&my_list_lock);
    list_del_rcu(&entry->list);            // 从链表中摘除
    spin_unlock(&my_list_lock);
    call_rcu(&entry->rcu, free_entry_rcu); // 注册回调，宽限期后释放
}
```

注意写者之间仍然需要 spinlock 互斥（两个写者同时修改链表会破坏链表结构），但读者完全不需要任何锁。这就是 RCU 的精髓：读端零开销，写端承担复制和等待宽限期的代价。在读多写少的场景下，这种取舍非常划算。

:::thinking RCU 的宽限期怎么确定结束？

宽限期的核心问题是：如何确定所有在替换指针之前进入读侧临界区的读者都已经退出？

RCU 引入了静止状态(quiescent state)的概念。当一个 CPU 经过一次上下文切换、执行了用户态代码、或者进入了空闲循环(idle loop)，就认为它经过了一个静止状态。关键的推理是：`rcu_read_lock()` 和 `rcu_read_unlock()` 之间不能发生上下文切换（因为不能睡眠），所以一个 CPU 一旦经过了上下文切换，就意味着它之前的所有读侧临界区一定已经结束了。

宽限期的结束条件是：所有 CPU 都经过了至少一次静止状态。当这个条件满足时，可以确定没有任何 CPU 上还存在替换指针之前进入的读侧临界区。

`synchronize_rcu()` 的实现就是等待所有 CPU 经过静止状态。Linux 内核的 Tree RCU（`kernel/rcu/tree.c`）用一棵分层的树结构来高效地聚合各 CPU 的静止状态报告。每个 CPU 向叶子节点报告自己的静止状态，叶子节点向父节点汇聚，直到根节点确认所有 CPU 都经过了静止状态，宽限期结束。

这个设计的巧妙之处在于：它把"确认所有读者完成"这个全局问题，转化为了"确认所有 CPU 经过了上下文切换"这个局部可观测的事件。不需要读者显式地注册或注销，不需要全局计数器，只需要观察 CPU 的调度行为。这也是 RCU 读端零开销的根本原因：读者什么都不需要做（不需要修改任何共享变量），宽限期的检测完全由 RCU 基础设施在后台完成。
:::

:::expand Paul McKenney

Paul E. McKenney 是 RCU 机制在 Linux 内核中的主要设计者和维护者。他在 IBM Linux Technology Center 工作超过 20 年，专注于并行编程和 RCU 的研究与实现。他主导了 Linux 内核中多个 RCU 版本的开发，包括 Classic RCU、Tree RCU 和 Tiny RCU。他撰写的 *Is Parallel Programming Hard, And, If So, What Can You Do About It?* 是并行编程领域的经典参考书，可在线免费阅读。他目前在 Meta 工作，继续维护 Linux 内核的 RCU 子系统。
:::

:::expand SRCU(Sleepable RCU)

RCU 的读侧临界区有一个硬性约束：不能睡眠。这是因为宽限期的检测依赖于 CPU 经过上下文切换来确认读侧临界区结束。如果读者在 `rcu_read_lock()` 和 `rcu_read_unlock()` 之间睡眠了，它的 CPU 会发生上下文切换（调度其他进程运行），RCU 子系统会误认为这个 CPU 已经经过了静止状态，从而过早结束宽限期。此时如果写者释放了旧数据，仍在睡眠的读者醒来后继续使用旧指针就会访问已释放的内存。

但某些内核代码路径确实需要在 RCU 读侧临界区中执行可能睡眠的操作。SRCU(Sleepable RCU)就是为这种场景设计的。SRCU 使用 per-CPU 计数器来跟踪每个 CPU 上活跃的读者数量，而不是依赖上下文切换来推断读侧临界区的结束。`srcu_read_lock()` 增加当前 CPU 的读者计数，`srcu_read_unlock()` 减少计数。`synchronize_srcu()` 等待所有 CPU 的读者计数归零。这样即使读者睡眠了，只要它没有调用 `srcu_read_unlock()`，计数器就不为零，宽限期不会提前结束。

代价是 SRCU 的读端不再是零开销：每次 `srcu_read_lock()` 和 `srcu_read_unlock()` 都需要修改 per-CPU 计数器（通过 `this_cpu_inc()` 等 per-CPU 操作完成，不需要跨 CPU 的原子指令，但仍比普通 RCU 的空操作要重）。所以只在确实需要在读侧临界区中睡眠时才使用 SRCU。
:::

## Per-CPU 变量与完成变量

Per-CPU 变量(per-CPU variable)是为每个 CPU 核心分配独立副本的变量，各 CPU 只访问自己的副本，从根本上消除了共享和同步的需要。完成变量(completion)是一种轻量级的一次性事件通知机制，让一个线程等待另一个线程完成某项工作。

线程一课介绍了线程本地存储(TLS)：每个线程拥有变量的独立副本，通过 `thread_local` 关键字（或 C 的 `__thread`）声明，编译器把 TLS 变量放到 `.tdata`/`.tbss` 段，访问时通过 FS 段寄存器做相对寻址。Per-CPU 变量是 TLS 在内核中的对应物，但两者的设计动机有一个关键区别。TLS 的目的是隔离线程的私有数据（比如 `errno`），Per-CPU 变量的主要目的是消除同步开销：如果每个 CPU 只读写自己的副本，就不存在跨 CPU 的数据争用，线程一课讲过的伪共享问题也不会发生，同时也不需要任何锁。

```c
// include/linux/percpu.h
// 定义 per-CPU 变量
DEFINE_PER_CPU(int, my_counter);

// 访问 per-CPU 变量
void increment_counter(void) {
    get_cpu_var(my_counter)++;    // 禁用抢占 + 获取当前 CPU 的副本
    put_cpu_var(my_counter);       // 恢复抢占
}

// 跨 CPU 汇总
int total_count(void) {
    int total = 0;
    int cpu;
    for_each_possible_cpu(cpu)
        total += per_cpu(my_counter, cpu);
    return total;
}
```

`get_cpu_var()` 宏在返回当前 CPU 副本的指针之前，会先调用 `preempt_disable()` 禁用内核抢占。原因是：如果一段代码正在修改 CPU 0 的 `my_counter`，此时被抢占并迁移到 CPU 1 上继续执行，它接下来修改的就是 CPU 1 的 `my_counter`，而 CPU 0 的更新只做了一半。禁用抢占保证了在访问 per-CPU 变量期间，当前线程不会被迁移到其他 CPU。`put_cpu_var()` 恢复抢占。

Per-CPU 变量的典型使用场景包括：统计计数器（网络子系统中每个 CPU 独立计数发包和收包数量，需要总数时再汇总）、内核调度器的 per-CPU 运行队列（`struct rq`，每个 CPU 维护自己的就绪进程队列，避免全局队列的锁争用），以及 slab 分配器的 per-CPU 缓存（每个 CPU 维护自己的空闲对象链表，分配和释放大部分时候不需要访问全局对象池）。

完成变量解决的是另一个问题：一个线程需要等待另一个线程完成某项工作后才能继续。这听起来像 mutex，但两者的语义不同。mutex 保护的是共享数据：同一时刻只有一个线程能访问被保护的数据。completion 传递的是事件通知：一个线程说"我做完了"，另一个线程才开始动。

```c
// include/linux/completion.h
struct completion my_done;
init_completion(&my_done);

// 线程 A：等待工作完成
void thread_a(void) {
    start_work();
    wait_for_completion(&my_done);  // 阻塞，直到 complete() 被调用
    use_result();
}

// 线程 B：执行工作并通知完成
void thread_b(void) {
    do_work();
    complete(&my_done);             // 唤醒等待者
}
```

`wait_for_completion()` 会让当前线程睡眠，直到另一个线程调用 `complete()` 唤醒它。内核中典型的使用场景是：模块初始化时启动一个内核线程，主线程调用 `wait_for_completion()` 等待内核线程初始化完毕后再继续；或者驱动程序提交一个 DMA 传输请求，然后用 `wait_for_completion()` 等待 DMA 完成中断的回调调用 `complete()`。

RCU 的读侧临界区有一个硬性约束：不能睡眠。这是因为宽限期的检测依赖于 CPU 经过上下文切换来确认读侧临界区结束。如果读者在 `rcu_read_lock()` 和 `rcu_read_unlock()` 之间睡眠了，它的 CPU 会发生上下文切换（调度其他进程运行），RCU 子系统会误认为这个 CPU 已经经过了静止状态，从而过早结束宽限期。此时如果写者释放了旧数据，仍在睡眠的读者醒来后继续使用旧指针就会访问已释放的内存。

但某些内核代码路径确实需要在 RCU 读侧临界区中执行可能睡眠的操作。SRCU(Sleepable RCU)就是为这种场景设计的。SRCU 使用 per-CPU 计数器来跟踪每个 CPU 上活跃的读者数量，而不是依赖上下文切换来推断读侧临界区的结束。`srcu_read_lock()` 增加当前 CPU 的读者计数，`srcu_read_unlock()` 减少计数。`synchronize_srcu()` 等待所有 CPU 的读者计数归零。这样即使读者睡眠了，只要它没有调用 `srcu_read_unlock()`，计数器就不为零，宽限期不会提前结束。

代价是 SRCU 的读端不再是零开销：每次 `srcu_read_lock()` 和 `srcu_read_unlock()` 都需要修改 per-CPU 计数器（通过 `this_cpu_inc()` 等 per-CPU 操作完成，不需要跨 CPU 的原子指令，但仍比普通 RCU 的空操作要重）。所以只在确实需要在读侧临界区中睡眠时才使用 SRCU。
:::

## 小结

| 概念 | 说明 |
|------|------|
| 内核自旋锁 | 自旋 + 中断控制，四个变体对应不同的中断场景 |
| 内核抢占 | 可抢占内核中，持有 spinlock 或访问 per-CPU 数据时必须禁用抢占 |
| 内核互斥量 | 睡眠锁，三条路径（CAS 快速 / optimistic spinning / 睡眠），仅限进程上下文 |
| 顺序锁(seqlock) | 写者优先，读者通过序列计数器检测并重试，适合值类型的读多写少场景 |
| RCU(Read-Copy-Update) | 读端零开销（非抢占内核）或仅禁用/启用抢占（可抢占内核），写者等待宽限期后回收旧数据 |
| SRCU | RCU 的变体，允许读侧临界区睡眠，代价是读端需要修改 per-CPU 计数器 |
| Per-CPU 变量 | 每 CPU 独立副本，消除共享和同步 |
| 完成变量(completion) | 一次性事件通知，一个线程等待另一个线程完成工作 |

内核同步的设计哲学是让读的代价趋近于零：spinlock 让读写都付出自旋的代价，读写锁让读者之间不互斥，seqlock 让读者完全不阻塞写者，RCU 让读的开销降到零（非抢占内核）或仅一次禁用/启用抢占（可抢占内核），Per-CPU 变量连共享都消除了。

---

**Linux 源码入口**：
- [`include/linux/spinlock.h`](https://elixir.bootlin.com/linux/latest/source/include/linux/spinlock.h) — spinlock API 与变体宏
- [`kernel/locking/qspinlock.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/qspinlock.c) — queued spinlock 实现
- [`kernel/locking/mutex.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/mutex.c) — mutex 实现与 optimistic spinning
- [`include/linux/seqlock.h`](https://elixir.bootlin.com/linux/latest/source/include/linux/seqlock.h) — seqlock 定义与内联函数
- [`kernel/rcu/tree.c`](https://elixir.bootlin.com/linux/latest/source/kernel/rcu/tree.c) — Tree RCU 核心实现
- [`include/linux/percpu.h`](https://elixir.bootlin.com/linux/latest/source/include/linux/percpu.h) — Per-CPU 变量 API
- [`include/linux/completion.h`](https://elixir.bootlin.com/linux/latest/source/include/linux/completion.h) — completion API
