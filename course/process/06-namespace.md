# 命名空间

前面几课讲的进程都生活在同一个世界里——共享同一套 PID 编号、同一个文件系统、同一个网络栈。但容器技术需要让每个容器觉得自己独占一台机器。来看一个实验：运行一条命令，观察进程看到的世界：

```
$ unshare --pid --fork --mount-proc bash
$ echo $$
1
$ ps aux
USER  PID  COMMAND
root    1  bash
```

这个 bash 认为自己是 PID 1，`ps` 也只显示它一个进程。但从宿主机看，它的 PID 可能是 54321，周围有几百个进程。同一个进程，在不同视角下看到完全不同的 PID。

这就是 namespace（命名空间）的效果。

PID 编号空间本来是全局的：内核维护一张 PID 表，所有进程从中分配编号，互相可见。PID namespace 把这张全局表拆成多份，每个 namespace 各自维护独立的 PID 表，内部进程从 1 开始编号，看不到其他 namespace 的进程。

Linux 中这样的全局资源不止 PID 一种。挂载点列表、网络栈、主机名、用户 ID 空间，都是所有进程默认共享的。namespace 对每种资源做同样的事：从「全局一份，所有进程共享」变成「每个 namespace 各一份，组内进程只看到自己那份」。Linux 有八种 namespace，每种隔离一类资源：

| Namespace | 隔离的资源 | 内核版本 |
|-----------|-----------|---------|
| Mount | 文件系统挂载点 | 2.4.19 (2002) |
| UTS | 主机名、域名 | 2.6.19 (2006) |
| IPC | System V IPC、POSIX 消息队列 | 2.6.19 (2006) |
| PID | 进程 ID 编号空间 | 2.6.24 (2008) |
| Network | 网络设备、路由、端口、防火墙 | 2.6.29 (2009) |
| User | 用户 ID、组 ID、capabilities | 3.8 (2013) |
| Cgroup | cgroup 根目录视图 | 4.6 (2016) |
| Time | CLOCK_MONOTONIC、CLOCK_BOOTTIME | 5.6 (2020) |

八种原理相同，本篇聚焦与构建容器直接相关的五种：**PID** 隔离进程编号空间，**Mount** 隔离文件系统挂载点，**Network** 隔离网络栈，**User** 隔离用户 ID 与权限，**UTS** 隔离主机名。剩余三种（IPC、Cgroup、Time）不展开。知道了有哪些 namespace，下一个问题是怎么操作它们——内核提供三个系统调用：**clone** 在创建子进程时建立新 namespace，**unshare** 让当前进程脱离旧 namespace 进入新的，**setns** 加入一个已经存在的 namespace。最后看内核的 **nsproxy** 结构如何把一切串起来。

## PID

PID namespace 隔离进程 ID 编号空间。不同 PID namespace 中的进程可以拥有相同的 PID 值。新 PID namespace 中的第一个进程获得 PID 1，成为该 namespace 的 init。

一个进程在宿主机上是 PID 54321，在自己的 PID namespace 里却是 PID 1。内核怎么做到的？

先看一个具体场景。宿主机创建了 namespace A，A 里面又创建了 namespace B，B 里运行着一个 bash。PID namespace 可以嵌套，每一层各自维护独立的 PID 表。这个 bash 同时出现在三层的 PID 表中，编号各不相同：

```
                  PID     usage
Host:             54321   host runs kill(54321, ...) to terminate it
Namespace A:      89      A runs kill(89, ...) to manage it
Namespace B:      1       bash calls getpid(), gets 1
```

三个编号指向同一个进程。

:::thinking 为什么 OS 要允许多层 namespace 嵌套？
假设不嵌套，所有进程共享一个 PID 空间。想想云平台的场景：平台、租户、租户的服务全在一个 namespace 里。租户运行 `ps aux`，能看到平台的数据库（PID 42）、别的租户的 Web 服务（PID 200）。执行 `kill 42`，平台数据库没了；执行 `kill 200`，别的租户的服务也没了。这不行。

这就是**隔离**。每个租户只能看到自己的进程，看不到平台，也看不到别的租户。隔离需求可以递归：租户内部还想隔离自己的服务，服务内部还想隔离子任务，每一层组织边界对应一层 namespace。

但隔离不等于失控。平台要杀掉最内层的 bash，用 `kill(54321, ...)`；租户要停掉它，用 `kill(89, ...)`；bash 自己调 `getpid()` 得到 1。三个编号，三层视角，指向同一个进程。所以内核要为这一个进程同时记住三个 PID。

