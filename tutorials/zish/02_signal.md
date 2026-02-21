# zish 02: 信号处理

原理见 [process/02_signal.md](../process/02_signal.md)。这里只说 zish 要做什么、怎么做。

---

## 1. API 速查

全部在 `std.posix` 下。

### sigaction

```zig
pub fn sigaction(sig: u8, noalias act: ?*const Sigaction, noalias oact: ?*Sigaction) void
```

注册或查询信号处置。`act` 为新处置，`oact` 保存旧处置，传 `null` 表示不关心。

Sigaction 结构体：

```zig
pub const Sigaction = struct {
    handler: extern union {
        handler: ?handler_fn,     // fn (i32) callconv(.c) void
        sigaction: ?sigaction_fn,  // fn (i32, *siginfo_t, ?*anyopaque) callconv(.c) void
    },
    mask: sigset_t,
    flags: c_ulong,
};
```

三个字段：

- **handler**：处置方式。`SIG.DFL`（默认）、`SIG.IGN`（忽略）、或自定义函数指针
- **mask**：handler 执行期间，除了触发信号本身外，还要额外阻塞哪些信号。`sigemptyset()` 返回空集，表示不额外阻塞任何信号，大多数情况下用这个就够了
- **flags**：控制行为的标志位。传 `0` 表示不设任何标志。常用的是 `SA.RESTART`（被信号中断的慢速系统调用自动重启，不需要程序自己处理 EINTR）

### sigprocmask

```zig
pub fn sigprocmask(flags: u32, noalias set: ?*const sigset_t, noalias oldset: ?*sigset_t) void
```

修改当前线程的信号掩码（被阻塞的信号集）。

| flags | 含义 |
|-------|------|
| `SIG.BLOCK` | 将 set 中的信号加入阻塞集 |
| `SIG.UNBLOCK` | 从阻塞集中移除 set 中的信号 |
| `SIG.SETMASK` | 用 set 替换整个阻塞集 |

### sigset 操作

```zig
pub fn sigemptyset() sigset_t                          // 空集（不阻塞任何信号）
pub fn sigfillset() sigset_t                           // 满集（阻塞所有信号）
pub fn sigaddset(set: *sigset_t, sig: u8) void         // 添加信号到集合
pub fn sigdelset(set: *sigset_t, sig: u8) void         // 从集合移除信号
pub fn sigismember(set: *const sigset_t, sig: u8) bool // 测试成员
```

### SIG 常量

```zig
posix.SIG.HUP   // 1  终端断开
posix.SIG.INT   // 2  Ctrl+C
posix.SIG.QUIT  // 3  Ctrl+\
posix.SIG.KILL  // 9  不可捕获
posix.SIG.PIPE  // 13 管道断开
posix.SIG.TERM  // 15 kill 默认信号
posix.SIG.CHLD  // 17 子进程状态变化
posix.SIG.CONT  // 18 继续
posix.SIG.STOP  // 19 不可捕获的停止
posix.SIG.TSTP  // 20 Ctrl+Z

// 特殊处置值
posix.SIG.DFL   // 默认处置
posix.SIG.IGN   // 忽略
```

### SA 标志

```zig
posix.SA.RESTART     // 被信号中断的系统调用自动重启
posix.SA.NOCLDSTOP   // 子进程停止时不发 SIGCHLD
posix.SA.NOCLDWAIT   // 子进程终止时自动回收（不产生僵尸）
posix.SA.SIGINFO     // 使用扩展 handler（sigaction_fn）
posix.SA.RESETHAND   // handler 调用后重置为 SIG_DFL
posix.SA.NODEFER     // handler 执行期间不自动阻塞触发信号
```

---

## 2. 实现

### 问题

上一篇实现的 zish 没有做任何信号处理。用户按 Ctrl+C 时，shell 自己也会被杀死：

```
$ ./zish
zish> sleep 100
^C
$                   ← shell 和 sleep 一起死了，回到了系统 shell
```

原因：Ctrl+C 向前台进程组发 SIGINT，zish 和子进程都在这个组里，所有进程的默认处置都是终止。

我们需要的行为是：Ctrl+C 终止子进程，但 zish 自己不受影响。

### 第一步：zish 启动时忽略 SIGINT

在 main 函数开头、进入 REPL 之前，把 SIGINT 的处置设为 SIG_IGN：

```zig
const posix = std.posix;

const ign = posix.Sigaction{
    .handler = .{ .handler = posix.SIG.IGN },
    .mask = posix.sigemptyset(),
    .flags = 0,
};
posix.sigaction(posix.SIG.INT, &ign, null);
```

这之后，zish 进程的 `action[2]`（SIGINT 的处置）被设为 SIG_IGN。Ctrl+C 对 zish 无效。

### 第二步：fork 后、exec 前，子进程重置 SIGINT 为默认

如果只做第一步，会引入一个新 bug。信号教程第 6 节讲过：fork 会复制处置数组。zish 的 `action[2]` 是 SIG_IGN，fork 出来的子进程也是 SIG_IGN。exec 不会改变 SIG_IGN（它是常量，不依赖旧程序的代码）。结果就是 `sleep 100` 也忽略 SIGINT，按 Ctrl+C 毫无反应。

修复：在 fork 和 exec 之间，子进程把 SIGINT 重置为 SIG_DFL。

```zig
const pid = try posix.fork();

if (pid == 0) {
    // 这里是子进程（zish 的副本）在执行
    // sigaction 修改的是调用者自己的 action[]
    const dfl = posix.Sigaction{
        .handler = .{ .handler = posix.SIG.DFL },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.INT, &dfl, null);

    const err = posix.execvpeZ(args[0].?, @ptrCast(&args), std.c.environ);
    std.debug.print("exec failed: {}\n", .{err});
    posix.exit(1);
} else {
    _ = posix.waitpid(pid, 0);
}
```

---

## 3. 验证

```
$ ./zish
zish> sleep 100
^C                  ← sleep 被终止
zish>               ← zish 还活着
zish> sleep 5
^C                  ← 再试一次，依然正常
zish>
```

如果第二步没做，按 Ctrl+C 后 sleep 不会退出。如果第一步没做，按 Ctrl+C 后 zish 和 sleep 一起死。

---

上一篇：[01_basic.md](01_basic.md)
