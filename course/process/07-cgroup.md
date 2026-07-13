# Cgroups

- 写作时间：`2026-03-04 首次提交，2026-07-13 最近修改`
- 当前字符：`10372`

[命名空间](/process/06-namespace)让进程看到独立的 PID、挂载和网络视图，但“看不见宿主机资源”不代表“不能消耗宿主机资源”。隔离在新 PID namespace 中的程序仍可创建大量线程、持续占用 CPU、触碰大量内存页，或者不断向同一块磁盘提交 I/O。

来看一个具体场景。同一台机器运行两个服务：编译服务短时间内启动大量并行任务，数据库服务需要稳定的 CPU 和 I/O 延迟。如果只使用 namespace，内核知道它们看到的资源视图不同，却没有得到“编译服务最多使用多少资源”这一策略。资源仍由同一个调度器、内存管理器和块设备共同提供，一个服务的突发负载会影响另一个服务。

cgroup 是 Linux 按层级组织任务，并让控制器对这些任务进行资源记账、分配和限制的机制。本课先通过 **cgroup v2** 建立统一层级、文件接口和控制器启用规则；随后，**CPU 控制器**处理份额与带宽，**内存控制器**处理回收阈值与硬上限，**I/O 控制器**限制块设备吞吐和操作次数，**PID 控制器**限制可创建的任务数量。最后用 **内核表示** 解释目录、控制器状态与进程归属如何连接起来。

## cgroup v2

cgroup v2 是把所有控制器组织在同一棵层级树中的 Linux 资源控制接口。

系统通常把 `cgroup2` 伪文件系统挂载在 `/sys/fs/cgroup`。伪文件系统不在磁盘上保存普通文件内容：目录对应内核中的 cgroup 节点，控制文件由内核动态生成；用户空间对这些文件执行 `read()` 或 `write()`，内核便读取状态或修改策略。

层级结构表达管理边界。父 cgroup 把自己获得的资源继续分给子 cgroup，子节点只能进一步收紧约束，不能绕过祖先限制：

```text
/sys/fs/cgroup
└── course
    ├── compiler
    └── database
```

`compiler` 和 `database` 是兄弟节点，可以在共同父节点 `course` 分得的范围内设置不同策略。新进程默认继承父进程当时的 cgroup 归属；把一个现有进程迁移到其他 cgroup，不会连带迁移它已经存在的子进程。

三个文件构成最基本的控制流程：

| 文件 | 语义 |
|------|------|
| `cgroup.controllers` | 当前节点可以为子层启用的控制器 |
| `cgroup.subtree_control` | 当前节点已经启用、用于管理直接子节点的控制器 |
| `cgroup.procs` | 直接归属于当前节点的进程 PID；写入 PID 会迁移整个线程组 |

“可用”和“已启用”是两个不同状态。某个控制器只有先出现在父节点的 `cgroup.controllers` 中，才能用 `+controller` 写入父节点的 `cgroup.subtree_control`；启用后，直接子节点才获得该控制器的接口文件。委派(delegation)是把一棵 cgroup 子树的组织权限交给权限较低的管理者。下面的命令假设 `/sys/fs/cgroup/course` 已完成委派，而且 `cpu`、`memory`、`io`、`pids` 均可用：

```sh
cd /sys/fs/cgroup/course
echo "+cpu +memory +io +pids" > cgroup.subtree_control
mkdir compiler database
echo "$COMPILER_PID" > compiler/cgroup.procs
echo "$DATABASE_PID" > database/cgroup.procs
```

控制器按自顶向下(top-down)规则启用：非根节点只能启用父节点已经交给它的控制器；只要某个子节点仍启用了控制器，父节点就不能先关闭它。资源限制也沿层级累计生效，例如 `course` 的内存上限是 2 GiB 时，两个子节点合计不能越过这个祖先上限，即使各自写入了更大的值。

cgroup v2 把按完整进程承载资源消耗的普通节点称为 domain cgroup。它还受到“无内部进程”(no internal process)约束：除根节点外，domain cgroup 若要在 `cgroup.subtree_control` 中启用 domain 控制器，自身不能直接容纳进程；进程应迁入它的子节点。这样，父节点负责向子节点分配资源，实际工作负载位于叶子，控制器不必同时比较父节点自己的进程与其子节点。若违反这项约束，启用操作会失败。

