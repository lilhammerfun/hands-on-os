# IPC 机制

- 写作时间：`2026-03-04 首次提交，2026-03-31 最近修改`
- 当前字符：`8677`

到目前为止，我们已经在不同的课中接触过三种进程间通信的方式。进程生命周期一课用管道(pipe)把 `ls` 的输出接到 `grep` 的输入上。内存映射一课讲过 `mmap MAP_SHARED`，让多个进程的页表指向同一组物理页，修改对彼此可见。上一课讲的 `AF_INET` socket 可以跨网络通信，当然也可以通过回环地址(loopback, 127.0.0.1)在同一台机器上使用。

这些方式各有侧重，但都能实现一个目标：让一个进程把数据交给另一个进程。这一课把它们放在一起比较，并引入两种新的 IPC 机制：`AF_UNIX` socket（专为本地通信设计的 socket）和 Netlink socket（用户空间与内核之间的通信通道）。此外，`AF_UNIX` socket 有一个独特的能力：通过 `SCM_RIGHTS` 在进程之间传递打开的文件描述符。

## AF_UNIX Socket

AF_UNIX 套接字(AF_UNIX socket)是 Linux 上最常用的本地进程间通信机制。和 `AF_INET` 一样，它通过 `socket()` 创建，支持 `SOCK_STREAM` 和 `SOCK_DGRAM` 两种类型，服务端走 `bind()` → `listen()` → `accept()`，客户端走 `connect()`。区别在于：`AF_UNIX` 的数据不经过 TCP/IP 协议栈，内核直接在发送方和接收方的缓冲区之间复制数据，省去了 IP 头、TCP 头的封装和解析、校验和计算、拥塞控制等所有网络协议的开销。

### 地址格式

`AF_INET` 的地址是 IP 加端口，`AF_UNIX` 的地址是文件系统中的一个路径：

```c
#include <sys/un.h>

struct sockaddr_un {
    sa_family_t sun_family;    // AF_UNIX
    char        sun_path[108]; // socket 文件路径
};
```

`bind()` 时内核会在 `sun_path` 指定的位置创建一个特殊的 socket 文件。客户端通过 `connect()` 连接到同一个路径。这个文件只是一个标识符，数据并不经过文件系统，它的作用相当于 `AF_INET` 中的端口号。

socket 文件在服务端退出后不会自动删除，所以服务端在 `bind()` 之前通常要先调用 `unlink()` 清理上一次运行留下的文件，否则 `bind()` 会因为文件已存在而失败。

Linux 还支持一种不需要文件的寻址方式：抽象命名空间(abstract namespace)。把 `sun_path[0]` 设为 `\0`，后面的字节作为名字，内核就不会在文件系统中创建文件。抽象命名空间的 socket 在所有引用它的 fd 关闭后自动消失，不需要 `unlink()`。D-Bus 就使用这种方式。

### 服务端与客户端

下面是一个 AF_UNIX echo server。它的结构和上一课的 TCP echo server 几乎一样，唯一的不同在于地址的设置方式：

<<< @/network/code/unix_echo_server.c

客户端也只需要把 `AF_INET` 换成 `AF_UNIX`，把 `sockaddr_in` 换成 `sockaddr_un`：

```c
int fd = socket(AF_UNIX, SOCK_STREAM, 0);

struct sockaddr_un addr = { .sun_family = AF_UNIX };
strncpy(addr.sun_path, "/tmp/echo.sock", sizeof(addr.sun_path) - 1);

connect(fd, (struct sockaddr *)&addr, sizeof(addr));
// 之后的 read/write/close 和 TCP 完全一样
```

这正是 socket 抽象的设计目标：不同的地址族共享同一套 API，应用程序切换通信方式时只需要改地址设置部分，数据收发的代码不用动。

### socketpair

`socketpair()` 创建一对已经互相连接好的 AF_UNIX socket，类似于 `pipe()` 创建一对互相连接的 fd，但 `socketpair()` 创建的是全双工(full-duplex)的：两端都能读写。

```c
int sv[2];
socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
// sv[0] 和 sv[1] 已经连接好了，往 sv[0] 写的数据从 sv[1] 读出，反之亦然
```

`socketpair()` 不需要 `bind()`/`listen()`/`accept()`/`connect()` 这些步骤，返回后两端就能直接通信。它通常用在 `fork()` 之后，父子进程各拿一端，建立双向通信。管道(pipe)只能单向传数据，要实现双向通信需要两根管道；`socketpair()` 一对就够了。

