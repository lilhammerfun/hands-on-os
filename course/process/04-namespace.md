# 命名空间

当我们运行一条命令，观察一个进程看到的世界：

```
$ unshare --pid --fork --mount-proc bash
$ echo $$
1
$ ps aux
USER  PID  COMMAND
root    1  bash
```

这个 bash 认为自己是 PID 1，`ps` 也只显示它一个进程。但从宿主机看，它的 PID 可能是 54321，周围有几百个进程。同一个进程，在不同视角下看到完全不同的 PID。

这就是 namespace（命名空间）的效果。namespace 包裹一种全局系统资源，让内部的进程以为自己拥有该资源的独立副本。Linux 有八种 namespace，每种隔离一类资源：

| Namespace | clone 标志 | 隔离的资源 | 内核版本 |
|-----------|-----------|-----------|---------|
| Mount | `CLONE_NEWNS` | 文件系统挂载点 | 2.4.19 (2002) |
| UTS | `CLONE_NEWUTS` | 主机名、域名 | 2.6.19 (2006) |
| IPC | `CLONE_NEWIPC` | System V IPC、POSIX 消息队列 | 2.6.19 (2006) |
| PID | `CLONE_NEWPID` | 进程 ID 编号空间 | 2.6.24 (2008) |
| Network | `CLONE_NEWNET` | 网络设备、路由、端口、防火墙 | 2.6.29 (2009) |
| User | `CLONE_NEWUSER` | 用户 ID、组 ID、capabilities | 3.8 (2013) |
| Cgroup | `CLONE_NEWCGROUP` | cgroup 根目录视图 | 4.6 (2016) |
| Time | `CLONE_NEWTIME` | CLOCK_MONOTONIC、CLOCK_BOOTTIME | 5.6 (2020) |

Mount namespace 是最早加入的，当时是唯一的 namespace 类型，所以标志叫 `CLONE_NEWNS`（不是 `CLONE_NEWMNT`）。后来加的类型都带上了具体名称。这个命名是历史遗留，不是设计选择。

八种原理相同，本篇聚焦与构建容器直接相关的五种：**PID**（进程 ID 编号空间）、**Mount**（文件系统挂载点）、**Network**（网络栈）、**User**（用户 ID 与权限）、**UTS**（主机名）。剩余三种（IPC、Cgroup、Time）不展开。三个系统调用操作 namespace：**clone** 在创建子进程时建立新 namespace，**unshare** 让当前进程脱离旧 namespace 进入新的，**setns** 加入一个已经存在的 namespace。最后看内核的 **nsproxy** 结构如何把一切串起来。

## PID Namespace

PID namespace 隔离进程 ID 编号空间。不同 PID namespace 中的进程可以拥有相同的 PID 值。新 PID namespace 中的第一个进程获得 PID 1，成为该 namespace 的 init。

一个进程在宿主机上是 PID 54321，在自己的 PID namespace 里却是 PID 1。内核怎么做到的？关键在于每个进程存储了**多个 PID 值**——每一层 namespace 一个：

```c
// include/linux/pid.h
struct upid {
    int nr;                     // 这一层 namespace 中的 PID 值
    struct pid_namespace *ns;   // 对应的 namespace
};

struct pid {
    refcount_t count;
    unsigned int level;         // 最深的 namespace 层级
    spinlock_t lock;
    struct hlist_head tasks[PIDTYPE_MAX];
    struct upid numbers[];      // 变长数组：每层 namespace 一个 upid
};
```

`numbers[]` 是一个变长数组。如果进程在第 2 层 PID namespace 中创建，`numbers` 有 3 个元素：

```
struct pid {
    level = 2,
    numbers[0] = { nr = 54321, ns = 根 namespace },       // 宿主机看到 PID 54321
    numbers[1] = { nr = 89,    ns = 中间层 namespace },    // 中间层看到 PID 89
    numbers[2] = { nr = 1,     ns = 最内层 namespace },    // 自己看到 PID 1
};
```

`getpid()` 返回 `numbers[level].nr`——进程所在最深层 namespace 的 PID 值。宿主机通过 `numbers[0].nr` 看到它。同一个进程，不同的数字，不同的视角。这个设计很漂亮：不是给进程一个"真实 PID"加一堆别名，而是让每一层 namespace 都有平等的地位。

每个 PID namespace 的 PID 1 充当该 namespace 的 init，具备三个特殊行为：