本课以普通 domain 模式和进程粒度为主。v2 还提供 threaded subtree，让同一进程的线程在受限制的子树内分别归组；此时使用 `cgroup.threads`，而 `cpu`、`pids` 等支持 threaded 模式的控制器需要处理线程级归属。

:::expand cgroup v1

cgroup v1 允许不同控制器挂载在不同层级中，同一进程可以在 CPU、内存和 I/O 层级处于不同位置。灵活性带来了组合复杂度：管理器需要同时维护多棵树，控制器之间也难以形成一致的进程归属。

cgroup v2 用统一层级约束进程归属，并统一了控制文件命名和委派模型。系统仍可能采用 v1、v2 或混合挂载，因此判断接口版本应查看实际挂载类型，而不能只根据发行版名称推断。本课后续内容只讨论 v2。

:::

## CPU 控制器

CPU 控制器是为 cgroup 中的普通公平调度任务分配相对 CPU 份额并限制最大 CPU 带宽的控制器。

它直接连接 [Linux 调度器](/process/05-linux-scheduler)中的组调度。`cpu.weight` 表达活跃兄弟 cgroup 之间的相对权重，范围为 1 到 10000，默认值为 100。假设两个兄弟 cgroup 的权重分别是 100 和 300，并且它们的公平调度任务持续竞争同一组可用 CPU，在没有其他约束时，目标份额约为 1:3。这个比例只在竞争时有意义；一侧没有可运行任务时，另一侧可以使用空闲处理器时间。

权重不是整个系统上的固定百分比。实际结果还受到祖先权重、其他兄弟节点、任务 nice 值、CPU 亲和性、处理器容量以及 `cpu.max` 的共同影响：

```sh
echo 100 > compiler/cpu.weight
echo 300 > database/cpu.weight
```

`cpu.max` 设置公平调度任务的带宽上限，格式为 `$MAX $PERIOD`，两个值都以微秒计。默认值 `max 100000` 表示每 100000 微秒重新开始一个周期，但不限制可消耗的 CPU 时间：

```sh
# 每 100 ms 最多消耗 50 ms CPU 时间，相当于平均 0.5 个 CPU
echo "50000 100000" > compiler/cpu.max

# 每 100 ms 最多消耗 200 ms CPU 时间，相当于平均 2 个 CPU
echo "200000 100000" > database/cpu.max
```

配额统计的是 cgroup 在所有允许 CPU 上累计执行的时间，不是把任务固定到某几个核心。多线程可以在多个 CPU 上快速消耗配额；配额耗尽后，组内公平调度任务会被节流，直到下一个周期补充带宽。若要限制任务可运行在哪些 CPU 上，需要 CPU 亲和性或 cpuset 控制器，而不是 `cpu.max`；cpuset 控制器负责限定任务可使用的 CPU 和 NUMA 内存节点集合。

`cpu.stat` 提供观测证据。`usage_usec`、`user_usec`、`system_usec` 统计累计 CPU 时间；控制器启用后，`nr_periods`、`nr_throttled` 和 `throttled_usec` 分别反映经历的配额周期、发生节流的周期数和累计节流时间。只写限制而不观察这些计数，无法判断负载究竟受到竞争还是配额影响。

:::thinking 为什么同时需要 cpu.weight 和 cpu.max？

若只设置 `cpu.weight`，系统在竞争时可以按策略分配份额，并在其他组空闲时充分利用 CPU；但单个组在无竞争时没有硬上限。若只设置 `cpu.max`，可以阻止某组越过带宽配额，却不能表达多个未触顶组之间谁更重要。

两者控制不同问题：weight 决定竞争时的相对分配，max 决定无论竞争与否都不能长期越过的带宽。实际策略可以只使用其中一种，也可以先用祖先和兄弟权重分配份额，再用 max 设置故障边界。

:::

