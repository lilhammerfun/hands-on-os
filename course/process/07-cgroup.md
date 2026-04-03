# Cgroups

- 写作时间：`2026-03-04 首次提交，2026-03-30 最近修改`
- 当前字符：`12363`

上一课的 namespace 解决了隔离问题——让容器看不到宿主机的进程、文件系统和网络栈。但"看不到"不等于"用不了"。一个运行在独立 namespace 中的进程，仍然可以调用 `malloc` 吃掉宿主机所有内存，用一个死循环占满所有 CPU 核心，或者用 fork bomb 耗尽系统的 PID 资源。namespace 隔离了视图，没有限制用量。

```bash
# this process can consume all host memory, regardless of namespace
stress --vm 1 --vm-bytes 8G
```

不管这个 `stress` 在哪个 PID namespace、哪个 Mount namespace 里，它一样消耗 8 GB 物理内存。宿主机上的其他进程（包括其他容器）会因为内存不足被 OOM killer 杀掉。一个容器的失控导致所有容器受害。

解决这个问题需要 **cgroup**（control group）——内核提供的资源限制机制，通过虚拟文件系统对一组进程施加配额。cgroup 本身只是一个分组框架，真正的限制由挂载在上面的控制器完成。**CPU 控制器**限制进程组的 CPU 时间，**内存控制器**限制内存使用量并在超限时触发回收或杀死进程，**I/O 控制器**限制对块设备的读写带宽，**PID 控制器**限制能创建的进程总数。最后看**内核实现**如何把进程和 cgroup 关联起来。

## cgroup

cgroup（control group，控制组）是内核提供的资源限制机制，通过虚拟文件系统（`/sys/fs/cgroup/`）对一组进程的 CPU、内存、I/O、PID 等资源施加配额。

:::expand 虚拟文件系统

这里的"文件系统"不是指磁盘上存文件的 ext4 或 XFS，而是内核伪造的一组文件和目录。这些文件背后没有磁盘数据，内核在你 `read` 时动态生成内容，在你 `write` 时解析内容并执行操作。上一篇提到的 `/proc` 就是同一类东西：`cat /proc/1234/status` 不是从磁盘读文件，而是内核临时拼出该进程的状态信息返回给你。

这正是 Linux "一切皆文件"设计原则的体现。进程信息、设备、内核参数、cgroup 配额，这些东西本质上都不是文件，但内核把它们统一暴露为文件和目录。结果是：用户态不需要为每种内核资源学一套专门的 API，用同一组文件操作（`open`、`read`、`write`、`mkdir`）就能和所有这些资源交互。

| 挂载点 | 文件系统类型 | 暴露的内容 |
|--------|------------|-----------|
| `/proc` | procfs | 进程状态、内核参数 |
| `/sys` | sysfs | 设备、驱动、内核子系统 |
| `/sys/fs/cgroup` | cgroup2 | cgroup 层级和资源配额 |
| `/dev` | devtmpfs | 硬件设备（磁盘、终端、随机数生成器） |

所以下文所有对 `/sys/fs/cgroup/` 下文件的 `echo` 和 `cat`，实质上是在向内核发命令和读状态，不是在操作磁盘文件。

这个设计还带来了两个额外好处。**可扩展性**：新增控制器或参数只需要让内核在目录下多创建几个文件，不需要新增系统调用号、不需要用户态工具同步更新。**权限控制**：`chown` 一个 cgroup 目录给普通用户，该用户就能管理这个 cgroup 下的资源，粒度到目录和文件级别。

:::

cgroup 的操作全部通过这个虚拟文件系统完成。目录结构对应 cgroup 的层级结构。创建子 cgroup 就是创建子目录，把进程移入 cgroup 就是往文件里写 PID，读取资源用量就是读文件。标准的 `mkdir`、`echo`、`cat` 就够了。

```bash
# view the root cgroup
ls /sys/fs/cgroup/
cgroup.controllers  cgroup.procs  cgroup.subtree_control  cpu.stat  memory.current ...

# create a child cgroup = just mkdir
mkdir /sys/fs/cgroup/my-group
```

这里有三个关键文件需要了解：

**`cgroup.controllers`** 列出了当前 cgroup 可用的控制器。根 cgroup 的 `cgroup.controllers` 显示了内核编译时启用的所有控制器：

```bash
cat /sys/fs/cgroup/cgroup.controllers
cpu io memory pids
```

