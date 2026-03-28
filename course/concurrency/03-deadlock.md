# 死锁

- 写作时间：`2026-03-04 首次提交，2026-03-27 最近修改`
- 当前字符：`16910`

上一课的同步原语解决了竞态条件，但锁本身会带来新的问题。来看一个最简单的例子：两个线程都需要同时持有两把锁，但获取顺序相反。

```c
#include <pthread.h>
#include <stdio.h>

pthread_mutex_t lock_a = PTHREAD_MUTEX_INITIALIZER;
pthread_mutex_t lock_b = PTHREAD_MUTEX_INITIALIZER;

void *thread1(void *arg) {
    pthread_mutex_lock(&lock_a);
    printf("thread1: acquired lock_a\n");
    pthread_mutex_lock(&lock_b);    // 等 thread2 释放 lock_b
    printf("thread1: acquired lock_b\n");
    pthread_mutex_unlock(&lock_b);
    pthread_mutex_unlock(&lock_a);
    return NULL;
}

void *thread2(void *arg) {
    pthread_mutex_lock(&lock_b);
    printf("thread2: acquired lock_b\n");
    pthread_mutex_lock(&lock_a);    // 等 thread1 释放 lock_a
    printf("thread2: acquired lock_a\n");
    pthread_mutex_unlock(&lock_a);
    pthread_mutex_unlock(&lock_b);
    return NULL;
}

int main() {
    pthread_t t1, t2;
    pthread_create(&t1, NULL, thread1, NULL);
    pthread_create(&t2, NULL, thread2, NULL);
    pthread_join(t1, NULL);
    pthread_join(t2, NULL);
    printf("done\n");
}
```

```
$ gcc -pthread deadlock.c && ./a.out
thread1: acquired lock_a
thread2: acquired lock_b
█                          ← 程序挂起，永远不会打印 done
```

thread1 持有 lock_a、等待 lock_b，thread2 持有 lock_b、等待 lock_a。两个线程互相等待对方释放锁，谁也无法继续。程序没有崩溃，也没有报错，只是永远停在那里。这就是 ABBA 死锁：两个线程以相反的顺序（A→B 和 B→A）获取同一组锁。

这个程序永远不会结束。要理解为什么，先从 ABBA 示例中推导出**死锁的四个必要条件**——互斥、持有并等待、非抢占、循环等待，缺一不可。条件有了，需要一种工具来可视化分析：**资源分配图**把线程和资源画成有向图，死锁就变成图中的环检测问题。分析清楚后，讨论操作系统的**死锁处理策略**：预防、避免、检测、恢复，每种策略本质上都是破坏四个条件中的某一个。死锁是线程被阻塞而无法推进，但还有一种相反的情况——线程一直在执行却没有任何有效进展，这就是**活锁**。最后，死锁只是并发 bug 中最显著的一类，我们对所有**并发 bug** 做一个整体分类，建立全局视角。

## 死锁的四个必要条件

死锁(deadlock)是两个或多个线程互相等待对方释放资源，导致所有线程永远无法继续执行的状态。

回到开篇的 ABBA 示例。程序为什么会挂起？用时间交错表还原一下：

| 时刻 | thread1 | thread2 | lock_a | lock_b |
|------|---------|---------|--------|--------|
| 1 | `pthread_mutex_lock(A)` 成功 | | 被 T1 持有 | 空闲 |
| 2 | | `pthread_mutex_lock(B)` 成功 | 被 T1 持有 | 被 T2 持有 |
| 3 | `pthread_mutex_lock(B)` 阻塞 | | 被 T1 持有 | 被 T2 持有 |
| 4 | | `pthread_mutex_lock(A)` 阻塞 | 被 T1 持有 | 被 T2 持有 |

时刻 3，thread1 想获取 lock_b，但 lock_b 被 thread2 持有，thread1 阻塞。时刻 4，thread2 想获取 lock_a，但 lock_a 被 thread1 持有，thread2 阻塞。此时两个线程都在等对方释放锁，而释放锁的前提是获取到另一把锁。条件永远不会满足，程序永远不会推进。