### SOCK_DGRAM

AF_UNIX 也支持 `SOCK_DGRAM` 类型。和 UDP 的 `SOCK_DGRAM` 类似，它保留消息边界：发送方调用一次 `sendto()` 发一条消息，接收方调用一次 `recvfrom()` 完整收到这条消息。但和 UDP 不同的是，AF_UNIX 的 `SOCK_DGRAM` 在本地传输，不存在丢包和乱序问题。消息保证按序到达，不会丢失。

这让 AF_UNIX 的 `SOCK_DGRAM` 兼具两个优势：像 UDP 一样保留消息边界，像 TCP 一样可靠。如果你的进程间通信是基于消息的（每条消息是一个独立的请求或事件），`SOCK_DGRAM` 比 `SOCK_STREAM` 更方便，因为不需要自己在字节流中划分消息边界。systemd 的日志系统 journald 就通过 AF_UNIX 的 `SOCK_DGRAM` 接收日志消息。

## fd passing

进程生命周期一课讲过，`fork()` 后子进程继承了父进程的文件描述符表。这意味着父子进程可以共享打开的文件。但如果两个进程不是父子关系呢？一个进程打开了某个文件（可能需要特定权限），想让另一个无关的进程也能访问这个文件，怎么办？

一个做法是把文件路径告诉对方，让对方自己 `open()`。但对方可能没有权限打开这个文件。更根本的问题是，有些 fd 根本不对应文件路径：管道、`epoll` 实例、`eventfd`、匿名 `mmap` 区域，这些内核对象只有一个 fd，没有路径可以传。

fd 传递(fd passing)解决的就是这个问题。AF_UNIX socket 支持通过辅助数据(ancillary data)在 `sendmsg()`/`recvmsg()` 中携带文件描述符。发送方把一个 fd 的编号放入控制消息(control message)，类型设为 `SCM_RIGHTS`；接收方从控制消息中取出 fd。传递完成后，接收方的 fd 表中多了一个新条目，指向发送方打开的同一个内核文件对象(`struct file`)。

### 接口

`sendmsg()` 和 `recvmsg()` 是通用的 socket 收发函数，比 `read()`/`write()` 多了一个"控制消息"通道。控制消息通过 `struct msghdr` 的 `msg_control` 字段传递：

```c
struct msghdr {
    void         *msg_name;       // 目标地址（SOCK_DGRAM 使用）
    socklen_t     msg_namelen;
    struct iovec *msg_iov;        // 普通数据（至少要有 1 字节）
    size_t        msg_iovlen;
    void         *msg_control;    // 辅助数据（fd 就放在这里）
    size_t        msg_controllen;
    int           msg_flags;
};
```

辅助数据由 `struct cmsghdr` 描述。传递 fd 时，`cmsg_level` 设为 `SOL_SOCKET`，`cmsg_type` 设为 `SCM_RIGHTS`，`CMSG_DATA()` 宏指向存放 fd 编号的位置。POSIX 提供了一组宏（`CMSG_FIRSTHDR`、`CMSG_LEN`、`CMSG_SPACE`、`CMSG_DATA`）来操作这些结构，避免手动计算对齐。

### 代码示例

下面的代码演示了 fd 传递的完整过程：父进程通过 `socketpair()` 和子进程建立连接，子进程打开一个文件，把 fd 传给父进程，父进程用收到的 fd 读取文件内容。

<<< @/network/code/fd_passing.c

运行结果类似：

```console
$ ./fd_passing
child: opened /etc/hostname as fd 4, sending to parent
parent: received fd 4 from child
parent: content = my-hostname
```

子进程的 fd 4 和父进程的 fd 4 是不同进程中的编号，但它们在内核中指向同一个 `struct file` 对象。这和 `fork()` 后父子进程共享 fd 的机制本质相同，只不过 `fork()` 是在进程创建时复制整个 fd 表，fd passing 是在运行时按需传递单个 fd。

### 内核机制

fd 传递在内核中的实现并不复杂。发送方调用 `sendmsg()` 时，内核在 `net/unix/af_unix.c` 中解析控制消息，通过 `SCM_RIGHTS` 找到发送方要传递的 fd 编号，在发送方的 fd 表中查找对应的 `struct file`，增加它的引用计数，然后把这个 `struct file` 指针附在数据包上。接收方调用 `recvmsg()` 时，内核在接收方的 fd 表中找一个空闲位置，把 `struct file` 指针填进去，返回新的 fd 编号。整个过程就是"从一个进程的 fd 表中取出 `struct file`，放入另一个进程的 fd 表"。