**`cgroup.subtree_control`** 决定了哪些控制器对子 cgroup 生效。可用不等于启用，控制器必须被显式写入 `cgroup.subtree_control` 后，子 cgroup 中才会出现对应的控制文件：

```bash
# enable cpu and memory controllers for children
echo "+cpu +memory" > /sys/fs/cgroup/cgroup.subtree_control

# now child cgroups will have cpu.max, memory.max, etc.
```

**`cgroup.procs`** 列出了当前 cgroup 中的所有进程 PID。向这个文件写入一个 PID，就能把该进程移入这个 cgroup。一个进程在同一时刻只属于一个 cgroup。

```bash
# move current shell into my-group
echo $$ > /sys/fs/cgroup/my-group/cgroup.procs

# check which processes are in this cgroup
cat /sys/fs/cgroup/my-group/cgroup.procs
```

cgroup 是层级结构。子 cgroup 受父 cgroup 的限制：如果父 cgroup 的内存上限是 1 GB，子 cgroup 即使设置 2 GB，实际可用也只有 1 GB。资源限制向下继承，子节点不能超过父节点的配额。

:::expand cgroup v1 与 v2

Linux 存在两个版本的 cgroup 接口。cgroup v1（2007 年，Linux 2.6.24）为每种控制器维护独立的层级结构，每种控制器挂载为独立的文件系统（如 `/sys/fs/cgroup/cpu/`、`/sys/fs/cgroup/memory/`）。这导致一个问题：同一个进程在 CPU 层级的位置和在内存层级的位置可以不同，管理工具需要分别操作多棵树，配置容易不一致。

cgroup v2（2016 年，Linux 4.5）把所有控制器统一到一棵层级树上，挂载点只有一个 `/sys/fs/cgroup/`。一个进程在树中有唯一的位置，所有控制器的配置都在同一个目录下。本篇只讨论 v2。现代发行版（Ubuntu 21.10+、Fedora 31+、Debian 11+）默认使用 v2。

:::

## CPU 控制器

CPU 控制器通过 `cpu.max` 和 `cpu.weight` 控制进程组的 CPU 使用。

没有 CPU 控制器时，一个进程可以执行死循环占满整个 CPU 核心。如果它创建多个线程，可以占满所有核心。同一台机器上的其他容器被饿死，完全分不到 CPU 时间。

CPU 控制器提供了两种限制方式，分别解决两个不同的问题。

**`cpu.max`：绝对上限。** 格式是 `$QUOTA $PERIOD`，单位微秒。含义是：在每个 `$PERIOD` 微秒的时间窗口内，这个 cgroup 中的所有进程加起来最多使用 `$QUOTA` 微秒的 CPU 时间。

```bash
# allow max 50% of one CPU core
# 50000 us quota per 100000 us period = 50%
echo "50000 100000" > /sys/fs/cgroup/my-group/cpu.max

# allow max 2 full CPU cores
echo "200000 100000" > /sys/fs/cgroup/my-group/cpu.max

# remove limit
echo "max 100000" > /sys/fs/cgroup/my-group/cpu.max
```

`$QUOTA` 写 `max` 表示不限制。`cpu.max` 的默认值就是 `max 100000`（不限制，周期 100ms）。

**`cpu.weight`：比例分配。** 取值范围是 1-10000，默认值是 100。当多个 cgroup 竞争同一个 CPU 时，内核按 weight 的比例分配时间。

```bash
# cgroup A: weight 100 (default)
echo 100 > /sys/fs/cgroup/group-a/cpu.weight

# cgroup B: weight 300
echo 300 > /sys/fs/cgroup/group-b/cpu.weight

# when both competing: A gets 25%, B gets 75%
# when only A is running: A gets 100% (weight only matters under contention)
```

:::thinking 有了 cpu.max 为什么还需要 cpu.weight？
`cpu.max` 设的是硬上限。假设一台 4 核机器上有两个容器 A 和 B，都设了 `cpu.max = 200000 100000`（最多 2 核）。当 A 空闲时，B 也只能用 2 核，剩下 2 核的计算能力白白浪费。`cpu.max` 防止单个容器吃光所有 CPU，但它会导致资源浪费。

`cpu.weight` 设的是比例。没有硬上限，只在竞争时按比例分。A 空闲时，B 可以用满 4 核；A 和 B 同时忙时，按 weight 比例分配。不浪费资源，但也挡不住单个容器在无竞争时独占所有 CPU。