:::


内核把一对 (编号, 所属 namespace) 叫做 `upid`（namespace-level PID），把一个进程在所有层的 `upid` 集合叫做 `struct pid`。对于上面的 bash，它的 `struct pid` 存了三个 `upid`：

```c
// include/linux/pid.h
struct upid {                   // unit pid: one PID number in one namespace layer
    int nr;                     // nr = number, the PID value
    struct pid_namespace *ns;   // which namespace layer this number belongs to
};

struct pid {                    // complete PID identity: all layers combined
    unsigned int level;         // deepest layer index (here: 2)
    struct upid numbers[];      // one upid per layer
    // numbers[0] = { 54321, Host }
    // numbers[1] = { 89,    Namespace A }
    // numbers[2] = { 1,     Namespace B }
};
```

`getpid()` 返回 `numbers[level].nr`，即最内层的编号（这里是 1）。宿主机通过 `numbers[0].nr` 看到 54321。没有哪一层的 PID 是「真实」的，每层地位平等。

每个 PID namespace 的 PID 1 充当该 namespace 的 init，具备三个特殊行为：

**信号屏蔽。** 和真正的 init 一样，namespace 内的其他进程只能向 PID 1 发送 PID 1 已注册处理函数的信号。如果 PID 1 没有注册 SIGTERM 的处理函数，`kill(1, SIGTERM)` 会被内核直接丢弃。这防止 namespace 内的进程误杀 init。但来自祖先 namespace 的 SIGKILL 和 SIGSTOP 不受此限，父 namespace 拥有控制权。

**孤儿收养。** namespace 内的进程变成孤儿时（父进程退出），被重新挂到 PID 1 下面。PID 1 必须 `wait()` 这些子进程，否则它们变成僵尸。这是容器中一个常见的坑：用普通应用程序作为 PID 1（它不调用 `wait()`），导致僵尸进程堆积。解决方案是在容器中使用轻量 init（如 `tini` 或 `dumb-init`）。

**namespace 终结。** PID 1 退出时，内核向 namespace 内所有剩余进程发送 SIGKILL，然后标记 namespace 为不可用，不能再在其中创建新进程。换句话说，PID 1 一退出，整个容器就被销毁了。所以要确保容器的主进程（就是那个 PID 1）不能意外退出，否则容器里所有服务会被一起杀掉。

PID namespace 还影响 `ps` 命令的输出。`ps` 的数据来源是 `/proc` 目录，这个目录是 per-namespace 的。进入新 PID namespace 后，如果不重新挂载 `/proc`，`ps` 读到的仍然是宿主机的 `/proc`，会显示宿主机的进程（错误的信息）。所以创建 PID namespace 后通常需要同时创建 Mount namespace，然后：

:::expand /proc

进程的状态、内存映射、打开的文件等信息都在内核里，用户态程序没法直接访问内核内存。内核需要提供一种方式让用户态能读到这些信息。Linux 的做法是 `/proc`：一个虚拟文件系统，不占磁盘空间，内容由内核动态生成。每个进程在 `/proc` 下有一个以 PID 命名的子目录（如 `/proc/1234`），用户态程序用普通的文件读取操作（`open` + `read`）就能获取内核中的进程信息。`ps`、`top` 这些工具的底层就是在读 `/proc` 下的文件。

:::

```bash
mount -t proc proc /proc
```

新挂载的 `/proc` 只显示当前 PID namespace 中的进程。`/proc/self` 指向 namespace 内的 PID（如 1）。这也是开篇例子中 `--mount-proc` 参数的作用。

PID namespace 最大嵌套深度：32 层（`MAX_PID_NS_LEVEL`）。

## Mount

Mount namespace 隔离文件系统挂载点列表。不同 Mount namespace 中的进程看到不同的挂载表。在一个 namespace 内挂载或卸载文件系统，不影响其他 namespace。

这是最早加入内核的 namespace 类型（2002 年）。创建新 Mount namespace 时，当前的挂载表被**复制**一份到新 namespace。之后两边各自独立。

容器需要让进程看到一个完全不同的根文件系统。Linux 提供了两个系统调用来做这件事：`chroot` 和 `pivot_root`。