### 实际应用

fd 传递在系统编程中应用广泛。Nginx 使用 fd passing 在 master 进程和 worker 进程之间传递监听 socket：master 进程打开 80 端口的监听 socket，通过 AF_UNIX socket 把这个 fd 传给每个 worker，worker 各自在同一个监听 socket 上 `accept()`。这样 master 进程不需要 root 权限以外的东西，worker 进程可以用更低的权限运行。

systemd 的 socket activation 也依赖 fd passing。systemd 提前打开服务需要的监听 socket，等第一个连接到达时才启动服务进程，并把已打开的 socket fd 传给它。服务进程不需要自己做 `bind()`/`listen()`，直接从传入的 fd 开始 `accept()`。

## IPC 机制对比

到这里，同一台机器上进程间通信的主要方式都已经出场了。每种方式有不同的特性，适合不同的场景。

| 特性 | 管道(pipe) | AF_UNIX socket | 共享内存(mmap MAP_SHARED) | AF_INET 回环 |
|------|------------|----------------|--------------------------|-------------|
| 方向 | 单向 | 双向 | 双向 | 双向 |
| 消息边界 | 无（字节流） | STREAM 无，DGRAM 有 | 不适用（自行管理） | STREAM 无，DGRAM 有 |
| 需要同步 | 不需要（内核管理） | 不需要（内核管理） | 需要（用户自行同步） | 不需要（内核管理） |
| fd 传递 | 不支持 | 支持（SCM_RIGHTS） | 不适用 | 不支持 |
| 数据路径 | 内核缓冲区复制 | 内核缓冲区复制 | 直接访问共享页（零拷贝） | 完整 TCP/IP 协议栈 |
| 适用关系 | 有亲缘关系的进程[^1] | 任意进程 | 任意进程 | 任意进程（含跨机器） |

从数据路径这一列可以看出每种方式的性能特征。管道和 AF_UNIX socket 都需要把数据从发送方的用户空间复制到内核缓冲区，再从内核缓冲区复制到接收方的用户空间，一共两次复制。AF_INET 回环在此基础上还要走完整的 TCP/IP 协议栈（构造/解析头部、校验和计算、拥塞控制），开销更大。共享内存没有复制：两个进程的页表映射到同一块物理内存，一方写入后另一方直接可见。

但共享内存的零拷贝优势是有代价的。没有内核缓冲区作为中介，也就没有内核替你管理读写顺序和并发。两个进程同时读写共享内存会产生数据竞争(data race)，线程与并发一课讲过的所有同步问题在这里同样存在。你需要自己用信号量、互斥锁或原子操作来协调访问。管道和 socket 不需要操心同步，因为 `read()` 和 `write()` 由内核串行化了：写入的数据保证按序到达，缓冲区满了写入方会阻塞，空了读取方会阻塞。

那什么时候用哪种？

- **管道**：最简单的选择，适合有亲缘关系的进程之间做单向数据流传输。shell 管道就是典型场景。如果需要无关进程之间通信，可以用命名管道(named pipe, FIFO)：通过 `mkfifo()` 在文件系统中创建一个管道文件，任何进程都可以打开它读写。
- **AF_UNIX socket**：通用的本地 IPC，双向通信、支持 fd 传递、可以在无关进程之间使用。数据库客户端连接（PostgreSQL、MySQL 都支持 AF_UNIX）、日志收集（journald）、容器运行时（containerd 的 gRPC 通信）大多使用 AF_UNIX。
- **共享内存**：需要极低延迟或极高吞吐量的场景。典型例子是数据库的共享缓冲池（PostgreSQL 用 `shmget` 或 `mmap MAP_SHARED` 让多个后端进程共享缓冲区）。代价是需要自己处理同步。
- **AF_INET 回环**：通常只在需要和远程通信保持相同代码路径时使用。如果确定只在本地通信，AF_UNIX 几乎总是更好的选择。

:::thinking AF_UNIX 比 AF_INET 回环快多少？

AF_INET 回环（连接 127.0.0.1）虽然数据不离开机器，但内核仍然走完整的 TCP/IP 协议栈：构造 IP 头和 TCP 头、计算校验和、维护拥塞窗口和重传定时器、处理 ACK。AF_UNIX 跳过所有这些，直接在 `unix_stream_sendmsg()` 中把 skb 从发送方的队列移到接收方的队列。