**信号屏蔽。** 和真正的 init 一样，namespace 内部只能向 PID 1 发送它已注册处理函数的信号，其他信号被丢弃。这防止 namespace 内的进程误杀 init。但来自祖先 namespace 的 SIGKILL 和 SIGSTOP 不受此限——父 namespace 拥有控制权。

**孤儿收养。** namespace 内的进程变成孤儿时（父进程退出），被重新挂到 PID 1 下面。PID 1 必须 `wait()` 这些子进程，否则它们变成僵尸。这是容器中一个常见的坑：用普通应用程序作为 PID 1（它不调用 `wait()`），导致僵尸进程堆积。解决方案是在容器中使用轻量 init（如 `tini` 或 `dumb-init`）。

**namespace 终结。** PID 1 退出时，内核向 namespace 内所有剩余进程发送 SIGKILL，然后标记 namespace 为不可用——不能再在其中创建新进程。这是容器设计的关键约束：主进程不能意外退出。

PID namespace 还影响 `/proc`。`/proc` 文件系统是 per-namespace 的。进入新 PID namespace 后，如果不重新挂载 `/proc`，`ps` 等工具会读到宿主机的 `/proc`，显示宿主机的进程（错误的信息）。所以创建 PID namespace 后通常需要同时创建 Mount namespace，然后：

```bash
mount -t proc proc /proc
```

新挂载的 `/proc` 只显示当前 PID namespace 中的进程。`/proc/self` 指向 namespace 内的 PID（如 1）。这也是开篇例子中 `--mount-proc` 参数的作用。

PID namespace 最大嵌套深度：32 层（`MAX_PID_NS_LEVEL`）。

## Mount Namespace

Mount namespace 隔离文件系统挂载点列表。不同 Mount namespace 中的进程看到不同的挂载表——在一个 namespace 内挂载或卸载文件系统，不影响其他 namespace。

这是最早加入内核的 namespace 类型（2002 年）。创建新 Mount namespace 时，当前的挂载表被**复制**一份到新 namespace。之后两边各自独立。

容器需要让进程看到一个完全不同的根文件系统。有两种方式：`chroot` 和 `pivot_root`。

**`chroot(path)`** 改变当前进程的根目录。但它只是一个 per-process 属性（`task_struct->fs->root`），不改变挂载表。宿主机的文件系统仍然可以通过 `../` 或挂载设备访问。特权进程可以通过 `chroot()` + `fchdir()` 组合逃逸。`chroot` 设计初衷是打包构建，不是安全隔离。

**`pivot_root(new_root, put_old)`** 交换整个 Mount namespace 的根挂载。旧的根移动到 `put_old` 目录下，之后可以卸载。卸载后，宿主机的文件系统完全不可见。操作的是 namespace 级别，不是进程级别，无法通过简单的系统调用逃逸。

容器运行时（runc 等）用 `pivot_root`，不用 `chroot`。典型流程：

```bash
mount --bind /path/to/rootfs /path/to/rootfs   # bind mount 新根
cd /path/to/rootfs
mkdir .put_old
pivot_root . .put_old                           # 交换根
umount -l /.put_old                             # 卸载旧根
rmdir /.put_old
mount -t proc proc /proc                        # 挂载新的 /proc
```

:::expand 挂载传播

Mount namespace 创建时复制父 namespace 的挂载表。但之后父 namespace 里的新挂载是否传播到子 namespace？取决于挂载传播类型：

| 类型 | 行为 |
|------|------|
| shared | 挂载事件双向传播 |
| private | 不传播（容器默认） |
| slave | 单向：从 master 接收，不回传 |
| unbindable | private + 不可被 bind mount |

容器运行时通常在创建 Mount namespace 后把所有挂载设为 private（`mount --make-rprivate /`），防止容器内的挂载操作泄漏到宿主机。

:::

## Network Namespace

Network namespace 隔离整个网络栈：网络设备、IPv4/IPv6 协议栈、路由表、防火墙规则、端口号空间、`/proc/net`、`/sys/class/net`。

新创建的 Network namespace 只有一个 loopback 接口（`lo`），而且默认是 **down** 的。没有路由、没有防火墙规则、没有任何连接。从零开始——这才是真正的隔离。要和外界通信，需要建立通道。

veth（virtual ethernet）设备总是成对创建——一根虚拟网线的两端。数据从一端进去，从另一端出来。把一端放进容器的 Network namespace，另一端留在宿主机，就建立了容器和宿主机之间的网络通道：

