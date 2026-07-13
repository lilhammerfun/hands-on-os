# 内核同步机制

- 写作时间：`2026-03-04 首次提交，2026-07-13 最近修改`
- 当前字符：`12627`

[事件驱动并发](/concurrency/04-event-driven)通过明确状态归属，让少量线程可以管理大量等待。但内核不能只面对一种执行流：用户进程进入系统调用时会执行内核代码，内核线程可与其他执行流并发，设备发出的硬件中断还可能暂停当前代码并转去执行中断处理函数。同一份内核数据因而可能被不同入口、不同 CPU 同时访问。

来看一个驱动中的队列。进程正在持锁修改队列时，本 CPU 收到硬件中断；中断处理函数也要获取同一把锁。若进程只调用普通 `spin_lock()`，本地中断仍可发生。中断处理函数会一直自旋等待，而真正持锁的代码只有等中断返回后才能继续，单个 CPU 上便形成自死锁。这里不是缺少一把更强的锁，而是加锁前没有先判断代码可能在哪种环境中运行。

因此，本课先用 **执行上下文**确定代码能否睡眠、能被谁打断。不能睡眠的临界区使用 **内核自旋锁**，允许睡眠的进程上下文可以选择 **内核互斥量**。读多写少、可以整体复制的数据若允许读者重试，可以改用 **顺序锁**；共享对象的指针与回收时机需要同时管理时，则进入 **RCU**。如果共享本身不是必需的，**Per-CPU 变量**把写入拆到各 CPU 的独立副本。最后，线程并非总在争夺数据，有时只是等待另一项工作到达某个里程碑，这由 **完成变量**表达。

## 执行上下文

执行上下文(execution context)是内核代码当前由哪类活动触发，以及这种活动对抢占、中断和睡眠施加哪些约束。

这里的“睡眠”不是 CPU 进入低功耗状态，而是当前任务把自己放入等待状态，让调度器选择其他任务运行。睡眠要求存在一个可被调度器管理的任务，等待条件满足后再把这个任务唤醒。因此，能否睡眠不是函数自身的固定属性，还取决于调用它时所处的上下文。

内核中最常见的三类上下文如下：

| 上下文 | 触发方式 | 能否主动睡眠 | 典型约束 |
|--------|----------|--------------|----------|
| 进程上下文 | 系统调用处理或内核线程 | 通常可以 | 禁用抢占、关闭中断或持有自旋锁后不能睡眠 |
| 硬中断上下文 | 设备向 CPU 发出中断请求 | 不可以 | 必须尽快处理并返回被打断的位置 |
| 软中断上下文 | 内核延后执行的一类中断工作 | 不可以 | 可在多个 CPU 并行，也可能被硬中断打断 |

进程上下文代表某个任务执行。内核可用 `current` 找到这个任务，允许它加入等待队列并由调度器切换出去。但“正在进程上下文”仍不等于“此刻一定能睡眠”：代码一旦关闭本地中断、禁用抢占或持有普通自旋锁，就进入了不能主动调度的区间。

硬中断处理函数不是一个可以独立加入等待队列的调度实体。它借用当前 CPU 立即执行，并必须完成后返回被打断的代码。即使 `current` 仍能指向被打断的任务，也不能把中断处理函数当成该任务的一段普通可睡眠代码。软中断同样运行在不可睡眠的环境中，只是触发和执行时机与硬中断不同。

原子上下文(atomic context)是对所有“不能主动睡眠”区间的统称。硬中断、软中断、关闭中断的代码、禁用抢占的代码和持有自旋锁的临界区都属于这一类。这里的 atomic 强调调度约束，不表示临界区内的多条指令自动成为一个硬件原子操作。

选择同步原语时，第一个问题因此不是“临界区有几行”，而是“等待这把锁时是否允许睡眠”。若答案是否定的，只能使用不会让当前执行流睡眠的原语；若答案是肯定的，才有资格在自旋锁和睡眠锁之间继续比较竞争、持有时间与调度成本。

## 内核自旋锁

内核自旋锁(kernel spinlock)是等待者持续检查锁状态而不主动睡眠的互斥原语，适用于不可睡眠的执行上下文和受严格约束的短临界区。

在普通未启用完全抢占实时配置(PREEMPT_RT)的内核中，`spin_lock()` 获取锁时会禁止当前任务在本 CPU 上被抢占，但不会关闭本地硬中断。这样可以防止任务持锁后被同一 CPU 上的另一任务抢占，却不能阻止开篇中的中断处理函数重入同一临界区。