实际测量中，AF_UNIX 的吞吐量通常是 AF_INET 回环的 1.5 到 2 倍，延迟大约低 30% 到 50%。具体数字取决于消息大小和系统负载。Redis 的官方文档就建议客户端在本地部署时使用 AF_UNIX socket 连接以减少延迟。
:::

## Netlink Socket

到目前为止讨论的所有 IPC 机制都用于用户空间进程之间的通信。但有些场景需要用户空间和内核之间通信：配置网络接口、查询路由表、接收设备插拔事件。这就是 Netlink 的用途。

Netlink 套接字(Netlink socket)是 Linux 特有的通信机制，通过 `AF_NETLINK` 地址族创建，允许用户空间进程和内核子系统之间交换消息。

```c
int fd = socket(AF_NETLINK, SOCK_DGRAM, NETLINK_ROUTE);
```

第三个参数指定要通信的内核子系统。`NETLINK_ROUTE` 用于网络配置（路由、接口、地址），`NETLINK_KOBJECT_UEVENT` 用于设备事件（udev 监听的就是这个），`NETLINK_AUDIT` 用于审计，`NETLINK_GENERIC` 是一个通用扩展协议，允许内核模块注册自己的 Netlink 族。

你每天用的 `ip` 命令（iproute2 工具集）就是通过 Netlink 和内核通信的。当你执行 `ip addr add 10.0.0.1/24 dev eth0` 时，`ip` 命令构造一条 Netlink 消息（类型为 `RTM_NEWADDR`），通过 `sendmsg()` 发给内核，内核的路由子系统收到后给 `eth0` 添加 IP 地址。查询操作也是类似的流程：`ip addr show` 发送查询消息，内核回复当前的地址列表。

命名空间一课讲过 `ip link add veth0 type veth` 创建虚拟网络设备。这个命令背后也是一条 Netlink 消息。整个 Linux 网络配置子系统都构建在 Netlink 之上。

Netlink 和普通 socket 还有一个区别：它支持多播(multicast)。内核可以把事件通知发给所有订阅了特定多播组的 Netlink socket。udev 监听设备热插拔事件就是这个机制：udevd 创建一个 `NETLINK_KOBJECT_UEVENT` socket 并加入多播组，当内核检测到硬件变化时，向这个多播组广播事件消息，udevd 收到后执行相应的规则。

:::thinking 为什么不用 ioctl 配置网络？

在 Netlink 出现之前，用户空间通过 `ioctl()` 配置网络。老版本的 `ifconfig` 就用 `SIOCSIFADDR`、`SIOCSIFFLAGS` 等 `ioctl` 命令来设置 IP 地址和启停接口。但 `ioctl` 有几个问题。

第一，`ioctl` 是同步的点对点调用：一个进程发请求，内核回复，只有这个进程能看到结果。如果另一个进程修改了网络配置，第一个进程不会收到通知。Netlink 支持多播，内核的配置变更可以通知所有监听的进程。

第二，`ioctl` 的接口是一次一个操作：设一个地址、改一个标志。Netlink 可以在一条消息中批量传递多个属性，减少系统调用次数。

第三，`ioctl` 的参数格式是固定大小的结构体，扩展新字段很困难。Netlink 使用 TLV（Type-Length-Value）编码，新增属性不需要改已有结构体的布局，向前兼容。

所以 iproute2 全面使用 Netlink 替代了 `ioctl`，`ifconfig` 也逐渐被 `ip` 命令取代。
:::

## 小结

这一课把分散在前面各课中的 IPC 机制拉到了一起。

管道是最简单的单向通道，适合有亲缘关系的进程之间传递数据流。AF_UNIX socket 是本地 IPC 的通用选择：双向通信、支持字节流和数据报、支持 fd 传递，而且比 AF_INET 回环快。共享内存(mmap MAP_SHARED)提供零拷贝的最低延迟，代价是需要自行处理同步。Netlink 填补了用户空间与内核之间的通信空白，是 Linux 网络配置和设备事件的基础。

fd 传递(SCM_RIGHTS)是 AF_UNIX socket 独有的能力。它让进程可以在运行时传递打开的文件描述符，而不只是在 `fork()` 时继承。这个机制被 Nginx、systemd 等系统软件广泛使用，在后续的 zedis 项目中我们也会用到它。

---

[^1]: 匿名管道(anonymous pipe)要求通信双方有亲缘关系（通常是父子进程），因为管道的 fd 必须通过 `fork()` 继承。命名管道(named pipe, FIFO)通过文件系统路径标识，任何有权限的进程都可以打开它，不受亲缘关系限制。
