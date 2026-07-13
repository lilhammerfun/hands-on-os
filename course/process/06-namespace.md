# 命名空间

- 写作时间：`2026-02-27 首次提交，2026-07-13 最近修改`
- 当前字符：`12202`

[Linux 调度器](/process/05-linux-scheduler)解释了多个任务怎样共享处理器，但这些任务默认仍然看到同一套系统资源：同一组进程编号、同一棵挂载树、同一组网络设备和同一个主机名。容器首先要解决的不是资源分配，而是让一组进程获得受限且彼此一致的系统视图。

来看一个具体场景。某个服务在容器内调用 `getpid()` 得到 1，读取主机名得到 `web-1`，只看见容器自己的网络接口；宿主机却用另一个 PID 管理同一个服务，并能看见连接容器的虚拟网络接口。这里没有复制进程或内核，变化的是系统调用解释资源标识时采用的上下文。

命名空间(namespace)是 Linux 把一类全局系统资源包装成多个独立实例，并让进程关联其中一个实例的隔离机制。Linux 目前提供八类 namespace：Mount 隔离挂载视图，UTS 隔离主机标识，IPC 隔离部分进程间通信对象，PID 隔离进程编号，Network 隔离网络栈，User 隔离用户与权限上下文，Cgroup 隔离 cgroup 路径视图，Time 隔离部分系统时钟的偏移。

本课先用 **PID** 说明同一个进程为什么能有多层编号，再用 **Mount** 说明进程怎样获得独立的文件系统视图。文件系统隔离后仍需要受控通信，因此继续分析 **Network**；网络和挂载操作又涉及权限检查，于是进入 **User**。较轻量的主机标识和其余类型放在 **UTS 与其余类型** 中统一说明。最后通过 **Namespace API** 连接创建、拆分与加入操作，再用 **内核表示** 解释一个进程怎样同时关联多类 namespace。

## PID

PID namespace 是为一组进程提供独立进程编号视图的命名空间。

PID namespace 可以嵌套，最外层是系统启动时建立的初始 PID namespace。一个进程在自己所属的 namespace 中有一个 PID，在每个祖先 PID namespace 中也各有一个 PID。例如，同一个进程可能同时具有下面三个编号：

```text
初始 PID namespace       PID 31420
└── 租户 PID namespace   PID 87
    └── 容器 PID namespace  PID 1
```

祖先 namespace 中的进程能看见后代 namespace 中的进程，所以宿主机可以用 31420 管理它；容器内的进程只能看见本层及其后代，不能用 87 或 31420 访问祖先中的进程。`kill()`、`waitpid()` 等接收 PID 的接口，都按调用者所处 PID namespace 的编号解释参数。

内核用 `struct pid` 保存这种多层身份。`numbers[]` 中的每个 `struct upid` 都把一个数值与它所属的 PID namespace 配对：

```c
/* include/linux/pid.h, trimmed */
struct upid {
    int nr;
    struct pid_namespace *ns;
};

struct pid {
    refcount_t count;
    unsigned int level;
    /* task lists and lifetime fields omitted */
    struct upid numbers[];
};
```

这里的“同一个进程有多个 PID”不是说 PID 值会随时变化，而是每一层拥有自己的编号。进程所属的活动 PID namespace 在创建时确定，之后不能改变；`getpid()` 返回的是进程的线程组 ID 在该层中的可见编号。Linux 将 PID namespace 的最大嵌套深度限制为 32 层。

新 PID namespace 中创建的第一个进程获得 PID 1，称为 namespace init。它有三项特殊语义：

- **信号保护**：同一 PID namespace 中的其他进程，只能向 PID 1 发送它已经注册处理函数的信号。祖先 namespace 仍可在权限检查通过后发送信号，其中 `SIGKILL` 和 `SIGSTOP` 会被强制投递。
- **孤儿回收**：进程退出而留下后代时，内核优先把孤儿重新挂到最近的 child subreaper；如果没有这样的进程，再交给相关 PID namespace 的 init。init 必须调用 `wait()` 一类接口回收退出状态，否则会积累僵尸进程。
- **生命周期约束**：namespace init 退出后，内核向该 PID namespace 中的其余进程发送 `SIGKILL`，并拒绝继续在其中创建进程。即使某个文件描述符仍引用该 namespace 对象，对它执行后续 `fork()` 也会失败；因此“PID 1 退出”不等于对象引用立即消失，但这组进程已经不能继续运行。

