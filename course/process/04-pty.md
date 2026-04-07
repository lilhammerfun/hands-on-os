# 伪终端

- 写作时间：`2026-04-07 首次提交，2026-04-07 最近修改`
- 当前字符：`10371`

上一课建立了进程组、会话和控制终端的完整层次，并给出了终端模拟器启动 shell 的七步序列。但那个序列是从子进程的视角写的：`setsid()`、`open("/dev/pts/N")`、`dup2`、`exec`。父进程——也就是终端模拟器本身——在 fork 之后做了什么？它怎样把用户的键盘输入送给 shell，又怎样把 shell 的输出画到屏幕上？这条数据通路的中间层就是伪终端。

来看一个具体的问题。你在终端模拟器里敲了一个字符 `a`，shell 收到了它；shell 调用 `write(1, "hello\n", 6)`，屏幕上出现了 `hello`。两个方向的数据显然都穿过了某个东西，但那个东西既不是管道也不是 socket——上一课说它叫 PTY，却没有展开。

本课从终端模拟器的视角补上这条缺失的数据通路。**伪终端**是连接终端模拟器和 shell 的内核设备对；理解了主端和从端各自被谁持有，就能画出完整的**数据流**——输入方向和输出方向各经过哪些处理。数据流中间有一层行规程，它的行为取决于**终端模式**：cooked mode 下它拦截 Ctrl+C、做行编辑；raw mode 下它什么都不做，逐字节透传。最后用 **SSH** 作为一个完整的例子：SSH 在本地和远程各创建一套伪终端，用加密通道把它们桥接起来。如果你真的理解了一套伪终端的数据流，就能推导出 SSH 场景下发生的一切。

## 伪终端

伪终端(pseudo-terminal, PTY)是内核提供的一对虚拟设备，分为主端(master)和从端(slave)，两者之间构成一条双向数据通道。

上一课的信号那一课介绍过，历史上终端是独立的物理设备（如 DEC VT100），通过串口线连接主机。内核中的终端驱动负责从串口读取输入、向串口写入输出，中间经过行规程处理特殊字符。物理终端消失后，终端模拟器（iTerm2、Ghostty、GNOME Terminal）取代了它们的位置。但终端模拟器是一个普通的用户态 GUI 程序，不是真正的硬件设备。内核需要一种机制让终端模拟器能够"插入"到终端驱动原来连接硬件的那个位置。这就是伪终端的由来：主端模拟过去的串口线的"外侧"，从端模拟"内侧"，两者之间经过的内核代码和真正的终端设备完全相同。

上一课给出了终端模拟器启动 shell 的七步序列，但只展开了子进程（步骤 3-7）的视角。现在补上父进程（终端模拟器）的视角。完整的序列是这样的：

```
终端模拟器（父进程）                     子进程
──────────────────────                ──────────────
1. master_fd = posix_openpt(O_RDWR)
2. grantpt(master_fd)
   unlockpt(master_fd)
   slave_name = ptsname(master_fd)
                    │
                    ├── fork() ──→
                    │                 3. close(master_fd)
                    │                 4. setsid()
                    │                 5. slave_fd = open(slave_name)
                    │                    // 自动绑定控制终端
                    │                 6. dup2(slave_fd, 0/1/2)
                    │                    close(slave_fd)
                    │                 7. exec("zsh")
                    │
8. close(slave_fd)
9. 进入事件循环：
   - read(master_fd) → 拿到 shell 输出 → 渲染到屏幕
   - 键盘事件 → write(master_fd) → 送给 shell
```

要理解这个序列中每一步到底做了什么，需要看看内核中 PTY 对的结构。上一课介绍过从端的 `struct tty_struct`，它有 `pgrp` 和 `session` 两个字段，行规程挂在上面。主端也有自己的 `tty_struct`，两者通过 `link` 字段互相指向对方：