这里的两个接口只作用于 fair-class 调度任务；实时调度任务不遵循同一组 weight 和 bandwidth 语义，不能把 `cpu.max` 当成对所有调度类的统一 CPU 上限。

## 内存控制器

内存控制器是对 cgroup 及其后代的受控内存进行记账、回收、节流和内存耗尽(Out of Memory, OOM)处理的控制器。

内存记账不等于 `malloc()` 参数的简单相加。`malloc()` 主要建立用户空间分配关系，匿名页通常在进程真正访问时才由缺页路径分配并计入 cgroup；匿名页是不以普通文件为持久后备的堆、栈等内存页。控制器还会统计文件页缓存、部分内核内存和套接字缓冲区等资源。文件页缓存是 RAM 中保存的文件数据副本，读取命中时可以避免再次访问存储设备。

`memory.current` 显示当前 cgroup 及其后代已计入的内存总量。限制策略中的两个核心边界是：

| 文件 | 语义 |
|------|------|
| `memory.high` | 节流边界；超过后让相关进程承受强回收压力，但不触发 OOM killer |
| `memory.max` | 硬边界；到达后若回收仍不能降低用量，在该 cgroup OOM 域中启动 OOM 处理 |

回收(reclaim)是内核释放可回收内存的过程，例如丢弃之后可从文件重新读取的干净页缓存，或者在允许时把匿名页换出到 swap。超过 `memory.high` 的进程会被节流并参与直接回收，因此延迟上升；极端并发条件下，用量仍可能暂时越过 high。这个边界适合由管理程序持续观察并调整，而不是作为绝对封顶值。

`memory.max` 用于最终约束。若 cgroup 到达 max 且回收没有取得足够进展，内核进入 cgroup OOM 状态。这里的 OOM 表示当前内存分配域无法满足分配；OOM killer 是内核为恢复进展而选择并终止任务的机制。由某个 cgroup 的 max 触发时，候选任务限制在该 cgroup 的层级中；若触发的是更高祖先的限制，候选范围也相应扩大到那个祖先的后代，不能笼统地理解成“永远只影响最内层目录”。

下面为数据库设置 384 MiB 的节流边界和 512 MiB 的硬边界：

```sh
echo 402653184 > database/memory.high
echo 536870912 > database/memory.max
```

`memory.events` 中的 `high`、`max`、`oom` 和 `oom_kill` 计数分别记录触发节流、触碰硬边界、进入 OOM 状态和实际杀死任务的次数。`memory.events` 会汇总后代事件；只观察当前节点自身时使用 `memory.events.local`。如果一个工作负载中的多个进程必须作为整体存活或退出，可以设置 `memory.oom.group=1`，让该 cgroup 在 OOM 选择中按组处理。

交换空间是磁盘或其他存储上用于暂存匿名内存页的区域，由 `memory.swap.max` 单独限制。`memory.max` 约束受控内存用量并不等价于同时设置 swap 上限；希望控制匿名内存换出规模时，需要把两者作为不同资源配置。

## I/O 控制器

I/O 控制器是按块设备对 cgroup 的读写带宽和每秒 I/O 操作数进行记账与限制的控制器。

块设备是按固定大小数据块提供随机访问的存储设备，例如磁盘、SSD 或逻辑卷。内核用主设备号和次设备号 `MAJ:MIN` 标识一个块设备；`io.max` 的每一行先指定目标设备，再配置一个或多个限制：

| 键 | 含义 |
|----|------|
| `rbps` | 每秒最多读取的字节数 |
| `wbps` | 每秒最多写入的字节数 |
| `riops` | 每秒最多提交的读 I/O 次数 |
| `wiops` | 每秒最多提交的写 I/O 次数 |

每秒字节数(Bytes Per Second, BPS)表示单位时间允许传输的字节量，每秒 I/O 操作数(Input/Output Operations Per Second, IOPS)表示单位时间允许通过控制点的 I/O 请求数量。下面的示例把设备 `8:0` 的读带宽限制为 50 MiB/s、写带宽限制为 10 MiB/s，并同时限制操作次数：

```sh
echo "8:0 rbps=52428800 wbps=10485760 riops=1000 wiops=500" \
  > database/io.max
```

