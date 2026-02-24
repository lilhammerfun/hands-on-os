# zish 03: 进程组与 Job Control

原理见 [process/03_process_group.md](../process/03_process_group.md)。这里只说 zish 要做什么、怎么做。

---

## 1. API 速查

### 进程组与会话

全部在 `std.posix` 下，除非特别标注。

```zig
pub fn setpgid(pid: pid_t, pgid: pid_t) SetPgidError!void
```

设置进程 pid 的 PGID。pid=0 表示自己，pgid=0 表示用 pid 做 PGID。

```zig
pub fn setsid() pid_t
```

创建新会话，返回新 SID。

> `getpgid()` 在 Zig 0.15 标准库中不存在。如果需要查询 PGID，使用 raw syscall：
>
> ```zig
> const pgid = std.os.linux.syscall1(.getpgid, @intCast(pid));
> ```
>
> 但实际实现中很少需要查询，因为 shell 自己维护 PGID 信息。

### 终端前台控制

```zig
pub fn tcsetpgrp(fd: fd_t, pgid: pid_t) TcSetPgrpError!void
pub fn tcgetpgrp(fd: fd_t) TcGetPgrpError!pid_t
```

设置/查询终端的前台进程组。fd 通常传 `STDIN_FILENO`。

### 向进程组发信号

`std.posix.kill` 不支持负 PID。需要使用 Linux 特定接口：

```zig
// 向 PGID=pgid 的整个进程组发送 sig
_ = std.os.linux.kill(@as(i32, -@as(i32, @intCast(pgid))), sig);
```

注意类型转换：`kill` 的第一个参数是 `i32`，需要先转成 `i32` 再取负。

### waitpid 标志

```zig
const W = std.posix.W;
```

| 标志 | 用途 |
|------|------|
| `W.UNTRACED` | 除了退出，也报告被停止(Stopped)的子进程 |
| `W.CONTINUED` | 也报告被 SIGCONT 恢复的子进程 |
| `W.NOHANG` | 非阻塞，没有状态变化就立即返回 |

状态解析宏：

| 宏 | 用途 |
|----|------|
| `W.IFEXITED(status)` | 是否正常退出 |
| `W.EXITSTATUS(status)` | 退出码 |
| `W.IFSTOPPED(status)` | 是否被信号停止 |
| `W.STOPSIG(status)` | 停止信号编号 |
| `W.IFSIGNALED(status)` | 是否被信号终止 |
| `W.TERMSIG(status)` | 终止信号编号 |

> `W.IFCONTINUED` 在 Zig 0.15 标准库中不存在。如果需要检测 SIGCONT 恢复事件，手动检查：
>
> ```zig
> const CONTINUED_VALUE = 0xffff;
> fn ifcontinued(status: u32) bool {
>     return status == CONTINUED_VALUE;
> }
> ```

---

## 2. 实现步骤

### 第一步：为每个 job 创建独立进程组

在 fork 后、exec 前，子进程把自己设为新进程组的组长。shell 也做同样的设置（双保险防竞态）。

管道中第一个子进程的 PID 作为整个 job 的 PGID。后续子进程加入同一个组。

```zig
const first_pid = try posix.fork();
if (first_pid == 0) {
    // 子进程：自己做组长
    try posix.setpgid(0, 0);  // pgid=0 → 用自己的 PID
    // ... 重定向、重置信号、exec
}
// 父进程（shell）：也设一下（防竞态）
try posix.setpgid(first_pid, first_pid);

// 管道中后续进程
const second_pid = try posix.fork();
if (second_pid == 0) {
    // 子进程：加入 first_pid 的组
    try posix.setpgid(0, first_pid);
    // ... 重定向、重置信号、exec
}
try posix.setpgid(second_pid, first_pid);
```

### 第二步：tcsetpgrp 切换前台

启动前台 job 后，把终端前台交给它。job 结束后收回。

```zig
// 启动前台 job 后
try posix.tcsetpgrp(posix.STDIN_FILENO, job_pgid);

// waitpid...

// job 结束或停止后，收回前台
try posix.tcsetpgrp(posix.STDIN_FILENO, shell_pgid);
```

`shell_pgid` 在 main 函数开头用 `getpgrp()` 获取并保存。Zig 标准库没有 `getpgrp`，等价写法：

```zig
const shell_pid = posix.getpid();
const shell_pgid = shell_pid; // shell 启动时自己就是组长
```

或者更准确地用 raw syscall：

```zig
const shell_pgid: posix.pid_t = @intCast(std.os.linux.syscall1(.getpgrp, 0));
```

### 第三步：Shell 忽略 job control 信号

在 main 函数开头，除了第二课已经忽略的 SIGINT，再忽略三个信号：