如果同一份数据会被进程上下文和硬中断上下文访问，进程侧必须在持锁前关闭本 CPU 的硬中断。最稳妥的常见写法是保存原中断状态：

```c
static DEFINE_SPINLOCK(queue_lock);

void update_queue(struct item *item)
{
    unsigned long flags;

    spin_lock_irqsave(&queue_lock, flags);
    add_item(item);
    spin_unlock_irqrestore(&queue_lock, flags);
}
```

`spin_lock_irqsave()` 先把当前本地中断状态写入 `flags`，再关闭本地硬中断并获取锁；解锁接口先释放锁，再恢复保存的状态。若外层代码本来已经关闭中断，恢复后仍保持关闭，而不是错误地把中断打开。

不同后缀控制的是本 CPU 上哪些执行入口可以重入：

| 接口 | 本地附加约束 | 适用前提 |
|------|--------------|----------|
| `spin_lock()` | 禁止抢占 | 数据不会从本地硬中断或软中断重入，或调用点已经处理这些入口 |
| `spin_lock_bh()` | 禁止抢占并关闭软中断处理 | 数据同时由进程上下文和软中断访问 |
| `spin_lock_irq()` | 关闭本地硬中断 | 已知进入前硬中断处于开启状态 |
| `spin_lock_irqsave()` | 保存并关闭本地硬中断 | 调用点原有中断状态不确定，解锁时需要准确恢复 |

关闭本地中断只影响当前 CPU。其他 CPU 仍可到达同一数据，因此它们还要通过自旋锁互斥。反过来，自旋锁只解决 CPU 之间的同时访问；只有 `_bh`、`_irq` 或 `_irqsave` 变体才解决本 CPU 被相应中断入口重入的问题。这两个作用必须同时理解。

持有自旋锁期间不能调用可能睡眠的函数。若持锁者睡眠，其他 CPU 会持续自旋消耗处理器，而且调度与唤醒路径本身还可能需要当前上下文禁止的操作。临界区还应保持有界，避免复制大量数据、等待设备或执行无法预估次数的循环。是否改用 mutex 不应靠固定的指令数决定，而应先检查上下文合法性，再用实际竞争和延迟数据判断。

[死锁](/concurrency/03-deadlock)介绍过的 lockdep 也会验证内核锁的中断用法。lockdep 是运行时锁正确性验证器：它把遵循同一规则的锁实例归为锁类，记录已经执行过的获取顺序，并记录锁类是否在硬中断、软中断开启或关闭的环境中出现。若某个锁类既可在硬中断中获取，又曾在本地硬中断开启时由可被打断的路径获取，lockdep 可以根据这两段已观察事实报告潜在自死锁。它不要求危险时序真的发生，但也看不到测试从未执行的路径，因此不能替代锁规则审查。

:::expand PREEMPT_RT 中的自旋锁

PREEMPT_RT 配置以更强的实时抢占能力为目标，会改变 `spinlock_t` 的实现语义。普通内核中 `spinlock_t` 映射到 `raw_spinlock_t`，获取后禁止抢占；PREEMPT_RT 中的 `spinlock_t` 建立在实时 mutex 机制上，等待者可能阻塞，任务保持不可迁移，但仍可被抢占。`_irq` 和 `_irqsave` 后缀也不再按普通内核方式改变硬中断状态。

真正必须在硬中断等原子上下文中保持非睡眠语义的底层代码使用 `raw_spinlock_t`。这一区别说明“spinlock 一定只会忙等”不是跨所有内核配置都成立的接口结论。正文其余部分讨论的是常见非 PREEMPT_RT 语义，阅读实时内核代码时必须重新核对锁类型。
:::

## 内核互斥量

内核互斥量(kernel mutex)是由 `struct mutex` 表示的睡眠锁，竞争失败的任务可以进入等待队列，因此只能在允许睡眠的进程上下文中获取。

mutex 与自旋锁保护的目标相同，都是让临界区一次只由一个执行流进入；差别在等待策略。无竞争时，mutex 通过原子操作把 owner 从空值改为当前任务，直接走快速路径。有竞争时，Linux 不一定立即睡眠：若持有者正在 CPU 上运行，而且当前任务不需要调度，等待者可以短暂进行乐观自旋，期待持有者很快解锁。内核用队列限制同时竞争的自旋者，避免所有等待者反复修改同一锁状态。