```c
// include/linux/tty.h (simplified)
struct tty_struct {
    struct tty_struct      *link;     // master->link = slave, slave->link = master
    struct tty_ldisc       *ldisc;    // line discipline (slave side has N_TTY)
    struct tty_port        *port;     // read buffer
    struct pid             *pgrp;     // foreground process group (slave only)
    struct pid             *session;  // owning session (slave only)
    const struct tty_operations *ops; // master: ptm_unix98_ops, slave: pty_unix98_ops
    // ...
};
```

`posix_openpt()` 在内核中创建了**两个** `tty_struct`——一个是主端，一个是从端——并用 `link` 字段把它们连起来。但此时从端还没有被打开，只是作为主端的配对方存在。`grantpt()` 设置从端设备文件的权限，`unlockpt()` 解锁从端使其可被打开，`ptsname()` 返回从端设备的路径（如 `/dev/pts/0`）。

有了这个结构，主端 fd 上的 `read()`/`write()` 做的事就很具体了。以 `write(master_fd, "a", 1)` 为例——终端模拟器把用户按下的 `a` 写入主端：

```
write(master_fd, "a", 1)
  → 内核调用主端的 pty_write()
    → 通过 master_tty->link 找到 slave_tty
    → 调用 tty_insert_flip_char(slave_tty->port, 'a')
       ┌─────────────────────────────────────┐
       │  slave_tty->port 的 flip buffer      │
       │                                     │
       │  ┌───┬───┬───┬───┬───┬───┐          │
       │  │ h │ e │ l │ a │   │   │ ← 追加到这里
       │  └───┴───┴───┴───┴───┴───┘          │
       └─────────────────────────────────────┘
    → 调用 tty_flip_buffer_push()
      → 通知行规程："缓冲区里有新数据了，来处理"
      → 行规程（n_tty）从 flip buffer 取出 'a'
        ├── ISIG 开启？检查是不是 0x03 之类的特殊字符
        ├── ECHO 开启？把 'a' 写回主端的输出缓冲区（回显）
        └── ICANON 开启？先攒着，等回车再整行交付
            → 把 'a' 放进行规程自己的 read_buf
               ┌─────────────────────────────┐
               │  n_tty_data->read_buf        │
               │                             │
               │  ┌───┬───┬───┬───┐           │
               │  │ h │ e │ l │ a │ ← shell 的 read() 从这里取
               │  └───┴───┴───┴───┘           │
               └─────────────────────────────┘
```

这条路径上有两级缓冲区。第一级是 `tty_port` 里的 **flip buffer**，主端的 `pty_write()` 把原始字节放进这里，相当于"收件箱"。`port` 这个名字来自硬件串口(serial port)——历史上终端通过串口连接主机，每个串口都有一个硬件接收缓冲区，数据从线缆"到港"后先存在这里。PTY 没有物理端口，但缓冲区的角色完全一样。第二级是行规程内部的 **read_buf**，行规程从 flip buffer 取出原始字节，做完所有处理（特殊字符检查、回显、cooked mode 下的行缓冲）后，把结果放进 read_buf。shell 的 `read(0, ...)` 最终从这里取走数据。

为什么需要两级？因为行规程会"吃掉"某些字节。如果用户按了 Ctrl+C（`0x03`），这个字节会进入 flip buffer，但行规程发现它是 INTR 字符后，不会把它放进 read_buf，而是直接向 `tty->pgrp` 发 SIGINT。shell 的 `read()` 永远看不到 `0x03`。flip buffer 是原始输入，read_buf 是加工后的输出，中间的行规程决定了哪些字节通过、哪些被拦截。

反方向也经过缓冲区。shell 调用 `write(1, "hello\n", 6)` 时，数据进入从端的行规程输出处理（比如 `\n` → `\r\n` 转换），处理完的结果放进主端的输出缓冲区，终端模拟器的 `read(master_fd, ...)` 从那里取走并渲染到屏幕上。

所以主端 fd 不是一根"管道的另一头"——它是从端行规程的背面入口。终端模拟器写主端，数据经过从端行规程的输入侧处理；终端模拟器读主端，数据来自从端行规程的输出侧。行规程始终挂在从端上，主端自己没有行规程。