**`chroot(path)`** 把当前进程的根目录（`/`）指向 `path`。比如 `chroot("/container/rootfs")` 之后，进程访问 `/bin/sh` 实际访问的是宿主机上的 `/container/rootfs/bin/sh`。看起来进程已经被关在一个新的文件系统里了，但实际上宿主机的文件系统还在，`chroot` 只是改变了进程自己对 `/` 的理解，并没有把宿主机的文件系统卸载掉。特权进程可以通过 `chroot()` + `fchdir()` 组合逃逸回宿主机的真实根目录。`chroot` 的设计初衷是打包构建，不是安全隔离。

**`pivot_root(new_root, put_old)`** 做得更彻底。还是用 `/container/rootfs` 这个例子：`pivot_root("/container/rootfs", "/container/rootfs/.put_old")` 执行后，`/container/rootfs` 变成新的 `/`，而原来的宿主机根目录被挪到了 `/.put_old` 下面。此时进程访问 `/.put_old` 还能看到宿主机的文件。但接下来执行 `umount /.put_old`，宿主机的文件系统就从当前 namespace 的目录树上断开了。文件还在磁盘上（宿主机照常访问），但这个 namespace 里的进程再也访问不到。和 `chroot` 的区别在于：`chroot` 只是让进程「以为」根目录变了，宿主机文件系统还挂在目录树上；`pivot_root` 配合 `umount` 是真的把宿主机文件系统从目录树上摘掉了。

容器运行时（runc 等）用 `pivot_root`，不用 `chroot`。典型流程：

```bash
mount --bind /path/to/rootfs /path/to/rootfs   # bind mount new root
cd /path/to/rootfs
mkdir .put_old
pivot_root . .put_old                           # swap root
umount -l /.put_old                             # unmount old root
rmdir /.put_old
mount -t proc proc /proc                        # mount new /proc
```

:::expand 挂载传播

Mount namespace 创建时复制父 namespace 的挂载表。但之后父 namespace 里的新挂载是否传播到子 namespace？取决于挂载传播类型。用 `mount` 命令设置：

| 类型 | 设置命令 | 行为 |
|------|---------|------|
| shared | `mount --make-shared /mnt` | 挂载事件双向传播 |
| private | `mount --make-private /mnt` | 不传播（容器默认） |
| slave | `mount --make-slave /mnt` | 单向：从父 namespace 接收，不回传 |
| unbindable | `mount --make-unbindable /mnt` | private + 不可被 bind mount |

举个例子：如果 `/mnt` 是 shared 的，在父 namespace 里执行 `mount /dev/sdb /mnt/usb`，子 namespace 里也会自动出现 `/mnt/usb`。如果是 private 的，子 namespace 完全不受影响。

容器运行时通常在创建 Mount namespace 后把所有挂载递归设为 private（`mount --make-rprivate /`），防止容器内的挂载操作泄漏到宿主机。

:::

## Network

Network namespace 隔离整个网络栈：网络设备、IPv4/IPv6 协议栈、路由表、防火墙规则、端口号空间、`/proc/net`、`/sys/class/net`。

新创建的 Network namespace 只有一个 loopback 接口（`lo`），而且默认是 **down** 的。没有路由、没有防火墙规则、没有任何连接。从零开始，这才是真正的隔离。

但完全隔离的容器没有用处，它至少要能和宿主机通信（比如对外提供 Web 服务）。问题是：两个 Network namespace 各自有独立的网络栈，怎么把它们连起来？Linux 提供了 veth（virtual ethernet）设备来解决这个问题。veth 总是成对创建，可以理解为一根虚拟网线的两端：数据从一端进去，从另一端出来。把一端放进容器的 Network namespace，另一端留在宿主机，两个网络栈就连通了。我们在宿主机上用`ip`这个工具创建 veth 对，把一端移入容器，给两端分配 IP 地址并启用：

```bash
# create veth pair
ip link add veth-host type veth peer name veth-container

# move one end into container's Network namespace (assuming container init PID = 1234)
ip link set veth-container netns 1234

# host side configuration
ip addr add 10.0.0.1/24 dev veth-host
ip link set veth-host up

# container side configuration
nsenter --target 1234 --net -- ip addr add 10.0.0.2/24 dev veth-container
nsenter --target 1234 --net -- ip link set veth-container up
nsenter --target 1234 --net -- ip link set lo up
```