若继续自旋不合适，任务进入慢速路径，加入 mutex 的等待队列并睡眠；解锁路径再唤醒等待者。因此 `struct mutex` 在语义上仍是睡眠锁，乐观自旋只是减少短暂竞争下调度开销的内部优化，不能据此把 mutex 用进硬中断、软中断或其他原子上下文。

mutex 的基本规则包括：

| 规则 | 原因 |
|------|------|
| 只能由持有者解锁 | owner 表示具体任务，跨任务解锁会破坏所有权 |
| 不支持递归获取 | 同一任务再次获取自己持有的普通 mutex 会自死锁 |
| 不能在中断上下文获取 | 竞争路径可能睡眠 |
| 不能在持有自旋锁时获取 | mutex 睡眠会违反外层原子上下文约束 |
| 释放前要恢复共享不变量 | 解锁只建立互斥边界，不会替代码修复半更新状态 |

`mutex_lock()` 默认进行不可中断等待；`mutex_lock_interruptible()` 允许信号中断等待，并通过返回值告诉调用者是否真正取得锁；`mutex_trylock()` 不等待，只报告本次是否成功。后两者都会引入额外控制路径，代码必须只在成功取得锁后访问临界区，并在每条退出路径正确解锁。

自旋锁与 mutex 的选择可以归结为下面的顺序：

1. 若调用路径可能位于硬中断、软中断或其他原子上下文，排除 mutex。
2. 若临界区内需要调用允许睡眠的接口，例如可能阻塞的内存分配或设备操作，排除普通自旋锁。
3. 两者都合法时，再根据持锁时间、竞争概率、CPU 数量和调度延迟进行测量，而不是套用固定时长阈值。

调试配置中的 `might_sleep()` 检查可以在原子上下文走到潜在睡眠点时发出诊断，lockdep 则继续检查 mutex 与其他锁之间的依赖顺序。前者发现上下文违规，后者发现锁关系违规；两类工具覆盖的问题不同。

## 顺序锁

顺序锁(seqlock)是把序列计数器与写者自旋锁组合起来的同步原语，写者彼此互斥，而读者不加锁地复制数据并在版本变化时重试。

序列计数器(sequence counter)是这套机制的核心。没有写者时，计数值为偶数；写者开始修改前把它变成奇数，修改完成后再变回下一个偶数。读者先取得起始值，复制整组数据，再检查结束时的计数：起始值为偶数且前后相同，才表示这份副本没有跨过写入过程。

```c
struct clock_snapshot {
    u64 seconds;
    u32 nanoseconds;
};

static DEFINE_SEQLOCK(clock_lock);
static struct clock_snapshot clock_state;

void update_clock(u64 seconds, u32 nanoseconds)
{
    write_seqlock(&clock_lock);
    clock_state.seconds = seconds;
    clock_state.nanoseconds = nanoseconds;
    write_sequnlock(&clock_lock);
}

struct clock_snapshot read_clock(void)
{
    struct clock_snapshot copy;
    unsigned int seq;

    do {
        seq = read_seqbegin(&clock_lock);
        copy.seconds = READ_ONCE(clock_state.seconds);
        copy.nanoseconds = READ_ONCE(clock_state.nanoseconds);
    } while (read_seqretry(&clock_lock, seq));

    return copy;
}
```

`read_seqbegin()` 与 `read_seqretry()` 包含这套协议需要的编译器和 CPU 内存顺序约束，不能用两个普通变量读取随意替换。读者还必须在循环内先复制到局部变量，验证成功后再使用；如果验证失败，此轮读到的所有字段都应丢弃。

裸 `seqcount_t` 只维护计数，不会阻止两个写者同时进入。调用者必须用外部锁串行化写者，并保证写侧临界区不可被会执行读侧代码的上下文抢占。`seqlock_t` 内嵌一个 `spinlock_t`，自动完成写者互斥和普通抢占保护；若读者可能来自硬中断或软中断，写侧还要使用对应的 `_irqsave` 或 `_bh` 变体，避免写者停在奇数状态时被读者打断并让读者持续重试。

顺序锁不会让写者等待普通无锁读者，但写者仍会等待其他写者。读者也不是保证一次成功：写入频繁或写侧临界区过长时，读者可能反复重试甚至饥饿。因此它适合写入少、读取快，并且数据可以廉价复制的场景。