`8:0` 只是格式示例，实际配置必须使用承载工作负载的块设备编号。达到限制后，控制器延迟后续 I/O；接口允许短暂突发，因此瞬时速率不一定严格贴着配置值。把某个键写成 `max` 可以移除该方向的限制。

`io.stat` 按设备记录 `rbytes`、`wbytes`、`rios`、`wios` 等累计值，分别对应读写字节数和读写操作数。限制应配置在真正接收 I/O 的设备层；如果文件系统位于设备映射器、磁盘阵列或其他分层块设备之上，逻辑设备与物理设备看到的请求可能不同。

缓冲写入还跨越内存与 I/O 两个控制域。进程先把数据写入页缓存并把页面标记为脏页，内核随后通过回写(writeback)异步提交块 I/O。cgroup writeback 会结合内存页和表示文件的内核对象归属，把回写请求记到相应 I/O cgroup；但这需要文件系统支持，不支持的文件系统可能把回写归到根 cgroup。因此，`write()` 返回时的应用吞吐、`io.stat` 中的设备流量和存储设备实际负载不一定在同一时刻变化。

## PID 控制器

PID 控制器是限制 cgroup 及其后代可同时拥有多少个内核任务的控制器。

这里的“PID”按内核任务 ID，也就是线程 ID(Thread ID, TID)计数。TID 标识一个可调度线程：单线程进程占用一个计数，含 20 个线程的进程通常占用 20 个计数。PID namespace 改变编号和可见性，PID 控制器限制数量，两者解决的是不同问题。

`pids.max` 设置层级硬上限，默认值 `max` 表示当前节点不增加额外限制。`pids.current` 统计当前 cgroup 及其后代的任务数量，`pids.peak` 记录历史峰值：

```sh
echo 100 > compiler/pids.max
```

创建进程和创建线程最终都会进入 `fork()` 或 `clone()` 的任务创建路径。若新增任务会使当前 cgroup 或任一祖先越过 `pids.max`，创建操作返回 `EAGAIN`。因此，限制既能阻止进程快速递归创建后代，也会影响使用大量线程的程序；[线程](/concurrency/01-thread)会说明用户态线程库怎样使用 `clone()` 建立内核线程。

cgroup 的组织操作不受这项策略阻止。管理员可以把 `pids.max` 调低到 `pids.current` 以下，也可以迁入足够多的现有任务，使 current 暂时大于 max；已有任务不会因此被自动终止，但后续创建会继续失败，直到计数回到限制以内。`pids.events` 的 `max` 计数可用于观察层级中发生了多少次上限命中。

限制任务数量不能替代内存限制。一个任务可以消耗大量内存，而大量轻量任务也可能在耗尽内存前先耗尽 PID 和调度结构；两类资源需要分别控制。

## 内核表示

cgroup 的内核表示是 `task_struct` 通过 `css_set` 关联统一层级中的 cgroup 节点及各控制器状态的引用关系。

每个任务的 `task_struct->cgroups` 指向 `struct css_set`。`css_set` 表示该任务完整的 cgroup 归属组合；归属相同的多个任务可以共享同一个实例，从而在 `fork()` 和 `exit()` 热路径上只维护一组引用：

```c
/* include/linux/cgroup-defs.h, trimmed */
struct css_set {
    struct cgroup_subsys_state *subsys[CGROUP_SUBSYS_COUNT];
    refcount_t refcount;
    struct css_set *dom_cset;
    struct cgroup *dfl_cgrp;
    /* task lists and migration fields omitted */
};
```

`dfl_cgrp` 指向任务在 cgroup v2 默认层级中的节点。`subsys[]` 为每个已注册控制器提供 `cgroup_subsys_state`（简称 css）指针；如果某个控制器没有在当前节点启用，对应指针可能指向最近的已启用祖先状态，这正是控制器自顶向下生效的内核表示。

每个 cgroup 目录对应 `struct cgroup`。每个控制器在一个节点上的具体状态都包含 `struct cgroup_subsys_state` 成员，它记录所属 cgroup、控制器类型和父子关系；控制器再在外层结构中保存自己的计数器与策略字段。PID 控制器就是一个直接例子：