**fork 之后，父子进程各取一端。** 子进程关闭 master_fd，打开从端设备；父进程关闭 slave_fd，保留 master_fd。从这一刻起，父子进程通过 PTY 对通信：父进程写 master_fd 的数据经过从端行规程处理后到达子进程的 fd 0（stdin），子进程写 fd 1（stdout）的数据经过从端行规程处理后到达父进程的 master_fd。

**终端模拟器不在 shell 的会话中。** 上一课讲过，子进程调用 `setsid()` 创建了一个新会话，自己成为 session leader。这个新会话不包含终端模拟器。终端模拟器始终在自己原来的会话中（macOS 桌面环境的会话），和 shell 的会话唯一的连接就是 master_fd。如果终端模拟器崩溃了，master_fd 被关闭，内核检测到主端关闭，就会通过从端的 `tty->session` 向 session leader（shell）发送 SIGHUP。

从端的 `pgrp` 和 `session` 字段上一课已经讲过，它们让终端驱动知道键盘信号该发给谁、终端断开时该通知谁。主端的 `tty_struct` 中这两个字段没有意义——终端模拟器不是会话的成员，也不属于任何前台进程组。主端和从端的根本区别是：从端是一个终端设备，shell 可以对它调用 `tcgetattr()`/`tcsetattr()` 修改终端属性、`tcsetpgrp()` 设置前台进程组；主端不是终端设备，它只是行规程背面的读写接口。

下面这段程序演示了 PTY 的创建和双向通信。父进程通过主端写入一段文本，子进程从从端读到它；子进程通过从端写入回复，父进程从主端读到回复：

<<< @/process/code/pty_demo.c

```bash
$ gcc -o /tmp/pty_demo pty_demo.c && /tmp/pty_demo
slave device: /dev/pts/0
child read from slave: "hello from master"
parent read from master: "hello from slave"
```

父进程写入主端的 `"hello from master"` 穿过了内核中的 PTY 驱动和行规程，到达了从端的读缓冲区，子进程的 `read()` 拿到了它。反方向同理。这就是终端模拟器和 shell 之间数据流动的基本机制。

:::thinking 为什么主端 fd 不是 3 而是更大的数字？
在 Docker 容器或某些终端模拟器中，进程启动时可能已经有一些额外的文件描述符被打开（比如日志、systemd 通知 socket 等）。`posix_openpt()` 分配的 fd 编号是当前进程中最小的可用编号，所以它的值取决于运行环境。fd 的具体数值不影响 PTY 的工作方式——重要的是谁持有它，以及它连接到哪个从端。
:::

## 数据流

数据流是指用户的键盘输入从终端模拟器到达 shell、以及 shell 的输出从 shell 到达屏幕的完整路径。

信号那一课在一个 `:::expand` 容器里画过一条简化的输入路径：键盘 → GUI → 终端模拟器 → PTY → 终端驱动 → shell。现在我们把两个方向都展开，并且标清每一跳经过了什么处理。

**输入方向**（用户敲键盘 → shell 收到数据）：

```
物理键盘
  → 键盘驱动（内核）：扫描码 → 按键事件
    → GUI 系统（macOS / X11 / Wayland）：按键事件 → 字符
      → 终端模拟器（用户态）：write(master_fd, "a", 1)
        → 内核 PTY 驱动 → 行规程（从端侧）
          ├── 是特殊字符？（如 0x03 = Ctrl+C）
          │     → 不传给从端，直接向 tty->pgrp 发 SIGINT
          ├── ECHO 开启？
          │     → 把字符回写到主端（终端模拟器读到后显示在屏幕上）
          └── 普通字符
                → 放入从端读缓冲区
                  → shell 的 read(0, ...) 返回数据
```

**输出方向**（shell 输出数据 → 屏幕显示）：

```
shell 调用 write(1, "hello\n", 6)
  → 写入 PTY 从端
    → 行规程处理
      ├── \n → \r\n 转换（ONLCR 标志）
      └── 其他输出处理
    → 数据到达 PTY 主端读缓冲区
      → 终端模拟器调用 read(master_fd, ...)
        → 解析 ANSI 转义序列
          → 渲染到屏幕（GPU 或 CPU 绘制）
```