顺序锁通常不适合保护可能被写者释放或失效的指针。读者取得指针后，尚未执行结束校验，写者就可能让目标对象失效；即使读者随后发现版本变化，危险的解引用已经发生。顺序计数只能判断快照是否一致，不能延长对象生命周期。需要无锁读取指针结构并推迟回收时，必须使用能管理生命周期的机制。

## RCU

读-复制-更新(Read-Copy-Update, RCU)是面向读多写少指针结构的同步机制，它允许读者访问仍然有效的旧版本，同时把更新拆成发布或移除与延迟回收两个阶段。

顺序锁让读者在冲突时重试，却不能保护已经失效的对象。RCU 改变的是对象回收时机：更新者可以立即让新读者不再看到旧对象，但必须等待所有可能仍持有旧引用的读者离开后，才能释放旧对象。这个等待区间称为宽限期(grace period)。

一条典型 RCU 路径包含三个协议：

1. 读者在 `rcu_read_lock()` 与 `rcu_read_unlock()` 之间取得并使用 RCU 指针。
2. 更新者初始化新对象，再用 RCU 发布接口替换指针，或把旧对象从结构中摘除。
3. 更新者等待一个宽限期，或注册宽限期结束后的回调，然后才回收旧对象。

下面的配置指针示例展示了这三个阶段：

```c
struct config {
    int limit;
};

static struct config __rcu *active_config;
static DEFINE_MUTEX(config_lock);

int read_limit(void)
{
    struct config *config;
    int limit;

    rcu_read_lock();
    config = rcu_dereference(active_config);
    limit = config ? READ_ONCE(config->limit) : 0;
    rcu_read_unlock();

    return limit;
}

void replace_config(struct config *new_config)
{
    struct config *old_config;

    mutex_lock(&config_lock);
    old_config = rcu_dereference_protected(
        active_config, lockdep_is_held(&config_lock));
    rcu_assign_pointer(active_config, new_config);
    mutex_unlock(&config_lock);

    synchronize_rcu();
    kfree(old_config);
}
```

`rcu_assign_pointer()` 不只写入一个地址，还保证新对象的初始化在指针对其他 CPU 可见前完成。`rcu_dereference()` 读取受 RCU 保护的指针，并保留随后解引用所需的编译器和硬件顺序。普通赋值与普通指针读取缺少这些协议含义，也会绕过内核的静态检查。

示例把已经发布的 `struct config` 当作不可原地修改的对象，并用 `config_lock` 串行化多个更新者。RCU 只保证读者所引用的旧对象在宽限期前不会被回收，不会自动阻止两个写者同时修改结构，也不会让任意原地字段更新成为一致快照。需要原地更新时，还要为相应字段建立锁、原子操作或其他明确协议。

宽限期等待的是“发布或移除动作发生前已经进入、因而可能取得旧引用的相关读侧临界区”结束，不是等待系统中永远不再出现读者。更新协议必须先撤销从共享结构到旧对象的入口，再开始等待；此后按当前结构查找的读者不会通过该入口新取得旧对象。读者若要在 `rcu_read_unlock()` 之后继续保存对象，必须在临界区内取得引用计数或使用其他生命周期协议，不能只把裸指针带出去。

静止状态(quiescent state)是 RCU 用来证明某个 CPU 不再处于旧读侧临界区的可观察状态。非抢占式 RCU 可以利用上下文切换、进入用户态或进入空闲状态等事件报告静止状态。可抢占 RCU 允许读侧临界区被调度器抢占，但仍不允许读者主动执行会阻塞的操作；若读者被抢占，Tree RCU 会跟踪对应任务，直到其最外层 `rcu_read_unlock()` 完成。因而“每个 CPU 都切换过一次”只是理解宽限期的起点，不是覆盖所有内核配置的完整算法。

Tree RCU 用分层的 `rcu_node` 结构汇总 CPU 和被抢占读者的状态，避免所有 CPU 直接竞争一个全局计数器。`synchronize_rcu()` 让当前更新者睡眠等待宽限期；`call_rcu()` 注册回调，让更新者先继续执行，回调在宽限期后处理回收。前者控制流直观但会等待，后者适合不能同步等待或希望批量回收的路径。

RCU 读侧通常不获取互斥锁、不写全局共享计数，也不与其他读者争用同一缓存行，因此开销很低。但“低开销”不等于在所有配置、调试选项和 RCU 类型下都编译为空操作。更新者还要承担对象复制或摘除、写者互斥、宽限期跟踪和延迟回收的成本，所以 RCU 适合经过设计的读多写少结构，不是通用的无锁替代品。