```bash
# 创建 veth 对
ip link add veth-host type veth peer name veth-container

# 把一端移入容器的 Network namespace（假设容器 init 的 PID 为 1234）
ip link set veth-container netns 1234

# 宿主机端配置
ip addr add 10.0.0.1/24 dev veth-host
ip link set veth-host up

# 容器内配置
nsenter --target 1234 --net -- ip addr add 10.0.0.2/24 dev veth-container
nsenter --target 1234 --net -- ip link set veth-container up
nsenter --target 1234 --net -- ip link set lo up
```

现在宿主机和容器可以互相 ping。要让容器访问外部网络，还需要在宿主机上配置桥接(bridge)和 NAT。Docker 的默认网络就是这个原理：创建 `docker0` 桥接设备，每个容器的 veth 一端接到桥上，通过 iptables MASQUERADE 规则做出站 NAT。

一个物理网络设备同一时刻只能属于**一个** Network namespace。把物理设备移入容器后，宿主机就看不到它了。容器销毁时，物理设备回到宿主机的 namespace；veth 设备则直接销毁。

## User Namespace

User namespace 隔离用户 ID、组 ID 和 capabilities。进程在 User namespace 内部可以是 UID 0（root）且拥有全部 capabilities，而在外部只是一个普通用户。

User namespace 有一个独特属性：它是**唯一一种不需要 root 权限就能创建的 namespace**（从 Linux 3.8 开始）。当 `clone()` 的标志同时包含 `CLONE_NEWUSER` 和其他 `CLONE_NEW*` 标志时，内核**先创建 User namespace**，子进程在新 User namespace 中获得完整 capabilities，然后用这些 capabilities 创建其他 namespace。这使得非特权用户也能创建容器（rootless container）。这个设计非常巧妙——用一个不需要特权的 namespace 来引导其他需要特权的 namespace。

新 User namespace 内的 UID/GID 和外部的映射关系通过 `/proc/[pid]/uid_map` 和 `/proc/[pid]/gid_map` 配置。格式每行一条：

```
<namespace内ID>  <namespace外ID>  <范围长度>
```

例：

```
0 1000 1        # namespace 内的 UID 0 映射到外部 UID 1000
```

这意味着容器里的 root（UID 0）在宿主机上其实是 UID 1000——一个普通用户。容器进程即使逃逸，也只有普通用户的权限。

映射规则：

- 每个映射文件只能写入**一次**（写完不可修改）
- 非特权用户只能映射自己的 UID/GID（单行，范围长度 1）
- 写 `gid_map` 前必须先向 `/proc/[pid]/setgroups` 写入 `"deny"`（安全措施）
- 最大 340 行映射（Linux 4.15+）
- User namespace 最大嵌套深度：32 层

:::expand 安全提示

User namespace 让非特权用户能访问更多内核攻击面。这是一个需要警惕的地方。近年多个提权漏洞（CVE-2023-0386、CVE-2024-1086 等）利用 User namespace 作为跳板。部分发行版默认禁用非特权 User namespace（`kernel.unprivileged_userns_clone=0`），Ubuntu 23.10+ 通过 AppArmor 限制只允许特定程序使用。

:::

## UTS Namespace

UTS namespace 隔离主机名（hostname）和 NIS 域名（domainname）——即 `uname()` 返回的 `nodename` 和 `domainname` 字段。"UTS" 是 "UNIX Time-Sharing" 的缩写，来源于 `uname()` 使用的结构体名称。

这是最简单的 namespace 类型。创建时复制父 namespace 的值，之后各自独立：

```bash
hostname                  # myhost
unshare --uts bash
hostname container-1
hostname                  # container-1（只在这个 namespace 内生效）
# 退出后回到宿主机
hostname                  # myhost（没有受到影响）
```

Docker 用 UTS namespace 给每个容器设置独立主机名（通常是容器 ID 的短形式）。

## 系统调用

三个系统调用操作 namespace，分别对应三种场景：创建子进程时隔离、当前进程脱离、加入已有 namespace。

`clone()` 是 `fork()` 的通用形式。`fork()` 等价于 `clone(SIGCHLD, 0)`——子进程共享父进程的所有 namespace。加上 `CLONE_NEW*` 标志，子进程就会进入新建的 namespace：

```c
// 创建一个在新 PID + Mount + UTS namespace 中的子进程
int flags = CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWUTS | SIGCHLD;
pid_t pid = clone(child_fn, stack + STACK_SIZE, flags, arg);
```

容器运行时用一次 `clone()` 调用把所有需要的 `CLONE_NEW*` 标志 OR 在一起，一次性创建多个 namespace。

每种 namespace 标志的权限要求：