`ps` 并不直接询问“当前 PID namespace 有哪些进程”，而是读取 procfs 中的 `/proc/PID` 目录。procfs 是由内核动态生成内容的虚拟文件系统；一次 procfs 挂载会绑定到执行挂载操作的进程所见的 PID namespace，并只展示该视角可见的进程。因此，创建 PID namespace 后通常还要创建独立的挂载视图，再在其中挂载新的 `/proc`：

```sh
mount -t proc proc /proc
```

如果继续使用宿主机原有的 procfs 挂载，`ps` 读取的仍是旧视角。PID 隔离本身没有自动替换 `/proc`，进程编号视图与独立挂载视图必须在这里配合。

## Mount

Mount namespace 是为一组进程提供独立挂载列表和目录层次视图的命名空间。

挂载(mount)是把一个文件系统的目录树接入某个目录路径的操作，接入位置称为挂载点。创建 Mount namespace 时，内核以调用者当前的挂载列表初始化新实例；此后，一侧执行 `mount()` 或 `umount()` 通常只改变自己的挂载视图。

“通常”这一限制来自挂载传播(mount propagation)。挂载点带有传播类型，它决定某个挂载事件是否在相关挂载点之间同步：

| 类型 | 传播语义 |
|------|----------|
| shared | 与同一 peer group 中的挂载点双向传播事件 |
| private | 不向外传播，也不接收其他挂载点的事件 |
| slave | 接收 master 一侧的事件，但自身事件不反向传播 |
| unbindable | 具有 private 语义，并禁止作为绑定挂载的源 |

绑定挂载(bind mount)把一棵已经存在的目录树接到另一个路径，不会为文件内容创建副本。peer group 是一组共享挂载事件的挂载点。新 Mount namespace 虽然复制了挂载列表，但其中的 shared 挂载仍可能与其他 namespace 传播事件。容器运行时在重建根文件系统前，通常会把相关子树递归改为 private 或 slave，避免容器内的挂载操作影响宿主机。

独立挂载视图还不等于已经切换根文件系统。`chroot(path)` 只修改进程进行绝对路径解析时采用的根目录，不会创建 Mount namespace，也不会自动卸载旧根文件系统。若进程保留指向外部目录的当前工作目录或文件描述符，并且仍有足够权限，单独使用 `chroot()` 不能构成完整的安全边界。

`pivot_root(new_root, put_old)` 改变的是当前 Mount namespace 的根挂载：`new_root` 成为新的 `/`，旧根被移动到新根下的 `put_old`。随后卸载旧根，并清理仍指向旧目录树的工作目录和文件描述符，进程才不再能通过这棵挂载树访问宿主机根目录。容器运行时可以使用 `pivot_root()`，也可以使用较新的挂载 API 组合完成等价的根挂载切换；关键不在某个固定命令，而在于旧根是否从容器的挂载视图和可达引用中移除。

Mount namespace 只隔离“哪些文件系统挂在哪里”。文件自身的用户 ID(User ID, UID)、组 ID(Group ID, GID)和访问权限仍由文件系统与进程凭据检查，磁盘块和页缓存也可能由多个 namespace 共享。它提供的是挂载视图隔离，不是文件内容的自动复制。

## Network

Network namespace 是包含独立网络设备、协议栈状态、路由表、防火墙规则和端口空间的命名空间。

套接字在创建时关联当前 Network namespace，因此两个 namespace 可以分别在同一个端口号上监听而不冲突。`/proc/net`、`/sys/class/net` 和部分 `/proc/sys/net` 配置也按 Network namespace 提供视图。新实例只有一个默认未启用的 `lo` 设备；`lo` 是只在本网络栈内部收发数据的回环接口。没有额外设备和路由时，新实例不能与外部通信。

虚拟以太网设备对(veth pair)是成对创建的两个网络接口：一端发送的以太网帧会从另一端接收。把一端留在初始 Network namespace，另一端移入容器，就能在两个网络栈之间建立数据路径：

```text
容器 Network namespace                  初始 Network namespace

eth0 10.0.0.2
      │
      └── veth-container ⇄ veth-host ── bridge ── 路由/NAT ── 物理网卡
```

网桥(bridge)是根据以太网帧中的媒体访问控制地址(Media Access Control address, MAC)转发帧的网络设备。多个容器的宿主机侧 veth 接入同一个网桥后，可以处于同一个以太网链路中。网络地址转换(Network Address Translation, NAT)则在数据包经过宿主机时改写地址或端口，并保存反向转换所需的连接状态；容器使用私有地址访问外部网络时，常用源地址转换把容器地址替换为宿主机可路由的地址。