:::expand SRCU

可睡眠 RCU(Sleepable RCU, SRCU)是允许读侧临界区主动睡眠的一种 RCU 类型。读者通过 `srcu_read_lock()` 取得索引，并在 `srcu_read_unlock()` 时交还；`synchronize_srcu()` 根据显式读者状态等待宽限期，而不是把普通 RCU 的调度约束直接套用过来。

这种能力会增加读侧记账和每个 SRCU 域的管理成本。只有读者确实需要跨越可睡眠操作时才应选择 SRCU；普通 RCU、SRCU 和其他 RCU 类型的读锁与宽限期接口不能随意混用。
:::

## Per-CPU 变量

每 CPU 变量(per-CPU variable)是为每个可能的 CPU 分配独立副本的数据，使本地更新不必争用同一个全局存储位置。

[线程](/concurrency/01-thread)介绍的 TLS 按线程保存副本，Per-CPU 变量则按 CPU 保存副本。它的主要目标不是为任务保密，而是把频繁写入分散开：CPU 0 更新自己的计数，CPU 1 更新另一份计数，两者就不需要反复争夺同一缓存行的写权限。

```c
DEFINE_PER_CPU(unsigned long, packet_count);

void account_packet(void)
{
    this_cpu_inc(packet_count);
}
```

`this_cpu_inc()` 把“选择当前 CPU 副本”和“递增”组合为一个本地操作，不需要先取得全局锁。任务可能在这条操作之前或之后迁移，所以单个 CPU 的计数不一定代表某个固定任务的历史；但每次递增都会落入某个 CPU 的有效副本，所有副本之和仍保留总次数。

若代码需要取得本地副本指针并连续执行多步操作，就必须在整个区间防止迁移。`get_cpu_ptr()` 会禁止抢占并返回当前 CPU 的副本，`put_cpu_ptr()` 在结束时恢复抢占。单独调用 `this_cpu_ptr()` 取得的指针，也只能在调用者已经保证不会迁移的区间安全使用；抢占恢复后继续保存这个指针，可能操作错误 CPU 的副本。

Per-CPU 只消除了不同 CPU 对同一副本的常规争用，不会自动处理本 CPU 上进程上下文与中断上下文的重入。如果两者会用多步读改写访问同一副本，仍要选择适合该上下文的本地中断控制或原子操作。其他 CPU 直接写远端 CPU 的副本也属于例外路径，可能破坏 `this_cpu_*` 所依赖的本地更新假设。

汇总同样有代价：

```c
unsigned long total_packets(void)
{
    unsigned long total = 0;
    int cpu;

    for_each_possible_cpu(cpu)
        total += per_cpu(packet_count, cpu);

    return total;
}
```

如果各 CPU 正在并发更新，这个结果通常只是逐项读取期间的近似快照，不保证对应某个单一时刻。统计接口可以接受近似值时，这种取舍很合适；若调用者要求严格一致的总数，就要增加冻结、版本校验或其他同步协议，不能因为数据叫 Per-CPU 就省略一致性定义。

内核把 Per-CPU 设计用于高频统计、本地缓存和调度数据等场景。它用汇总复杂度和额外内存换取本地快速路径，核心收益是避免共享写入，而不是让任意跨 CPU 操作自动安全。

## 完成变量

完成变量是内核中的事件同步对象，它让进程上下文等待某项活动到达已完成状态，并由执行该活动的上下文发出通知。

mutex 表示“取得所有权后才能进入临界区”，completion 表示“某个里程碑尚未发生，发生后才继续”。例如驱动提交设备初始化后，调用任务可以等待初始化完成；中断处理或工作线程完成初始化时调用 `complete()`。等待者不需要占有完成者使用的数据，也不应反复检查状态并调用毫秒级睡眠函数 `msleep()` 猜测工作何时结束。

```c
static DECLARE_COMPLETION(setup_done);

void setup_worker(void)
{
    initialize_device();
    complete(&setup_done);
}

int start_device(void)
{
    queue_setup_work();
    wait_for_completion(&setup_done);
    return use_initialized_device();
}
```

completion 内部保存完成计数和等待队列。`complete()` 记录一次完成并唤醒一个等待者；如果通知先于 `wait_for_completion()` 发生，完成状态会被记住，后来的等待者可以直接继续，不会丢失唤醒。`complete_all()` 把对象标记为全部完成，使当前以及随后到达的等待者都能继续，直到调用方在确认并发使用已经结束后显式重新初始化；它的语义不同于连续调用一次 `complete()`。