| 标志 | 要求 |
|------|------|
| `CLONE_NEWUSER` | 无需特权（唯一例外） |
| 其他所有 `CLONE_NEW*` | 需要 `CAP_SYS_ADMIN` |

`unshare()` 让当前进程进入新 namespace，不创建子进程：

```c
unshare(CLONE_NEWNS | CLONE_NEWUTS);
// 调用者现在在新的 Mount + UTS namespace 中
```

有两个例外，容易踩坑：`CLONE_NEWPID` 和 `CLONE_NEWTIME` **不移动调用者**。`unshare(CLONE_NEWPID)` 只设置 `pid_ns_for_children`，之后创建的子进程才会在新 PID namespace 中。原因：进程的 PID 一旦分配就不能改变。

命令行工具 `unshare` 封装了这个系统调用：

```bash
unshare --pid --fork --mount-proc bash
```

`--fork` 参数的原因就是上面说的：`unshare(CLONE_NEWPID)` 不影响调用者，需要 fork 一个子进程才能进入新 PID namespace。

`setns()` 让当前进程加入一个**已存在**的 namespace：

```c
int fd = open("/proc/1234/ns/net", O_RDONLY);
setns(fd, CLONE_NEWNET);
close(fd);
// 当前进程现在在 PID 1234 的 Network namespace 中
```

第一个参数是 `/proc/[pid]/ns/` 下某个符号链接的文件描述符。每个进程在 `/proc/[pid]/ns/` 下有一组符号链接，指向该进程所属的各个 namespace：

```
$ ls -l /proc/self/ns/
lrwxrwxrwx ... mnt -> mnt:[4026531841]
lrwxrwxrwx ... pid -> pid:[4026531836]
lrwxrwxrwx ... net -> net:[4026532008]
lrwxrwxrwx ... user -> user:[4026531837]
lrwxrwxrwx ... uts -> uts:[4026531838]
...
```

方括号中的数字是 inode 编号，唯一标识一个 namespace 实例。两个进程的同类 namespace inode 相同，说明它们在同一个 namespace 中。

命令行工具 `nsenter` 封装了 `setns()`，用于进入容器调试：

```bash
nsenter --target 1234 --pid --net --mount bash
```

namespace 通常在其中所有进程退出后销毁。两种方式让 namespace 在无进程时存活：保持 `/proc/[pid]/ns/` 文件的 fd 不关闭，或者 bind mount 该文件到其他路径。`ip netns add` 命令底层就是把 Network namespace 文件 bind mount 到 `/run/netns/` 下。

## 内核实现

namespace 的实现围绕一个核心结构：`nsproxy`。前面五种 namespace 各有各的隔离对象，但内核用同一套框架来管理它们。

每个进程的 `task_struct` 有一个指针指向 `nsproxy`，`nsproxy` 聚合了该进程所属的各种 namespace：

```c
// include/linux/nsproxy.h
struct nsproxy {
    refcount_t              count;
    struct uts_namespace   *uts_ns;
    struct ipc_namespace   *ipc_ns;
    struct mnt_namespace   *mnt_ns;
    struct pid_namespace   *pid_ns_for_children;
    struct net             *net_ns;
    struct time_namespace  *time_ns;
    struct time_namespace  *time_ns_for_children;
    struct cgroup_namespace *cgroup_ns;
};
```

注意两个特殊点：

**PID namespace 存的是 `pid_ns_for_children`，不是当前进程的 PID namespace。** 进程自己的 PID namespace 记录在 `struct pid` 的 `numbers[]` 数组中（PID Namespace 一节讲过），创建后不能改变。`pid_ns_for_children` 决定的是子进程会进入哪个 PID namespace。

**User namespace 不在 `nsproxy` 里。** 它在 `task_struct->cred->user_ns`，因为 credentials（UID、GID、capabilities）和 User namespace 紧密耦合——在子 User namespace 中拥有 `CAP_SYS_ADMIN` 不等于在父 namespace 中也有。

完整的引用关系：

```
task_struct
├── *nsproxy ──→ struct nsproxy
│                ├── *uts_ns              ──→ struct uts_namespace
│                ├── *ipc_ns              ──→ struct ipc_namespace
│                ├── *mnt_ns              ──→ struct mnt_namespace
│                ├── *pid_ns_for_children ──→ struct pid_namespace
│                ├── *net_ns              ──→ struct net
│                ├── *time_ns             ──→ struct time_namespace
│                └── *cgroup_ns           ──→ struct cgroup_namespace
│
├── *thread_pid ──→ struct pid
│                   └── numbers[] ──→ 各层 PID namespace 中的 PID 值
│
└── *cred ──→ struct cred
              └── *user_ns ──→ struct user_namespace
```