网桥、路由和 NAT 都不是 namespace 自动创建的功能。namespace 先建立网络隔离，管理员或容器运行时再显式配置允许的连接，这样才能区分“拥有独立网络栈”和“能够访问哪些网络”。

物理网络设备同一时刻只能属于一个 Network namespace；namespace 释放时，其中的物理设备会回到初始 Network namespace，veth 设备则随实例销毁。这个规则说明 Network namespace 隔离的是网络对象的归属，不是为每个容器复制一份真实硬件。

## User

User namespace 是隔离 UID、GID 以及 Linux 权能作用范围的命名空间。

UID 和 GID 分别表示用户身份与组身份。Linux 权能(capability)把传统 root 权限拆成 `CAP_SYS_ADMIN`、`CAP_NET_ADMIN` 等独立权限位，内核在执行特权操作时检查调用线程是否在正确的 User namespace 中拥有所需权能。

一个进程可以在子 User namespace 中是 UID 0，同时在父 namespace 中映射为普通 UID。映射通过 `/proc/PID/uid_map` 和 `/proc/PID/gid_map` 表达，每行包含三个数字：

```text
namespace 内起始 ID    父 namespace 起始 ID    连续数量
0                      1000                    1
1                      100000                  65535
```

第一行把内部 UID 0 映射为父层 UID 1000；第二行把内部 1 到 65535 映射为父层 100000 到 165534。内核在访问父层文件等对象时会沿映射转换身份，因此内部 root 并不会自动变成初始 User namespace 的 root。

创建新 User namespace 的进程会在新实例中获得完整 capability 集合，但这些能力只支配该 User namespace 拥有的资源。例如，新建的 Mount namespace 会记录创建它的 User namespace；在其中执行挂载操作时，内核检查调用者在这个拥有者 User namespace 中的 capability。加载内核模块、改变宿主机系统时间等不受子 User namespace 管辖的操作，仍要求初始 User namespace 中的权限。

Linux 接口允许没有父层权能的进程创建 User namespace，但发行版可以通过内核配置或安全策略限制这项能力。若一次 `clone()` 或 `unshare()` 同时指定 `CLONE_NEWUSER` 和其他 `CLONE_NEW*` 标志，内核先创建 User namespace，使调用者能够在新 User namespace 的权限范围内创建由它拥有的其他 namespace。这是无 root 容器(rootless container)的基础：运行时和容器进程不需要取得初始 User namespace 的 root 权限。

ID 映射本身仍受约束。映射文件只能成功写入一次，区间不能重叠；缺少父 User namespace 中 `CAP_SETUID` 或 `CAP_SETGID` 的进程，通常只能直接写入一行，把自己的有效 ID 映射进子 namespace。为普通用户分配更大范围时，系统先在 `/etc/subuid` 和 `/etc/subgid` 中授权从属 ID(subordinate ID)区间，再由 `newuidmap`、`newgidmap` 这类受控辅助程序写入。写 `gid_map` 前还可能需要向 `setgroups` 文件写入 `deny`，防止组权限映射绕过访问检查。

因此，User namespace 改变的是“某项 capability 在哪个资源范围内有效”，而不是让权限检查消失。容器内显示 UID 0，只能说明它在本层的身份，不能单独证明它拥有宿主机权限。

## UTS 与其余类型

UTS、IPC、Cgroup 与 Time namespace 分别隔离主机标识、部分进程间通信对象、cgroup 路径视图和部分系统时钟。

UTS namespace 保存 hostname 和网络信息服务(Network Information Service, NIS)的域名。hostname 是 `uname()`、`gethostname()` 等接口返回的主机标识，应用常把它写入日志或服务实例信息。不同 UTS namespace 可以设置不同 hostname；这不会自动在域名系统(Domain Name System, DNS)中创建记录，也不会改变 Network namespace 中的地址和路由。修改 hostname 仍需在拥有该 UTS namespace 的 User namespace 中通过相应权能检查。

其余三类 namespace 解决更专门的视图隔离问题：