现在宿主机和容器可以互相 ping。但容器还不能访问外部网络（比如 `curl google.com`），因为 veth 只连接了容器和宿主机，外部网络不知道容器的 IP 地址。要解决这个问题，需要在宿主机上配置桥接和 NAT。Docker 的默认网络就是这个原理：创建 `docker0` 桥接设备，每个容器的 veth 一端接到桥上，通过 iptables MASQUERADE 规则做出站 NAT。

:::expand 桥接与 NAT

这两个概念可以用家庭网络来理解。家用路由器其实是三个东西的组合：交换机 + 路由 + NAT。

**交换机（switch）** 负责局域网内部互联。家里的手机、电脑、电视都连到路由器上，路由器内部的交换机根据 MAC 地址把数据转发给目标设备，让它们之间能互相通信。Docker 里的 `docker0` bridge 就是一个虚拟交换机：每个容器的 veth 宿主机端接到 bridge 上，所有容器就组成了一个局域网。没有 bridge 的话，3 个容器互联需要 3 对 veth（A↔B、A↔C、B↔C）；有了 bridge，每个容器只需要一对 veth 接到 bridge 上，bridge 负责内部转发。

**NAT（Network Address Translation）** 负责连接外部网络。家里的设备用的是内部 IP（如 `192.168.1.x`），外部网络不认识这些地址。路由器把出站数据包的源 IP 从内部 IP 替换成路由器自己的外部 IP，再转发出去。外部服务器看到的是路由器的 IP，回复也发给路由器，路由器再根据记录转回给对应的设备。Docker 做的事一模一样：容器用内部 IP（如 `10.0.0.x`），宿主机通过 iptables MASQUERADE 规则做出站 NAT，把容器的内部 IP 替换成宿主机的外部 IP。

:::

除了 veth，还可以把宿主机上的物理网卡（如 `eth0`）直接移入容器的 Network namespace（`ip link set eth0 netns 1234`）。这样容器就独占这块网卡，不经过 bridge 和 NAT，直接收发网络数据，性能更高。这种方式适合对网络性能要求高的场景，比如运行数据库或高频交易服务。代价是：物理网卡同一时刻只能属于一个 Network namespace，移入容器后宿主机就用不了这块网卡了。容器销毁时，网卡会自动回到宿主机的 namespace。

## User

User namespace 隔离用户 ID、组 ID 和 capabilities（能力）。

每个进程都有一个 UID（用户 ID），内核根据 UID 决定这个进程能访问哪些文件、能不能绑定 80 端口、能不能加载内核模块。正常情况下 UID 是全局的：UID 0 就是 root，在整个系统里什么都能做。

传统 Unix 的权限模型很粗暴：要么是 root 什么都能做，要么是普通用户处处受限。Linux capabilities 把 root 的权力拆分成了大约 40 个独立的小权限，比如：

| capability | 允许的操作 |
|-----------|-----------|
| `CAP_NET_BIND_SERVICE` | 绑定 1024 以下的端口（如 80、443） |
| `CAP_SYS_ADMIN` | 挂载文件系统、创建 namespace 等 |
| `CAP_NET_RAW` | 使用原始套接字（如 `ping`） |
| `CAP_KILL` | 向任意进程发信号 |

这样就可以做到精细控制：一个 Web 服务器只需要 `CAP_NET_BIND_SERVICE` 就能绑定 80 端口，不需要给它完整的 root 权限。容器运行时通常只给容器少量必要的 capabilities，而不是完整的 root。

User namespace 把 UID 和 capabilities 都变成 per-namespace 的：一个进程在自己的 User namespace 内部看到的 UID 是 0（root），但这个 0 映射到宿主机上可能是 UID 1000，一个普通用户。容器里的程序以为自己是 root，可以装软件、改配置，但如果它突破了容器边界，在宿主机上只有普通用户的权限。

:::thinking User namespace 和 PC 上的多用户（比如 Linux 上有多个账号）是同一个机制吗？

不是。PC 多用户是传统的 Unix 用户系统：每个用户有一个 UID（你是 1000，另一个用户是 1001），所有用户共享同一个 UID 空间，内核根据 UID 判断谁能访问什么文件。这个机制从 Unix 诞生就有了，不涉及 namespace。User namespace 是在这个基础上再加一层：创建隔离的 UID 空间。同一个进程在 namespace 内部看到自己的 UID 是 0，但在宿主机上它的 UID 是 1000。多用户是「同一个空间里有不同的人」，User namespace 是「多个平行空间，同一个人在不同空间里有不同身份」。