两种机制正交。实际使用中通常同时设置：`cpu.max` 设一个硬上限防止极端情况，`cpu.weight` 在上限之下按比例公平分配。

:::

## 内存控制器

内存控制器通过 `memory.max` 和 `memory.high` 限制进程组的内存使用量，超限触发 OOM killer 或回收压力。

没有内存控制器时，一个进程调用 `malloc` 分配内存，只要物理内存还有余量，内核就会满足。一个失控的容器可以把物理内存吃光，内核的 OOM killer 开始在整个系统范围内挑选进程杀掉。哪个进程被杀完全取决于 OOM 评分算法，可能是别的容器里正在提供服务的进程。

**`memory.max`：硬上限。** 当 cgroup 的内存使用量达到 `memory.max` 时，内核先尝试回收该 cgroup 内的可回收内存（页面缓存等）。如果回收后仍然不够，内核触发 OOM killer，但只在这个 cgroup 内部选择进程杀掉，不影响其他 cgroup。

```bash
# limit to 256 MB
echo 268435456 > /sys/fs/cgroup/my-group/memory.max

# or use shorthand (kernel 4.5+)
echo 256M > /sys/fs/cgroup/my-group/memory.max
```

**`memory.high`：软上限。** 不会触发 OOM kill，但当用量超过 `memory.high` 时，内核大幅增加该 cgroup 的内存回收压力。回收意味着把页面换出到 swap 或丢弃页面缓存，进程的内存访问变慢（需要重新从磁盘读取），但进程不会被杀。

```bash
echo 128M > /sys/fs/cgroup/my-group/memory.high
```

`memory.high` 和 `memory.max` 配合使用：`memory.high` 设为期望的正常用量（超过就减速），`memory.max` 设为绝对上限（超过就杀）。进程在两者之间运行时会受到回收压力变慢，但还能活着。这比一超限就杀进程更友好。

**`memory.current`** 显示了当前 cgroup 的实际内存使用量（单位是字节）：

```bash
cat /sys/fs/cgroup/my-group/memory.current
134217728
```

OOM killer 在选择杀哪个进程时，依据的是 `oom_score`。每个进程在 `/proc/[pid]/oom_score` 有一个分数，分数越高越容易被杀。内核根据进程的内存占用量计算基础分，占用越多分越高。管理员可以通过 `/proc/[pid]/oom_score_adj`（取值 -1000 到 1000）调整：写入负数降低被杀概率（保护关键服务），写入 1000 表示优先杀掉。在 cgroup 内部触发 OOM 时，内核只在该 cgroup 的进程中比较 `oom_score`，选分数最高的杀掉。

## I/O 控制器

I/O 控制器通过 `io.max` 限制进程组对块设备的读写带宽和 IOPS（每秒 I/O 操作数）。

没有 I/O 控制器时，一个容器执行大量磁盘写入（比如数据库批量导入），可以占满磁盘 I/O 带宽。同一块磁盘上的其他容器的读写请求被排在后面，延迟急剧上升。

**`io.max`** 对指定块设备设置了带宽和 IOPS 上限，格式如下：

```
MAJ:MIN rbps=BYTES wbps=BYTES riops=COUNT wiops=COUNT
```

`MAJ:MIN` 是块设备的主次设备号（可以通过 `lsblk` 或 `ls -l /dev/sda` 查看）。四个参数分别限制了读带宽（bytes/s）、写带宽（bytes/s）、读 IOPS 和写 IOPS。

```bash
# find device number
ls -l /dev/sda
# brw-rw---- 1 root disk 8, 0 ...  (major=8, minor=0)

# limit write bandwidth to 10 MB/s on device 8:0
echo "8:0 wbps=10485760" > /sys/fs/cgroup/my-group/io.max

# limit both read and write
echo "8:0 rbps=52428800 wbps=10485760 riops=1000 wiops=500" > /sys/fs/cgroup/my-group/io.max
```

**`io.stat`** 显示了各块设备的实际 I/O 统计：

```bash
cat /sys/fs/cgroup/my-group/io.stat
8:0 rbytes=1048576 wbytes=524288 rios=256 wios=128 ...
```

## PID 控制器

PID 控制器通过 `pids.max` 限制进程组能创建的进程总数，防止 fork bomb 耗尽系统 PID。