从这个示例中可以提取出死锁形成的四个条件。这四个条件在 1971 年由 Coffman 等人提出，每一个都必不可少。

:::expand Edward G. Coffman Jr.
Edward G. Coffman Jr. 是美国计算机科学家，长期任职于 Bell Labs 和哥伦比亚大学。他在 1971 年与 Elphick、Shoshani 合著的论文 *System Deadlocks* 中首次系统地归纳了死锁的四个必要条件，这一表述至今仍是所有操作系统教材讲解死锁的标准框架。
:::

**互斥(Mutual Exclusion)**。资源一次只能被一个线程持有。在示例中，`pthread_mutex_lock()` 保证了 lock_a 和 lock_b 在同一时刻只能被一个线程持有。如果两个线程可以同时持有同一把锁，thread1 在时刻 3 就不会阻塞，死锁不会发生。

**持有并等待(Hold and Wait)**。线程在持有至少一个资源的同时，等待获取其他资源。thread1 持有 lock_a 的同时等待 lock_b，thread2 持有 lock_b 的同时等待 lock_a。如果规则要求"要么一次性获取所有锁，要么一个都不持有"，那 thread1 在获取 lock_b 失败时就必须释放 lock_a，死锁不会形成。

**非抢占(No Preemption)**。已经被线程持有的资源不能被强制夺走，只能由持有者主动释放。thread2 持有 lock_b，操作系统不能强行把 lock_b 从 thread2 手里拿走交给 thread1。如果可以抢占，thread1 等不到 lock_b 时，系统可以强制 thread2 释放 lock_b，死锁就被打破了。

**循环等待(Circular Wait)**。存在一条线程链，每个线程都在等待链中下一个线程持有的资源。thread1 等待 thread2 持有的 lock_b，thread2 等待 thread1 持有的 lock_a，形成了一个环。如果所有线程都按相同的顺序获取锁（比如都先获取 lock_a 再获取 lock_b），就不会形成环，死锁不会发生。

## 资源分配图

资源分配图(Resource-Allocation Graph, RAG)是用有向图表示线程和资源之间持有/请求关系的模型。

RAG 包含两类节点和两类边：

- **线程节点**（圆形）：图中的每个圆代表一个线程（或进程）
- **资源节点**（方形 + 圆点）：图中的每个方形代表一类资源，方形内的圆点数量表示该资源的实例数。例如一个方形内有 3 个圆点，表示该资源有 3 个实例
- **请求边**（线程 → 资源）：线程正在等待获取该资源
- **分配边**（资源 → 线程）：该资源的一个实例已经分配给了这个线程

画出 ABBA 示例的资源分配图：

```
         请求                   分配
  T₁ ──────────→ lock_b ──────────→ T₂
  ↑                                  │
  │              分配                │
  └────────── lock_a ←───────────────┘
                             请求
```

$T_1$ 持有 lock_a（lock_a → $T_1$ 的分配边），请求 lock_b（$T_1$ → lock_b 的请求边）。$T_2$ 持有 lock_b（lock_b → $T_2$ 的分配边），请求 lock_a（$T_2$ → lock_a 的请求边）。沿着边的方向走：$T_1$ → lock_b → $T_2$ → lock_a → $T_1$，形成了一个环。

RAG 的核心定理是：**如果图中没有环，则系统没有死锁。** 对于每类资源只有一个实例的情况（如 mutex），定理还有更强的形式：**有环则必定死锁。** 开篇的 ABBA 示例中，lock_a 和 lock_b 都是 mutex（单实例资源），图中有环，所以一定是死锁。

上一课结尾介绍的哲学家就餐问题也可以用 RAG 分析。五个哲学家 $P_0$-$P_4$，五根筷子 $C_0$-$C_4$。每个哲学家先拿左边的筷子（$P_i$ 请求 $C_i$），再拿右边的筷子（$P_i$ 请求 $C_{(i+1)\%5}$）。如果所有哲学家都拿起了左边的筷子，RAG 中就形成了一个五节点的环：$P_0$ → $C_1$ → $P_1$ → $C_2$ → $P_2$ → $C_3$ → $P_3$ → $C_4$ → $P_4$ → $C_0$ → $P_0$。每根筷子是单实例资源，有环即死锁。