```zig
const ign = posix.Sigaction{
    .handler = .{ .handler = posix.SIG.IGN },
    .mask = posix.sigemptyset(),
    .flags = 0,
};
posix.sigaction(posix.SIG.INT, &ign, null);
posix.sigaction(posix.SIG.TSTP, &ign, null);   // Ctrl+Z
posix.sigaction(posix.SIG.TTIN, &ign, null);    // 后台读终端
posix.sigaction(posix.SIG.TTOU, &ign, null);    // 后台写终端
```

子进程在 fork 后、exec 前，把所有四个信号重置为 SIG_DFL：

```zig
const dfl = posix.Sigaction{
    .handler = .{ .handler = posix.SIG.DFL },
    .mask = posix.sigemptyset(),
    .flags = 0,
};
posix.sigaction(posix.SIG.INT, &dfl, null);
posix.sigaction(posix.SIG.TSTP, &dfl, null);
posix.sigaction(posix.SIG.TTIN, &dfl, null);
posix.sigaction(posix.SIG.TTOU, &dfl, null);
```

### 第四步：waitpid + WUNTRACED 处理 stopped

前台 job 运行时，shell 的 waitpid 必须带 `W.UNTRACED` 标志，才能感知 Ctrl+Z 导致的停止：

```zig
const result = posix.waitpid(-job_pgid, W.UNTRACED);

if (W.IFSTOPPED(result.status)) {
    // 子进程被 Ctrl+Z 停止
    const sig = W.STOPSIG(result.status);
    // 在 job 表中记录为 Stopped
    job.state = .stopped;
    // 收回前台
    try posix.tcsetpgrp(posix.STDIN_FILENO, shell_pgid);
    // 打印 "[1]+  Stopped"
} else if (W.IFEXITED(result.status)) {
    // 正常退出，从 job 表移除
} else if (W.IFSIGNALED(result.status)) {
    // 被信号终止，从 job 表移除
}
```

注意：`waitpid` 的第一个参数传负的 PGID（`-job_pgid`）可以等待该进程组中的任意子进程。但 `std.posix.waitpid` 的参数是 `pid_t`，传负值需要用 `@intCast`。如果类型不兼容，可以逐个等待组内已知的 PID。

### 第五步：fg/bg/jobs 内建命令

这三个命令是 shell 内建的，不能 fork + exec（它们需要操作 shell 自身的状态）。

```zig
if (mem.eql(u8, cmd, "fg")) {
    const job = findJob(job_id);
    try posix.tcsetpgrp(posix.STDIN_FILENO, job.pgid);
    _ = std.os.linux.kill(-@as(i32, @intCast(job.pgid)), posix.SIG.CONT);
    job.state = .foreground;
    waitForJob(job);
    try posix.tcsetpgrp(posix.STDIN_FILENO, shell_pgid);
}

if (mem.eql(u8, cmd, "bg")) {
    const job = findJob(job_id);
    _ = std.os.linux.kill(-@as(i32, @intCast(job.pgid)), posix.SIG.CONT);
    job.state = .background;
}

if (mem.eql(u8, cmd, "jobs")) {
    for (job_table) |job| {
        // 打印 [job_id]  state  command
    }
}
```

### 第六步：Job 表数据结构

```zig
const JobState = enum {
    foreground,
    background,
    stopped,
};

const Job = struct {
    id: u32,               // job 编号（[1], [2], ...）
    pgid: posix.pid_t,     // 进程组 ID
    state: JobState,
    command: []const u8,   // 命令行文本（用于 jobs 显示）
    process_count: u32,    // 组内进程数
    completed_count: u32,  // 已退出的进程数
};
```

管道中有多个进程时，需要 waitpid 所有进程都退出才算 job 完成。`process_count` 和 `completed_count` 用于跟踪。

---

## 3. 验证

### 基本进程组

```
$ ./zish
zish> sleep 100 | cat
^C                      ← 两个进程都退出
zish>                   ← shell 还在
```

### Ctrl+Z 和 fg

```
zish> sleep 100
^Z
[1]+  Stopped     sleep 100
zish> fg %1
sleep 100               ← 恢复运行
^C                      ← 正常终止
zish>
```

### 后台 job

```
zish> sleep 100 &
[1] 500
zish> jobs
[1]  Running     sleep 100
zish> fg %1
sleep 100
^C
zish>
```

### 管道 + Ctrl+Z

```
zish> sleep 100 | cat
^Z
[1]+  Stopped     sleep 100 | cat
zish> bg %1
[1]  sleep 100 | cat &
zish> fg %1
sleep 100 | cat
^C
zish>
```

---

上一篇：[02_signal.md](02_signal.md)