:::thinking fork bomb :(){ :|:& };: 为什么危险？

把这段 bash 展开：它定义了一个函数 `:`，函数体是 `: | : &`，然后调用 `:`。每次调用会产生两个新的 `:` 进程（一个管道的两端），每个新进程又各自产生两个。进程数量以 2^n 指数增长。几秒内就能创建几万个进程，耗尽系统的 PID 空间（默认上限 `/proc/sys/kernel/pid_max`，通常 32768 或 4194304）。PID 耗尽后，系统上任何程序都无法 `fork()`，包括 SSH 登录、cron 任务、系统服务。机器还在运行，但什么新进程都起不来，实际上已经不可用了。

没有 PID 控制器时，一个容器里的 fork bomb 会耗尽整台宿主机的 PID 资源，所有容器和宿主机服务全部受影响。

:::

**`pids.max`** 设置了 cgroup 内允许的最大进程数（包括子 cgroup 中的进程）：

```bash
# limit to 100 processes
echo 100 > /sys/fs/cgroup/my-group/pids.max
```

达到上限后，cgroup 内的 `fork()` 和 `clone()` 会返回 `EAGAIN` 错误，不会创建新进程。已有的进程不受影响，只是不能再创建新的。

**`pids.current`** 显示了当前 cgroup 中的进程数：

```bash
cat /sys/fs/cgroup/my-group/pids.current
3
```

Docker 默认不设置 `pids.max`（无限制）。可以通过 `--pids-limit` 参数启用：`docker run --pids-limit 100 ...`。Kubernetes 从 1.14 开始支持通过 kubelet 的 `--pod-max-pids` 参数设置每个 Pod 的 PID 上限。

## 内核实现

进程和 cgroup 的内核关联通过 `task_struct` → `css_set` → `cgroup_subsys_state` 链路实现。

上一篇讲 namespace 时，进程和 namespace 的关联是 `task_struct` → `nsproxy` → 各种 namespace 结构体。cgroup 的关联方式类似但更复杂，因为一个进程需要同时属于多个控制器的 cgroup，而且多个进程可能共享同一组 cgroup 归属。

每个进程的 `task_struct` 有一个 `cgroups` 指针，指向 `css_set`：

```c
// include/linux/sched.h (simplified)
struct task_struct {
    struct css_set __rcu  *cgroups;   // which cgroups this task belongs to
    // ...
};
```

`css_set`（control group subsystem state set）聚合了一个进程在每个控制器中的 cgroup 归属。它是一个中间层：多个进程如果属于完全相同的一组 cgroup（同一个 CPU cgroup、同一个内存 cgroup、同一个 I/O cgroup……），就共享同一个 `css_set`，通过引用计数管理。

```c
// include/linux/cgroup-defs.h (simplified)
struct css_set {
    refcount_t              refcount;
    struct cgroup_subsys_state *subsys[CGROUP_SUBSYS_COUNT];
    // subsys[cpu]    → this task's CPU cgroup state
    // subsys[memory] → this task's memory cgroup state
    // subsys[io]     → this task's I/O cgroup state
    // subsys[pids]   → this task's PID cgroup state
};
```

`subsys[]` 数组的每个元素是一个 `cgroup_subsys_state`（简称 css），代表一个进程在某个控制器中所属的 cgroup 节点。每个 cgroup 目录（如 `/sys/fs/cgroup/my-group/`）在内核中对应一个 `struct cgroup`，每个控制器在该 cgroup 上有一个 `cgroup_subsys_state`：

```c
// include/linux/cgroup-defs.h (simplified)
struct cgroup_subsys_state {
    struct cgroup          *cgroup;     // which cgroup node
    struct cgroup_subsys   *ss;         // which controller (cpu, memory, ...)
    refcount_t              refcnt;
    // ...
};
```

每种控制器用 `cgroup_subsys` 描述自己，并注册了回调函数供内核在特定事件时调用：

```c
// include/linux/cgroup-defs.h (simplified)
struct cgroup_subsys {
    int (*css_online)(struct cgroup_subsys_state *css);     // cgroup activated
    void (*css_offline)(struct cgroup_subsys_state *css);   // cgroup deactivated
    void (*attach)(struct cgroup_taskset *tset);            // process moved into cgroup
    void (*fork)(struct task_struct *task);                  // new process created
    void (*exit)(struct task_struct *task);                  // process exiting
    const char *name;                                        // "cpu", "memory", "io", "pids"
    // ...
};
```