:::expand 多实例资源的资源分配图

前面说"有环则必定死锁"只对单实例资源成立。如果一类资源有多个实例，有环不一定死锁。

考虑这个例子：资源 $R$ 有 2 个实例，线程 $T_1$ 和 $T_2$ 各持有一个实例，线程 $T_3$ 正在请求 $R$。

```
T₁ ←── R (2 instances) ──→ T₂
       ↑
       │
       T₃（请求 R）
```

$T_3$ 请求 $R$，$R$ 的两个实例分别被 $T_1$ 和 $T_2$ 持有，所以 $T_3$ 必须等待。但只要 $T_1$ 或 $T_2$ 中的任何一个释放了它持有的实例，$T_3$ 就可以获取，不会死锁。这里虽然可以画出 $T_3$ → $R$ → $T_1$ 的路径，但不构成死锁，因为 $T_1$ 没有在等待 $T_3$ 持有的任何资源。

对于多实例资源，判断死锁需要更复杂的算法（如银行家算法），单纯的环检测不够。但在实践中，大多数同步资源都是 mutex（单实例），所以"有环即死锁"这个判据覆盖了最常见的场景。
:::

## 死锁处理策略

操作系统处理死锁有四种策略：预防、避免、检测和恢复。

**预防**是在设计阶段就保证死锁不可能发生，方法是破坏四个必要条件中的一个。**避免**是在运行时，每次分配资源前检查是否会导致死锁，如果会就拒绝。**检测**是允许死锁发生，但通过算法定期检测。**恢复**是检测到死锁后采取措施消除它。

这四种策略从严到松，预防最保守但最简单，检测+恢复最灵活但最复杂。

**预防：破坏循环等待。** 给所有锁定义一个全局顺序，所有线程必须按这个顺序获取锁。这是最实用的死锁预防方法。

回到 ABBA 示例。死锁的原因是 thread1 按 lock_a → lock_b 获取，thread2 按 lock_b → lock_a 获取。如果规定"lock_a 的顺序在 lock_b 之前，所有线程必须先获取 lock_a 再获取 lock_b"，thread2 就必须改成先获取 lock_a 再获取 lock_b：

```c
void *thread2_fixed(void *arg) {
    pthread_mutex_lock(&lock_a);    // 先获取 lock_a（遵守全局锁序）
    printf("thread2: acquired lock_a\n");
    pthread_mutex_lock(&lock_b);    // 再获取 lock_b
    printf("thread2: acquired lock_b\n");
    pthread_mutex_unlock(&lock_b);
    pthread_mutex_unlock(&lock_a);
    return NULL;
}
```

两个线程都先竞争 lock_a，只有一个能获取成功，另一个阻塞在 lock_a 上。阻塞的线程没有持有任何锁，不满足"持有并等待"条件，循环等待无法形成。

**预防：破坏持有并等待。** 要求线程一次性获取所有需要的锁。如果无法一次性获取全部，就一个也不持有。这个策略在理论上可行，但实践中很少使用，因为线程往往无法提前知道自己需要哪些锁，而且一次性锁住所有资源会严重降低并发度。

**预防：破坏非抢占。** 使用 `pthread_mutex_trylock()` 尝试获取锁，如果失败就释放已持有的锁，稍后重试：

```c
void *thread_trylock(void *arg) {
    while (1) {
        pthread_mutex_lock(&lock_a);
        if (pthread_mutex_trylock(&lock_b) == 0) {
            break;  // 两把锁都拿到了
        }
        pthread_mutex_unlock(&lock_a);  // 拿不到 lock_b，释放 lock_a
    }
    // 临界区
    pthread_mutex_unlock(&lock_b);
    pthread_mutex_unlock(&lock_a);
    return NULL;
}
```