| 类型 | 隔离内容 | 不负责的内容 |
|------|----------|--------------|
| IPC | System V 共享内存、信号量、消息队列以及 POSIX 消息队列 | 匿名管道、文件描述符和普通文件 |
| Cgroup | 进程看到的 cgroup 根和路径 | CPU、内存等资源配额本身 |
| Time | `CLOCK_MONOTONIC`、`CLOCK_BOOTTIME` 等时钟相对初始 namespace 的偏移 | `CLOCK_REALTIME` 所表示的系统墙上时间 |

IPC 表示进程间通信；表中的共享内存、信号量和消息队列都是由内核维护的具名 IPC 对象。Cgroup namespace 只改变进程观察 cgroup 层级时采用的根，不替代 [cgroups](/process/07-cgroup) 的控制器。Time namespace 通过偏移量让迁移或恢复后的进程保持合适的单调时钟视图，并不让容器任意修改宿主机实时时钟。

这四类对象共同说明 namespace 没有统一的“复制系统”语义。UTS 初始化一组名称，IPC 创建独立对象集合，Cgroup 改写路径视角，Time 保存时钟偏移；共同点只是系统调用会根据进程关联的 namespace 对象解释资源。

## Namespace API

Namespace API 是 Linux 用于创建新 namespace、拆分共享关系和加入已有 namespace 的接口集合。

三个核心接口对应三种操作：

| 接口 | 作用 |
|------|------|
| `clone()` / `clone3()` | 创建子任务，并按 `CLONE_NEW*` 标志让子任务进入新 namespace |
| `unshare()` | 让调用者不再共享指定执行上下文，通常创建新 namespace 并切入其中 |
| `setns()` | 通过 namespace 文件描述符，让调用线程关联已有 namespace |

glibc 的 `clone()` 包装函数和两个直接操作接口具有下面的 C 签名：

```c
#define _GNU_SOURCE
#include <sched.h>

int clone(int (*fn)(void *), void *stack, int flags, void *arg, ...);
int unshare(int flags);
int setns(int fd, int nstype);
```

`CLONE_NEWPID`、`CLONE_NEWNS`、`CLONE_NEWNET`、`CLONE_NEWUSER` 和 `CLONE_NEWUTS` 分别请求本课讨论的五类新实例。`clone()` 与 `fork()` 都进入内核的任务创建路径，但它们不是简单的固定参数替换关系：glibc 包装函数的调用约定、不同架构的原始系统调用以及 `clone3()` 的结构化参数都不相同。对 namespace 而言，关键语义是 `CLONE_NEW*` 标志决定子任务是否新建相应实例。

PID namespace 是 `unshare()` 和 `setns()` 的特殊情况。进程自己的 PID 身份一旦建立就不能改变，因此 `unshare(CLONE_NEWPID)` 只设置以后创建的子进程所用的 PID namespace；对 PID namespace 文件描述符调用 `setns()` 也只影响后续子进程，而且目标只能是当前 PID namespace 本身或其后代。命令行工具 `unshare --pid --fork ...` 需要额外创建子进程，原因正在这里。

`setns()` 的第一个参数通常来自 `/proc/PID/ns/TYPE`。这些路径是指向 namespace 对象的特殊链接，打开后得到的文件描述符持有对象引用：

```c
int fd = open("/proc/1234/ns/net", O_RDONLY | O_CLOEXEC);
if (fd == -1)
    /* handle errno */;

if (setns(fd, CLONE_NEWNET) == -1)
    /* handle errno */;

close(fd);
```

链接显示的 `TYPE:[inode]` 中，inode 是文件系统用来标识对象的内核记录，这里的 inode 编号标识一个 namespace 实例。两个进程对应类型的编号相同，表示它们关联同一个实例。保持文件描述符打开，或者对该链接建立绑定挂载，可以让 namespace 在没有成员进程时继续存在；`nsenter` 和 `ip netns` 等工具正是利用这类接口管理现有实例。

权限检查并不只看调用者是不是 UID 0。每个非 User namespace 都记录一个拥有它的 User namespace，`clone()`、`unshare()` 和 `setns()` 会根据 namespace 类型、目标关系以及调用者在相关 User namespace 中的 capability 判断是否允许操作。

## 内核表示

namespace 的内核表示是 `task_struct` 通过 `nsproxy`、进程凭据和 PID 对象关联各类 namespace 实例的引用关系。

大多数 namespace 指针集中在 `struct nsproxy` 中。当前 Linux 源码的核心字段如下：