当执行 `echo $PID > /sys/fs/cgroup/my-group/cgroup.procs` 把进程移入新 cgroup 时，内核为该进程查找或创建一个新的 `css_set`（对应新的 cgroup 组合），更新 `task_struct->cgroups` 指针，然后调用相关控制器的 `attach` 回调。`fork()` 时，子进程默认继承父进程的 `css_set`（引用计数 +1），控制器的 `fork` 回调被调用（比如 PID 控制器在这里检查是否超过 `pids.max`）。

完整的引用关系如下：

```
task_struct
├── *cgroups ──→ struct css_set
│                ├── refcount
│                ├── subsys[cpu]    ──→ struct cgroup_subsys_state ──→ struct cgroup (my-group)
│                ├── subsys[memory] ──→ struct cgroup_subsys_state ──→ struct cgroup (my-group)
│                ├── subsys[io]     ──→ struct cgroup_subsys_state ──→ struct cgroup (my-group)
│                └── subsys[pids]   ──→ struct cgroup_subsys_state ──→ struct cgroup (my-group)
│
├── *nsproxy ──→ struct nsproxy     (namespace, from previous chapter)
│
└── *cred ──→ struct cred
              └── *user_ns          (user namespace, from previous chapter)
```

和 namespace 的 `nsproxy` 对比：`nsproxy` 聚合的是进程的各 namespace 归属（PID namespace、Mount namespace……），`css_set` 聚合的是进程的各 cgroup 归属（CPU cgroup、内存 cgroup……）。两者都是 `task_struct` 上的一个指针，都可以被多个进程共享，都用引用计数管理生命周期。

## 小结

| 概念 | 说明 |
|------|------|
| cgroup（控制组） | 内核的资源限制机制，通过虚拟文件系统（`/sys/fs/cgroup/`）操作 |
| `cgroup.controllers` | 列出可用的控制器 |
| `cgroup.subtree_control` | 启用子 cgroup 的控制器 |
| `cgroup.procs` | 列出或移动进程 |
| CPU 控制器 | `cpu.max`（绝对上限）和 `cpu.weight`（比例分配） |
| 内存控制器 | `memory.max`（硬上限，OOM kill）和 `memory.high`（软上限，回收压力） |
| I/O 控制器 | `io.max` 限制块设备的带宽和 IOPS |
| PID 控制器 | `pids.max` 限制进程总数，防止 fork bomb |
| `css_set` | 聚合进程在每个控制器中的 cgroup 归属 |
| `cgroup_subsys_state` | 进程在某个控制器中所属的 cgroup 节点 |
| `cgroup_subsys` | 描述控制器本身，注册 attach/fork/exit 回调 |

namespace 隔离视图（进程看到什么），cgroup 限制配额（进程能用多少）。两者正交：namespace 不限资源，cgroup 不隔视图。容器把两者叠加。namespace 让进程以为自己独占系统，cgroup 确保它不能真的独占。

---

**Linux 源码入口**：
- [`kernel/cgroup/cgroup.c`](https://elixir.bootlin.com/linux/latest/source/kernel/cgroup/cgroup.c) — `cgroup_migrate()`、`cgroup_attach_task()`：进程在 cgroup 之间的迁移
- [`kernel/cgroup/cgroup-v1.c`](https://elixir.bootlin.com/linux/latest/source/kernel/cgroup/cgroup-v1.c) — v1 兼容层
- [`kernel/sched/core.c`](https://elixir.bootlin.com/linux/latest/source/kernel/sched/core.c) — CPU 控制器的调度集成
- [`mm/memcontrol.c`](https://elixir.bootlin.com/linux/latest/source/mm/memcontrol.c) — 内存控制器：`mem_cgroup_charge()`、OOM 处理
- [`kernel/cgroup/pids.c`](https://elixir.bootlin.com/linux/latest/source/kernel/cgroup/pids.c) — PID 控制器：`pids_can_fork()`

:::practice 给 zish 加上隔离
学完命名空间和 Cgroups，你已经掌握了 Linux 容器的两大支柱。现在可以给 zish 加上 Namespace 隔离和资源限制，让它变成一个简易容器。

前往 [zish-03：隔离与移植](/zish/03-isolation) 继续实践。
:::