`trylock()` 不阻塞，如果锁已被持有就立即返回失败。拿不到 lock_b 时主动释放 lock_a，打破了"持有并等待"。但这个方案有一个隐患：如果两个线程同步执行 trylock-release 循环，可能形成活锁（后面会讲）。

**预防：破坏互斥。** 使用无锁(lock-free)数据结构，通过 CAS 等原子操作实现并发访问，不需要互斥锁。但无锁编程复杂度高，只适用于特定的数据结构（如队列、栈、计数器），不是通用方案。

**避免：银行家算法。** 银行家算法(Banker's Algorithm)由 Dijkstra 于 1965 年提出。它的思想是：每次分配资源前，模拟分配后的状态是否安全。如果安全就分配，不安全就拒绝。

:::expand Edsger W. Dijkstra
![Edsger W. Dijkstra](https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Edsger_Wybe_Dijkstra.jpg/330px-Edsger_Wybe_Dijkstra.jpg)

Edsger W. Dijkstra（1930-2002）是荷兰计算机科学家，2002 年图灵奖得主。他的贡献遍布计算机科学的多个基础领域：最短路径算法（Dijkstra 算法）、信号量(semaphore)的发明、银行家算法、"goto 有害论"、以及结构化编程的倡导。在操作系统领域，他设计了第一个多道程序操作系统 THE，并在其中首次实现了信号量机制来解决进程同步问题。
:::

"安全"的定义是：存在一个线程执行顺序，使得每个线程都能获取到它需要的最大资源量、执行完毕、释放所有资源。这个顺序叫做安全序列(safe sequence)。如果存在安全序列，系统处于安全状态(safe state)；否则处于不安全状态(unsafe state)。不安全状态不一定死锁，但可能导致死锁。银行家算法的策略是永远不进入不安全状态。

用一个具体例子推演。假设系统有 2 类资源（$A$ 和 $B$），$A$ 有 10 个实例，$B$ 有 5 个实例。3 个进程 $P_0$、$P_1$、$P_2$，各自声明了最大需求：

| 进程 | 最大需求 (A, B) | 已分配 (A, B) | 还需要 (A, B) |
|------|----------------|--------------|--------------|
| $P_0$ | (7, 5) | (0, 1) | (7, 4) |
| $P_1$ | (3, 2) | (2, 0) | (1, 2) |
| $P_2$ | (9, 0) | (3, 0) | (6, 0) |

当前已分配总量：$A = 0+2+3 = 5$，$B = 1+0+0 = 1$。可用资源：$A = 10-5 = 5$，$B = 5-1 = 4$。

银行家算法尝试找安全序列。先看哪个进程的"还需要"不超过当前可用资源 (5, 4)：

1. $P_1$ 还需要 (1, 2)，不超过 (5, 4)，可以满足。假设 $P_1$ 执行完毕并释放所有资源，可用变为 $(5+2, 4+0) = (7, 4)$
2. $P_0$ 还需要 (7, 4)，不超过 (7, 4)，可以满足。$P_0$ 执行完毕，可用变为 $(7+0, 4+1) = (7, 5)$
3. $P_2$ 还需要 (6, 0)，不超过 (7, 5)，可以满足

安全序列 $\langle P_1, P_0, P_2 \rangle$ 存在，系统处于安全状态。

现在 $P_2$ 请求额外的资源 (1, 0)。银行家算法模拟分配后的状态：$P_2$ 的已分配变为 (4, 0)，还需要变为 (5, 0)，可用变为 (4, 4)。重新检查是否存在安全序列。$P_1$ 还需要 $(1, 2) \leq (4, 4)$，可以执行，释放后可用变为 (6, 4)。$P_0$ 还需要 $(7, 4) > (6, 4)$，$A$ 不够。$P_2$ 还需要 $(5, 0) \leq (6, 4)$，可以执行，释放后可用变为 (10, 4)。$P_0$ 还需要 $(7, 4) \leq (10, 4)$，可以执行。安全序列 $\langle P_1, P_2, P_0 \rangle$ 存在，所以这次分配是安全的，银行家算法允许分配。

银行家算法需要每个进程提前声明最大资源需求，这在实际系统中很难做到。而且每次资源请求都要执行安全性检查，时间复杂度为 $O(m \times n^2)$（$m$ 是资源类型数，$n$ 是进程数），开销不小。所以银行家算法在实际操作系统中几乎不使用，但它是理解"安全状态"概念的最佳教学工具。

**检测：wait-for graph 与 lockdep。** 既然预防和避免都有各自的限制，另一种思路是：允许死锁发生，但通过算法检测它。

对于单实例资源，检测死锁等价于在 wait-for graph（等待图）中找环。wait-for graph 是资源分配图的简化版：去掉资源节点，如果线程 $T_i$ 在等待线程 $T_j$ 持有的资源，就画一条边 $T_i$ → $T_j$。图中有环就意味着死锁。

Linux 内核使用 lockdep 子系统在运行时检测潜在的死锁。lockdep 的核心思想是：不等死锁真正发生，而是在锁的使用模式中检测违反锁序的行为。它的工作方式分三步：

1. **锁类(lock class)**。lockdep 不跟踪每一个锁实例，而是把同一类锁（如"所有 inode 的 i_mutex"）归为一个锁类。锁类由锁的初始化位置（源码文件名+行号）决定。

2. **依赖图(dependency graph)**。每当一个线程在持有锁 A 的情况下获取锁 B，lockdep 记录一条依赖边 A → B，表示"A 必须在 B 之前获取"。随着系统运行，这些边构成一张全局的锁依赖图。

3. **环检测**。每当新增一条边时，lockdep 检查依赖图中是否出现了环。如果出现环，说明存在两条代码路径，一条先获取 A 再获取 B，另一条先获取 B 再获取 A，这就违反了锁序，存在死锁风险。lockdep 立即打印告警：

```
======================================================
WARNING: possible circular locking dependency detected
------------------------------------------------------
thread1/1234 is trying to acquire lock:
 (&lock_b){+.+.}, at: thread1_func+0x20/0x50

but task is already holding lock:
 (&lock_a){+.+.}, at: thread1_func+0x10/0x50

which lock already depends on the new lock.

the existing dependency chain (in reverse order) is:
-> #1 (&lock_b){+.+.}: lock_acquire+0x80/0x100
-> #0 (&lock_a){+.+.}: lock_acquire+0x80/0x100
======================================================
```

lockdep 的精巧之处在于它是一个静态分析+动态验证的混合方案。它不需要死锁真正发生（两个线程同时持有对方需要的锁），只要检测到锁的获取顺序不一致（一条路径先 A 后 B，另一条路径先 B 后 A），就立即报警。这意味着即使那个特定的线程交错在测试中从未出现过，lockdep 也能提前发现潜在的死锁。lockdep 的完整实现细节留给后续内核同步机制一课。

**恢复。** 检测到死锁后，系统需要采取措施消除它。常见的恢复手段有两种：

- **终止进程**：杀死死锁环中的一个或多个进程，强制释放它们持有的资源。可以逐个终止，每杀一个就重新检测是否还有死锁。数据库系统中的死锁恢复通常采用这种方式：选择一个"受害者"事务(victim)回滚。
- **资源抢占**：强制从某个进程手中夺走资源，分配给其他进程。但被抢占的进程需要回滚到某个一致状态，这要求系统支持检查点(checkpoint)机制，实现成本很高。

:::thinking 为什么 lock ordering 是最实用的死锁预防方法？

四种预防策略分别破坏四个必要条件。我们逐一评估它们的可行性。

破坏互斥：mutex 的存在就是为了互斥。用无锁数据结构可以消除互斥，但无锁编程复杂度极高，而且只适用于特定场景（计数器、队列等），不能替代所有需要互斥的场景。

破坏持有并等待：要求线程一次性获取所有锁。第一个问题是线程往往无法提前知道自己需要哪些锁，因为锁的获取可能分散在多个函数调用中，依赖运行时的条件分支。第二个问题是一次性锁住所有资源会严重降低并发度，不相关的锁也被提前占用了。

破坏非抢占：trylock + 释放重试可以避免死锁，但可能导致活锁，而且每次释放锁后需要回滚已完成的操作，逻辑复杂且容易出错。

破坏循环等待：给所有锁定义全局顺序，所有线程按顺序获取。这个方案不需要改变锁的语义（互斥不变），不需要一次性获取（可以逐个获取，只要顺序正确），不需要回滚逻辑（不需要释放已持有的锁）。代价是程序员需要记住并遵守锁的顺序，但这是一个静态的编码规范，可以在代码审查中检查，也可以用 lockdep 在运行时自动验证。

所以 lock ordering 是唯一在正确性和可行性之间取得平衡的策略。Linux 内核的数千把锁就是通过严格的锁序规范来避免死锁的，lockdep 作为运行时验证工具确保规范被遵守。
:::

:::expand 银行家算法的完整伪代码

银行家算法维护以下数据结构（n 个进程，m 类资源）：

- `Available[m]`：每类资源的可用实例数
- `Max[n][m]`：每个进程声明的最大需求
- `Allocation[n][m]`：每个进程当前已分配的资源
- `Need[n][m]`：每个进程还需要的资源，`Need[i][j] = Max[i][j] - Allocation[i][j]`

**安全性检查算法**：判断当前状态是否安全。

```
function is_safe():
    Work[m] = Available        // 工作向量，初始化为可用资源
    Finish[n] = {false}        // 标记每个进程是否能完成

    repeat:
        找到一个进程 Pi，满足 Finish[i] == false 且 Need[i] <= Work
        if 找到了:
            Work = Work + Allocation[i]   // 模拟 Pi 执行完毕并释放资源
            Finish[i] = true
        else:
            break

    if 所有 Finish[i] == true:
        return SAFE
    else:
        return UNSAFE
```

**资源请求算法**：进程 Pi 请求资源 Request[m]。

```
function request(Pi, Request[m]):
    if Request > Need[i]:
        error("请求超过声明的最大需求")

    if Request > Available:
        Pi 必须等待（资源不足）

    // 试探性分配
    Available = Available - Request
    Allocation[i] = Allocation[i] + Request
    Need[i] = Need[i] - Request

    if is_safe():
        分配生效
    else:
        // 回滚试探性分配
        Available = Available + Request
        Allocation[i] = Allocation[i] - Request
        Need[i] = Need[i] + Request
        Pi 必须等待
```

安全性检查的时间复杂度是 O(m × n²)：外层 repeat 最多执行 n 次（每次标记一个进程为完成），每次需要扫描 n 个进程，每个进程需要比较 m 个资源。
:::

## 活锁

活锁(livelock)是线程持续执行但没有任何有效进展的状态。与死锁的区别是：死锁中线程被阻塞，完全不执行；活锁中线程一直在执行（消耗 CPU），但做的都是无用功。

活锁的典型场景来自前面介绍的 trylock 预防策略。如果两个线程同步执行 trylock-release 循环，它们可能永远在"获取-释放-重试"中打转：

```c
// thread1                                     // thread2
pthread_mutex_lock(&lock_a);                   pthread_mutex_lock(&lock_b);
while (pthread_mutex_trylock(&lock_b) != 0) {  while (pthread_mutex_trylock(&lock_a) != 0) {
    pthread_mutex_unlock(&lock_a);                 pthread_mutex_unlock(&lock_b);
    pthread_mutex_lock(&lock_a);                   pthread_mutex_lock(&lock_b);
}                                              }
```

| 时刻 | thread1 | thread2 |
|------|---------|---------|
| 1 | `lock(A)` 成功 | `lock(B)` 成功 |
| 2 | `trylock(B)` 失败 | `trylock(A)` 失败 |
| 3 | `unlock(A)` | `unlock(B)` |
| 4 | `lock(A)` 成功 | `lock(B)` 成功 |
| 5 | `trylock(B)` 失败 | `trylock(A)` 失败 |
| ... | 无限循环 | 无限循环 |

两个线程都在跑，CPU 利用率可能很高，但程序没有任何进展。这比死锁更难诊断，因为死锁时线程阻塞，系统工具可以看到线程卡在哪个锁上；活锁时线程在不停地执行，看起来一切正常。

解决活锁的标准方法是引入随机退避(random backoff)：trylock 失败后，等待一个随机时间再重试。两个线程选择不同的等待时间，就打破了同步：

```c
void *thread_with_backoff(void *arg) {
    while (1) {
        pthread_mutex_lock(&lock_a);
        if (pthread_mutex_trylock(&lock_b) == 0) {
            break;
        }
        pthread_mutex_unlock(&lock_a);
        // 随机退避：等待 0~999 微秒
        usleep(rand() % 1000);
    }
    // 临界区
    pthread_mutex_unlock(&lock_b);
    pthread_mutex_unlock(&lock_a);
    return NULL;
}
```

随机退避让两个线程不再同步执行，其中一个大概率会先完成 lock + trylock 的组合，拿到两把锁进入临界区。以太网的 CSMA/CD 协议在检测到冲突时也使用类似的指数退避(exponential backoff)策略。

## 并发 bug 分类

并发 bug 按违反的正确性属性分为四类：死锁(deadlock)、原子性违规(atomicity violation)、顺序违规(order violation)和数据竞争(data race)。

死锁是最显著的并发 bug，但远非全部。Lu et al. 在 2008 年的研究（*Learning from Mistakes — A Comprehensive Study on Real World Concurrency Bug Characteristics*）分析了 MySQL、Apache、Mozilla 和 OpenOffice 四个大型开源项目中的 105 个并发 bug，发现非死锁 bug 占了约 2/3。了解其他类型的并发 bug 有助于建立更完整的并发正确性视角。

**原子性违规(Atomicity Violation)**。程序员假设一段代码会原子执行，但实际上没有用同步原语保护，导致另一个线程在中间插入。最典型的模式是 check-then-act：

```c
// Thread 1                          // Thread 2
if (ptr != NULL) {                   ptr = NULL;
    ptr->field = value;
}
```

Thread 1 检查 ptr 不为空后，Thread 2 把 ptr 设为了 NULL，Thread 1 随后解引用 ptr 导致段错误。检查和使用之间没有原子性保证。Lu et al. 的研究发现，原子性违规占非死锁并发 bug 的约 70%。

**顺序违规(Order Violation)**。程序员假设操作 A 一定在操作 B 之前执行，但没有用同步机制保证这个顺序：

```c
// Thread 1（初始化线程）             // Thread 2（工作线程）
config = load_config();              // 假设 config 已经初始化
                                     use(config);  // config 可能还是 NULL
```

Thread 2 假设 config 在使用前已经被 Thread 1 初始化，但如果 Thread 2 先运行，就会使用未初始化的 config。修复方法是用条件变量或屏障(barrier)保证初始化先于使用。

**数据竞争(Data Race)**。数据竞争是并发 bug 的形式化定义：两个线程并发访问同一内存位置，至少一个是写操作，且没有同步机制保证它们的执行顺序。

数据竞争的形式定义需要三个条件同时成立：

1. 两个线程访问同一内存位置
2. 至少一个是写操作
3. 两个访问之间没有 happens-before 关系

前面同步原语一课介绍的竞态条件（`counter++` 的例子）就是一个典型的数据竞争。Google 开发的 ThreadSanitizer(TSan)可以在运行时检测数据竞争，编译时加上 `-fsanitize=thread` 即可启用。

:::expand 数据竞争 vs 竞态条件

数据竞争(data race)和竞态条件(race condition)是两个不同的概念，容易混淆。

**数据竞争**是一个精确的形式定义：两个线程并发访问同一内存位置，至少一个是写，没有同步。它是纯粹的内存访问层面的问题，可以被工具（如 TSan）机械地检测。

**竞态条件**是一个更广泛的语义概念：程序的正确性依赖于线程的相对执行顺序。它关注的是程序行为是否正确，而不仅仅是内存访问是否有保护。

两者的关系不是包含关系，而是交叉关系：

**有数据竞争但没有竞态条件**：两个线程同时写入同一个标志位 `done = true`，没有加锁。这是数据竞争（同一位置、有写、无同步），但无论谁先写，结果都是 `true`，程序行为正确，不是竞态条件。

**有竞态条件但没有数据竞争**：两个线程各自加锁后检查账户余额并转账。

```c
pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
int balance = 100;

void *transfer(void *arg) {
    int amount = *(int *)arg;
    pthread_mutex_lock(&lock);
    int current = balance;       // 读余额（持有锁）
    pthread_mutex_unlock(&lock);

    // ... 执行转账审批逻辑 ...

    pthread_mutex_lock(&lock);
    if (current >= amount) {     // 用之前读到的旧值做判断
        balance -= amount;       // 写余额（持有锁）
    }
    pthread_mutex_unlock(&lock);
    return NULL;
}
```

逐条检查数据竞争的三个条件：两个线程访问同一内存位置（`balance`），至少一个是写（`balance -= amount`），但每次访问 `balance` 时都持有 `lock`，锁的 acquire/release 建立了 happens-before 关系，第三个条件不满足，所以不是数据竞争。TSan 不会报任何错误。

但程序有 bug：thread1 读到余额 100 后释放锁，thread2 也读到余额 100 后释放锁。两者都认为余额充足，各自转出 80 元，最终余额变成 -60 元。问题不在内存访问的同步，而在于"检查余额"和"扣减余额"之间释放了锁，另一个线程在这个窗口中读到了过时的值。程序正确性依赖于执行顺序（应该一个先转完另一个再检查），这是竞态条件。

简单记：数据竞争是工具能查的（看内存访问有没有 happens-before），竞态条件是人才能判断的（看程序语义对不对）。
:::

## 小结

| 概念 | 说明 |
|------|------|
| 死锁(deadlock) | 线程互相等待对方释放资源，所有线程永远无法继续 |
| 四个必要条件 | 互斥、持有并等待、非抢占、循环等待，缺一不可 |
| 资源分配图(RAG) | 有向图表示线程和资源的持有/请求关系，单实例资源有环即死锁 |
| 预防 | 设计时破坏四个条件之一，最实用的是全局锁序 |
| 避免 | 运行时检查安全状态，银行家算法是经典方案 |
| 检测 | wait-for graph 找环，lockdep 在锁使用模式中检测锁序违反 |
| 恢复 | 终止进程或资源抢占 |
| 活锁(livelock) | 线程持续执行但无有效进展，随机退避可解决 |
| 原子性违规 | check-then-act 模式，假设原子但未保护 |
| 顺序违规 | 假设操作顺序但未用同步机制保证 |
| 数据竞争(data race) | 并发访问同一位置、至少一个写、无同步 |

死锁的四个必要条件是分析和解决的基础。预防死锁就是破坏其中一个条件，而在工程实践中，给所有锁规定获取顺序（破坏循环等待）是唯一兼顾正确性和可行性的策略。Linux 内核通过 lockdep 在运行时自动验证这个顺序，把一个需要程序员自觉遵守的规范变成了机器可检查的约束。

---

**Linux 源码入口**：
- [`kernel/locking/lockdep.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/lockdep.c) — lockdep 核心实现：锁类注册、依赖图构建、环检测
- [`include/linux/lockdep_types.h`](https://elixir.bootlin.com/linux/latest/source/include/linux/lockdep_types.h) — lockdep 数据结构定义
- [`kernel/locking/mutex.c`](https://elixir.bootlin.com/linux/latest/source/kernel/locking/mutex.c) — 内核 mutex 实现，包含 lockdep 注解
- [`lib/debug_locks.c`](https://elixir.bootlin.com/linux/latest/source/lib/debug_locks.c) — 调试锁基础设施