两者的全面对比：

|  | 多用户 | namespace |
|--|--------|-----------|
| 隔离方式 | 权限控制：不同用户有不同的读写权限 | 可见性隔离：不同 namespace 看到完全不同的资源 |
| 进程可见性 | 所有用户都能看到系统上的所有进程（`ps aux`） | 不同 PID namespace 的进程互相看不到 |
| 文件系统 | 共享同一个文件系统，靠文件权限控制访问 | 可以有完全不同的根文件系统（`pivot_root`） |
| 网络 | 共享同一个网络栈和端口空间 | 每个 Network namespace 有独立的网络栈 |
| 攻击面 | 用户 A 能看到用户 B 的进程，可以尝试攻击 | 容器 A 根本不知道容器 B 的存在 |
| 典型场景 | 一台 Linux 服务器上多个开发者共用 | 云平台上不同租户的容器 |

一句话总结：多用户靠「不让你动」，namespace 靠「不让你看到」。

:::

User namespace 有一个独特属性：它是**唯一一种不需要 root 权限就能创建的 namespace**（从 Linux 3.8 开始）。创建其他类型的 namespace（PID、Mount、Network 等）都需要 root 权限，但创建 User namespace 不需要。进程进入新的 User namespace 后，在里面获得完整的 root 权限（capabilities），然后用这个权限去创建其他类型的 namespace。这使得普通用户也能创建容器（rootless container）：用一个不需要特权的 namespace 来引导其他需要特权的 namespace。

回想一下前面几节：创建 PID namespace、Mount namespace、Network namespace 都需要 `CAP_SYS_ADMIN`，也就是 root 权限。在 User namespace 出现之前，普通用户没有任何途径获得这些 capabilities，所以 Docker 只能以 root 身份运行。这意味着 Docker 守护进程本身就是一个 root 进程，它的任何漏洞都是 root 级别的安全风险。有了 User namespace，普通用户可以先创建 User namespace（不需要 root），在里面获得 capabilities，再创建其他 namespace。整个过程不需要真正的 root，即使容器运行时被攻破，攻击者在宿主机上也只有普通用户的权限。

namespace 内部和宿主机之间的 UID 映射关系可以通过 `/proc/[pid]/uid_map` 和 `/proc/[pid]/gid_map` 配置，直接用 `echo` 往里写：

```bash
# container init PID = 1234
# map UID 0 inside namespace to UID 1000 outside, range 1
echo "0 1000 1" > /proc/1234/uid_map
```

格式是 `<namespace内ID> <namespace外ID> <范围长度>`。上面这条的意思是：namespace 内的 UID 0 对应宿主机的 UID 1000，只映射 1 个 UID。容器里的 root 在宿主机上其实是 UID 1000，一个普通用户。

映射规则：

- 每个映射文件只能写入**一次**（写完不可修改）
- 非特权用户只能映射自己的 UID/GID（单行，范围长度 1）
- 写 `gid_map` 前必须先向 `/proc/[pid]/setgroups` 写入 `"deny"`（安全措施）
- 最大 340 行映射（Linux 4.15+）
- User namespace 最大嵌套深度：32 层

:::expand 安全提示

User namespace 带来了一个安全隐患。内核里有很多代码路径（配置防火墙、挂载文件系统等）以前只有 root 才能触发。这些代码即使有 bug，也被归为低危，因为触发条件本身就需要 root，而 root 已经什么都能做了。User namespace 改变了这个前提：普通用户创建 User namespace 获得内部 root，再创建 Network namespace 或 Mount namespace，就能触发那些以前只有真正 root 才能碰到的内核逻辑。原来的低危 bug 一夜之间变成了高危提权漏洞，bug 本身没变，变的是谁能触发它。