`fork()`/`clone()` 时，`copy_process()` 调用 `copy_namespaces()`（`kernel/nsproxy.c`）。如果没有 `CLONE_NEW*` 标志，子进程直接共享父进程的 `nsproxy`（引用计数 +1）。如果有任何 `CLONE_NEW*` 标志，`create_new_namespaces()` 分配新的 `nsproxy`，对每种 namespace 调用对应的复制函数：

```c
// kernel/nsproxy.c（简化）
int copy_namespaces(u64 flags, struct task_struct *tsk)
{
    struct nsproxy *old_ns = tsk->nsproxy;

    // 快速路径：没有 CLONE_NEW* 标志，共享 nsproxy
    if (!(flags & (CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC |
                   CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWCGROUP |
                   CLONE_NEWTIME))) {
        get_nsproxy(old_ns);    // 引用计数 +1
        return 0;
    }

    // 慢路径：创建新 nsproxy，选择性复制/新建各 namespace
    new_ns = create_new_namespaces(flags, tsk, user_ns, tsk->fs);
    tsk->nsproxy = new_ns;
    return 0;
}
```

`create_new_namespaces()` 依次调用 `copy_mnt_ns()`、`copy_utsname()`、`copy_ipcs()`、`copy_pid_ns()`、`copy_net_ns()` 等。每个函数检查对应的 `CLONE_NEW*` 标志：有标志则创建新 namespace，没有则对现有 namespace 增加引用计数。

:::expand ns_common

每种 namespace 都内嵌一个通用结构：

```c
// include/linux/ns_common.h
struct ns_common {
    struct dentry *stashed;
    const struct proc_ns_operations *ops;
    unsigned int inum;      // /proc/[pid]/ns/ 中显示的 inode 编号
    refcount_t count;
};
```

`inum` 就是 `/proc/[pid]/ns/` 中 `type:[inode]` 里的那个 inode 编号。`ops` 提供了每种 namespace 的操作函数（install、get、put 等），让 `setns()` 和 `/proc` 文件系统能统一处理不同类型的 namespace。

:::

## 小结

| 概念 | 说明 |
|------|------|
| Namespace | 包裹全局系统资源，让进程看到隔离的视图 |
| PID Namespace | 隔离 PID 编号空间，进程在内部看到 PID 1 |
| Mount Namespace | 隔离挂载点列表，配合 pivot_root 实现文件系统隔离 |
| Network Namespace | 隔离网络栈，通过 veth 对建立通信通道 |
| User Namespace | 隔离 UID/GID 和 capabilities，唯一不需要 root 即可创建 |
| UTS Namespace | 隔离主机名，最简单的 namespace 类型 |
| `clone()` | fork 的通用形式，用 CLONE_NEW* 标志创建子进程时建立新 namespace |
| `unshare()` | 当前进程脱离旧 namespace 进入新的 |
| `setns()` | 加入一个已存在的 namespace |
| nsproxy | 内核中聚合进程所属各 namespace 的结构体 |
| pivot_root | 交换 Mount namespace 的根挂载，比 chroot 更安全 |
| veth | 虚拟网线对，连接不同 Network namespace |

**核心洞察**：namespace 不是一个新的内核对象类型，而是把已有的全局资源（PID 表、挂载表、网络栈……）从"系统全局唯一"变成"per-namespace 一份"。容器不是一种特殊的进程，它就是一个普通进程，只不过它的 `nsproxy` 指向了一组新建的 namespace，让它看到的世界和宿主机不同。

---

**Linux 源码入口**：
- [`kernel/nsproxy.c`](https://elixir.bootlin.com/linux/latest/source/kernel/nsproxy.c) — `copy_namespaces()`、`create_new_namespaces()`：namespace 的创建和复制
- [`kernel/pid_namespace.c`](https://elixir.bootlin.com/linux/latest/source/kernel/pid_namespace.c) — `create_pid_namespace()`、`zap_pid_ns_processes()`：PID namespace 的生命周期
- [`kernel/pid.c`](https://elixir.bootlin.com/linux/latest/source/kernel/pid.c) — `alloc_pid()`：多层 PID 分配
- [`fs/namespace.c`](https://elixir.bootlin.com/linux/latest/source/fs/namespace.c) — `copy_mnt_ns()`、`do_pivot_root()`：Mount namespace 和 pivot_root

---

<!-- 下一篇：Cgroups（待补充） -->