等待接口可能睡眠，所以 `wait_for_completion()` 及其等待变体只能在允许睡眠、硬中断开启且抢占允许的进程上下文调用。发出通知的 `complete()` 不需要睡眠，可以由中断处理等上下文调用。带 timeout 或 interruptible 的等待接口会返回状态，调用者必须区分完成、超时和信号中断，不能把所有非正值合并为同一种结果。

完成对象的生命周期必须覆盖通知方与所有等待方。把 completion 放在栈上后进行超时等待尤其危险：函数超时返回并释放栈帧后，异步完成者若仍调用 `complete()`，就会写入失效内存。此时需要取消并等待异步活动结束，或把 completion 放进生命周期更长的对象。`reinit_completion()` 可以重置已协调好的对象，但不能在仍有并发等待或通知时用来强行开始下一轮。

| 需求 | 合适原语 | 关键语义 |
|------|----------|----------|
| 保护共享不变量 | spinlock 或 mutex | 进入临界区前取得所有权 |
| 读取一致值快照 | seqlock | 复制后验证版本，冲突时重试 |
| 读取指针结构并延迟回收 | RCU | 移除后等待旧读者离开再释放 |
| 高频本地更新 | Per-CPU 变量 | 分散写入，按需汇总 |
| 等待一次工作到达里程碑 | completion | 完成状态可先于等待发生并被记住 |

## 小结

| 概念 | 说明 |
|------|------|
| 执行上下文 | 决定代码能否睡眠、会被哪些入口打断以及可用的同步原语 |
| 原子上下文 | 所有不能主动睡眠的中断、禁抢占、关中断或持自旋锁区间 |
| 内核自旋锁 | 等待者不睡眠，并可配合 `_bh`、`_irq`、`_irqsave` 控制本地重入 |
| lockdep | 记录锁类顺序和中断用法，验证已执行路径组成的潜在错误 |
| 内核互斥量 | 允许竞争任务进入等待队列的进程上下文睡眠锁 |
| 顺序锁 | 写者互斥，读者复制值后检查序列并在冲突时重试 |
| RCU | 让旧读者继续访问有效对象，并把回收推迟到宽限期之后 |
| 静止状态 | RCU 用来证明旧读侧临界区已经结束的可观察状态 |
| Per-CPU 变量 | 按 CPU 拆分频繁写入，以额外内存和汇总代价减少共享竞争 |
| 完成变量 | 记录工作完成事件并用等待队列唤醒进程上下文 |

内核同步没有一条按性能从慢到快排列的原语清单，真正的选择顺序是先满足执行上下文，再确定要保护的是互斥、快照、对象生命周期、本地更新还是事件完成，最后才优化竞争成本。

---

**Linux 文档与源码入口**：
- [Lock types and their rules](https://docs.kernel.org/locking/locktypes.html)：原子上下文、`spinlock_t` 与 PREEMPT_RT 语义
- [Runtime locking correctness validator](https://docs.kernel.org/locking/lockdep-design.html)：锁类、依赖边与中断安全状态
- [Generic Mutex Subsystem](https://docs.kernel.org/locking/mutex-design.html)：mutex 快速路径、乐观自旋与睡眠慢速路径
- [Sequence counters and sequential locks](https://docs.kernel.org/locking/seqlock.html)：`seqcount_t`、`seqlock_t` 与读者重试规则
- [RCU Concepts](https://docs.kernel.org/RCU/rcu.html)：移除、宽限期与延迟回收
- [Using RCU to Protect Read-Mostly Linked Lists](https://docs.kernel.org/RCU/listRCU.html)：RCU 指针结构与对象生命周期实例
- [this_cpu operations](https://docs.kernel.org/core-api/this_cpu_ops.html)：Per-CPU 地址、迁移约束与本地操作
- [Completions](https://docs.kernel.org/scheduler/completion.html)：等待、通知、超时与对象生命周期
- [`kernel/locking/`](https://github.com/torvalds/linux/tree/master/kernel/locking)：spinlock、mutex 与 lockdep 实现
- [`kernel/rcu/`](https://github.com/torvalds/linux/tree/master/kernel/rcu)：Tree RCU、宽限期与回调实现
- [`kernel/sched/completion.c`](https://github.com/torvalds/linux/blob/master/kernel/sched/completion.c)：completion 等待与唤醒实现