两个方向都经过了行规程，但行规程在两个方向上做的事不同。**输入方向**的行规程负责三件事：拦截特殊字符（Ctrl+C、Ctrl+Z 等，信号那一课已经详细讲过）、回显（把输入字符发回主端让终端模拟器显示）、行编辑（退格键删除前一个字符，在 cooked mode 下按回车才把整行送给从端）。**输出方向**的行规程主要做字符转换，最常见的是 `\n` → `\r\n`：Unix 程序只写 `\n` 表示换行，但终端需要 `\r`（回到行首）+ `\n`（下移一行）才能正确显示。

回显这个细节容易被忽略。你在终端里敲 `ls` 时，屏幕上出现的 `ls` 两个字符不是 shell 打印的——是行规程在输入方向回显的。shell 的 `read()` 还没返回（在 cooked mode 下要等回车），但行规程已经把你敲的每个字符发回了主端，终端模拟器读到后立刻显示在屏幕上。这就是为什么你能实时看到自己敲的字符。

## 终端模式

终端模式(terminal mode)是行规程对输入输出的处理方式，由 `termios` 结构体中的标志位控制。

上一节描述的行编辑、回显、特殊字符拦截，都可以通过标志位单独开关。这些标志的组合形成了两种常见的模式。

**Cooked mode（canonical mode）** 是默认模式。行规程做完整的行编辑：输入以行为单位缓冲，按回车后才把整行交给 `read()`；退格键删除前一个字符；Ctrl+C、Ctrl+Z 等特殊字符触发信号。shell 的命令行界面就工作在 cooked mode 下——你可以用退格键修改输入，按回车提交。

**Raw mode** 是 cooked 的反面。行规程几乎不做任何处理：每个字节立刻传给 `read()`，不等回车；不做回显；不拦截特殊字符。vim、less、top 和 ssh 客户端都在启动时把终端切到 raw mode，因为它们需要逐键响应（vim 要区分 `h`/`j`/`k`/`l` 方向键），不能等行规程攒够一行才给数据。

控制这些行为的是 `termios` 结构体中的标志位：

| 标志 | 所在字段 | 含义 |
|------|---------|------|
| `ICANON` | `c_lflag` | 启用行编辑（canonical mode）：按行缓冲，退格有效 |
| `ECHO` | `c_lflag` | 回显输入字符到终端 |
| `ISIG` | `c_lflag` | 识别 INTR/QUIT/SUSP 等特殊字符并发信号 |
| `ICRNL` | `c_iflag` | 把输入的 CR（`\r`）转换为 NL（`\n`） |
| `ONLCR` | `c_oflag` | 把输出的 NL（`\n`）转换为 CR+NL（`\r\n`） |

cooked mode 下这些标志全部开启；raw mode 下前四个关闭。程序通过 `tcgetattr()` 读取当前标志，修改后用 `tcsetattr()` 写回。

下面这段程序在一个 PTY 上演示 cooked mode 和 raw mode 的区别。它先打印默认的标志状态，然后关闭 `ICANON`、`ECHO`、`ISIG`、`ICRNL`，再打印一次。最后在 raw mode 下通过主端写入一个 `0x03`（Ctrl+C 的 ASCII 码），观察子进程是否收到了 SIGINT：

<<< @/process/code/pty_raw.c

```bash
$ gcc -o /tmp/pty_raw pty_raw.c && /tmp/pty_raw
cooked:  ICANON=1  ECHO=1  ISIG=1  ICRNL=1
raw:     ICANON=0  ECHO=0  ISIG=0  ICRNL=0
raw mode: child read byte 0x03 (Ctrl+C passed through as data, no SIGINT)
```

在 cooked mode 下，`0x03` 会被行规程拦截，行规程向 `tty->pgrp` 发送 SIGINT，子进程根本读不到这个字节。但在 raw mode 下，行规程不再识别特殊字符（`ISIG=0`），`0x03` 作为普通数据透传到了从端，子进程读到了它。vim 就是这样工作的：它把终端切到 raw mode，然后自己解释每一个按键——Ctrl+C 在 vim 里不是"杀死进程"，而是"取消当前操作"。