```c
/* kernel/cgroup/pids.c, trimmed */
struct pids_cgroup {
    struct cgroup_subsys_state css;
    atomic64_t counter;
    atomic64_t limit;
    int64_t watermark;
    /* event counters omitted */
};
```

`struct cgroup_subsys` 描述控制器本身，并提供创建状态、迁移任务、创建任务和退出任务等回调。PID 控制器把 `pids_can_fork()` 注册为 `can_fork` 回调；任务创建前，它沿当前 cgroup 到祖先逐层尝试增加计数，只要一层越过限制就撤销计数并返回 `EAGAIN`。

把 PID 写入 `cgroup.procs` 时，cgroup 核心为目标归属查找或创建合适的 `css_set`，再把任务从旧集合迁移到新集合。创建子任务时，子任务默认继承父任务的集合；控制器回调可以在提交创建前检查策略，在退出时撤销记账。

```text
task_struct
└── cgroups ── struct css_set
               ├── dfl_cgrp ── struct cgroup
               └── subsys[] ── cgroup_subsys_state
                                ├── CPU controller state
                                ├── memory controller state
                                ├── I/O controller state
                                └── pids_cgroup
```

[命名空间](/process/06-namespace)中的 Cgroup namespace 只改变进程看到的 cgroup 根和路径；`task_struct->cgroups` 才决定任务实际接受哪些资源策略。容器运行时通常同时设置 namespace 与 cgroup：前者限制资源视图，后者进行资源记账、分配和限制。

## 小结

| 概念 | 说明 |
|------|------|
| cgroup v2 | 在统一层级中组织任务，并通过伪文件系统配置控制器 |
| `cgroup.controllers` | 列出当前节点可为子层启用的控制器 |
| `cgroup.subtree_control` | 选择当前节点用于管理直接子节点的控制器 |
| `cgroup.procs` | 查看或迁移直接归属于节点的进程 |
| 无内部进程约束 | 启用 domain 控制器的非根节点不能同时直接容纳进程 |
| CPU 控制器 | 用 `cpu.weight` 分配竞争份额，用 `cpu.max` 设置公平调度带宽上限 |
| 内存控制器 | 用 `memory.high` 施加回收与节流，用 `memory.max` 建立 OOM 硬边界 |
| I/O 控制器 | 用 `io.max` 按块设备限制 BPS 和 IOPS |
| PID 控制器 | 用 `pids.max` 限制 cgroup 层级中的任务数量 |
| `css_set` | 表示任务完整 cgroup 归属组合，可由多个任务共享 |
| `cgroup_subsys_state` | 控制器在某个 cgroup 节点上的通用状态结构 |
| `cgroup_subsys` | 描述控制器并注册迁移、创建和退出等回调 |

namespace 决定内核从哪个资源视图解释进程请求，cgroup 决定这些进程可以怎样竞争和消耗底层资源；只有同时建立视图边界与用量边界，容器隔离才具有可管理的运行时行为。

---

**Linux 源码与接口入口**：
- [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)：统一层级、控制器接口和委派规则
- [`kernel/cgroup/cgroup.c`](https://github.com/torvalds/linux/blob/master/kernel/cgroup/cgroup.c)：层级管理、进程迁移与控制器启用
- [`include/linux/cgroup-defs.h`](https://github.com/torvalds/linux/blob/master/include/linux/cgroup-defs.h)：`struct cgroup`、`css_set` 与 `cgroup_subsys_state`
- [`kernel/cgroup/pids.c`](https://github.com/torvalds/linux/blob/master/kernel/cgroup/pids.c)：PID 控制器的层级计数与 `can_fork` 回调
- [`kernel/sched/core.c`](https://github.com/torvalds/linux/blob/master/kernel/sched/core.c)：CPU 控制器与组调度
- [`mm/memcontrol.c`](https://github.com/torvalds/linux/blob/master/mm/memcontrol.c)：内存记账、回收和 cgroup OOM
- [`block/blk-cgroup.c`](https://github.com/torvalds/linux/blob/master/block/blk-cgroup.c)：块 I/O cgroup 基础设施
