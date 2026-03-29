# Job Control

- 写作时间：`2026-03-12 首次提交，2026-03-29 最近修改`
- 当前字符：`2693`

> 前置理论：[进程组与会话](/process/03-process-group)

本课目标：为 zish 实现进程组管理和 job control，支持前台/后台切换。

## 验收标准

- 每条管道命令创建独立的进程组
- `tcsetpgrp` 正确切换前台进程组
- Ctrl+Z 暂停前台 job
- `fg` / `bg` / `jobs` 内建命令正常工作
- 后台命令 `&` 正常工作
- Shell 忽略 SIGTSTP、SIGTTIN、SIGTTOU

## 设计与实现指导

当前 zish 能运行命令、处理管道和重定向、忽略 SIGINT。本课实现进程组和 job control，让 zish 支持 Ctrl+Z、fg/bg。

**API 速查**

**信号**（仍在 `std.posix`）：

```zig
const posix = std.posix;

pub fn sigaction(sig: SIG, act: ?*const Sigaction, oact: ?*Sigaction) void
pub fn sigemptyset() sigset_t
pub fn tcsetpgrp(fd: fd_t, pgrp: pid_t) TermioSetPgrpError!void
pub fn tcgetpgrp(fd: fd_t) TermioGetPgrpError!pid_t
```

**Wait 常量**（`std.os.linux.W`）：

| 标志 | 用途 |
|------|------|
| `W.UNTRACED` | 也报告被停止(Stopped)的子进程 |
| `W.NOHANG` | 非阻塞 |

| 宏 | 用途 |
|----|------|
| `W.IFEXITED(status)` | 是否正常退出 |
| `W.EXITSTATUS(status)` | 退出码 |
| `W.IFSTOPPED(status)` | 是否被信号停止 |
| `W.STOPSIG(status)` | 停止信号编号 |

**实现要点**

**薄封装层**：`std.os.linux` 的 syscall 返回 `usize`，需要检查 errno。定义一组薄封装避免在业务代码中到处写 errno 检查：

```zig
fn sysFork() !posix.pid_t {
    const rc = linux.fork();
    if (rc > std.math.maxInt(isize)) return error.ForkFailed;
    return @intCast(rc);
}

fn sysPipe() ![2]i32 {
    var fds: [2]i32 = undefined;
    const rc = linux.pipe(&fds);
    if (rc > std.math.maxInt(isize)) return error.PipeFailed;
    return fds;
}
```

**PATH 搜索**：`execvpeZ` 已删除，zish 需要自己从 PATH 环境变量逐目录搜索可执行文件，拼接完整路径后调用 `linux.execve`。

**Shell 信号处理**（4 个信号）：

```zig
posix.sigaction(posix.SIG.INT, &ign, null);    // Ctrl+C won't kill shell
posix.sigaction(posix.SIG.TSTP, &ign, null);   // Ctrl+Z won't stop shell
posix.sigaction(posix.SIG.TTIN, &ign, null);   // won't be stopped in background group
posix.sigaction(posix.SIG.TTOU, &ign, null);   // won't be stopped when calling tcsetpgrp
```

**管道解析**：将输入按 `|` 分割成多个 Command，每个有自己的 argv。

**fork 循环 + 前台控制**：

```zig
for (0..cmd_count) |i| {
    // create pipe (except for last command)
    // fork
    // child: setpgid → pipe redirect → reset signals → exec
    // parent: setpgid (race guard) → close unused pipe ends
}

// set foreground → wait all children → reclaim foreground
```

子进程四个步骤（进程组 → 管道重定向 → 重置信号 → exec）和[进程组与会话](/process/03-process-group)中的 Shell 管道流程图一一对应。

**fg / bg / jobs 内建命令**：

- **fg**：`tcsetpgrp` + `kill(-pgid, SIGCONT)` + `waitpid` + `tcsetpgrp` 收回
- **bg**：只 `kill(-pgid, SIGCONT)`，不切换前台
- **jobs**：遍历 job_table 打印

fg 和 bg 的区别就是一个 `tcsetpgrp`。

## 验证

```
zish> ls | grep src
src
zish> sleep 100
^Z
[1]+  Stopped     sleep 100
zish> fg %1
sleep 100
^C
zish> sleep 100 &
[1] 500
zish> jobs
[1]  Running     sleep 100
zish> fg %1
sleep 100
^C
zish>
```