:::thinking vim 退出后终端为什么能恢复正常？
vim 在启动时用 `tcgetattr()` 保存了原始的 termios 设置，然后修改标志切到 raw mode。退出时用 `tcsetattr()` 恢复保存的设置。如果 vim 异常崩溃没来得及恢复，终端就会停留在 raw mode——此时你敲的字符不回显，回车不换行，终端看起来"坏了"。运行 `reset` 命令（盲敲 `r`-`e`-`s`-`e`-`t`-回车）可以恢复，因为 `reset` 会重新初始化终端到 cooked mode。
:::

## SSH

SSH 登录远程服务器时，本地和远程各有一套伪终端，中间通过加密通道桥接。

前三节建立了一套伪终端的完整工作模型：终端模拟器持有主端，shell 持有从端，中间经过行规程。现在来看这个模型在 SSH 场景下怎样扩展。如果你真正理解了一套 PTY 的数据流，SSH 的行为可以全部推导出来。

在本地终端中输入 `ssh user@server` 后，ssh 客户端做的第一件事是把**本地终端切成 raw mode**。为什么？因为 ssh 客户端需要把每一个按键都原封不动地发给远程服务器——如果本地行规程还在 cooked mode 下拦截 Ctrl+C、做行编辑，这些操作就会在本地生效而不是在远程生效。切到 raw mode 后，本地行规程被"架空"，所有字节直接透传给 ssh 客户端。

在远程端，sshd 收到 SSH 连接请求后，做的事情和终端模拟器启动 shell 完全一样：创建一套 PTY 对 → fork → 子进程 `setsid()` + `open` 从端 + `dup2` + `exec` 远程 shell。sshd 扮演的角色和 Ghostty 在本地扮演的角色是同构的——它们都是 PTY 主端的持有者。区别只是 Ghostty 从键盘事件获取输入、用 GPU 渲染输出，而 sshd 从 SSH 加密通道获取输入、把输出发回加密通道。

完整的拓扑：

```
┌────────── 本地 ──────────┐          ┌────────── 远程服务器 ──────────┐
│                           │          │                                │
│  Ghostty                  │          │  sshd                         │
│    ↕ read/write           │          │    ↕ read/write               │
│  PTY master (local)       │          │  PTY master (remote)          │
│    ↕                      │          │    ↕                          │
│  行规程 (RAW mode)        │          │  行规程 (cooked mode)          │
│    ↕                      │          │    ↕                          │
│  PTY slave (local)        │          │  PTY slave (remote)           │
│    ↕                      │          │    ↕                          │
│  本地 session             │   SSH    │  远程 session                  │
│  ├── zsh (等待)           │  加密通道 │  ├── bash (session leader)    │
│  └── ssh client ←─────────────────────→ └── 用户命令 (vim, make ...) │
│       (前台进程)          │          │                                │
└───────────────────────────┘          └────────────────────────────────┘
```

用 Ctrl+C 的路径来验证这个拓扑。你按下 Ctrl+C，Ghostty 把 `0x03` 写入本地 PTY 主端。本地行规程在 raw mode 下不做任何处理，`0x03` 透传到本地 PTY 从端。ssh 客户端从本地从端读到 `0x03`，通过加密通道发给远程 sshd。sshd 写入远程 PTY 主端。远程行规程在 cooked mode 下识别出 `0x03` 是 INTR 字符，向远程 `tty->pgrp`（远程前台进程组）发送 SIGINT。所以 Ctrl+C 杀死的是远程进程，不是本地的 ssh 客户端——因为 `0x03` 是在远程行规程中被解释的，不是在本地。