[CVE-2024-1086](https://nvd.nist.gov/vuln/detail/CVE-2024-1086) 就是一个典型案例：netfilter（内核防火墙）有一个内存释放后使用的 bug，正常情况下只有 root 能配置 netfilter，普通用户碰不到。但通过 User namespace + Network namespace，普通用户就能在里面配置 netfilter 触发这个 bug，最终获得宿主机的真正 root 权限。拿到 root 之后，攻击者可以读取 `/etc/shadow` 获取所有用户的密码哈希，安装 rootkit 隐藏自己的进程让管理员发现不了，植入 SSH 后门保持长期访问，或者在云平台场景下从一个容器逃逸到宿主机，进而访问同一台物理机上所有其他租户的容器和数据。2024 年 Leaky Vessels 漏洞（[CVE-2024-21626](https://nvd.nist.gov/vuln/detail/CVE-2024-21626)）就是一个容器逃逸的真实案例，攻击者利用 runc 的一个文件描述符泄漏，从容器内部获得了宿主机文件系统的访问权限。

类似的还有 [CVE-2023-0386](https://nvd.nist.gov/vuln/detail/CVE-2023-0386)（OverlayFS 漏洞）。部分发行版因此默认禁用非特权 User namespace（`kernel.unprivileged_userns_clone=0`），Ubuntu 23.10+ 通过 AppArmor 限制只允许特定程序使用。

:::

## UTS

UTS namespace 隔离主机名（hostname）和 NIS 域名（domainname）。"UTS" 是 "UNIX Time-Sharing" 的缩写，来源于 `uname()` 使用的结构体名称。

隔离主机名有什么用？很多应用程序会把主机名写进日志、上报给监控系统，或者用于服务发现。如果同一台宿主机上跑着 10 个容器，它们共享同一个主机名，日志里全是 `myhost`，根本分不清哪条日志来自哪个容器。有了 UTS namespace，每个容器可以有自己的主机名。Docker 默认把容器的主机名设为容器 ID 的短形式（如 `a1b2c3d4`），这样日志和监控一眼就能区分。

这是最简单的 namespace 类型。创建时复制父 namespace 的值，之后各自独立：

```bash
hostname                  # myhost
unshare --uts bash
hostname container-1
hostname                  # container-1 (only within this namespace)
# after exit, back to host
hostname                  # myhost (unaffected)
```

## namespace 操作

我们可以通过三个系统调用来操作 namespace，分别对应三种场景：创建子进程时隔离、当前进程脱离、加入已有 namespace。

`clone()` 是 `fork()` 的通用形式。`fork()` 等价于 `clone(SIGCHLD, 0)`，子进程共享父进程的所有 namespace。加上 `CLONE_NEW*` 标志，子进程就会进入新建的 namespace：

```c
// create a child in new PID + Mount + UTS namespaces
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
// caller is now in new Mount + UTS namespaces
```

有两个例外，容易踩坑：`CLONE_NEWPID` 和 `CLONE_NEWTIME` **不移动调用者**。`unshare(CLONE_NEWPID)` 只设置 `pid_ns_for_children`，之后创建的子进程才会在新 PID namespace 中。原因：进程的 PID 一旦分配就不能改变。

命令行工具 `unshare` 封装了这个系统调用：

```bash
unshare --pid --fork --mount-proc bash
```

`--fork` 参数的原因就是上面说的：`unshare(CLONE_NEWPID)` 不影响调用者，需要 fork 一个子进程才能进入新 PID namespace。

`setns()` 让当前进程加入一个**已存在**的 namespace。它的第一个参数不是 PID，而是一个指向 namespace 的文件描述符。这是因为 namespace 是一个独立的内核对象，不属于某个特定进程（多个进程可以在同一个 namespace 里）。`/proc/1234/ns/net` 这个文件指向的是进程 1234 所在的 Network namespace 对象，`open` 拿到的 fd 引用的是那个 namespace 本身：

```c
int fd = open("/proc/1234/ns/net", O_RDONLY);  // get a reference to the namespace, not to process 1234
setns(fd, CLONE_NEWNET);                        // move current process into that namespace
close(fd);
```

每个进程的 `/proc/[pid]/ns/` 下可以看到它所属的所有 namespace：

```
$ ls -l /proc/self/ns/
lrwxrwxrwx ... mnt -> mnt:[4026531841]
lrwxrwxrwx ... pid -> pid:[4026531836]
lrwxrwxrwx ... net -> net:[4026532008]
lrwxrwxrwx ... user -> user:[4026531837]
lrwxrwxrwx ... uts -> uts:[4026531838]
...
```

方括号中的数字是 inode 编号，唯一标识一个 namespace 实例。如果两个进程的 `net` inode 相同，说明它们在同一个 Network namespace 中。

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

**PID namespace 存的是 `pid_ns_for_children`，不是当前进程的 PID namespace。** 进程自己的 PID namespace 记录在 `struct pid` 的 `numbers[]` 数组中（PID 一节讲过），创建后不能改变。`pid_ns_for_children` 决定的是子进程会进入哪个 PID namespace。

**User namespace 不在 `nsproxy` 里。** 它在 `task_struct->cred->user_ns`。前面讲过，UID 和 capabilities 都是 per-namespace 的，内核在做权限检查时必须知道「在哪个 User namespace 里检查」，所以 User namespace 和 credentials（UID、GID、capabilities）放在一起，而不是和其他 namespace 一起挂在 `nsproxy` 下。

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
│                   └── numbers[] ──→ PID values in each namespace layer
│
└── *cred ──→ struct cred
              └── *user_ns ──→ struct user_namespace
```

`fork()`/`clone()` 时，`copy_process()` 调用 `copy_namespaces()`（`kernel/nsproxy.c`）。如果没有 `CLONE_NEW*` 标志，子进程直接共享父进程的 `nsproxy`（引用计数 +1）。如果有任何 `CLONE_NEW*` 标志，`create_new_namespaces()` 分配新的 `nsproxy`，对每种 namespace 调用对应的复制函数：

```c
// kernel/nsproxy.c (simplified)
int copy_namespaces(u64 flags, struct task_struct *tsk)
{
    struct nsproxy *old_ns = tsk->nsproxy;

    // fast path: no CLONE_NEW* flags, share nsproxy
    if (!(flags & (CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC |
                   CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWCGROUP |
                   CLONE_NEWTIME))) {
        get_nsproxy(old_ns);    // refcount +1
        return 0;
    }

    // slow path: create new nsproxy, selectively copy/create namespaces
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
    unsigned int inum;      // inode number shown in /proc/[pid]/ns/
    refcount_t count;
};
```

`inum` 就是 `/proc/[pid]/ns/` 中 `type:[inode]` 里的那个 inode 编号。`ops` 提供了每种 namespace 的操作函数（install、get、put 等），让 `setns()` 和 `/proc` 文件系统能统一处理不同类型的 namespace。

:::

## 小结

| 概念 | 说明 |
|------|------|
| Namespace | 包裹全局系统资源，让进程看到隔离的视图 |
| PID | 隔离 PID 编号空间，进程在内部看到 PID 1 |
| Mount | 隔离挂载点列表，配合 pivot_root 实现文件系统隔离 |
| Network | 隔离网络栈，通过 veth 对建立通信通道 |
| User | 隔离 UID/GID 和 capabilities，唯一不需要 root 即可创建 |
| UTS | 隔离主机名，最简单的 namespace 类型 |
| `clone()` | fork 的通用形式，用 CLONE_NEW* 标志创建子进程时建立新 namespace |
| `unshare()` | 当前进程脱离旧 namespace 进入新的 |
| `setns()` | 加入一个已存在的 namespace |
| nsproxy | 内核中聚合进程所属各 namespace 的结构体 |
| pivot_root | 交换 Mount namespace 的根挂载，比 chroot 更安全 |
| veth | 虚拟网线对，连接不同 Network namespace |

Linux 内核里没有「容器」这个概念，没有 container 系统调用，也没有 container 数据结构。容器就是一个普通进程，同时套上了一组 namespace（隔离它能看到的资源）加 cgroup（限制它能用多少资源）。Docker「创建容器」本质上就是 fork 一个进程，让它的 `nsproxy` 指向一组新建的 namespace，配好 cgroup，仅此而已。namespace 本身也不是什么新的内核对象类型，它只是把已有的全局资源（PID 表、挂载表、网络栈……）从「系统全局唯一」变成「per-namespace 一份」。

---

**Linux 源码入口**：
- [`kernel/nsproxy.c`](https://elixir.bootlin.com/linux/latest/source/kernel/nsproxy.c) — `copy_namespaces()`、`create_new_namespaces()`：namespace 的创建和复制
- [`kernel/pid_namespace.c`](https://elixir.bootlin.com/linux/latest/source/kernel/pid_namespace.c) — `create_pid_namespace()`、`zap_pid_ns_processes()`：PID namespace 的生命周期
- [`kernel/pid.c`](https://elixir.bootlin.com/linux/latest/source/kernel/pid.c) — `alloc_pid()`：多层 PID 分配
- [`fs/namespace.c`](https://elixir.bootlin.com/linux/latest/source/fs/namespace.c) — `copy_mnt_ns()`、`do_pivot_root()`：Mount namespace 和 pivot_root

---

<!-- 下一篇：Cgroups -->