```c
/* include/linux/nsproxy.h */
struct nsproxy {
    refcount_t count;
    struct uts_namespace *uts_ns;
    struct ipc_namespace *ipc_ns;
    struct mnt_namespace *mnt_ns;
    struct pid_namespace *pid_ns_for_children;
    struct net *net_ns;
    struct time_namespace *time_ns;
    struct time_namespace *time_ns_for_children;
    struct cgroup_namespace *cgroup_ns;
};
```

这里没有 `user_ns`，也没有“当前进程的 PID namespace”。User namespace 决定凭据和 capability 的解释范围，因此通过 `task_struct->cred->user_ns` 关联。进程当前的 PID namespace 由 `task_struct->thread_pid` 指向的 `struct pid` 决定；`nsproxy->pid_ns_for_children` 只记录后续子进程应进入哪一层。Time namespace 同样区分当前视图与子进程视图。

完整关系可以压缩成下面这张图：

```text
task_struct
├── nsproxy ────────────────┬── uts_ns
│                           ├── ipc_ns
│                           ├── mnt_ns
│                           ├── net_ns
│                           ├── cgroup_ns
│                           └── pid_ns_for_children
├── cred ── user_ns
└── thread_pid ── struct pid ── numbers[] ── 多层 PID 编号
```

多个任务在全部 namespace 归属相同时可以共享同一个 `nsproxy`。`fork()` 或 `clone()` 没有请求新 namespace 时，内核增加现有对象的引用；只要某一类 namespace 被新建或拆分，`copy_namespaces()` 就建立新的 `nsproxy`，复用未变化的 namespace 对象，并替换发生变化的指针。每个 namespace 实例仍有自己的类型、状态和生命周期管理，不是把所有资源复制进 `nsproxy`。

Linux 内核没有一个包办进程、网络、文件系统和资源配额的单一 `container` 对象。容器运行时在用户空间把一组真实的 namespace 对象、cgroup 归属、根文件系统和进程生命周期组合成“容器”；其中 namespace 负责改变可见视图，[cgroups](/process/07-cgroup)负责限制资源用量。

## 小结

| 概念 | 说明 |
|------|------|
| PID | 为进程提供分层编号与可见性边界，最内层第一个进程是 namespace init |
| namespace init | PID namespace 中的 PID 1，负责回收孤儿并维持该层进程生命周期 |
| procfs | 挂载时绑定 PID 视角，`ps` 通过它获得可见进程信息 |
| Mount | 隔离挂载列表和目录层次视图，不自动复制文件内容 |
| 挂载传播 | 控制 mount 与 umount 事件是否在相关挂载点之间同步 |
| `pivot_root()` | 更换当前 Mount namespace 的根挂载，并允许随后卸载旧根 |
| Network | 隔离网络设备、协议栈状态、路由、防火墙和端口空间 |
| veth pair | 用两个虚拟以太网接口连接不同 Network namespace |
| bridge / NAT | 分别提供二层转发和地址转换，不由 namespace 自动配置 |
| User | 隔离 UID、GID 以及 capability 的作用范围 |
| ID 映射 | 定义子 User namespace 与父层 UID、GID 之间的对应关系 |
| UTS 与其余类型 | 隔离主机标识、IPC 对象、cgroup 路径视图和部分时钟偏移 |
| Namespace API | 用 `clone()`、`unshare()`、`setns()` 创建、拆分或加入实例 |
| `nsproxy` | 聚合任务所关联的大多数 namespace 指针 |

namespace 的本质不是复制一台机器，而是让内核在解释 PID、路径、网络对象和权限时选择进程所属的资源实例；只有把每类资源的视图边界分别建立起来，多个进程才能组成一致的隔离环境。

---

**Linux 源码与接口入口**：
- [`namespaces(7)`](https://man7.org/linux/man-pages/man7/namespaces.7.html)：namespace 类型与通用接口
- [`pid_namespaces(7)`](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)：多层 PID、namespace init 与 procfs
- [`mount_namespaces(7)`](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html)：挂载列表与传播类型
- [`network_namespaces(7)`](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)：网络对象归属与 veth
- [`user_namespaces(7)`](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)：capability 范围与 ID 映射
- [`include/linux/nsproxy.h`](https://github.com/torvalds/linux/blob/master/include/linux/nsproxy.h)：`struct nsproxy`
- [`include/linux/pid.h`](https://github.com/torvalds/linux/blob/master/include/linux/pid.h)：`struct pid` 与多层编号
- [`kernel/nsproxy.c`](https://github.com/torvalds/linux/blob/master/kernel/nsproxy.c)：`copy_namespaces()` 与 namespace 创建路径