窗口大小的同步也值得一提。当你 resize 终端模拟器窗口时，Ghostty 对本地 PTY 主端执行 `ioctl(TIOCSWINSZ)` 更新窗口尺寸。内核向本地前台进程组发送 SIGWINCH。ssh 客户端捕获这个信号后，通过 SSH 协议的 `window-change` 消息把新尺寸发给远程 sshd。sshd 对远程 PTY 主端执行同样的 `ioctl`，内核向远程前台进程组发送 SIGWINCH。远程的 vim 收到 SIGWINCH 后重新查询终端尺寸并重绘界面。这就是为什么在 SSH 会话中 resize 窗口后 vim 能正确重绘。

:::thinking 断开 SSH 连接时远程进程会怎样？
当 ssh 客户端退出或网络断开时，本地端的加密通道关闭。远程 sshd 检测到连接断开后，关闭远程 PTY 主端 fd。内核发现主端关闭后，通过远程 `tty->session` 找到远程 session leader（bash），向它发送 SIGHUP。bash 收到 SIGHUP 后退出，内核进而向 bash 的前台进程组发送 SIGHUP。这个过程和在本地关闭终端窗口时的行为完全一致——因为 sshd 对远程 PTY 的关系，和 Ghostty 对本地 PTY 的关系是同构的。

如果你希望远程进程在 SSH 断开后继续运行，需要让它脱离远程会话：`nohup` 忽略 SIGHUP，`tmux`/`screen` 创建独立的会话和 PTY 对。tmux 本质上是在远程再多加一层 PTY：sshd ↔ PTY1 ↔ tmux ↔ PTY2 ↔ 用户 shell。断开 SSH 只关闭了 PTY1 的主端，PTY2 和它上面的会话不受影响。
:::

## 小结

| 概念 | 说明 |
|------|------|
| 伪终端(PTY) | 内核提供的一对虚拟设备（主端 + 从端），连接终端模拟器和 shell |
| 主端(master) | 普通 fd，由终端模拟器（或 sshd）持有，读写 shell 的输出和输入 |
| 从端(slave) | 终端设备（`/dev/pts/N`），挂载了行规程，shell 的 fd 0/1/2 指向它 |
| `posix_openpt()` | 创建 PTY 主端，返回 master fd |
| 输入路径 | 键盘 → 终端模拟器 → 主端 → 行规程 → 从端 → shell |
| 输出路径 | shell → 从端 → 行规程 → 主端 → 终端模拟器 → 屏幕 |
| cooked mode | 默认模式。行编辑、回显、特殊字符拦截，以行为单位缓冲 |
| raw mode | 行规程不处理，逐字节透传。vim、ssh 客户端使用 |
| `termios` | 控制终端模式的结构体，通过 `tcgetattr()`/`tcsetattr()` 读写 |
| SSH 双 PTY | 本地一套 PTY（raw mode）+ 远程一套 PTY（cooked mode），加密通道桥接 |

终端模拟器和 shell 之间不是一根普通的管道，而是一套带行规程的 PTY 对。行规程是这条通路中唯一有"智能"的环节：它决定了 Ctrl+C 是变成信号还是透传为数据，输入是攒够一行才交付还是逐字节交付，字符是回显还是吃掉。从本地终端到 SSH 远程登录，变化的只是"谁持有主端"和"行规程处于什么模式"，PTY 的基本架构没有变。

---

**Linux 源码入口**：
- [`drivers/tty/pty.c`](https://elixir.bootlin.com/linux/latest/source/drivers/tty/pty.c) — PTY 主端/从端的创建和数据转发
- [`drivers/tty/n_tty.c`](https://elixir.bootlin.com/linux/latest/source/drivers/tty/n_tty.c) — 默认行规程（N_TTY）的实现：行编辑、回显、特殊字符处理
- [`include/uapi/asm-generic/termbits.h`](https://elixir.bootlin.com/linux/latest/source/include/uapi/asm-generic/termbits.h) — `termios` 结构体和标志位定义（`ICANON`、`ECHO`、`ISIG` 等）
- [`drivers/tty/tty_io.c`](https://elixir.bootlin.com/linux/latest/source/drivers/tty/tty_io.c) — TTY 子系统的核心：`tty_open()`、`tty_read()`、`tty_write()`
